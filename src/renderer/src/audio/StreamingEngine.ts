import type { ComandoProgramado, DiagnosticoAudio, EstadoBuffer, Pista, Proyecto } from '@shared/types'
import { WAV_HEADER_FETCH_BYTES, WavHeaderError, bytesPorFrame, decodePcmSegment, parseWavHeader, totalFrames, type WavInfo } from '@shared/wav'
import { posicionActualMs } from '@shared/playback'
import { codificarMezcla, mezclaEfectiva } from '@shared/mezcla'
import type { MezclaPersonal, PlaybackEngine } from './PlaybackEngine'
import {
  BUFFER_CRITICAL_SEC,
  BUFFER_MIN_START_SEC,
  BUFFER_TARGET_SEC,
  FUNDIDO_MEZCLA_SEC,
  HORIZONTE_PROGRAMADO_SEC,
  INTERVALO_CAMBIO_MEZCLA_MS,
  MAX_CUES,
  MAX_FETCHES_GLOBAL,
  MAX_FETCHES_POR_PISTA,
  SEGMENT_DURATION_SEC,
  SEGMENTOS_POR_CUE,
  SEGMENTOS_PRECARGA_SIGUIENTE,
  VOLUMEN_MAX
} from './streamConfig'

/**
 * 'mezcla': el celular pide UNA pista estereo ya mezclada por la compu (con su
 * "Mi mezcla"): ~1,4 Mbps en vez de 20+. 'pistas': baja cada pista y mezcla
 * aca (la compu, que las lee de su propio disco y quiere los faders al instante).
 */
export type ModoMotor = 'mezcla' | 'pistas'

/** Un segmento bajado. `clave` = con que mezcla se hizo (modo mezcla; '' en pistas). */
interface Segmento {
  buffer: AudioBuffer
  clave: string
}

/** Una fuente de audio: una pista (modo pistas) o la mezcla de la compu (modo mezcla). */
interface Canal {
  id: string
  nombre: string
  /** archivo de la pista en /media (modo pistas) */
  archivo: string | null
  gainNode: GainNode
  pannerNode: StereoPannerNode | null
  wavInfo: WavInfo | null
  wavInfoPromise: Promise<WavInfo> | null
  /** Ventana deslizante alrededor de lo que suena: nunca contiene la cancion entera. */
  segmentos: Map<number, Segmento>
  /** Arranque de cada marcador (cues), para saltos/loops sin esperar la red. */
  cueSegmentos: Map<number, Segmento>
  enVuelo: Map<number, { ctrl: AbortController; clave: string }>
  /** Primer indice que ya no existe (fin de la pista). null = todavia no se supo. */
  finEnIndice: number | null
  /** error irrecuperable (archivo que falta, formato ilegible): la pista queda muda, las demas siguen */
  error: string | null
  fallosSeguidos: number
  /** Date.now() hasta el que no se reintenta (backoff ante errores de red) */
  esperarHasta: number
}

/**
 * Un tramo programado en Web Audio: desde `inicioCtx` suena el contenido
 * `posInicio`..`posInicio + contenido` (seg de la cancion), a velocidad 1 o
 * con una correccion suave (rampa-meseta-rampa hasta `rate`). La posicion que
 * suena en cada instante sale de aca, exacta: es lo que se programo.
 */
interface Tramo {
  indice: number
  inicioCtx: number
  duracionCtx: number
  posInicio: number
  contenido: number
  rate: number
  rampa: number
  /** cuanto se corrio respecto del reloj (seg, duracionCtx - contenido) */
  absorbido: number
  clave: string
  fuentes: { canal: Canal; source: AudioBufferSourceNode; gain: GainNode | null }[]
}

/** Lo ya bajado de un canal de la proxima cancion. */
interface CanalPrecargado {
  archivo: string | null
  wavInfo: WavInfo | null
  segmentos: Map<number, Segmento>
  finEnIndice: number | null
  error: boolean
}

/** Principio ya bajado de la proxima cancion. */
interface Precarga {
  proyectoId: string
  revision: number
  /** primer segmento a bajar (la cancion arranca donde se la dejo) */
  indiceInicio: number
  clave: string
  canales: Map<string, CanalPrecargado>
  /** "canal:indice" -> pedido en vuelo */
  enVuelo: Map<string, AbortController>
  fallosSeguidos: number
  esperarHasta: number
}

const INTERVALO_TICK_MS = 250
/**
 * El limitador (DynamicsCompressorNode) mira 6 ms hacia adelante: todo sale
 * 6 ms despues de pasar por el. Es igual en todos los navegadores (el mismo
 * codigo de base) y se descuenta al programar, asi el sync no se corre.
 */
const DEMORA_LIMITADOR_SEC = 0.006

/** 0,4%: correccion de drift inaudible */
const MAX_RATE_DEV = 0.004
const RAMPA_CORRECCION_SEC = 0.15
const HISTORIA_SEC = 3
const VENTANA_DIAG_MS = 20000
const ID_MEZCLA = 'mezcla'

class ErrorFatal extends Error {}

/** Contenido (seg) consumido `t` segundos despues de empezar un tramo. */
function contenidoHasta(tr: Tramo, t: number): number {
  if (t <= 0) return 0
  if (t >= tr.duracionCtx) return tr.contenido
  if (tr.rate === 1) return t
  const d = tr.duracionCtx
  const q = tr.rampa
  const dr = tr.rate - 1
  if (t < q) return t + (dr * t * t) / (2 * q)
  if (t <= d - q) return t + dr * (t - q / 2)
  const resto = d - t
  return tr.contenido - (resto + (dr * resto * resto) / (2 * q))
}

/**
 * Motor de audio por streaming (celulares Y compu): buffer deslizante por
 * segmentos de 2 s pedidos al servidor (ver README "Streaming progresivo").
 * Nunca descarga ni decodifica la cancion entera.
 *
 * Encadenado gapless: cada segmento es un `AudioBufferSourceNode` de un solo
 * uso, programado en el instante exacto en que termina el anterior (aritmetica
 * de muestras, nunca temporizadores). Se programa poco por delante
 * (`HORIZONTE_PROGRAMADO_SEC`); lo demas espera bajado en memoria.
 *
 * Correccion fina de sync: un tramo entero a otra velocidad (0,4%, inaudible)
 * con su duracion calculada: el siguiente arranca donde de verdad termina, asi
 * la correccion no se deshace en el borde del segmento.
 *
 * Garantia dura: jamas se programa un segmento que todavia no llego. Si se
 * agota el buffer, se espera a juntar `BUFFER_MIN_START_SEC` y se pide un
 * reingreso a sync fresco por `onRequiereResync`.
 */
export class StreamingEngine implements PlaybackEngine {
  private ctx: AudioContext
  private masterGain: GainNode
  private canales = new Map<string, Canal>()
  /** la cancion activa, tal como la mezcla la compu */
  private ultimoProyecto: Proyecto | null = null
  private mezclaPersonal: MezclaPersonal = {}
  /** mezcla con la que se piden los segmentos (modo mezcla) */
  private claveMezcla = ''
  private claveDeseada = ''
  private ultimoCambioMezcla = 0
  private timerMezcla: ReturnType<typeof setTimeout> | null = null

  proyectoIdCargado: string | null = null
  revisionCargada = 0
  private proyectoId: string | null = null
  private precarga: Precarga | null = null
  /** la cancion que se esta precargando (para rehacerla si cambia "Mi mezcla") */
  private ultimaPrecarga: Proyecto | null = null
  private ajusteManualMs = 0

  private reproduciendo = false
  private esperando = false
  private tramos: Tramo[] = []
  /** lo proximo a encadenar (null = nada, o sin reproducir) */
  private siguiente: { indice: number; posInicio: number; inicioCtx: number } | null = null
  /** en reposo: desde donde tener el buffer listo */
  private indiceReposo = 0
  /** el proximo tramo que se programe entra con fundido (paso a la mezcla nueva) */
  private fundirEntradaEn: number | null = null
  /** correccion de sync que falta aplicar (seg; + = iba adelantado) */
  private correccionPendiente = 0
  /**
   * Cuando arranca (tiempo del AudioContext) la ultima corrida programada
   * (play, salto, reingreso). Mientras no empezo, lo que suena es la corrida
   * anterior: no se mide ni se corrige, y no se rehace nada (se perderia el salto).
   */
  private inicioCorridaCtx = 0
  private cueIndices = new Set<number>()

  private onResyncCb: (() => void) | null = null
  /** diagnostico: en el ultimo salto sonando, cuanto se corrio el corte para empalmar parejo (null = no aplico) */
  private ultimoEmpalmeMs: number | null = null
  private diag = {
    cortes: 0,
    /** veces que se paso a una mezcla nueva mientras sonaba */
    cambiosMezcla: 0,
    correcciones: 0,
    errores: 0,
    activos: 0,
    ocupadoDesde: 0,
    /** pedidos terminados: [fin (ms), bytes, duracion (ms)] */
    recibidos: [] as [number, number, number][],
    /** intervalos con algun pedido en curso: [desde, hasta] (ms) */
    ocupado: [] as [number, number][]
  }
  private intervalo: ReturnType<typeof setInterval>

  constructor(readonly modo: ModoMotor = 'pistas') {
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    // limitador al final: con el volumen por encima de 100 % (o muchas pistas juntas) no satura ni distorsiona
    const limitador = this.ctx.createDynamicsCompressor()
    limitador.threshold.value = -1.5
    limitador.knee.value = 0
    limitador.ratio.value = 20
    limitador.attack.value = 0.003
    limitador.release.value = 0.15
    this.masterGain.connect(limitador)
    limitador.connect(this.ctx.destination)
    this.intervalo = setInterval(() => this.tick(), INTERVALO_TICK_MS)
  }

  async resumeSiHaceFalta(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  /** 0-200: hasta 100 la curva de siempre (cuadratica); de 100 a 200, de 0 a +6 dB. */
  setVolumenGeneral(volumen: number): void {
    const v = clamp(volumen, 0, VOLUMEN_MAX)
    const g = v <= 100 ? (v / 100) ** 2 : 10 ** ((((v - 100) / 100) * 6) / 20)
    this.masterGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02)
  }

  setAjusteManualMs(ms: number): void {
    this.ajusteManualMs = ms
  }

  setMezclaPersonal(mezcla: MezclaPersonal): void {
    this.mezclaPersonal = mezcla
    if (this.ultimoProyecto) this.aplicarMezcla(this.ultimoProyecto)
    if (this.modo === 'mezcla' && this.precarga) this.reiniciarPrecarga()
  }

  onRequiereResync(cb: () => void): void {
    this.onResyncCb = cb
  }

  /** Ganancia y paneo de cada pista en ESTE dispositivo (director + "Mi mezcla" + click y guia a un lado). */
  private mezclaDe(proyecto: Proyecto) {
    return mezclaEfectiva(proyecto.pistas, this.mezclaPersonal)
  }

  private claveDe(proyecto: Proyecto): string {
    return this.modo === 'mezcla' ? codificarMezcla(this.mezclaDe(proyecto)) : ''
  }

  private crearCanal(id: string, nombre: string, archivo: string | null): Canal {
    const gainNode = this.ctx.createGain()
    let pannerNode: StereoPannerNode | null = null
    if (this.modo === 'pistas') {
      pannerNode = this.ctx.createStereoPanner()
      gainNode.connect(pannerNode)
      pannerNode.connect(this.masterGain)
    } else {
      gainNode.connect(this.masterGain)
    }
    return {
      id,
      nombre,
      archivo,
      gainNode,
      pannerNode,
      wavInfo: null,
      wavInfoPromise: null,
      segmentos: new Map(),
      cueSegmentos: new Map(),
      enVuelo: new Map(),
      finEnIndice: null,
      error: null,
      fallosSeguidos: 0,
      esperarHasta: 0
    }
  }

  activarProyecto(proyecto: Proyecto, posicionMs: number): void {
    const revision = proyecto.revision ?? 0
    if (this.proyectoId !== proyecto.id || this.revisionCargada !== revision) {
      this.detener()
      for (const c of this.canales.values()) {
        for (const v of c.enVuelo.values()) v.ctrl.abort()
        c.gainNode.disconnect()
        c.pannerNode?.disconnect()
      }
      this.canales.clear()
      this.proyectoId = proyecto.id
      this.proyectoIdCargado = proyecto.id
      this.revisionCargada = revision

      // si era la cancion que se venia precargando, se aprovecha lo que ya bajo
      const pre = this.precarga?.proyectoId === proyecto.id && this.precarga.revision === revision ? this.precarga : null
      this.cancelarPrecarga()

      const fuentes = this.modo === 'mezcla' ? [{ id: ID_MEZCLA, nombre: 'Mezcla', archivo: null as string | null }] : proyecto.pistas.map((p) => ({ id: p.id, nombre: p.nombre, archivo: p.archivo as string | null }))
      for (const f of fuentes) {
        const canal = this.crearCanal(f.id, f.nombre, f.archivo)
        const previa = pre?.canales.get(f.id)
        if (previa && previa.archivo === f.archivo && !previa.error) {
          // lo precargado entra directo a la ventana y, si es un cue, queda como cue (moverVentana descarta lo que no sirva)
          canal.wavInfo = previa.wavInfo
          canal.finEnIndice = previa.finEnIndice
          for (const [i, s] of previa.segmentos) {
            canal.segmentos.set(i, s)
            canal.cueSegmentos.set(i, s)
          }
        }
        this.canales.set(f.id, canal)
      }
      this.claveMezcla = this.claveDeseada = this.claveDe(proyecto)
    }
    this.aplicarMezcla(proyecto)
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
    const clave = this.claveDe(proyecto)
    const pre = this.precarga
    if (pre?.proyectoId === proyecto.id && pre.revision === revision && pre.indiceInicio === indiceInicio && pre.clave === clave) return
    this.cancelarPrecarga()
    const fuentes = this.modo === 'mezcla' ? [{ id: ID_MEZCLA, archivo: null as string | null }] : proyecto.pistas.map((p) => ({ id: p.id, archivo: p.archivo as string | null }))
    this.precarga = {
      proyectoId: proyecto.id,
      revision,
      indiceInicio,
      clave,
      canales: new Map(fuentes.map((f) => [f.id, { archivo: f.archivo, wavInfo: null, segmentos: new Map(), finEnIndice: null, error: false }])),
      enVuelo: new Map(),
      fallosSeguidos: 0,
      esperarHasta: 0
    }
    this.ultimaPrecarga = proyecto
  }

  private reiniciarPrecarga(): void {
    const pre = this.precarga
    const p = this.ultimaPrecarga
    if (!pre || !p || p.id !== pre.proyectoId) return
    this.precargar(p, pre.indiceInicio * SEGMENT_DURATION_SEC * 1000)
  }

  private cancelarPrecarga(): void {
    if (!this.precarga) return
    for (const c of this.precarga.enVuelo.values()) c.abort()
    this.precarga = null
  }

  aplicarMezcla(proyecto: Proyecto): void {
    if (proyecto.id !== this.proyectoId) return
    this.ultimoProyecto = proyecto
    if (this.modo === 'mezcla') {
      this.pedirCambioDeMezcla(this.claveDe(proyecto))
      return
    }
    // pistas sueltas: la misma cuenta que hace la compu para los celulares (curva de fader, mute/solo, "Mi mezcla")
    const mezcla = new Map(this.mezclaDe(proyecto).map((c) => [c.pistaId, c]))
    const t = this.ctx.currentTime
    for (const pista of proyecto.pistas) {
      const canal = this.canales.get(pista.id)
      if (!canal) continue
      canal.nombre = pista.nombre
      const c = mezcla.get(pista.id)
      // rampa corta: sin "clicks" al mover un fader o mutear
      canal.gainNode.gain.setTargetAtTime(c?.ganancia ?? 0, t, 0.015)
      canal.pannerNode?.pan.setTargetAtTime(c?.pan ?? clamp(pista.pan, -100, 100) / 100, t, 0.015)
    }
  }

  /**
   * Modo mezcla: la mezcla nueva se pide a la compu y se pasa a ella apenas
   * llega, con un fundido corto (mientras tanto sigue sonando la anterior:
   * nunca hay silencio). Mientras se arrastra un fader, como mucho cada 300 ms.
   */
  private pedirCambioDeMezcla(clave: string): void {
    this.claveDeseada = clave
    if (clave === this.claveMezcla) return
    if (this.timerMezcla) return
    const espera = this.ultimoCambioMezcla + INTERVALO_CAMBIO_MEZCLA_MS - Date.now()
    if (espera > 0) {
      this.timerMezcla = setTimeout(() => {
        this.timerMezcla = null
        this.aplicarCambioDeMezcla()
      }, espera)
      return
    }
    this.aplicarCambioDeMezcla()
  }

  private aplicarCambioDeMezcla(): void {
    if (this.claveDeseada === this.claveMezcla) return
    this.ultimoCambioMezcla = Date.now()
    this.claveMezcla = this.claveDeseada
    // lo que se estaba bajando con la mezcla anterior ya no sirve (lo ya bajado si: suena hasta que llegue lo nuevo)
    for (const c of this.canales.values()) {
      for (const [i, v] of c.enVuelo) {
        if (v.clave !== this.claveMezcla) {
          v.ctrl.abort()
          c.enVuelo.delete(i)
        }
      }
    }
    this.tick()
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
    for (const canal of this.canales.values()) {
      for (const i of [...canal.cueSegmentos.keys()]) if (!indices.has(i)) canal.cueSegmentos.delete(i)
    }
  }

  /**
   * Ejecuta un comando programado por el servidor. 'play' cubre arranque,
   * resume, seek, salto de marcador y "repetir seccion": siempre se
   * interpreta como "sonar desde `positionMs` en el instante
   * `executeAtServerTime`".
   */
  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void {
    if (this.canales.size === 0) return

    if (cmd.accion === 'seek') {
      // solo se emite sin audio sonando: preparar el buffer donde va a arrancar
      if (!this.reproduciendo) this.prepararEn(cmd.positionMs)
      return
    }

    const clienteObjetivoMs = cmd.executeAtServerTime - clockOffsetMs
    let offsetMs = cmd.positionMs

    // el instante del AudioContext que se va a ESCUCHAR a la hora pedida (reloj de salida del
    // parlante, menos el ajuste fino manual): ahi arranca el audio
    let targetTime = this.ctxEscuchadoAhora() + (clienteObjetivoMs - Date.now()) / 1000
    // nunca en el pasado ni "ya mismo" (si llego tarde, arranca enseguida saltando lo que se perdio):
    // se programa un instante despues, en la posicion que corresponde a ese instante
    const minimo = this.ctx.currentTime + 0.02
    if (targetTime < minimo) {
      offsetMs += (minimo - targetTime) * 1000
      targetTime = minimo
    }

    if (cmd.accion === 'pause' || cmd.accion === 'stop') {
      this.cortarDesde(targetTime)
      this.reproduciendo = false
      this.esperando = false
      this.siguiente = null
      this.correccionPendiente = 0
      this.prepararEn(cmd.accion === 'stop' ? 0 : cmd.positionMs)
      return
    }

    // 'play': siempre reprograma desde cero en la nueva posicion
    const empalme = this.empalmeContinuo(cmd, targetTime)
    this.ultimoEmpalmeMs = empalme === null ? null : Math.round((empalme - targetTime) * 10000) / 10
    const inicio = empalme ?? targetTime
    this.cortarDesde(inicio)
    const posicion = offsetMs / 1000
    const indice = Math.floor(posicion / SEGMENT_DURATION_SEC)
    this.siguiente = { indice, posInicio: posicion, inicioCtx: inicio }
    this.moverVentana(indice)
    this.inicioCorridaCtx = inicio
    this.correccionPendiente = 0 // arranque fresco: en la posicion exacta que dice el servidor
    this.reproduciendo = true
    this.esperando = !this.listoParaArrancar(indice)
    this.tick()
  }

  /**
   * Salto con la musica sonando (fin de seccion, compas, vuelta del "repetir"):
   * el corte se hace en la linea de tiempo del audio que ESTE celular esta
   * tocando, en el instante exacto en que llega al punto de corte. Si el
   * celular iba unos ms corrido, el pulso igual queda parejo en el salto; el
   * corrimiento lo sigue corrigiendo el monitor de drift, como siempre.
   * null = no aplica (no sonaba, esperaba buffer, o el tramo no coincide).
   */
  private empalmeContinuo(cmd: ComandoProgramado, targetTime: number): number | null {
    if (!this.reproduciendo || this.esperando || this.tramos.length === 0) return null
    const previo = cmd.playback.previo
    if (!previo || previo.estado !== 'playing') return null
    const posCorteSeg = posicionActualMs(previo, cmd.executeAtServerTime) / 1000
    const t = this.tiempoNodoParaPos(posCorteSeg)
    if (t === null || Math.abs(t - targetTime) > 0.06 || t < this.ctx.currentTime + 0.01) return null
    return t
  }

  detener(): void {
    this.cortarDesde(this.ctx.currentTime)
    this.reproduciendo = false
    this.esperando = false
    this.siguiente = null
    this.correccionPendiente = 0
  }

  /** Posicion (seg de la cancion) que toca el nodo de audio en el instante `t` del AudioContext. */
  posicionNodoEn(t: number): number | null {
    if (!this.reproduciendo) return null
    for (const tr of this.tramos) {
      if (t >= tr.inicioCtx && t < tr.inicioCtx + tr.duracionCtx) return tr.posInicio + contenidoHasta(tr, t - tr.inicioCtx)
    }
    const ultimo = this.tramos[this.tramos.length - 1]
    if (!ultimo || this.esperando) return null
    const fin = ultimo.inicioCtx + ultimo.duracionCtx
    // lo que viene todavia no esta programado, pero sigue a velocidad 1 desde donde termina lo programado
    if (t >= fin && this.siguiente && Math.abs(this.siguiente.inicioCtx - fin) < 1e-6) return ultimo.posInicio + ultimo.contenido + (t - fin)
    return null
  }

  /** Instante (tiempo del AudioContext) en que el nodo llega a la posicion `pos` (seg). */
  private tiempoNodoParaPos(pos: number): number | null {
    for (const tr of this.tramos) {
      if (pos < tr.posInicio || pos >= tr.posInicio + tr.contenido) continue
      const objetivo = pos - tr.posInicio
      if (tr.rate === 1) return tr.inicioCtx + objetivo
      let a = 0
      let b = tr.duracionCtx
      for (let k = 0; k < 40; k++) {
        const m = (a + b) / 2
        if (contenidoHasta(tr, m) < objetivo) a = m
        else b = m
      }
      return tr.inicioCtx + (a + b) / 2
    }
    const ultimo = this.tramos[this.tramos.length - 1]
    if (!ultimo || this.esperando) return null
    const fin = ultimo.inicioCtx + ultimo.duracionCtx
    const posFin = ultimo.posInicio + ultimo.contenido
    if (pos >= posFin && this.siguiente && Math.abs(this.siguiente.inicioCtx - fin) < 1e-6) return fin + (pos - posFin)
    return null
  }

  /**
   * Posicion que se ESCUCHA ahora: la del instante que esta saliendo por el
   * parlante (el nodo va por delante). Sale de los tramos programados: es la
   * posicion real, tambien durante una correccion.
   */
  posicionRealMs(): number | null {
    const p = this.posicionNodoEn(this.ctxEscuchadoAhora())
    return p === null ? null : p * 1000
  }

  /**
   * Instante del AudioContext que esta saliendo por el parlante AHORA, segun
   * el propio navegador (getOutputTimestamp: a que hora sale cada muestra).
   * Es mucho mas fino que currentTime, que se actualiza "a saltos" (10-40 ms
   * en celulares): con eso cada play arrancaba corrido distinto (hasta 40 ms)
   * y el monitor lo media con el mismo error. null = el navegador no lo da (o
   * da algo sin sentido): se usa currentTime menos la latencia, como antes.
   */
  private ctxSaliendoAhora(): number | null {
    if (typeof this.ctx.getOutputTimestamp !== 'function' || this.ctx.state !== 'running') return null
    const ts = this.ctx.getOutputTimestamp()
    const c = ts.contextTime ?? 0
    const p = ts.performanceTime ?? 0
    if (!(c > 0) || !(p > 0)) return null
    const t = c + (performance.now() - p) / 1000
    // cordura: lo que sale va un poco por detras de lo que se esta programando (la latencia de salida)
    if (Math.abs(t - (this.ctx.currentTime - this.latenciaDeSalidaSec())) > 0.3) return null
    return t
  }

  /** true si este navegador da la hora exacta de salida (sync mas fino: se corrige desde menos ms). */
  relojPreciso(): boolean {
    return this.ctxSaliendoAhora() !== null
  }

  /**
   * Instante del AudioContext (de lo programado) que se ESCUCHA ahora: el que
   * sale por el parlante, menos la demora del limitador y el ajuste fino manual.
   */
  private ctxEscuchadoAhora(): number {
    const saliendo = this.ctxSaliendoAhora() ?? this.ctx.currentTime - this.latenciaDeSalidaSec()
    return saliendo - DEMORA_LIMITADOR_SEC - this.ajusteManualMs / 1000
  }

  /**
   * true mientras una correccion todavia no termino de escucharse, o mientras
   * falta que empiece la ultima corrida (salto, reingreso): en esos momentos
   * no se mide ni se corrige.
   */
  enCorreccionSuave(): boolean {
    if (this.correccionPendiente !== 0) return true
    const escuchado = this.ctxEscuchadoAhora()
    if (this.reproduciendo && this.inicioCorridaCtx > escuchado) return true
    return this.tramos.some((tr) => tr.absorbido !== 0 && tr.inicioCtx + tr.duracionCtx > escuchado)
  }

  /**
   * Corrige un drift chico sin cortes: los proximos tramos suenan levemente
   * mas lentos o rapidos (0,4%, inaudible) hasta absorberlo. Lo ya programado
   * y todavia no empezado se reprograma para que arranque ya.
   */
  corregirDriftSuave(driftMs: number): void {
    if (!this.reproduciendo || this.esperando || this.tramos.length === 0 || this.enCorreccionSuave()) return
    this.correccionPendiente = driftMs / 1000
    this.diag.correcciones++
    this.reprogramarDesde(this.ctx.currentTime + 0.05)
    this.tick()
  }

  estadoBuffer(): EstadoBuffer | null {
    if (!this.reproduciendo) return null
    if (this.esperando) return 'critico'
    const porDelante = this.colchonSec()
    if (porDelante >= Math.min(this.bufferObjetivo() * 0.6, 6)) return 'normal'
    if (porDelante >= BUFFER_CRITICAL_SEC) return 'rellenando'
    return 'critico'
  }

  private bufferObjetivo(): number {
    return BUFFER_TARGET_SEC[this.modo]
  }

  /** Segundos de audio listos por delante de lo que suena (programado + bajado). */
  private colchonSec(): number {
    const ahora = this.ctx.currentTime
    const programado = this.siguiente ? Math.max(0, this.siguiente.inicioCtx - ahora) : 0
    const desde = this.siguiente?.indice ?? this.indiceReposo
    return programado + this.segundosDisponiblesDesde(desde)
  }

  /** Estado interno para diagnostico (window.__mt con ?debug). */
  diagnostico(): Record<string, unknown> {
    return {
      modo: this.modo,
      reproduciendo: this.reproduciendo,
      esperando: this.esperando,
      buffer: this.estadoBuffer(),
      colchon: this.colchonSec(),
      indice: this.siguiente?.indice ?? this.indiceReposo,
      posicionRealMs: this.posicionRealMs(),
      ultimoEmpalmeMs: this.ultimoEmpalmeMs,
      cambiosMezcla: this.diag.cambiosMezcla,
      clave: this.claveMezcla,
      clavesProgramadas: this.tramos.map((t) => t.clave),
      tramos: this.tramos.map((t) => ({ i: t.indice, ini: t.inicioCtx, dur: t.duracionCtx, pos: t.posInicio, cont: t.contenido, rate: t.rate })),
      correccionPendiente: this.correccionPendiente,
      outputLatency: this.ctx.outputLatency,
      baseLatency: this.ctx.baseLatency,
      pistas: [...this.canales.values()].map((c) => ({ n: c.nombre, seg: [...c.segmentos.keys()], cues: c.cueSegmentos.size, vuelo: c.enVuelo.size, err: c.error })),
      precarga: this.precarga
        ? { proyectoId: this.precarga.proyectoId, pistas: [...this.precarga.canales.values()].map((p) => (p.error ? -1 : p.segmentos.size)) }
        : null,
      resumen: this.resumenDiagnostico()
    }
  }

  resumenDiagnostico(): DiagnosticoAudio {
    const ahora = Date.now()
    const desde = ahora - VENTANA_DIAG_MS
    const d = this.diag
    d.recibidos = d.recibidos.filter(([fin]) => fin >= desde)
    d.ocupado = d.ocupado.filter(([, hasta]) => hasta >= desde)
    let bytes = 0
    let durTotal = 0
    for (const [, b, dur] of d.recibidos) {
      bytes += b
      durTotal += dur
    }
    let ocupadoMs = 0
    for (const [a, b] of d.ocupado) ocupadoMs += b - Math.max(a, desde)
    if (d.activos > 0) ocupadoMs += ahora - Math.max(d.ocupadoDesde, desde)
    const inicioVentana = Math.min(...d.recibidos.map(([fin, , dur]) => fin - dur), ahora)
    const segundos = Math.max(1, (ahora - Math.max(desde, inicioVentana)) / 1000)
    return {
      modo: this.modo,
      mbpsNecesarios: redondear(this.bytesPorSegundoNecesarios() * 8e-6, 2),
      mbpsRecibidos: redondear((bytes * 8e-6) / segundos, 2),
      mbpsCapacidad: ocupadoMs > 200 ? redondear((bytes * 8e-6) / (ocupadoMs / 1000), 1) : null,
      colchonSeg: redondear(this.reproduciendo ? this.colchonSec() : this.segundosDisponiblesDesde(this.indiceReposo), 1),
      cortes: d.cortes,
      correcciones: d.correcciones,
      errores: d.errores,
      latenciaMs: d.recibidos.length ? Math.round(durTotal / d.recibidos.length) : null,
      memoriaMB: redondear(this.bytesEnMemoria() / 1e6, 1),
      salidaMs: Math.round((this.ctx.currentTime - (this.ctxSaliendoAhora() ?? this.ctx.currentTime - this.latenciaDeSalidaSec())) * 1000)
    }
  }

  private bytesPorSegundoNecesarios(): number {
    let total = 0
    for (const c of this.canales.values()) {
      if (c.error) continue
      const seg = c.segmentos.values().next().value as Segmento | undefined
      if (this.modo === 'mezcla') total += (seg?.buffer.sampleRate ?? 44100) * 2 * 2
      else if (c.wavInfo) total += c.wavInfo.sampleRate * bytesPorFrame(c.wavInfo)
    }
    return total
  }

  private bytesEnMemoria(): number {
    const vistos = new Set<AudioBuffer>()
    let total = 0
    for (const c of this.canales.values()) {
      for (const s of [...c.segmentos.values(), ...c.cueSegmentos.values()]) {
        if (vistos.has(s.buffer)) continue
        vistos.add(s.buffer)
        total += s.buffer.length * s.buffer.numberOfChannels * 4
      }
    }
    return total
  }

  errorAudio(): string | null {
    for (const c of this.canales.values()) if (c.error) return this.modo === 'mezcla' ? c.error : `${c.nombre}: ${c.error}`
    return null
  }

  dispose(): void {
    clearInterval(this.intervalo)
    if (this.timerMezcla) clearTimeout(this.timerMezcla)
    this.cancelarPrecarga()
    this.detener()
    for (const c of this.canales.values()) for (const v of c.enVuelo.values()) v.ctrl.abort()
    this.canales.clear()
    void this.ctx.close().catch(() => {})
  }

  // ---- ventana / prebuffer ----

  /** En reposo: deja listos los primeros segundos desde `posicionMs` para que el proximo play arranque al instante. */
  private prepararEn(posicionMs: number): void {
    const indice = Math.floor(Math.max(0, posicionMs) / 1000 / SEGMENT_DURATION_SEC)
    this.indiceReposo = indice
    this.moverVentana(indice)
    this.lanzarFetchsPendientes()
  }

  /**
   * Reubica la ventana en `indiceBase`: descarta lo que queda fuera (y cancela
   * los pedidos en vuelo que ya no sirven) y aprovecha lo que haya en los cues.
   */
  private moverVentana(indiceBase: number): void {
    const hasta = indiceBase + this.cantidadIndicesVentana() + 1
    for (const canal of this.canales.values()) {
      for (const indice of [...canal.segmentos.keys()]) {
        if (indice < indiceBase || indice > hasta) canal.segmentos.delete(indice)
      }
      for (const [indice, v] of canal.enVuelo) {
        if ((indice < indiceBase || indice > hasta) && !this.cueIndices.has(indice)) {
          v.ctrl.abort()
          canal.enVuelo.delete(indice)
        }
      }
      for (let i = indiceBase; i <= hasta; i++) {
        const cue = canal.cueSegmentos.get(i)
        const actual = canal.segmentos.get(i)
        if (cue && (!actual || (actual.clave !== this.claveMezcla && cue.clave === this.claveMezcla))) canal.segmentos.set(i, cue)
      }
    }
  }

  private cantidadIndicesVentana(): number {
    return Math.ceil(this.bufferObjetivo() / SEGMENT_DURATION_SEC) + 1
  }

  /**
   * Primer indice que hace falta tener bajado: el proximo a encadenar. En modo
   * mezcla, si lo que suena se hizo con una mezcla vieja y sigue de corrido
   * hasta lo proximo (no hay un salto de por medio), desde lo que suena: asi
   * se puede pasar a la mezcla nueva sin esperar al proximo segmento.
   */
  private indiceBaseVentana(): number {
    if (!this.reproduciendo) return this.indiceReposo
    const s = this.siguiente
    if (!s) return this.indiceReposo
    if (this.modo !== 'mezcla') return s.indice
    const ahora = this.ctx.currentTime
    const i = this.tramos.findIndex((t) => t.inicioCtx + t.duracionCtx > ahora)
    if (i === -1 || this.tramos[i].clave === this.claveMezcla) return s.indice
    let pos = this.tramos[i].posInicio
    for (let k = i; k < this.tramos.length; k++) {
      if (Math.abs(this.tramos[k].posInicio - pos) > 0.001) return s.indice
      pos = this.tramos[k].posInicio + this.tramos[k].contenido
    }
    return Math.abs(s.posInicio - pos) <= 0.001 ? this.tramos[i].indice : s.indice
  }

  // ---- programacion ----

  private tick(): void {
    if (this.reproduciendo) {
      const ahora = this.ctx.currentTime
      this.tramos = this.tramos.filter((t) => t.inicioCtx + t.duracionCtx > ahora - HISTORIA_SEC)
      if (this.esperando) {
        const s = this.siguiente
        if (s && this.listoParaArrancar(s.indice)) {
          this.esperando = false
          this.onResyncCb?.() // reingreso a sync FRESCO (mecanismo existente), no un arranque con el horario viejo
          return
        }
      } else {
        if (this.modo === 'mezcla') this.pasarAMezclaNueva()
        this.encadenar()
      }
    }
    this.lanzarFetchsPendientes()
  }

  private encadenar(): void {
    for (;;) {
      const s = this.siguiente
      if (!s) return
      const ahora = this.ctx.currentTime
      if (s.inicioCtx - ahora >= HORIZONTE_PROGRAMADO_SEC) return
      if (this.todasTerminaronEn(s.indice)) return
      if (!this.indiceListoEnTodas(s.indice) || s.inicioCtx < ahora + 0.005) {
        // no llego a tiempo: se corta aca (nada de silencio sintetico) y se espera
        if (s.inicioCtx - ahora <= 0.5) {
          this.esperando = true
          this.diag.cortes++
        }
        return
      }
      this.programarTramo()
    }
  }

  private programarTramo(): void {
    const s = this.siguiente!
    const t0 = s.inicioCtx
    const inicioSeg = s.indice * SEGMENT_DURATION_SEC
    const offset = Math.max(0, s.posInicio - inicioSeg)
    let durSeg = 0
    let clave = ''
    for (const canal of this.canales.values()) {
      const seg = canal.segmentos.get(s.indice)
      if (!seg) continue
      durSeg = Math.max(durSeg, seg.buffer.duration)
      clave = seg.clave
    }
    const contenido = durSeg - offset
    if (contenido <= 0.0005) {
      this.siguiente = { indice: s.indice + 1, posInicio: inicioSeg + durSeg, inicioCtx: t0 }
      return
    }

    // correccion fina: este tramo un poco mas lento o rapido, con su duracion real calculada
    let rate = 1
    let rampa = 0
    let absorbido = 0
    if (this.correccionPendiente !== 0 && contenido >= 0.5) {
      rampa = Math.min(RAMPA_CORRECCION_SEC, contenido / 4)
      const util = contenido - rampa
      const max = this.correccionPendiente > 0 ? (MAX_RATE_DEV * util) / (1 - MAX_RATE_DEV) : (MAX_RATE_DEV * util) / (1 + MAX_RATE_DEV)
      absorbido = clamp(this.correccionPendiente, -max, max)
      rate = util / (absorbido + util)
      this.correccionPendiente -= absorbido
      if (Math.abs(this.correccionPendiente) < 0.0002) this.correccionPendiente = 0
    }
    const duracionCtx = contenido + absorbido

    const tramo: Tramo = { indice: s.indice, inicioCtx: t0, duracionCtx, posInicio: s.posInicio, contenido, rate, rampa, absorbido, clave, fuentes: [] }
    const fundir = this.fundirEntradaEn !== null && Math.abs(this.fundirEntradaEn - t0) < 1e-6
    this.fundirEntradaEn = null
    for (const canal of this.canales.values()) {
      if (canal.finEnIndice !== null && s.indice >= canal.finEnIndice) continue
      const seg = canal.segmentos.get(s.indice)
      if (!seg || offset >= seg.buffer.duration) continue
      const source = this.ctx.createBufferSource()
      source.buffer = seg.buffer
      let gain: GainNode | null = null
      if (this.modo === 'mezcla') {
        // cada tramo con su propio volumen: permite el fundido al cambiar de mezcla
        gain = this.ctx.createGain()
        source.connect(gain)
        gain.connect(canal.gainNode)
        if (fundir) {
          gain.gain.setValueAtTime(0, t0)
          gain.gain.linearRampToValueAtTime(1, t0 + FUNDIDO_MEZCLA_SEC)
        }
      } else {
        source.connect(canal.gainNode)
      }
      if (rate !== 1) {
        const p = source.playbackRate
        p.setValueAtTime(1, t0)
        p.linearRampToValueAtTime(rate, t0 + rampa)
        p.setValueAtTime(rate, t0 + duracionCtx - rampa)
        p.linearRampToValueAtTime(1, t0 + duracionCtx)
      }
      try {
        source.start(t0, offset)
      } catch {
        continue // horario/offset invalido puntual: se ignora este segmento de esta pista
      }
      source.onended = () => {
        // libera de memoria el segmento ya reproducido (los cues se conservan aparte)
        if (canal.segmentos.get(s.indice) === seg) canal.segmentos.delete(s.indice)
        tramo.fuentes = tramo.fuentes.filter((f) => f.source !== source)
        gain?.disconnect()
      }
      tramo.fuentes.push({ canal, source, gain })
    }
    this.tramos.push(tramo)
    this.siguiente = { indice: s.indice + 1, posInicio: inicioSeg + durSeg, inicioCtx: t0 + duracionCtx }
  }

  /** Corta todo lo programado desde `t` (lo que empieza despues no suena; lo que esta sonando termina en `t`). */
  private cortarDesde(t: number): void {
    for (const tr of this.tramos) {
      const fin = tr.inicioCtx + tr.duracionCtx
      if (fin <= t) continue
      for (const f of tr.fuentes) {
        f.source.onended = null
        try {
          f.source.stop(Math.max(t, tr.inicioCtx))
        } catch {
          // ya estaba detenida
        }
      }
      tr.fuentes = []
      if (tr.inicioCtx >= t) tr.duracionCtx = 0
      else {
        tr.contenido = contenidoHasta(tr, t - tr.inicioCtx)
        tr.duracionCtx = t - tr.inicioCtx
      }
    }
    this.tramos = this.tramos.filter((tr) => tr.duracionCtx > 0)
  }

  /**
   * Deshace lo programado que todavia no empezo (desde `t`) para volver a
   * encadenarlo (con una correccion nueva, o con la mezcla nueva). Lo que
   * esos tramos iban a corregir vuelve a quedar pendiente.
   */
  private reprogramarDesde(t: number): void {
    // solo el ultimo tramo continuo: si entre medio hay un salto programado, lo anterior al salto queda como esta
    let desde = this.tramos.findIndex((tr) => tr.inicioCtx >= t)
    if (desde === -1) return
    for (let k = this.tramos.length - 1; k > desde; k--) {
      const a = this.tramos[k - 1]
      const b = this.tramos[k]
      if (Math.abs(a.posInicio + a.contenido - b.posInicio) > 0.001 || Math.abs(a.inicioCtx + a.duracionCtx - b.inicioCtx) > 1e-6) {
        desde = k
        break
      }
    }
    const futuros = this.tramos.slice(desde)
    const primero = futuros[0]
    for (const tr of futuros) {
      this.correccionPendiente += tr.absorbido
      for (const f of tr.fuentes) {
        f.source.onended = null
        try {
          f.source.stop()
        } catch {
          // ya estaba detenida
        }
        f.gain?.disconnect()
      }
    }
    this.tramos = this.tramos.slice(0, desde)
    this.siguiente = { indice: primero.indice, posInicio: primero.posInicio, inicioCtx: primero.inicioCtx }
  }

  /**
   * Modo mezcla: si lo programado se hizo con una mezcla vieja y ya llego la
   * nueva, se pasa a la nueva. Lo que todavia no empezo se reprograma entero;
   * lo que esta sonando se funde con la mezcla nueva en el mismo punto exacto
   * de la cancion (sin silencio ni corrimiento).
   */
  private pasarAMezclaNueva(): void {
    const canal = this.canales.get(ID_MEZCLA)
    if (!canal || this.tramos.length === 0) return
    const ahora = this.ctx.currentTime
    // con un salto/reingreso por empezar no se toca nada: se pasa a la mezcla nueva despues
    if (this.inicioCorridaCtx > ahora) return
    const fresco = (indice: number): boolean => canal.segmentos.get(indice)?.clave === this.claveMezcla

    // 1) lo programado que todavia no empezo y ya tiene mezcla nueva: se rehace
    const futuroViejo = this.tramos.find((tr) => tr.inicioCtx > ahora + 0.03 && tr.clave !== this.claveMezcla && fresco(tr.indice))
    if (futuroViejo) {
      this.diag.cambiosMezcla++
      this.reprogramarDesde(futuroViejo.inicioCtx)
    }

    // 2) lo que esta sonando: fundido a la mezcla nueva
    const sonando = this.tramos.find((tr) => tr.inicioCtx <= ahora && tr.inicioCtx + tr.duracionCtx > ahora)
    if (!sonando || sonando.clave === this.claveMezcla || sonando.rate !== 1) return
    const tCambio = ahora + 0.06
    const fin = sonando.inicioCtx + sonando.duracionCtx
    if (tCambio >= fin - FUNDIDO_MEZCLA_SEC) return // el borde esta encima: lo resuelve el paso 1 en el proximo tick
    const pos = sonando.posInicio + (tCambio - sonando.inicioCtx)
    const indice = Math.floor(pos / SEGMENT_DURATION_SEC + 1e-9)
    if (!fresco(indice)) return
    for (const f of sonando.fuentes) {
      f.gain?.gain.setValueAtTime(1, tCambio)
      f.gain?.gain.linearRampToValueAtTime(0, tCambio + FUNDIDO_MEZCLA_SEC)
      try {
        f.source.stop(tCambio + FUNDIDO_MEZCLA_SEC)
      } catch {
        // ya estaba detenida
      }
    }
    this.diag.cambiosMezcla++
    sonando.contenido = tCambio - sonando.inicioCtx
    sonando.duracionCtx = tCambio - sonando.inicioCtx
    this.reprogramarDesde(tCambio)
    this.siguiente = { indice, posInicio: pos, inicioCtx: tCambio }
    this.fundirEntradaEn = tCambio
  }

  /**
   * Pide lo que falta, en orden de urgencia: primero el PROXIMO segmento de
   * todas las pistas, despues el siguiente de todas, etc. (el navegador solo
   * baja ~6 cosas a la vez por servidor). Los cues van al final, y lo ultimo
   * es el principio de la proxima cancion.
   */
  private lanzarFetchsPendientes(): void {
    if (this.canales.size === 0) return
    const ahora = Date.now()
    const desde = this.indiceBaseVentana()
    const cantidad = this.reproduciendo ? this.cantidadIndicesVentana() : Math.ceil(BUFFER_MIN_START_SEC / SEGMENT_DURATION_SEC) + 1
    const canales = [...this.canales.values()].filter((c) => !c.error && ahora >= c.esperarHasta)
    const maxGlobal = Math.max(MAX_FETCHES_GLOBAL, this.canales.size)
    const maxPorCanal = MAX_FETCHES_POR_PISTA[this.modo]
    let enVueloTotal = 0
    for (const c of this.canales.values()) enVueloTotal += c.enVuelo.size

    let ventanaCompleta = true
    for (let i = 0; i < cantidad; i++) {
      const indice = desde + i
      for (const canal of canales) {
        if (canal.finEnIndice !== null && indice >= canal.finEnIndice) continue
        if (canal.segmentos.get(indice)?.clave === this.claveMezcla) continue
        ventanaCompleta = false
        if (canal.enVuelo.has(indice)) continue
        // hasta tener el encabezado del WAV, un solo pedido por pista (los demas dependen de el)
        if (this.modo === 'pistas' && !canal.wavInfo && canal.enVuelo.size > 0) continue
        if (canal.enVuelo.size >= maxPorCanal || enVueloTotal >= maxGlobal) continue
        this.pedirSegmento(canal, indice)
        enVueloTotal++
      }
    }

    // cues: solo con la ventana cubierta y sin nada en vuelo, para no competir con lo que esta por sonar
    if (!ventanaCompleta || enVueloTotal > 0) return
    for (const indice of [...this.cueIndices].sort((a, b) => a - b)) {
      for (const canal of canales) {
        if (canal.finEnIndice !== null && indice >= canal.finEnIndice) continue
        if (canal.cueSegmentos.get(indice)?.clave === this.claveMezcla || canal.enVuelo.has(indice)) continue
        const enVentana = canal.segmentos.get(indice)
        if (enVentana?.clave === this.claveMezcla) {
          canal.cueSegmentos.set(indice, enVentana)
          continue
        }
        this.pedirSegmento(canal, indice)
        if (++enVueloTotal >= Math.max(2, this.canales.size)) return
      }
    }
    if (enVueloTotal === 0) this.lanzarPrecarga()
  }

  /** Baja el principio de la proxima cancion, pocos pedidos a la vez (menos todavia si algo suena). */
  private lanzarPrecarga(): void {
    const pre = this.precarga
    if (!pre || Date.now() < pre.esperarHasta) return
    const maxEnVuelo = this.reproduciendo ? 1 : 3
    for (let indice = pre.indiceInicio; indice < pre.indiceInicio + SEGMENTOS_PRECARGA_SIGUIENTE; indice++) {
      for (const [canalId, p] of pre.canales) {
        if (pre.enVuelo.size >= maxEnVuelo) return
        if (p.error || p.segmentos.has(indice) || (p.finEnIndice !== null && indice >= p.finEnIndice)) continue
        const clave = `${canalId}:${indice}`
        if (pre.enVuelo.has(clave)) continue
        // hasta tener el encabezado, un solo pedido por pista
        if (this.modo === 'pistas' && !p.wavInfo && [...pre.enVuelo.keys()].some((k) => k.startsWith(`${canalId}:`))) continue
        this.pedirPrecarga(pre, p, indice, clave)
      }
    }
  }

  private pedirPrecarga(pre: Precarga, p: CanalPrecargado, indice: number, clave: string): void {
    const ctrl = new AbortController()
    pre.enVuelo.set(clave, ctrl)
    void (async () => {
      let r: { buffer: AudioBuffer | null; finEnIndice: number | null }
      if (this.modo === 'mezcla') {
        r = await this.bajarMezcla(pre.proyectoId, pre.revision, pre.clave, indice, ctrl.signal)
      } else {
        const url = `/media/${pre.proyectoId}/${p.archivo}?v=${pre.revision}`
        if (!p.wavInfo) {
          const bytes = await this.fetchRango(url, 0, WAV_HEADER_FETCH_BYTES - 1, ctrl.signal)
          const info = parseWavHeader(bytes)
          if (![8, 16, 24, 32].includes(info.bitsPerSample)) throw new ErrorFatal('formato de audio no soportado')
          p.wavInfo = info
        }
        r = await this.bajarSegmento(url, p.wavInfo, indice, ctrl.signal)
      }
      if (r.buffer) p.segmentos.set(indice, { buffer: r.buffer, clave: pre.clave })
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

  private pedirSegmento(canal: Canal, indice: number): void {
    const ctrl = new AbortController()
    const clave = this.claveMezcla
    canal.enVuelo.set(indice, { ctrl, clave })
    const proyectoId = this.proyectoId
    void this.fetchSegmento(canal, indice, clave, ctrl.signal)
      .then((buffer) => {
        if (proyectoId !== this.proyectoId || ctrl.signal.aborted) return
        canal.fallosSeguidos = 0
        if (buffer) this.guardarSegmento(canal, indice, { buffer, clave })
        this.tick()
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || proyectoId !== this.proyectoId) return
        this.diag.errores++
        if (err instanceof ErrorFatal) {
          if (!canal.error) console.warn('[StreamingEngine] pista con error', canal.nombre, err.message)
          canal.error = err.message
          canal.finEnIndice = 0 // la pista queda muda; las demas siguen sonando
          this.tick()
        } else {
          // error de red: reintento con espera creciente (0.3s, 0.6s, ... hasta 4s)
          canal.fallosSeguidos++
          canal.esperarHasta = Date.now() + Math.min(4000, 300 * 2 ** (canal.fallosSeguidos - 1))
          if (!canal.wavInfo) canal.wavInfoPromise = null
        }
      })
      .finally(() => {
        if (canal.enVuelo.get(indice)?.ctrl === ctrl) canal.enVuelo.delete(indice)
      })
  }

  private guardarSegmento(canal: Canal, indice: number, seg: Segmento): void {
    if (this.cueIndices.has(indice)) canal.cueSegmentos.set(indice, seg)
    const desde = this.indiceBaseVentana()
    if (indice >= desde && indice <= desde + this.cantidadIndicesVentana() + 1) canal.segmentos.set(indice, seg)
  }

  /** Baja y decodifica un segmento. null = no hay audio en ese indice (fin de la pista). */
  private async fetchSegmento(canal: Canal, indice: number, clave: string, signal: AbortSignal): Promise<AudioBuffer | null> {
    const r =
      this.modo === 'mezcla'
        ? await this.bajarMezcla(this.proyectoId!, this.revisionCargada, clave, indice, signal)
        : await this.bajarSegmento(this.urlDe(canal), await this.obtenerWavInfo(canal), indice, signal)
    if (r.finEnIndice !== null) this.marcarFin(canal, r.finEnIndice)
    return r.buffer
  }

  /** Pide a la compu el segmento `indice` ya mezclado (un WAV estereo). */
  private async bajarMezcla(
    proyectoId: string,
    revision: number,
    clave: string,
    indice: number,
    signal: AbortSignal
  ): Promise<{ buffer: AudioBuffer | null; finEnIndice: number | null }> {
    const url = `/mezcla/${proyectoId}/${indice}.wav?v=${revision}&m=${clave}`
    const { resp, bytes } = await this.medir(async () => {
      const resp = await fetch(url, { signal })
      if (resp.status === 416) return { resp, bytes: new ArrayBuffer(0) }
      if (resp.status === 404) throw new Error('la cancion no esta abierta en la computadora')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return { resp, bytes: await resp.arrayBuffer() }
    })
    if (resp.status === 416 || bytes.byteLength === 0) return { buffer: null, finEnIndice: indice }
    const info = parseWavHeader(bytes)
    const canales = decodePcmSegment(info, bytes.slice(info.dataOffset))
    const frames = canales[0]?.length ?? 0
    if (frames <= 0) return { buffer: null, finEnIndice: indice }
    const buffer = this.ctx.createBuffer(info.numChannels, frames, info.sampleRate)
    for (let ch = 0; ch < info.numChannels; ch++) buffer.copyToChannel(canales[ch], ch)
    return { buffer, finEnIndice: resp.headers.get('X-Ultimo') === '1' ? indice + 1 : null }
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

  private marcarFin(canal: Canal, indice: number): void {
    canal.finEnIndice = canal.finEnIndice === null ? indice : Math.min(canal.finEnIndice, indice)
  }

  /** El encabezado no se cancela con el segmento que lo pidio: lo necesitan todos los de esa pista. */
  private obtenerWavInfo(canal: Canal): Promise<WavInfo> {
    if (canal.wavInfo) return Promise.resolve(canal.wavInfo)
    if (!canal.wavInfoPromise) {
      canal.wavInfoPromise = this.fetchRango(this.urlDe(canal), 0, WAV_HEADER_FETCH_BYTES - 1).then((bytes) => {
        try {
          const info = parseWavHeader(bytes)
          if (![8, 16, 24, 32].includes(info.bitsPerSample)) throw new WavHeaderError('formato de audio no soportado')
          canal.wavInfo = info
          return info
        } catch (err) {
          throw new ErrorFatal(err instanceof WavHeaderError ? 'formato de audio no soportado' : String(err))
        }
      })
    }
    return canal.wavInfoPromise
  }

  private async fetchRango(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.medir(async () => {
      const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
      if (resp.status === 206) return resp.arrayBuffer()
      if (resp.status === 200) {
        const completo = await resp.arrayBuffer()
        return completo.slice(start, end + 1)
      }
      if (resp.status === 416) return new ArrayBuffer(0) // rango fuera del archivo: fin de pista
      if (resp.status === 404) throw new ErrorFatal('falta el archivo de audio en la computadora')
      throw new Error(`HTTP ${resp.status}`)
    })
  }

  /** Mide cuanto se bajo y cuanto tardo (para el diagnostico del WiFi). */
  private async medir<T extends ArrayBuffer | { bytes: ArrayBuffer }>(fn: () => Promise<T>): Promise<T> {
    const d = this.diag
    const inicio = Date.now()
    if (d.activos++ === 0) d.ocupadoDesde = inicio
    try {
      const r = await fn()
      const bytes = r instanceof ArrayBuffer ? r.byteLength : r.bytes.byteLength
      const fin = Date.now()
      d.recibidos.push([fin, bytes, fin - inicio])
      if (d.recibidos.length > 400) d.recibidos.splice(0, d.recibidos.length - 400)
      return r
    } finally {
      if (--d.activos === 0) {
        d.ocupado.push([d.ocupadoDesde, Date.now()])
        if (d.ocupado.length > 400) d.ocupado.splice(0, d.ocupado.length - 400)
      }
    }
  }

  /** `?v=`: si el zip se actualizo, el archivo cambia con el mismo nombre (que no sirva el cache viejo). */
  private urlDe(canal: Canal): string {
    return `/media/${this.proyectoId}/${canal.archivo}?v=${this.revisionCargada}`
  }

  private latenciaDeSalidaSec(): number {
    return this.ctx.outputLatency ?? this.ctx.baseLatency ?? 0
  }

  /** true si, para CADA canal, hay `BUFFER_MIN_START_SEC` contiguos desde `indice` (o el canal termina antes). */
  private listoParaArrancar(indice: number): boolean {
    for (const canal of this.canales.values()) {
      let idx = indice
      let segundos = 0
      while (segundos < BUFFER_MIN_START_SEC) {
        if (canal.finEnIndice !== null && idx >= canal.finEnIndice) break
        const seg = canal.segmentos.get(idx)
        if (!seg) return false
        segundos += seg.buffer.duration
        idx++
      }
    }
    return true
  }

  private segundosDisponiblesDesde(indice: number): number {
    if (this.canales.size === 0) return 0
    const objetivo = this.bufferObjetivo()
    let minSegundos = Infinity
    for (const canal of this.canales.values()) {
      let idx = indice
      let segundos = 0
      while (segundos < objetivo) {
        if (canal.finEnIndice !== null && idx >= canal.finEnIndice) {
          segundos = objetivo
          break
        }
        const seg = canal.segmentos.get(idx)
        if (!seg) break
        segundos += seg.buffer.duration
        idx++
      }
      minSegundos = Math.min(minSegundos, segundos)
    }
    return minSegundos
  }

  private indiceListoEnTodas(indice: number): boolean {
    for (const canal of this.canales.values()) {
      if (canal.finEnIndice !== null && indice >= canal.finEnIndice) continue
      if (!canal.segmentos.has(indice)) return false
    }
    return true
  }

  private todasTerminaronEn(indice: number): boolean {
    if (this.canales.size === 0) return false
    for (const canal of this.canales.values()) {
      if (canal.finEnIndice === null || indice < canal.finEnIndice) return false
    }
    return true
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function redondear(v: number, decimales: number): number {
  const f = 10 ** decimales
  return Math.round(v * f) / f
}
