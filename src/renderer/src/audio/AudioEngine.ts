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
  proyectoIdCargado: string | null = null

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

  /** Descarga y decodifica todas las pistas del proyecto. Devuelve la duracion (ms) de la mas larga. */
  async cargarProyecto(proyecto: Proyecto): Promise<number> {
    this.detenerFuentesInmediato()
    this.tracks = []
    this.proyectoIdCargado = proyecto.id

    const buffers = await Promise.all(
      proyecto.pistas.map((pista) => this.descargarYDecodificar(proyecto.id, pista.archivo))
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

  private async descargarYDecodificar(proyectoId: string, archivoRelativo: string): Promise<AudioBuffer> {
    const url = `/media/${proyectoId}/${archivoRelativo}`
    const resp = await fetch(url)
    const arrayBuffer = await resp.arrayBuffer()
    return this.ctx.decodeAudioData(arrayBuffer)
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

    if (delaySec < 0) {
      // el mensaje llego tarde: arrancamos ya, pero saltando lo que se perdio
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
    } else if (cmd.accion === 'pause' || cmd.accion === 'stop') {
      this.detenerFuentes(targetTime)
    }
    // 'seek': no hay audio sonando (el servidor solo la emite en pausa/stop), nada que programar aqui.
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
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
