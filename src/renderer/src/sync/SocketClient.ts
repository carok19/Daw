import { io, Socket } from 'socket.io-client'
import type {
  ClockSyncAck,
  ComandoProgramado,
  DispositivoInfo,
  EstadoCompleto,
  ErrorPayload,
  OrigenCliente
} from '@shared/types'

const MUESTRAS_SYNC = 5
const RESYNC_INTERVAL_MS = 5 * 60 * 1000

export type Desuscribir = () => void

/**
 * Envuelve la conexion Socket.IO: sincronizacion de reloj (seccion 7.2) y
 * helpers tipados para emitir comandos / escuchar broadcasts del servidor.
 */
export class SocketClient {
  readonly socket: Socket
  clockOffsetMs = 0
  conectado = false

  private syncEnCurso: Promise<void> | null = null

  constructor(private readonly origen: OrigenCliente) {
    this.socket = io({ auth: { origen } })
    this.socket.on('connect', () => {
      this.conectado = true
      // La sincronizacion inicial (y el orden con el primer pedido de estado)
      // la maneja explicitamente quien use este cliente (ver onConexionCambia
      // en useAppController); aca solo se refresca el offset periodicamente.
    })
    this.socket.on('disconnect', () => {
      this.conectado = false
    })
    setInterval(() => {
      if (this.conectado) void this.sincronizarReloj()
    }, RESYNC_INTERVAL_MS)
  }

  /** Tiempo estimado del servidor ahora mismo, segun el offset calculado. */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs
  }

  /**
   * Corre las muestras de sincronizacion (ping/pong, seccion 7.2). Si ya hay
   * una sincronizacion en curso, se reutiliza esa misma promesa en vez de
   * lanzar una segunda corrida en paralelo: dos corridas concurrentes se
   * pisan entre si y corrompen el offset calculado (cada una mide RTT
   * inflado por el trafico de la otra).
   */
  async sincronizarReloj(): Promise<void> {
    if (this.syncEnCurso) return this.syncEnCurso
    this.syncEnCurso = this.correrMuestrasDeSync().finally(() => {
      this.syncEnCurso = null
    })
    return this.syncEnCurso
  }

  private async correrMuestrasDeSync(): Promise<void> {
    let mejorOffset = this.clockOffsetMs
    let mejorRtt = Infinity
    for (let i = 0; i < MUESTRAS_SYNC; i++) {
      const t0 = Date.now()
      try {
        const ack = await this.emitAck<ClockSyncAck>('clock:sync', {})
        const t1 = Date.now()
        const rtt = t1 - t0
        const offset = ack.tServer - (t0 + t1) / 2
        if (rtt < mejorRtt) {
          mejorRtt = rtt
          mejorOffset = offset
        }
      } catch {
        // se ignora una muestra fallida, se sigue con las demas
      }
    }
    this.clockOffsetMs = mejorOffset
  }

  async pedirEstado(): Promise<EstadoCompleto> {
    return this.emitAck<EstadoCompleto>('state:request', {})
  }

  emitAck<T>(evento: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket.timeout(5000).emit(evento, payload, (err: unknown, respuesta: T) => {
        if (err) reject(err)
        else resolve(respuesta)
      })
    })
  }

  emit(evento: string, payload: unknown = {}): void {
    this.socket.emit(evento, payload)
  }

  onEstado(cb: (estado: EstadoCompleto) => void): Desuscribir {
    this.socket.on('estado:actualizado', cb)
    return () => this.socket.off('estado:actualizado', cb)
  }

  onPlaybackScheduled(cb: (cmd: ComandoProgramado) => void): Desuscribir {
    this.socket.on('playback:scheduled', cb)
    return () => this.socket.off('playback:scheduled', cb)
  }

  onRechazado(cb: (err: ErrorPayload) => void): Desuscribir {
    this.socket.on('accion:rechazada', cb)
    return () => this.socket.off('accion:rechazada', cb)
  }

  onDispositivos(cb: (dispositivos: DispositivoInfo[]) => void): Desuscribir {
    this.socket.on('dispositivos:actualizado', cb)
    return () => this.socket.off('dispositivos:actualizado', cb)
  }

  onConexionCambia(cb: (conectado: boolean) => void): Desuscribir {
    const onConnect = () => cb(true)
    const onDisconnect = () => cb(false)
    this.socket.on('connect', onConnect)
    this.socket.on('disconnect', onDisconnect)
    return () => {
      this.socket.off('connect', onConnect)
      this.socket.off('disconnect', onDisconnect)
    }
  }
}
