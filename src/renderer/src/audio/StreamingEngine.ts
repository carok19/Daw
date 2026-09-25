import type { ComandoProgramado, EstadoBuffer, Pista, Proyecto } from '@shared/types'
import { WAV_HEADER_FETCH_BYTES, WavHeaderError, bytesPorFrame, decodePcmSegment, parseWavHeader, totalFrames, type WavInfo } from '@shared/wav'
import { clavePista, type MezclaPersonal, type PlaybackEngine } from './PlaybackEngine'
import {
  BUFFER_CRITICAL_SEC,
  BUFFER_MIN_START_SEC,
  BUFFER_TARGET_SEC,
  MAX_CUES,
  MAX_FETCHES_POR_PISTA,
  SEGMENT_DURATION_SEC,
  SEGMENTOS_POR_CUE
} from './streamConfig'

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
  nombre: string
  archivo: string
  gainNode: GainNode
  pannerNode: StereoPannerNode
  wavInfo: WavInfo | null
  wavInfoPromise: Promise<WavInfo> | null
  /** Ventana deslizante alrededor del playhead: nunca contiene la cancion entera. */
  segmentos: Map<number, AudioBuffer>
  /** Arranque de cada marcador (cues), para saltos/loops sin esperar la red. */
  cueSegmentos: Map<number, AudioBuffer>
  enVuelo: Map<number, AbortController>
  fuentesActivas: FuenteActiva[]
  /** ctx.currentTime donde encadenar el proximo segmento de ESTA pista (null = todavia nada en esta corrida). */
  cursorCtxTime: number | null
  /** Primer indice que ya no existe en el archivo (fin de la pista). null = todavia no se supo. */
  finEnIndice: number | null
  /** error irrecuperable (archivo que falta, formato ilegible): la pista queda muda, las demas siguen */
  error: string | null
  fallosSeguidos: number
  /** Date.now() hasta el que no se reintenta (backoff ante errores de red) */
  esperarHasta: number
}

const MARGEN_AGOTAMIENTO_SEC = 0.5
const INTERVALO_TICK_MS = 250
const MAX_RATE_DEV = 0.004 // 0.4%: correccion de drift inaudible

class ErrorFatal extends Error {}

/**
 * Motor de audio por streaming (celulares Y compu): buffer deslizante por
 * segmentos pedidos por HTTP Range al servidor (ver README "Streaming
 * progresivo"). Nunca descarga ni decodifica la cancion entera: cada pista
 * mantiene unos `BUFFER_TARGET_SEC` segundos de audio futuro, mas los
 * primeros segundos de cada marcador ("cues"), y libera cada segmento apenas
 * termina de sonar.
 *
 * Encadenado gapless: cada segmento es un `AudioBufferSourceNode` de un solo
 * uso, programado con `start(cursor, offset)` donde `cursor` se calcula por
 * aritmetica de muestras (duracion exacta del segmento anterior), nunca por
 * temporizador.
 *
 * Garantia dura: jamas se llama a `source.start()` para un segmento que
 * todavia no llego. Si se agota el buffer, se espera a juntar
 * `BUFFER_MIN_START_SEC` y se pide un reingreso a sync fresco por
 * `onRequiereResync` (el llamador usa `reingresarEnSync`).
 *
 * Errores: una pista con un problema irrecuperable (404, formato ilegible)
 * queda muda sin bloquear a las demas y se informa por `errorAudio()`; los
 * errores de red se reintentan con espera creciente (nunca en un bucle
 * cerrado que congele el celular).
 */
export class StreamingEngine implements PlaybackEngine {
  private ctx: AudioContext
  private masterGain: GainNode
  private pistas = new Map<string, PistaStream>()
  private ultimasPistas: Pista[] = []
  private mezclaPersonal: MezclaPersonal = {}

  proyectoIdCargado: string | null = null
  private proyectoId: string | null = null
  private ajusteManualMs = 0

  private reproduciendo = false
  private esperando = false
  private posicionBaseSeg = 0
  private targetCtxTimeInicio = 0
  private indiceBase = 0
  /** proximo indice a encadenar (reproduciendo) o a tener listo (en reposo) */
  private indiceSiguienteAEncadenar = 0
  private cueIndices = new Set<number>()

  private audioAnchorCtxTime: number | null = null
  private audioAnchorOffsetSec = 0
  private correccionActivaHastaCtxTime = 0
  private correccionActual: CorreccionActiva | null = null

  private onResyncCb: (() => void) | null = null
  private intervalo: ReturnType<typeof setInterval>

  constructor() {
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.connect(this.ctx.destination)
    this.intervalo = setInterval(() => this.tick(), INTERVALO_TICK_MS)
  }

  async resumeSiHaceFalta(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  setVolumenGeneral(volumen0a100: number): void {
    const v = clamp(volumen0a100, 0, 100) / 100
    this.masterGain.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02)
  }

  setAjusteManualMs(ms: number): void {
    this.ajusteManualMs = ms
  }

  setMezclaPersonal(mezcla: MezclaPersonal): void {
    this.mezclaPersonal = mezcla
    this.aplicarMezcla(this.ultimasPistas)
  }

  onRequiereResync(cb: () => void): void {
    this.onResyncCb = cb
  }

  activarProyecto(proyecto: Proyecto, posicionMs: number): void {
    if (this.proyectoId !== proyecto.id) {
      this.detener()
      for (const p of this.pistas.values()) {
        for (const c of p.enVuelo.values()) c.abort()
        p.gainNode.disconnect()
      }
      this.pistas.clear()
      this.proyectoId = proyecto.id
      this.proyectoIdCargado = proyecto.id

      for (const pista of proyecto.pistas) {
        const gainNode = this.ctx.createGain()
        const pannerNode = this.ctx.createStereoPanner()
        gainNode.connect(pannerNode)
        pannerNode.connect(this.masterGain)
        this.pistas.set(pista.id, {
          pistaId: pista.id,
          nombre: pista.nombre,
          archivo: pista.archivo,
          gainNode,
          pannerNode,
          wavInfo: null,
          wavInfoPromise: null,
          segmentos: new Map(),
          cueSegmentos: new Map(),
          enVuelo: new Map(),
          fuentesActivas: [],
          cursorCtxTime: null,
          finEnIndice: null,
          error: null,
          fallosSeguidos: 0,
          esperarHasta: 0
        })
      }
    }
    this.aplicarMezcla(proyecto.pistas)
    this.setCues(proyecto.marcadores.map((m) => m.tiempoMs))
    if (!this.reproduciendo) this.prepararEn(posicionMs)
  }

  aplicarMezcla(pistasProyecto: Pista[]): void {
    this.ultimasPistas = pistasProyecto
    const haySolo = pistasProyecto.some((p) => p.solo)
    const t = this.ctx.currentTime
    for (const pista of pistasProyecto) {
      const stream = this.pistas.get(pista.id)
      if (!stream) continue
      stream.nombre = pista.nombre
      const personal = this.mezclaPersonal[clavePista(pista.nombre)]
      const silenciado = pista.mute || (haySolo && !pista.solo) || !!personal?.mute
      const v = clamp(pista.volumen, 0, 100) / 100
      // curva de fader tipo audio (cuadratica): el recorrido del fader se siente parejo al oido
      const ganancia = silenciado ? 0 : v * v * (personal ? clamp(personal.ganancia, 0, 2) : 1)
      // rampa corta: sin "clicks" al mover un fader o mutear
      stream.gainNode.gain.setTargetAtTime(ganancia, t, 0.015)
      stream.pannerNode.pan.setTargetAtTime(clamp(pista.pan, -100, 100) / 100, t, 0.015)
    }
  }

  setCues(tiemposMs: number[]): void {
    const indices = new Set<number>()
    const add = (ms: number): void => {
      const base = Math.floor(ms / 1000 / SEGMENT_DURATION_SEC)
      for (let k = 0; k < SEGMENTOS_POR_CUE; k++) indices.add(base + k)
    }
    add(0) // el principio de la cancion siempre
    ;[...tiemposMs].sort((a, b) => a - b).slice(0, MAX_CUES).forEach(add)
    this.cueIndices = indices
    for (const pista of this.pistas.values()) {
      for (const i of [...pista.cueSegmentos.keys()]) if (!indices.has(i)) pista.cueSegmentos.delete(i)
    }
  }

  /**
   * Ejecuta un comando programado por el servidor. 'play' cubre arranque,
   * resume, seek, salto de marcador y "repetir seccion": siempre se
   * interpreta como "sonar desde `positionMs` en el instante
   * `executeAtServerTime`".
   */
  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void {
    if (this.pistas.size === 0) return

    if (cmd.accion === 'seek') {
      // solo se emite sin audio sonando: preparar el buffer donde va a arrancar
      if (!this.reproduciendo) this.prepararEn(cmd.positionMs)
      return
    }

    const clienteObjetivoMs = cmd.executeAtServerTime - clockOffsetMs
    let delaySec = (clienteObjetivoMs - Date.now()) / 1000
    let offsetMs = cmd.positionMs

    // compensa la latencia de salida propia de este dispositivo + el ajuste fino manual
    delaySec -= this.latenciaDeSalidaSec()
    delaySec -= this.ajusteManualMs / 1000
    if (delaySec < 0) {
      // llego tarde: arranca ya, saltando lo que se perdio
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
      this.prepararEn(cmd.accion === 'stop' ? 0 : cmd.positionMs)
      return
    }

    // 'play': siempre reprograma desde cero en la nueva posicion
    this.detenerFuentes(targetTime)
    const nuevaPosicionSeg = offsetMs / 1000
    const nuevoIndiceBase = Math.floor(nuevaPosicionSeg / SEGMENT_DURATION_SEC)
    this.moverVentana(nuevoIndiceBase)
    for (const pista of this.pistas.values()) pista.cursorCtxTime = null

    this.posicionBaseSeg = nuevaPosicionSeg
    this.targetCtxTimeInicio = targetTime
    this.indiceBase = nuevoIndiceBase
    this.indiceSiguienteAEncadenar = nuevoIndiceBase
    this.reproduciendo = true
    this.esperando = !this.listoParaArrancar(nuevoIndiceBase)
    this.tick()
  }

  detener(): void {
    this.detenerFuentes(this.ctx.currentTime)
    this.reproduciendo = false
    this.esperando = false
    this.audioAnchorCtxTime = null
    this.correccionActivaHastaCtxTime = 0
    this.correccionActual = null
  }

  posicionRealMs(): number | null {
    if (this.audioAnchorCtxTime === null) return null
    if (this.ctx.currentTime < this.audioAnchorCtxTime) return null
    return (this.audioAnchorOffsetSec + (this.ctx.currentTime - this.audioAnchorCtxTime)) * 1000
  }

  enCorreccionSuave(): boolean {
    return this.ctx.currentTime < this.correccionActivaHastaCtxTime
  }

  /**
   * Corrige un drift chico sin cortes: ajusta levemente la velocidad
   * (`playbackRate`, desviacion fija de 0.4%, inaudible) el tiempo justo para
   * absorberlo, en todas las fuentes activas y en las que se encadenen
   * mientras dure la correccion.
   */
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

  estadoBuffer(): EstadoBuffer | null {
    if (!this.reproduciendo) return null
    if (this.esperando) return 'critico'
    const porDelante = this.segundosYaEncadenadosPorDelante() + this.segundosDisponiblesDesde(this.indiceSiguienteAEncadenar)
    if (porDelante >= BUFFER_TARGET_SEC * 0.6) return 'normal'
    if (porDelante >= BUFFER_CRITICAL_SEC) return 'rellenando'
    return 'critico'
  }

  errorAudio(): string | null {
    for (const p of this.pistas.values()) if (p.error) return `${p.nombre}: ${p.error}`
    return null
  }

  dispose(): void {
    clearInterval(this.intervalo)
    this.detener()
    for (const p of this.pistas.values()) for (const c of p.enVuelo.values()) c.abort()
    this.pistas.clear()
    void this.ctx.close().catch(() => {})
  }

  // ---- ventana / prebuffer ----

  /** En reposo: deja listos los primeros segundos desde `posicionMs` para que el proximo play arranque al instante. */
  private prepararEn(posicionMs: number): void {
    const indice = Math.floor(Math.max(0, posicionMs) / 1000 / SEGMENT_DURATION_SEC)
    this.moverVentana(indice)
    this.indiceSiguienteAEncadenar = indice
    this.lanzarFetchsPendientes()
  }

  /**
   * Reubica la ventana en `indiceBase`: descarta lo que queda fuera (y cancela
   * los pedidos en vuelo que ya no sirven) y aprovecha lo que haya en los cues.
   */
  private moverVentana(indiceBase: number): void {
    const hasta = indiceBase + this.cantidadIndicesVentana() + 1
    for (const pista of this.pistas.values()) {
      for (const indice of [...pista.segmentos.keys()]) {
        if (indice < indiceBase || indice > hasta) pista.segmentos.delete(indice)
      }
      for (const [indice, ctrl] of pista.enVuelo) {
        if ((indice < indiceBase || indice > hasta) && !this.cueIndices.has(indice)) {
          ctrl.abort()
          pista.enVuelo.delete(indice)
        }
      }
      for (let i = indiceBase; i <= hasta; i++) {
        const cue = pista.cueSegmentos.get(i)
        if (cue && !pista.segmentos.has(i)) pista.segmentos.set(i, cue)
      }
    }
  }

  private cantidadIndicesVentana(): number {
    return Math.ceil(BUFFER_TARGET_SEC / SEGMENT_DURATION_SEC) + 1
  }

  // ---- scheduling interno ----

  private tick(): void {
    if (this.reproduciendo) {
      if (this.esperando) {
        if (this.listoParaArrancar(this.indiceSiguienteAEncadenar)) {
          this.esperando = false
          this.onResyncCb?.() // reingreso a sync FRESCO (mecanismo existente), no un arranque con el horario viejo
          return
        }
      } else {
        for (;;) {
          if (this.todasTerminaronEn(this.indiceSiguienteAEncadenar)) break
          if (this.segundosYaEncadenadosPorDelante() >= BUFFER_TARGET_SEC) break
          if (!this.indiceListoEnTodas(this.indiceSiguienteAEncadenar)) {
            // no llego a tiempo: se corta aca (nada de silencio sintetico) y se espera
            if (this.estaPorAgotarse()) this.esperando = true
            break
          }
          this.programarIndice(this.indiceSiguienteAEncadenar)
          this.indiceSiguienteAEncadenar++
        }
      }
    }
    this.lanzarFetchsPendientes()
  }

  private programarIndice(indice: number): void {
    const primeraDeLaCorrida = indice === this.indiceBase
    for (const pista of this.pistas.values()) {
      if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
      const buffer = pista.segmentos.get(indice)
      if (!buffer) continue

      const cursor = pista.cursorCtxTime ?? this.targetCtxTimeInicio
      const esPrimeraDeEstaPista = pista.cursorCtxTime === null
      const offsetDentro = esPrimeraDeEstaPista ? Math.max(0, this.posicionBaseSeg - indice * SEGMENT_DURATION_SEC) : 0
      if (offsetDentro >= buffer.duration) {
        pista.cursorCtxTime = cursor
        continue
      }

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
        // libera de memoria el segmento ya reproducido (los cues se conservan aparte)
        if (pista.segmentos.get(indice) === buffer) pista.segmentos.delete(indice)
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

  /** Pide lo que falta: primero la ventana actual (o la de reposo), despues los cues. */
  private lanzarFetchsPendientes(): void {
    if (this.pistas.size === 0) return
    const ahora = Date.now()
    const cantidad = this.reproduciendo
      ? this.cantidadIndicesVentana()
      : Math.ceil(BUFFER_MIN_START_SEC / SEGMENT_DURATION_SEC) + 1
    for (const pista of this.pistas.values()) {
      if (pista.error || ahora < pista.esperarHasta) continue
      let ventanaCompleta = true
      for (let i = 0; i < cantidad; i++) {
        const indice = this.indiceSiguienteAEncadenar + i
        if (pista.finEnIndice !== null && indice >= pista.finEnIndice) break
        if (pista.segmentos.has(indice)) continue
        ventanaCompleta = false
        if (pista.enVuelo.has(indice)) continue
        if (pista.enVuelo.size >= MAX_FETCHES_POR_PISTA) break
        this.pedirSegmento(pista, indice)
      }
      // cues: solo con la ventana ya cubierta, de a uno, para no competir con lo que esta por sonar
      if (!ventanaCompleta || pista.enVuelo.size > 0) continue
      for (const indice of this.cueIndices) {
        if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
        if (pista.cueSegmentos.has(indice) || pista.enVuelo.has(indice)) continue
        const enVentana = pista.segmentos.get(indice)
        if (enVentana) {
          pista.cueSegmentos.set(indice, enVentana)
          continue
        }
        this.pedirSegmento(pista, indice)
        break
      }
    }
  }

  private pedirSegmento(pista: PistaStream, indice: number): void {
    const ctrl = new AbortController()
    pista.enVuelo.set(indice, ctrl)
    const proyectoId = this.proyectoId
    void this.fetchSegmento(pista, indice, ctrl.signal)
      .then((buffer) => {
        if (proyectoId !== this.proyectoId || ctrl.signal.aborted) return
        pista.fallosSeguidos = 0
        if (buffer) this.guardarSegmento(pista, indice, buffer)
        this.tick()
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || proyectoId !== this.proyectoId) return
        if (err instanceof ErrorFatal) {
          pista.error = err.message
          pista.finEnIndice = 0 // la pista queda muda; las demas siguen sonando
          console.warn('[StreamingEngine] pista con error', pista.nombre, err.message)
          this.tick()
        } else {
          // error de red: reintento con espera creciente (0.3s, 0.6s, ... hasta 4s)
          pista.fallosSeguidos++
          pista.esperarHasta = Date.now() + Math.min(4000, 300 * 2 ** (pista.fallosSeguidos - 1))
          if (!pista.wavInfo) pista.wavInfoPromise = null
        }
      })
      .finally(() => {
        if (pista.enVuelo.get(indice) === ctrl) pista.enVuelo.delete(indice)
      })
  }

  private guardarSegmento(pista: PistaStream, indice: number, buffer: AudioBuffer): void {
    if (this.cueIndices.has(indice)) pista.cueSegmentos.set(indice, buffer)
    const desde = this.indiceSiguienteAEncadenar
    if (indice >= desde && indice <= desde + this.cantidadIndicesVentana() + 1) pista.segmentos.set(indice, buffer)
  }

  /** Baja y decodifica un segmento. null = no hay audio en ese indice (fin de la pista). */
  private async fetchSegmento(pista: PistaStream, indice: number, signal: AbortSignal): Promise<AudioBuffer | null> {
    const info = await this.obtenerWavInfo(pista)
    const bpf = bytesPorFrame(info)
    const framesTotales = totalFrames(info)
    const frameOffset = Math.round(indice * SEGMENT_DURATION_SEC * info.sampleRate)
    if (frameOffset >= framesTotales) {
      this.marcarFin(pista, indice)
      return null
    }
    const frameCountPedido = Math.min(Math.round(SEGMENT_DURATION_SEC * info.sampleRate), framesTotales - frameOffset)
    const byteStart = info.dataOffset + frameOffset * bpf
    const byteEnd = byteStart + frameCountPedido * bpf - 1

    const bytes = await this.fetchRango(this.urlDe(pista), byteStart, byteEnd, signal)
    const frameCountReal = Math.floor(bytes.byteLength / bpf)
    if (frameCountReal <= 0) {
      this.marcarFin(pista, indice)
      return null
    }
    const canales = decodePcmSegment(info, bytes)
    const buffer = this.ctx.createBuffer(info.numChannels, frameCountReal, info.sampleRate)
    for (let ch = 0; ch < info.numChannels; ch++) buffer.copyToChannel(canales[ch], ch)
    if (frameOffset + frameCountReal >= framesTotales) this.marcarFin(pista, indice + 1)
    return buffer
  }

  private marcarFin(pista: PistaStream, indice: number): void {
    pista.finEnIndice = pista.finEnIndice === null ? indice : Math.min(pista.finEnIndice, indice)
  }

  /** El encabezado no se cancela con el segmento que lo pidio: lo necesitan todos los de esa pista. */
  private obtenerWavInfo(pista: PistaStream): Promise<WavInfo> {
    if (pista.wavInfo) return Promise.resolve(pista.wavInfo)
    if (!pista.wavInfoPromise) {
      pista.wavInfoPromise = this.fetchRango(this.urlDe(pista), 0, WAV_HEADER_FETCH_BYTES - 1).then((bytes) => {
        try {
          const info = parseWavHeader(bytes)
          if (![8, 16, 24, 32].includes(info.bitsPerSample)) throw new WavHeaderError('formato de audio no soportado')
          pista.wavInfo = info
          return info
        } catch (err) {
          throw new ErrorFatal(err instanceof WavHeaderError ? 'formato de audio no soportado' : String(err))
        }
      })
    }
    return pista.wavInfoPromise
  }

  private async fetchRango(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
    if (resp.status === 206) return resp.arrayBuffer()
    if (resp.status === 200) {
      const completo = await resp.arrayBuffer()
      return completo.slice(start, end + 1)
    }
    if (resp.status === 416) return new ArrayBuffer(0) // rango fuera del archivo: fin de pista
    if (resp.status === 404) throw new ErrorFatal('falta el archivo de audio en la computadora')
    throw new Error(`HTTP ${resp.status}`)
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

  /** true si, para CADA pista, hay `BUFFER_MIN_START_SEC` contiguos desde `indice` (o la pista termina antes). */
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

  /** Seg de audio YA encadenado por delante del instante actual — min entre pistas que siguen sonando. */
  private segundosYaEncadenadosPorDelante(): number {
    if (this.pistas.size === 0) return 0
    let minCursor = Infinity
    for (const pista of this.pistas.values()) {
      if (pista.finEnIndice !== null && this.indiceSiguienteAEncadenar >= pista.finEnIndice) continue
      const cursor = pista.cursorCtxTime ?? this.targetCtxTimeInicio
      minCursor = Math.min(minCursor, cursor)
    }
    if (minCursor === Infinity) return BUFFER_TARGET_SEC
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
