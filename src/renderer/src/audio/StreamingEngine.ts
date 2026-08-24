import type { ComandoProgramado, Pista, PreparacionProyecto, Proyecto } from '@shared/types'
import type { PlaybackEngine } from './PlaybackEngine'
import { BUFFER_CRITICAL_SEC, BUFFER_MIN_START_SEC, BUFFER_TARGET_SEC, SEGMENT_DURATION_SEC } from './streamConfig'
import { WAV_HEADER_FETCH_BYTES, bytesPorFrame, decodePcmSegment, parseWavHeader, totalFrames, type WavInfo } from './wav'

interface FuenteActiva {
  indice: number
  source: AudioBufferSourceNode
}

interface CorreccionActiva {
  now: number
  rateObjetivo: number
  duracionSec: number
  rampIn: number
}

interface PistaStream {
  pistaId: string
  archivo: string
  gainNode: GainNode
  pannerNode: StereoPannerNode
  wavInfo: WavInfo | null
  wavInfoPromise: Promise<WavInfo> | null
  /** Segmentos ya decodificados, indexados por indice (0 = [0, SEGMENT_DURATION_SEC) seg de la cancion). Es la ventana deslizante: nunca contiene la cancion entera. */
  segmentos: Map<number, AudioBuffer>
  fetchEnCurso: Set<number>
  fuentesActivas: FuenteActiva[]
  /** ctx.currentTime donde encadenar el proximo segmento de ESTA pista (null = todavia no se encadeno nada en esta corrida). */
  cursorCtxTime: number | null
  /** Primer indice que ya no existe en el archivo (fin de la pista). null = todavia no se supo. */
  finEnIndice: number | null
}

const MAX_FETCHES_CONCURRENTES_POR_PISTA = 3
const MARGEN_AGOTAMIENTO_SEC = 0.5
const INTERVALO_TICK_MS = 300
const MAX_RATE_DEV = 0.004 // identico a AudioEngine.corregirDriftSuave: misma formula, sin tocarla.

/**
 * Motor de audio para el RECEPTOR (celular): buffer deslizante por segmentos,
 * pedidos por HTTP Range directamente al Host (ver README "Streaming
 * progresivo"). A diferencia de `AudioEngine` (compu, cache completo en
 * memoria), este motor NUNCA descarga ni decodifica la cancion entera: cada
 * pista mantiene como maximo unos `BUFFER_TARGET_SEC` segundos de audio
 * futuro, en segmentos de `SEGMENT_DURATION_SEC`, y libera cada segmento
 * apenas termina de sonar.
 *
 * Encadenado gapless: cada segmento es un `AudioBufferSourceNode` de un solo
 * uso, programado con `start(cursor, offset)` donde `cursor` se calcula por
 * aritmetica de muestras (duracion exacta del segmento anterior), nunca por
 * temporizador — asi el empalme entre segmentos consecutivos no tiene huecos
 * ni superposicion.
 *
 * Garantia dura: jamas se llama a `source.start()` para un segmento que
 * todavia no llego. Si al vencedor le toca sonar y no esta listo, se detiene
 * silenciosamente (nada de silencio sintetico) y se espera a que el buffer
 * junte `BUFFER_MIN_START_SEC` de nuevo; en ese momento se avisa por
 * `onRequiereResync` para que el llamador reingrese a sync con el mecanismo
 * YA EXISTENTE (`reingresarEnSync`), en vez de que este motor invente su
 * propio scheduling absoluto.
 */
export class StreamingEngine implements PlaybackEngine {
  private ctx: AudioContext
  private masterGain: GainNode
  private pistas = new Map<string, PistaStream>()

  proyectoIdCargado: string | null = null
  private proyectoId: string | null = null
  private ajusteManualMs = 0

  private reproduciendo = false
  private esperando = false
  private posicionBaseSeg = 0
  private targetCtxTimeInicio = 0
  private indiceBase = 0
  private indiceSiguienteAEncadenar = 0
  /** Se incrementa en cada 'play' (incluye seeks/marcadores): los fetches de una corrida vieja se descartan al llegar. */
  private generacion = 0

  private audioAnchorCtxTime: number | null = null
  private audioAnchorOffsetSec = 0
  private correccionActivaHastaCtxTime = 0
  private correccionActual: CorreccionActiva | null = null

  private onResyncCb: (() => void) | null = null

  constructor() {
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.connect(this.ctx.destination)
    setInterval(() => this.tick(), INTERVALO_TICK_MS)
  }

  async resumeSiHaceFalta(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  setVolumenGeneral(volumen0a100: number): void {
    this.masterGain.gain.value = clamp(volumen0a100, 0, 100) / 100
  }

  setAjusteManualMs(ms: number): void {
    this.ajusteManualMs = ms
  }

  onRequiereResync(cb: () => void): void {
    this.onResyncCb = cb
  }

  /** No aplica: el receptor no retiene canciones completas en cache, asi que no hay nada que "proteger" de un desalojo. */
  setProtegidos(_proyectoIds: string[]): void {
    return
  }

  /** No aplica en este motor: nunca se precarga una cancion entera de antemano (ver README). No-op seguro por si algun llamador lo invoca igual. */
  async precargarProyecto(proyecto: Proyecto, onEstado?: (p: PreparacionProyecto) => void): Promise<void> {
    onEstado?.({ proyectoId: proyecto.id, estado: this.proyectoId === proyecto.id ? 'listo' : 'sin-preparar' })
  }

  /** "Listo" aca es metadata (pistas + nodos creados), no audio descargado: en streaming eso no existe como concepto previo. */
  estaListo(proyectoId: string): boolean {
    return this.proyectoId === proyectoId
  }

  async activarProyecto(proyecto: Proyecto, onEstado?: (p: PreparacionProyecto) => void): Promise<number> {
    if (this.proyectoId !== proyecto.id) {
      this.detenerTodoInmediato()
      this.pistas.clear()
      this.proyectoId = proyecto.id
      this.proyectoIdCargado = proyecto.id
      this.posicionBaseSeg = 0
      this.indiceBase = 0
      this.indiceSiguienteAEncadenar = 0

      for (const pista of proyecto.pistas) {
        const gainNode = this.ctx.createGain()
        const pannerNode = this.ctx.createStereoPanner()
        gainNode.connect(pannerNode)
        pannerNode.connect(this.masterGain)
        this.pistas.set(pista.id, {
          pistaId: pista.id,
          archivo: pista.archivo,
          gainNode,
          pannerNode,
          wavInfo: null,
          wavInfoPromise: null,
          segmentos: new Map(),
          fetchEnCurso: new Set(),
          fuentesActivas: [],
          cursorCtxTime: null,
          finEnIndice: null
        })
      }
    }
    this.aplicarMezcla(proyecto.pistas)
    // no hay descarga que hacer: el "listo" de la precarga tradicional no aplica aca.
    onEstado?.({ proyectoId: proyecto.id, estado: 'listo' })
    return proyecto.duracionTotalMs
  }

  aplicarMezcla(pistasProyecto: Pista[]): void {
    const haySolo = pistasProyecto.some((p) => p.solo)
    for (const pista of pistasProyecto) {
      const stream = this.pistas.get(pista.id)
      if (!stream) continue
      const silenciado = pista.mute || (haySolo && !pista.solo)
      stream.gainNode.gain.value = silenciado ? 0 : clamp(pista.volumen, 0, 100) / 100
      stream.pannerNode.pan.value = clamp(pista.pan, -100, 100) / 100
    }
  }

  /**
   * Ejecuta un comando programado por el servidor. 'play' cubre tanto un
   * arranque/resume normal como un seek o salto de marcador (el servidor los
   * emite igual, ver socketHandlers.ts): siempre se interpreta como "arrancar
   * a sonar en `positionMs`, en el instante `executeAtServerTime`", nunca
   * como "seguir descargando desde donde estaba" — por eso se descarta la
   * ventana vieja y se pide directamente la ventana alrededor de la nueva
   * posicion, sin bajar nada del tramo intermedio.
   */
  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void {
    if (this.pistas.size === 0) return // proyecto todavia no activado

    const clienteObjetivoMs = cmd.executeAtServerTime - clockOffsetMs
    let delaySec = (clienteObjetivoMs - Date.now()) / 1000
    let offsetMs = cmd.positionMs

    delaySec -= this.latenciaDeSalidaSec()
    delaySec -= this.ajusteManualMs / 1000
    if (delaySec < 0) {
      offsetMs += -delaySec * 1000
      delaySec = 0
    }
    const targetTime = this.ctx.currentTime + delaySec

    if (cmd.accion === 'pause' || cmd.accion === 'stop') {
      this.detenerFuentes(targetTime)
      this.reproduciendo = false
      this.esperando = false
      this.audioAnchorCtxTime = null
      this.correccionActivaHastaCtxTime = 0
      this.correccionActual = null
      if (cmd.accion === 'stop') {
        for (const pista of this.pistas.values()) {
          pista.segmentos.clear()
          pista.fetchEnCurso.clear()
          pista.cursorCtxTime = null
        }
      }
      return
    }

    // 'play' (incluye seek/marker:jump mientras suena): siempre reprograma desde cero.
    this.detenerFuentes(targetTime)
    this.generacion++
    const nuevaPosicionSeg = offsetMs / 1000
    const nuevoIndiceBase = Math.floor(nuevaPosicionSeg / SEGMENT_DURATION_SEC)

    // libera lo que quedo antes de la nueva posicion; lo que ya estaba
    // cacheado DESPUES de la nueva posicion se conserva (p.ej. un resync
    // chico cerca de donde ya estabamos no vuelve a pedir nada).
    for (const pista of this.pistas.values()) {
      for (const indice of [...pista.segmentos.keys()]) {
        if (indice < nuevoIndiceBase) pista.segmentos.delete(indice)
      }
      pista.fetchEnCurso.clear()
      pista.cursorCtxTime = null
    }

    this.posicionBaseSeg = nuevaPosicionSeg
    this.targetCtxTimeInicio = targetTime
    this.indiceBase = nuevoIndiceBase
    this.indiceSiguienteAEncadenar = nuevoIndiceBase
    this.reproduciendo = true
    this.esperando = !this.listoParaArrancar(nuevoIndiceBase)
    this.tick()
  }

  posicionRealMs(): number | null {
    if (this.audioAnchorCtxTime === null) return null
    if (this.ctx.currentTime < this.audioAnchorCtxTime) return null
    return (this.audioAnchorOffsetSec + (this.ctx.currentTime - this.audioAnchorCtxTime)) * 1000
  }

  enCorreccionSuave(): boolean {
    return this.ctx.currentTime < this.correccionActivaHastaCtxTime
  }

  /** Misma formula que AudioEngine.corregirDriftSuave (sin tocarla), aplicada a TODAS las fuentes activas y propagada a las que se encadenen despues mientras dure la rampa (ver `programarIndice`). */
  corregirDriftSuave(driftMs: number): void {
    if (this.audioAnchorCtxTime === null || this.pistas.size === 0) return
    const now = this.ctx.currentTime
    if (now < this.correccionActivaHastaCtxTime) return

    const driftSec = driftMs / 1000
    const rateObjetivo = 1 - Math.sign(driftSec) * MAX_RATE_DEV
    const duracionSec = Math.max(0.5, Math.abs(driftSec) / MAX_RATE_DEV)
    const rampIn = Math.min(0.2, duracionSec / 4)
    const correccion: CorreccionActiva = { now, rateObjetivo, duracionSec, rampIn }

    this.correccionActual = correccion
    for (const pista of this.pistas.values()) {
      for (const { source } of pista.fuentesActivas) this.aplicarCorreccionANodo(source, correccion)
    }

    this.audioAnchorOffsetSec -= driftSec
    this.correccionActivaHastaCtxTime = now + duracionSec
  }

  /** Estado del buffer (min entre pistas) para pruebas/ajuste de los umbrales — no esta cableado a UI todavia. */
  bufferSegundosDisponibles(): number {
    return this.segundosDisponiblesDesde(this.indiceSiguienteAEncadenar)
  }

  estadoBuffer(): 'normal' | 'rellenando' | 'critico' {
    const disponibles = this.bufferSegundosDisponibles()
    if (disponibles >= BUFFER_TARGET_SEC) return 'normal'
    if (disponibles >= BUFFER_CRITICAL_SEC) return 'rellenando'
    return 'critico'
  }

  // ---- scheduling interno ----

  private tick(): void {
    if (!this.reproduciendo) return

    if (this.esperando) {
      if (this.listoParaArrancar(this.indiceSiguienteAEncadenar)) {
        this.esperando = false
        this.onResyncCb?.() // pide un reingreso a sync FRESCO (mecanismo existente), no un arranque con el horario viejo
        return
      }
      this.lanzarFetchsPendientes()
      return
    }

    for (;;) {
      if (this.todasTerminaronEn(this.indiceSiguienteAEncadenar)) break // fin de la cancion: nada mas que encadenar
      if (this.segundosYaEncadenadosPorDelante() >= BUFFER_TARGET_SEC) break
      if (!this.indiceListoEnTodas(this.indiceSiguienteAEncadenar)) {
        if (this.estaPorAgotarse()) {
          // no llego a tiempo: se corta aca, nada de silencio sintetico. onended
          // de lo ya encadenado dejara sonar hasta el final real, despues nada.
          this.esperando = true
        }
        break
      }
      this.programarIndice(this.indiceSiguienteAEncadenar)
      this.indiceSiguienteAEncadenar++
    }

    this.lanzarFetchsPendientes()
  }

  private programarIndice(indice: number): void {
    const primeraDeLaCorrida = indice === this.indiceBase
    for (const pista of this.pistas.values()) {
      if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
      const buffer = pista.segmentos.get(indice)
      if (!buffer) continue // defensivo: no deberia pasar, `indiceListoEnTodas` ya lo garantiza

      const cursor = pista.cursorCtxTime ?? this.targetCtxTimeInicio
      const esPrimeraDeEstaPista = pista.cursorCtxTime === null
      const offsetDentro = esPrimeraDeEstaPista ? Math.max(0, this.posicionBaseSeg - indice * SEGMENT_DURATION_SEC) : 0

      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(pista.gainNode)
      if (this.correccionActual && this.ctx.currentTime < this.correccionActivaHastaCtxTime) {
        this.aplicarCorreccionANodo(source, this.correccionActual)
      }
      try {
        source.start(cursor, offsetDentro)
      } catch {
        // horario/offset invalido puntual: se ignora este segmento de esta pista
      }
      source.onended = () => {
        pista.segmentos.delete(indice) // libera de memoria el segmento ya reproducido
        pista.fuentesActivas = pista.fuentesActivas.filter((f) => f.source !== source)
      }
      pista.fuentesActivas.push({ indice, source })
      pista.cursorCtxTime = cursor + (buffer.duration - offsetDentro)
    }

    if (primeraDeLaCorrida) {
      this.audioAnchorCtxTime = this.targetCtxTimeInicio
      this.audioAnchorOffsetSec = this.posicionBaseSeg
      this.correccionActivaHastaCtxTime = 0
      this.correccionActual = null
    }
  }

  private lanzarFetchsPendientes(): void {
    const cantidadIndices = Math.ceil(BUFFER_TARGET_SEC / SEGMENT_DURATION_SEC) + 1
    for (const pista of this.pistas.values()) {
      for (let i = 0; i < cantidadIndices; i++) {
        if (pista.fetchEnCurso.size >= MAX_FETCHES_CONCURRENTES_POR_PISTA) break
        const indice = this.indiceSiguienteAEncadenar + i
        if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
        if (pista.segmentos.has(indice) || pista.fetchEnCurso.has(indice)) continue
        pista.fetchEnCurso.add(indice)
        void this.fetchSegmento(pista, indice, this.generacion)
      }
    }
  }

  private async fetchSegmento(pista: PistaStream, indice: number, generacion: number): Promise<void> {
    try {
      const info = await this.obtenerWavInfo(pista)
      if (generacion !== this.generacion) return // la ventana que pidio esto ya no existe (seek/cambio de proyecto)

      const bpf = bytesPorFrame(info)
      const framesTotales = totalFrames(info)
      const frameOffset = Math.round(indice * SEGMENT_DURATION_SEC * info.sampleRate)
      if (frameOffset >= framesTotales) {
        this.marcarFin(pista, indice)
        return
      }
      const frameCountPedido = Math.min(Math.round(SEGMENT_DURATION_SEC * info.sampleRate), framesTotales - frameOffset)
      const byteStart = info.dataOffset + frameOffset * bpf
      const byteEnd = byteStart + frameCountPedido * bpf - 1

      const bytes = await this.fetchRango(this.urlDe(pista), byteStart, byteEnd)
      if (generacion !== this.generacion) return

      const frameCountReal = Math.floor(bytes.byteLength / bpf)
      if (frameCountReal <= 0) {
        this.marcarFin(pista, indice)
        return
      }
      const canales = decodePcmSegment(info, bytes)
      const buffer = this.ctx.createBuffer(info.numChannels, frameCountReal, info.sampleRate)
      for (let ch = 0; ch < info.numChannels; ch++) buffer.copyToChannel(canales[ch], ch)

      pista.segmentos.set(indice, buffer)
      if (frameCountReal < frameCountPedido) this.marcarFin(pista, indice + 1)
    } catch (err) {
      console.warn('[StreamingEngine] fallo al pedir segmento', pista.pistaId, indice, err)
    } finally {
      pista.fetchEnCurso.delete(indice)
      if (generacion === this.generacion) this.tick()
    }
  }

  private marcarFin(pista: PistaStream, indice: number): void {
    pista.finEnIndice = pista.finEnIndice === null ? indice : Math.min(pista.finEnIndice, indice)
  }

  private async obtenerWavInfo(pista: PistaStream): Promise<WavInfo> {
    if (pista.wavInfo) return pista.wavInfo
    if (!pista.wavInfoPromise) {
      pista.wavInfoPromise = this.fetchRango(this.urlDe(pista), 0, WAV_HEADER_FETCH_BYTES - 1).then((bytes) => {
        const info = parseWavHeader(bytes)
        pista.wavInfo = info
        return info
      })
    }
    return pista.wavInfoPromise
  }

  private async fetchRango(url: string, start: number, end: number): Promise<ArrayBuffer> {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
    if (resp.status === 206) return resp.arrayBuffer()
    if (resp.status === 200) {
      // el servidor no respeto el Range (no deberia pasar con express.static): recortamos nosotros del archivo completo
      const completo = await resp.arrayBuffer()
      return completo.slice(start, end + 1)
    }
    if (resp.status === 416) return new ArrayBuffer(0) // rango fuera del archivo: fin de pista
    throw new Error(`HTTP ${resp.status} pidiendo ${url}`)
  }

  private urlDe(pista: PistaStream): string {
    return `/media/${this.proyectoId}/${pista.archivo}`
  }

  private detenerFuentes(atTime: number): void {
    for (const pista of this.pistas.values()) {
      for (const { source } of pista.fuentesActivas) {
        try {
          source.stop(atTime)
        } catch {
          // ya estaba detenida
        }
        source.onended = null
      }
      pista.fuentesActivas = []
    }
  }

  private detenerTodoInmediato(): void {
    this.detenerFuentes(this.ctx.currentTime)
    this.reproduciendo = false
    this.esperando = false
    this.audioAnchorCtxTime = null
    this.correccionActivaHastaCtxTime = 0
    this.correccionActual = null
  }

  /** Identico a AudioEngine.latenciaDeSalidaSec (duplicado a proposito: no se toca AudioEngine.ts). */
  private latenciaDeSalidaSec(): number {
    return this.ctx.outputLatency ?? this.ctx.baseLatency ?? 0
  }

  private aplicarCorreccionANodo(source: AudioBufferSourceNode, c: CorreccionActiva): void {
    const p = source.playbackRate
    p.cancelScheduledValues(c.now)
    p.setValueAtTime(p.value, c.now)
    p.linearRampToValueAtTime(c.rateObjetivo, c.now + c.rampIn)
    p.setValueAtTime(c.rateObjetivo, c.now + c.duracionSec - c.rampIn)
    p.linearRampToValueAtTime(1, c.now + c.duracionSec)
  }

  /** true si, para CADA pista, hay `BUFFER_MIN_START_SEC` contiguos desde `indice` (o la pista ya termina antes de eso). */
  private listoParaArrancar(indice: number): boolean {
    for (const pista of this.pistas.values()) {
      let idx = indice
      let segundos = 0
      while (segundos < BUFFER_MIN_START_SEC) {
        if (pista.finEnIndice !== null && idx >= pista.finEnIndice) break
        const buffer = pista.segmentos.get(idx)
        if (!buffer) return false
        segundos += buffer.duration
        idx++
      }
    }
    return true
  }

  /** min entre pistas de cuantos segundos contiguos hay disponibles desde `indice` (tope BUFFER_TARGET_SEC, no hace falta seguir contando mas alla). */
  private segundosDisponiblesDesde(indice: number): number {
    if (this.pistas.size === 0) return 0
    let minSegundos = Infinity
    for (const pista of this.pistas.values()) {
      let idx = indice
      let segundos = 0
      while (segundos < BUFFER_TARGET_SEC) {
        if (pista.finEnIndice !== null && idx >= pista.finEnIndice) {
          segundos = BUFFER_TARGET_SEC
          break
        }
        const buffer = pista.segmentos.get(idx)
        if (!buffer) break
        segundos += buffer.duration
        idx++
      }
      minSegundos = Math.min(minSegundos, segundos)
    }
    return minSegundos
  }

  /** Seg de audio YA encadenado (source.start ya llamado) por delante del instante actual — min entre pistas. */
  private segundosYaEncadenadosPorDelante(): number {
    if (this.pistas.size === 0) return 0
    let minCursor = Infinity
    for (const pista of this.pistas.values()) {
      const cursor = pista.cursorCtxTime ?? this.targetCtxTimeInicio
      minCursor = Math.min(minCursor, cursor)
    }
    return Math.max(0, minCursor - this.ctx.currentTime)
  }

  private estaPorAgotarse(): boolean {
    return this.segundosYaEncadenadosPorDelante() <= MARGEN_AGOTAMIENTO_SEC
  }

  private indiceListoEnTodas(indice: number): boolean {
    for (const pista of this.pistas.values()) {
      if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
      if (!pista.segmentos.has(indice)) return false
    }
    return true
  }

  private todasTerminaronEn(indice: number): boolean {
    if (this.pistas.size === 0) return false
    for (const pista of this.pistas.values()) {
      if (pista.finEnIndice === null || indice < pista.finEnIndice) return false
    }
    return true
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
