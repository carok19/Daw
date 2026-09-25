import type { ComandoProgramado, EstadoBuffer, Pista, Proyecto } from '@shared/types'
import { WAV_HEADER_FETCH_BYTES, WavHeaderError, bytesPorFrame, decodePcmSegment, parseWavHeader, totalFrames, type WavInfo } from '@shared/wav'
import { clavePista, type MezclaPersonal, type PlaybackEngine } from './PlaybackEngine'
import {
  BUFFER_CRITICAL_SEC,
  BUFFER_MIN_START_SEC,
  BUFFER_TARGET_SEC,
  MAX_CUES,
  MAX_FETCHES_GLOBAL,
  MAX_FETCHES_POR_PISTA,
  SEGMENT_DURATION_SEC,
  SEGMENTOS_POR_CUE,
  SEGMENTOS_PRECARGA_SIGUIENTE
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
  /** cuanto hay que absorber (seg, con signo: + = adelantado) */
  driftSec: number
}

/** Fraccion (0-1) del drift ya absorbido `t` segundos despues de empezar la correccion (rampa-meseta-rampa). */
function fraccionCorregida(c: CorreccionActiva, t: number): number {
  const { duracionSec: d, rampIn: r } = c
  if (t <= 0) return 0
  if (t >= d) return 1
  const total = d - r // area del trapecio (en unidades de "desvio de velocidad x seg")
  let area: number
  if (t < r) area = (t * t) / (2 * r)
  else if (t <= d - r) area = t - r / 2
  else area = total - ((d - t) * (d - t)) / (2 * r)
  return Math.min(1, Math.max(0, area / total))
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

/** Principio ya bajado de una pista de la proxima cancion. */
interface PistaPrecargada {
  archivo: string
  wavInfo: WavInfo | null
  segmentos: Map<number, AudioBuffer>
  finEnIndice: number | null
  error: boolean
}

interface Precarga {
  proyectoId: string
  revision: number
  /** primer segmento a bajar (la cancion arranca donde se la dejo) */
  indiceInicio: number
  pistas: Map<string, PistaPrecargada>
  /** "pistaId:indice" -> pedido en vuelo */
  enVuelo: Map<string, AbortController>
  fallosSeguidos: number
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
  revisionCargada = 0
  private proyectoId: string | null = null
  private precarga: Precarga | null = null
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
  /**
   * Cuanto se adelanto el arranque en esta corrida (latencia de salida + ajuste
   * fino). El nodo de audio va ESE tiempo por delante de lo que se escucha: hay
   * que descontarlo al medir el drift, o el monitor "corrige" la compensacion y
   * la deshace (con Bluetooth, resincronizaria cada pocos segundos).
   */
  private compensacionSec = 0
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
    const revision = proyecto.revision ?? 0
    if (this.proyectoId !== proyecto.id || this.revisionCargada !== revision) {
      this.detener()
      for (const p of this.pistas.values()) {
        for (const c of p.enVuelo.values()) c.abort()
        p.gainNode.disconnect()
      }
      this.pistas.clear()
      this.proyectoId = proyecto.id
      this.proyectoIdCargado = proyecto.id
      this.revisionCargada = revision

      // si era la cancion que se venia precargando, se aprovecha lo que ya bajo
      const pre = this.precarga?.proyectoId === proyecto.id && this.precarga.revision === revision ? this.precarga : null
      this.cancelarPrecarga()

      for (const pista of proyecto.pistas) {
        const gainNode = this.ctx.createGain()
        const pannerNode = this.ctx.createStereoPanner()
        gainNode.connect(pannerNode)
        pannerNode.connect(this.masterGain)
        const previa = pre?.pistas.get(pista.id)
        const aprovechable = previa && previa.archivo === pista.archivo && !previa.error ? previa : null
        this.pistas.set(pista.id, {
          pistaId: pista.id,
          nombre: pista.nombre,
          archivo: pista.archivo,
          gainNode,
          pannerNode,
          wavInfo: aprovechable?.wavInfo ?? null,
          wavInfoPromise: null,
          // lo precargado entra directo a la ventana (prepararEn descarta lo que no sirva) y, si es un cue, queda como cue
          segmentos: new Map(aprovechable?.segmentos ?? []),
          cueSegmentos: new Map(aprovechable?.segmentos ?? []),
          enVuelo: new Map(),
          fuentesActivas: [],
          cursorCtxTime: null,
          finEnIndice: aprovechable?.finEnIndice ?? null,
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

  precargar(proyecto: Proyecto | null, posicionMs = 0): void {
    const revision = proyecto?.revision ?? 0
    if (!proyecto || proyecto.id === this.proyectoId) {
      this.cancelarPrecarga()
      return
    }
    const indiceInicio = Math.floor(Math.max(0, posicionMs) / 1000 / SEGMENT_DURATION_SEC)
    const pre = this.precarga
    if (pre?.proyectoId === proyecto.id && pre.revision === revision && pre.indiceInicio === indiceInicio) return
    this.cancelarPrecarga()
    this.precarga = {
      proyectoId: proyecto.id,
      revision,
      indiceInicio,
      pistas: new Map(
        proyecto.pistas.map((p) => [p.id, { archivo: p.archivo, wavInfo: null, segmentos: new Map(), finEnIndice: null, error: false }])
      ),
      enVuelo: new Map(),
      fallosSeguidos: 0,
      esperarHasta: 0
    }
  }

  private cancelarPrecarga(): void {
    if (!this.precarga) return
    for (const c of this.precarga.enVuelo.values()) c.abort()
    this.precarga = null
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
    const compensacionSec = this.latenciaDeSalidaSec() + this.ajusteManualMs / 1000
    delaySec -= compensacionSec
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
    this.compensacionSec = compensacionSec
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

  /**
   * Posicion que se ESCUCHA ahora (la del nodo menos la compensacion de latencia/ajuste con la que se
   * programo). Durante una correccion suave el ancla ya quedo movida al valor final: se le suma lo que
   * todavia falta absorber, para no informar como corregido un desfase que se esta corrigiendo.
   */
  posicionRealMs(): number | null {
    if (this.audioAnchorCtxTime === null) return null
    const now = this.ctx.currentTime
    if (now < this.audioAnchorCtxTime + this.compensacionSec) return null
    let pendienteSec = 0
    const c = this.correccionActual
    if (c && now < this.correccionActivaHastaCtxTime) pendienteSec = c.driftSec * (1 - fraccionCorregida(c, now - c.now))
    return (this.audioAnchorOffsetSec + (now - this.audioAnchorCtxTime) - this.compensacionSec + pendienteSec) * 1000
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
    const correccion: CorreccionActiva = { now, rateObjetivo, duracionSec, rampIn, driftSec }

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

  /** Estado interno para diagnostico (window.__mt con ?debug). */
  diagnostico(): Record<string, unknown> {
    return {
      reproduciendo: this.reproduciendo,
      esperando: this.esperando,
      buffer: this.estadoBuffer(),
      encadenadoPorDelante: this.segundosYaEncadenadosPorDelante(),
      disponibles: this.segundosDisponiblesDesde(this.indiceSiguienteAEncadenar),
      indice: this.indiceSiguienteAEncadenar,
      posicionRealMs: this.posicionRealMs(),
      outputLatency: this.ctx.outputLatency,
      baseLatency: this.ctx.baseLatency,
      pistas: [...this.pistas.values()].map((p) => ({ n: p.nombre, seg: [...p.segmentos.keys()], cues: p.cueSegmentos.size, vuelo: p.enVuelo.size, err: p.error })),
      precarga: this.precarga
        ? { proyectoId: this.precarga.proyectoId, pistas: [...this.precarga.pistas.values()].map((p) => (p.error ? -1 : p.segmentos.size)) }
        : null
    }
  }

  errorAudio(): string | null {
    for (const p of this.pistas.values()) if (p.error) return `${p.nombre}: ${p.error}`
    return null
  }

  dispose(): void {
    clearInterval(this.intervalo)
    this.cancelarPrecarga()
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

  /**
   * Pide lo que falta, en orden de urgencia: primero el PROXIMO segmento de
   * todas las pistas, despues el siguiente de todas, etc. (el navegador solo
   * baja ~6 cosas a la vez por servidor: si se pidiera "3 de la pista 1, 3 de
   * la pista 2...", el proximo segundo de las ultimas pistas quedaria en cola
   * detras de audio que todavia no hace falta). Los cues van al final.
   */
  private lanzarFetchsPendientes(): void {
    if (this.pistas.size === 0) return
    const ahora = Date.now()
    const cantidad = this.reproduciendo
      ? this.cantidadIndicesVentana()
      : Math.ceil(BUFFER_MIN_START_SEC / SEGMENT_DURATION_SEC) + 1
    const pistas = [...this.pistas.values()].filter((p) => !p.error && ahora >= p.esperarHasta)
    const maxGlobal = Math.max(MAX_FETCHES_GLOBAL, this.pistas.size)
    let enVueloTotal = 0
    for (const p of this.pistas.values()) enVueloTotal += p.enVuelo.size

    let ventanaCompleta = true
    for (let i = 0; i < cantidad; i++) {
      const indice = this.indiceSiguienteAEncadenar + i
      for (const pista of pistas) {
        if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
        if (pista.segmentos.has(indice)) continue
        ventanaCompleta = false
        if (pista.enVuelo.has(indice)) continue
        // hasta tener el encabezado del WAV, un solo pedido por pista (los demas dependen de el)
        if (!pista.wavInfo && pista.enVuelo.size > 0) continue
        if (pista.enVuelo.size >= MAX_FETCHES_POR_PISTA || enVueloTotal >= maxGlobal) continue
        this.pedirSegmento(pista, indice)
        enVueloTotal++
      }
    }

    // cues: solo con la ventana cubierta y sin nada en vuelo, de a uno, para no competir con lo que esta por sonar
    if (!ventanaCompleta || enVueloTotal > 0) return
    for (const indice of [...this.cueIndices].sort((a, b) => a - b)) {
      for (const pista of pistas) {
        if (pista.finEnIndice !== null && indice >= pista.finEnIndice) continue
        if (pista.cueSegmentos.has(indice) || pista.enVuelo.has(indice)) continue
        const enVentana = pista.segmentos.get(indice)
        if (enVentana) {
          pista.cueSegmentos.set(indice, enVentana)
          continue
        }
        this.pedirSegmento(pista, indice)
        if (++enVueloTotal >= this.pistas.size) return
      }
    }
    // lo ultimo: el principio de la proxima cancion (con la actual y sus cues ya asegurados)
    if (enVueloTotal === 0) this.lanzarPrecarga()
  }

  /** Baja el principio de la proxima cancion, pocos pedidos a la vez (menos todavia si algo suena). */
  private lanzarPrecarga(): void {
    const pre = this.precarga
    if (!pre || Date.now() < pre.esperarHasta) return
    const maxEnVuelo = this.reproduciendo ? 1 : 3
    for (let indice = pre.indiceInicio; indice < pre.indiceInicio + SEGMENTOS_PRECARGA_SIGUIENTE; indice++) {
      for (const [pistaId, p] of pre.pistas) {
        if (pre.enVuelo.size >= maxEnVuelo) return
        if (p.error || p.segmentos.has(indice) || (p.finEnIndice !== null && indice >= p.finEnIndice)) continue
        const clave = `${pistaId}:${indice}`
        if (pre.enVuelo.has(clave)) continue
        // hasta tener el encabezado, un solo pedido por pista
        if (!p.wavInfo && [...pre.enVuelo.keys()].some((k) => k.startsWith(`${pistaId}:`))) continue
        this.pedirPrecarga(pre, p, indice, clave)
      }
    }
  }

  private pedirPrecarga(pre: Precarga, p: PistaPrecargada, indice: number, clave: string): void {
    const ctrl = new AbortController()
    pre.enVuelo.set(clave, ctrl)
    const url = `/media/${pre.proyectoId}/${p.archivo}?v=${pre.revision}`
    void (async () => {
      if (!p.wavInfo) {
        const bytes = await this.fetchRango(url, 0, WAV_HEADER_FETCH_BYTES - 1, ctrl.signal)
        const info = parseWavHeader(bytes)
        if (![8, 16, 24, 32].includes(info.bitsPerSample)) throw new ErrorFatal('formato de audio no soportado')
        p.wavInfo = info
      }
      const r = await this.bajarSegmento(url, p.wavInfo, indice, ctrl.signal)
      if (r.buffer) p.segmentos.set(indice, r.buffer)
      if (r.finEnIndice !== null) p.finEnIndice = p.finEnIndice === null ? r.finEnIndice : Math.min(p.finEnIndice, r.finEnIndice)
    })()
      .then(() => {
        pre.fallosSeguidos = 0
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        if (err instanceof ErrorFatal || err instanceof WavHeaderError) p.error = true
        else {
          pre.fallosSeguidos++
          pre.esperarHasta = Date.now() + Math.min(8000, 500 * 2 ** (pre.fallosSeguidos - 1))
        }
      })
      .finally(() => {
        if (pre.enVuelo.get(clave) === ctrl) pre.enVuelo.delete(clave)
      })
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
          if (!pista.error) console.warn('[StreamingEngine] pista con error', pista.nombre, err.message)
          pista.error = err.message
          pista.finEnIndice = 0 // la pista queda muda; las demas siguen sonando
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
    const r = await this.bajarSegmento(this.urlDe(pista), info, indice, signal)
    if (r.finEnIndice !== null) this.marcarFin(pista, r.finEnIndice)
    return r.buffer
  }

  /**
   * Pide por HTTP Range el segmento `indice` de un WAV y lo decodifica.
   * `finEnIndice`: primer indice sin audio, si con este se llego al final.
   */
  private async bajarSegmento(
    url: string,
    info: WavInfo,
    indice: number,
    signal: AbortSignal
  ): Promise<{ buffer: AudioBuffer | null; finEnIndice: number | null }> {
    const bpf = bytesPorFrame(info)
    const framesTotales = totalFrames(info)
    const frameOffset = Math.round(indice * SEGMENT_DURATION_SEC * info.sampleRate)
    if (frameOffset >= framesTotales) return { buffer: null, finEnIndice: indice }
    const frameCountPedido = Math.min(Math.round(SEGMENT_DURATION_SEC * info.sampleRate), framesTotales - frameOffset)
    const byteStart = info.dataOffset + frameOffset * bpf
    const byteEnd = byteStart + frameCountPedido * bpf - 1

    const bytes = await this.fetchRango(url, byteStart, byteEnd, signal)
    const frameCountReal = Math.floor(bytes.byteLength / bpf)
    if (frameCountReal <= 0) return { buffer: null, finEnIndice: indice }
    const canales = decodePcmSegment(info, bytes)
    const buffer = this.ctx.createBuffer(info.numChannels, frameCountReal, info.sampleRate)
    for (let ch = 0; ch < info.numChannels; ch++) buffer.copyToChannel(canales[ch], ch)
    return { buffer, finEnIndice: frameOffset + frameCountReal >= framesTotales ? indice + 1 : null }
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

  /** `?v=`: si el zip se actualizo, el archivo cambia con el mismo nombre (que no sirva el cache viejo). */
  private urlDe(pista: PistaStream): string {
    return `/media/${this.proyectoId}/${pista.archivo}?v=${this.revisionCargada}`
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
