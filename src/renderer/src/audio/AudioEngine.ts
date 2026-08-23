import type { ComandoProgramado, Pista, Proyecto } from '@shared/types'

interface PistaRuntime {
  pistaId: string
  buffer: AudioBuffer
  gainNode: GainNode
  pannerNode: StereoPannerNode
  source: AudioBufferSourceNode | null
}

/**
 * Motor de audio multitrack (Web Audio API). Cada pista tiene su propio
 * GainNode (volumen) + StereoPannerNode (pan), persistentes mientras el
 * proyecto esta cargado; los AudioBufferSourceNode son de un solo uso y se
 * recrean en cada `ejecutar('play', ...)`.
 *
 * Un GainNode maestro adicional (`masterGain`) es el unico control disponible
 * en el celular (fader de volumen general, seccion 6): no afecta el pan ni
 * el balance entre pistas, que ya viene fijado por la mezcla de la compu.
 */
export class AudioEngine {
  private ctx: AudioContext
  private masterGain: GainNode
  private tracks: PistaRuntime[] = []
  private comandoPendiente: { cmd: ComandoProgramado; clockOffsetMs: number } | null = null
  /**
   * Ajuste fino manual (ms), calibrado a oido por el musico en ESTE
   * dispositivo cuando la compensacion automatica no alcanza (tipicamente
   * por Bluetooth). Mismo signo que `latenciaDeSalidaSec`: positivo = este
   * celular suena tarde, adelantarlo (arranca antes); negativo = suena
   * temprano, atrasarlo.
   */
  private ajusteManualMs = 0
  proyectoIdCargado: string | null = null

  /**
   * "Ancla" del punto de referencia de audio REAL (no de reloj de pared):
   * ctx.currentTime en el que efectivamente arranco el `source.start()` vigente,
   * y el offset de buffer (seg) con el que arranco. Con esto se puede calcular
   * en cualquier momento posterior la posicion real que esta sonando, usando
   * SOLO el reloj de audio (`ctx.currentTime`), sin depender del reloj de
   * pared — son dos relojes distintos dentro del mismo dispositivo y pueden
   * desviarse entre si con el tiempo (deriva de cristal del hardware de audio).
   * `null` cuando no hay audio sonando (pausado/detenido, o el `start()`
   * programado todavia no llego a su horario).
   */
  private audioAnchorCtxTime: number | null = null
  private audioAnchorOffsetSec = 0
  /** ctx.currentTime en el que termina la rampa de correccion suave en curso (0 = ninguna). */
  private correccionActivaHastaCtxTime = 0

  constructor() {
    this.ctx = new AudioContext()
    this.masterGain = this.ctx.createGain()
    this.masterGain.connect(this.ctx.destination)
  }

  async resumeSiHaceFalta(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume()
    }
  }

  setVolumenGeneral(volumen0a100: number): void {
    this.masterGain.gain.value = clamp(volumen0a100, 0, 100) / 100
  }

  setAjusteManualMs(ms: number): void {
    this.ajusteManualMs = ms
  }

  /**
   * Descarga y decodifica todas las pistas del proyecto. Devuelve la duracion
   * (ms) de la mas larga. `onProgreso` (0 a 1) se llama con el avance
   * combinado de bytes descargados de TODAS las pistas — para mostrar un
   * porcentaje/rueda de carga en vez de un simple "cargando" sin datos
   * (importante en celulares con WiFi lenta: varios MB de audio pueden
   * tardar bastante y el musico necesita saber cuanto falta).
   */
  async cargarProyecto(proyecto: Proyecto, onProgreso?: (fraccion: number) => void): Promise<number> {
    this.detenerFuentesInmediato()
    this.tracks = []
    this.proyectoIdCargado = proyecto.id

    const cargadosPorPista = new Array(proyecto.pistas.length).fill(0)
    const totalesPorPista = new Array(proyecto.pistas.length).fill(0)
    function reportarProgreso(): void {
      const totalConocido = totalesPorPista.reduce((a, b) => a + b, 0)
      if (totalConocido <= 0) return
      const cargado = cargadosPorPista.reduce((a, b) => a + b, 0)
      onProgreso?.(Math.min(1, cargado / totalConocido))
    }

    const buffers = await Promise.all(
      proyecto.pistas.map((pista, i) =>
        this.descargarYDecodificar(proyecto.id, pista.archivo, (cargados, total) => {
          cargadosPorPista[i] = cargados
          totalesPorPista[i] = total
          reportarProgreso()
        })
      )
    )

    // el proyecto pudo haber cambiado mientras esperabamos las descargas
    if (this.proyectoIdCargado !== proyecto.id) return 0

    this.tracks = proyecto.pistas.map((pista, i) => {
      const gainNode = this.ctx.createGain()
      const pannerNode = this.ctx.createStereoPanner()
      gainNode.connect(pannerNode)
      pannerNode.connect(this.masterGain)
      return { pistaId: pista.id, buffer: buffers[i], gainNode, pannerNode, source: null }
    })
    this.aplicarMezcla(proyecto.pistas)

    // si mientras se descargaba/decodificaba llego un "play" (p.ej. un celular
    // que se conecta justo cuando arranca la cancion), no se perdio: se aplica
    // ahora. `ejecutar` ya sabe recalcular la posicion correcta si el horario
    // original quedo en el pasado (ver mas abajo).
    if (this.comandoPendiente) {
      const { cmd, clockOffsetMs } = this.comandoPendiente
      this.comandoPendiente = null
      this.ejecutar(cmd, clockOffsetMs)
    }

    return Math.max(0, ...buffers.map((b) => b.duration * 1000))
  }

  private async descargarYDecodificar(
    proyectoId: string,
    archivoRelativo: string,
    onProgreso: (cargados: number, total: number) => void
  ): Promise<AudioBuffer> {
    const url = `/media/${proyectoId}/${archivoRelativo}`
    const resp = await fetch(url)
    const total = Number(resp.headers.get('content-length')) || 0

    if (!resp.body || total <= 0) {
      // sin Content-Length (o navegador sin streaming body) no se puede medir
      // progreso fino: se descarga entero y se reporta de un salto al terminar
      const arrayBuffer = await resp.arrayBuffer()
      onProgreso(arrayBuffer.byteLength, arrayBuffer.byteLength || 1)
      return this.ctx.decodeAudioData(arrayBuffer)
    }

    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let cargados = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        cargados += value.byteLength
        onProgreso(cargados, total)
      }
    }
    const bytes = new Uint8Array(cargados)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return this.ctx.decodeAudioData(bytes.buffer as ArrayBuffer)
  }

  /** Aplica volumen/pan/mute/solo en tiempo real (sin recrear las fuentes). */
  aplicarMezcla(pistas: Pista[]): void {
    const haySolo = pistas.some((p) => p.solo)
    for (const track of this.tracks) {
      const pista = pistas.find((p) => p.id === track.pistaId)
      if (!pista) continue
      const silenciado = pista.mute || (haySolo && !pista.solo)
      track.gainNode.gain.value = silenciado ? 0 : clamp(pista.volumen, 0, 100) / 100
      track.pannerNode.pan.value = clamp(pista.pan, -100, 100) / 100
    }
  }

  /**
   * Ejecuta un comando de reproduccion programado por el servidor, traduciendo
   * `executeAtServerTime` al reloj local del AudioContext usando `clockOffsetMs`
   * (offset calculado por SocketClient: serverTime ~= Date.now() + offset).
   */
  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void {
    if (cmd.accion === 'play' && this.tracks.length === 0) {
      // todavia no terminaron de decodificarse los buffers: se guarda para
      // aplicarlo apenas termine `cargarProyecto` en vez de perderlo en silencio.
      this.comandoPendiente = { cmd, clockOffsetMs }
      return
    }
    // cualquier otra accion (pause/stop/seek, o un play mas nuevo) reemplaza
    // o invalida un play que hubiera quedado pendiente de una carga anterior.
    this.comandoPendiente = null

    const clienteObjetivoMs = cmd.executeAtServerTime - clockOffsetMs
    let delaySec = (clienteObjetivoMs - Date.now()) / 1000
    let offsetMs = cmd.positionMs

    // Compensar la latencia de salida de audio propia de este dispositivo
    // (parlante/auriculares/controlador de sonido). Sin esto, el scheduling
    // puede estar perfectamente alineado y aun asi un celular con mas
    // latencia de hardware (comun en Android, sobre todo por Bluetooth)
    // suena mas tarde que otro: adelantamos el `start()` exactamente lo que
    // ESTE dispositivo tarda de mas en sacar sonido, para que lo audible
    // quede alineado entre todos.
    delaySec -= this.latenciaDeSalidaSec()
    delaySec -= this.ajusteManualMs / 1000

    if (delaySec < 0) {
      // el mensaje llego tarde (o la latencia de salida ya se comio el margen):
      // arrancamos ya, pero saltando lo que se perdio
      offsetMs += -delaySec * 1000
      delaySec = 0
    }
    const targetTime = this.ctx.currentTime + delaySec

    if (cmd.accion === 'play') {
      this.detenerFuentes(targetTime)
      for (const track of this.tracks) {
        const source = this.ctx.createBufferSource()
        source.buffer = track.buffer
        source.connect(track.gainNode)
        const offsetSec = Math.min(Math.max(offsetMs / 1000, 0), Math.max(track.buffer.duration - 0.001, 0))
        try {
          source.start(targetTime, offsetSec)
        } catch {
          // buffer vacio u offset invalido: se ignora esa pista puntual
        }
        track.source = source
      }
      // nuevo punto de referencia de audio real; cualquier correccion de drift
      // anterior queda obsoleta (las fuentes que corregia ya no existen)
      this.audioAnchorCtxTime = targetTime
      this.audioAnchorOffsetSec = offsetMs / 1000
      this.correccionActivaHastaCtxTime = 0
    } else if (cmd.accion === 'pause' || cmd.accion === 'stop') {
      this.detenerFuentes(targetTime)
      this.audioAnchorCtxTime = null
      this.correccionActivaHastaCtxTime = 0
    }
    // 'seek': no hay audio sonando (el servidor solo la emite en pausa/stop), nada que programar aqui.
  }

  /**
   * Posicion real (ms) que esta sonando AHORA MISMO, calculada solo con el
   * reloj de audio (`ctx.currentTime`). `null` si no hay audio sonando o el
   * `start()` programado todavia no llego a su horario.
   */
  posicionRealMs(): number | null {
    if (this.audioAnchorCtxTime === null) return null
    if (this.ctx.currentTime < this.audioAnchorCtxTime) return null
    return (this.audioAnchorOffsetSec + (this.ctx.currentTime - this.audioAnchorCtxTime)) * 1000
  }

  /** true mientras una rampa de correccion suave esta en curso (para no pisarla con otra). */
  enCorreccionSuave(): boolean {
    return this.ctx.currentTime < this.correccionActivaHastaCtxTime
  }

  /**
   * Corrige un drift chico sin cortes ni clicks: ajusta levemente la
   * velocidad de reproduccion (`playbackRate`) de todas las pistas por
   * `duracionSec` segundos, la cantidad justa para "absorber" `driftMs`, y
   * vuelve a velocidad normal. Un cambio de velocidad menor a ~1% sostenido
   * pocos segundos no se percibe al oido (misma tecnica que usan sistemas
   * profesionales de sincronizacion de audio - "vari-speed drift compensation").
   *
   * driftMs > 0 = este dispositivo esta ADELANTADO (suena mas rapido/mas
   * avanzado de lo esperado) -> se lo hace sonar mas LENTO un rato.
   */
  corregirDriftSuave(driftMs: number, duracionSec = 3): void {
    if (this.audioAnchorCtxTime === null || !this.tracks.some((t) => t.source)) return
    const now = this.ctx.currentTime
    if (now < this.correccionActivaHastaCtxTime) return // ya hay una correccion en curso

    const driftSec = driftMs / 1000
    // sostener `rateObjetivo` por `duracionSec` reproduce exactamente
    // `duracionSec * (rateObjetivo - 1)` segundos de mas/de menos, que
    // elegimos para que sea igual a `-driftSec` (cancela el drift).
    const rateObjetivo = clamp(1 - driftSec / duracionSec, 0.9, 1.1)
    const rampIn = Math.min(0.2, duracionSec / 4)

    for (const track of this.tracks) {
      if (!track.source) continue
      const p = track.source.playbackRate
      p.cancelScheduledValues(now)
      p.setValueAtTime(p.value, now)
      p.linearRampToValueAtTime(rateObjetivo, now + rampIn)
      p.setValueAtTime(rateObjetivo, now + duracionSec - rampIn)
      p.linearRampToValueAtTime(1, now + duracionSec)
    }

    // el ancla se ajusta de inmediato asumiendo que la correccion ya se aplico
    // por completo: durante la rampa `posicionRealMs()` queda un poco
    // aproximado (no importa, las decisiones se pausan hasta que termine via
    // `enCorreccionSuave()`), y coincide con el audio real justo cuando la
    // rampa termina.
    this.audioAnchorOffsetSec -= driftSec
    this.correccionActivaHastaCtxTime = now + duracionSec
  }

  private detenerFuentes(atTime: number): void {
    for (const track of this.tracks) {
      if (track.source) {
        try {
          track.source.stop(atTime)
        } catch {
          // ya estaba detenida
        }
        track.source.onended = null
        track.source = null
      }
    }
  }

  private detenerFuentesInmediato(): void {
    this.detenerFuentes(this.ctx.currentTime)
    this.audioAnchorCtxTime = null
    this.correccionActivaHastaCtxTime = 0
  }

  /**
   * Estimacion del navegador de cuanto tarda este dispositivo en sacar el
   * sonido despues de programarlo (`outputLatency`, y `baseLatency` como
   * respaldo en navegadores que no exponen la primera). No es perfecta —
   * en particular, un parlante/auricular por Bluetooth agrega latencia extra
   * que estas APIs normalmente no llegan a reportar del todo — pero corrige
   * la mayor parte de la diferencia entre, por ejemplo, dos Android distintos.
   */
  private latenciaDeSalidaSec(): number {
    return this.ctx.outputLatency ?? this.ctx.baseLatency ?? 0
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
