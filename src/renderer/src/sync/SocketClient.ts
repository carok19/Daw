import { io, Socket } from 'socket.io-client'
import type {
  AuthHandshake,
  ClockSyncAck,
  ComandoProgramado,
  DispositivoInfo,
  EstadoCompleto,
  ErrorPayload,
  ImportProgreso,
  MixerActualizadoPayload,
  MotivoCodigo,
  OrigenCliente
} from '@shared/types'

const MUESTRAS_SYNC = 7
/**
 * Cada cuanto se vuelve a medir el reloj. Los relojes de los celulares se
 * corren entre si (hasta ~50 ppm: ~6 ms cada 2 minutos); midiendo cada 30 s
 * la diferencia nunca pasa de ~1,5 ms. Son 7 mensajes chiquitos.
 */
const RESYNC_INTERVAL_MS = 30 * 1000
/** Cada cuanto se mira si la hora del sistema salto (el celular la corrigio por internet, o la cambiaron). */
const VIGILANCIA_RELOJ_MS = 1000
/** Un salto de la hora del sistema mas grande que esto se compensa al instante (y se vuelve a medir). */
const SALTO_RELOJ_MS = 15

export type Desuscribir = () => void

/**
 * Envuelve la conexion Socket.IO: sincronizacion de reloj y helpers tipados
 * para emitir comandos / escuchar broadcasts del servidor.
 */
export class SocketClient {
  readonly socket: Socket
  clockOffsetMs = 0
  conectado = false

  private syncEnCurso: Promise<void> | null = null
  private intervalo: ReturnType<typeof setInterval>
  private vigilancia: ReturnType<typeof setInterval>
  /** el mejor RTT de las ultimas mediciones (para descartar una medicion hecha con la red cargada) */
  private rttsRecientes: number[] = []
  /** cuantos saltos de la hora del sistema se compensaron (diagnostico) */
  saltosDeReloj = 0

  constructor(origen: OrigenCliente, auth: () => Omit<AuthHandshake, 'origen'>) {
    // `auth` como funcion: se re-evalua en cada reconexion (p.ej. si el celular cambio de nombre)
    this.socket = io({
      auth: (cb) => cb({ origen, ...auth() }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000
    })
    this.socket.on('connect', () => {
      this.conectado = true
    })
    this.socket.on('disconnect', () => {
      this.conectado = false
    })
    this.intervalo = setInterval(() => {
      if (this.conectado) void this.sincronizarReloj()
    }, RESYNC_INTERVAL_MS)
    this.vigilancia = setInterval(() => this.revisarReloj(), VIGILANCIA_RELOJ_MS)
  }

  private muro = Date.now()
  private mono = performance.now()

  /**
   * La hora del sistema (Date.now) puede saltar: el celular la corrige por
   * internet o alguien la cambia. El reloj monotono (performance.now) no
   * salta: si se separan, se compensa ya (sin esperar la proxima medicion) y
   * se vuelve a medir. Se llama sola cada segundo, y antes de medir el sync.
   */
  revisarReloj(): void {
    const m = Date.now()
    const n = performance.now()
    const salto = m - this.muro - (n - this.mono)
    this.muro = m
    this.mono = n
    if (Math.abs(salto) < SALTO_RELOJ_MS) return
    // la hora local se adelanto `salto` ms: la del servidor, vista desde aca, quedo `salto` ms mas cerca
    this.clockOffsetMs -= salto
    this.saltosDeReloj++
    if (this.conectado) void this.sincronizarReloj()
  }

  /** Tiempo estimado del servidor ahora mismo, segun el offset calculado. */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs
  }

  /**
   * Corre las muestras de sincronizacion (ping/pong) y se queda con la de
   * menor RTT. Si ya hay una en curso, se reutiliza esa misma promesa: dos
   * corridas en paralelo se pisan y corrompen el offset.
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
        const ack = await this.emitAck<ClockSyncAck>('clock:sync', {}, 2000)
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
    if (!Number.isFinite(mejorRtt)) return
    // con la red cargada hasta la mejor muestra viene demorada (y de un solo lado): si es mucho peor que
    // las de las ultimas mediciones, el reloj de antes es mas confiable (se vuelve a medir en 30 s)
    const referencia = this.rttsRecientes.length >= 3 ? Math.min(...this.rttsRecientes) : Infinity
    this.rttsRecientes = [...this.rttsRecientes.slice(-4), mejorRtt]
    if (mejorRtt > Math.max(3 * referencia, referencia + 40)) return
    this.clockOffsetMs = mejorOffset
  }

  async pedirEstado(): Promise<EstadoCompleto> {
    return this.emitAck<EstadoCompleto>('state:request', {})
  }

  emitAck<T>(evento: string, payload: unknown, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      this.socket.timeout(timeoutMs).emit(evento, payload, (err: unknown, respuesta: T) => {
        if (err) reject(err)
        else resolve(respuesta)
      })
    })
  }

  emit(evento: string, payload: unknown = {}): void {
    this.socket.emit(evento, payload)
  }

  on<T>(evento: string, cb: (v: T) => void): Desuscribir {
    this.socket.on(evento, cb)
    return () => this.socket.off(evento, cb)
  }

  onEstado(cb: (estado: EstadoCompleto) => void): Desuscribir {
    return this.on('estado:actualizado', cb)
  }

  onPlaybackScheduled(cb: (cmd: ComandoProgramado) => void): Desuscribir {
    return this.on('playback:scheduled', cb)
  }

  onMixer(cb: (m: MixerActualizadoPayload) => void): Desuscribir {
    return this.on('mixer:actualizado', cb)
  }

  onRechazado(cb: (err: ErrorPayload) => void): Desuscribir {
    return this.on('accion:rechazada', cb)
  }

  onDispositivos(cb: (dispositivos: DispositivoInfo[]) => void): Desuscribir {
    return this.on('dispositivos:actualizado', cb)
  }

  onImportProgreso(cb: (p: ImportProgreso) => void): Desuscribir {
    return this.on('import:progreso', cb)
  }

  /**
   * La compu pide el codigo de la banda (o el que se mando no es). Despues de
   * ese rechazo Socket.IO no reintenta solo: se reintenta con `reconectar()`.
   */
  onCodigo(cb: (motivo: MotivoCodigo) => void): Desuscribir {
    const h = (err: Error & { data?: { motivo?: MotivoCodigo } }): void => {
      if (err?.message === 'codigo') cb(err.data?.motivo ?? 'codigo-requerido')
    }
    this.socket.on('connect_error', h)
    return () => this.socket.off('connect_error', h)
  }

  /** Version de prueba (o licencia) con el maximo de celulares ya conectados: no entra. */
  onLicencia(cb: (limite: number, prueba: boolean) => void): Desuscribir {
    const h = (err: Error & { data?: { limite?: number; prueba?: boolean } }): void => {
      if (err?.message === 'licencia') cb(err.data?.limite ?? 0, err.data?.prueba ?? true)
    }
    this.socket.on('connect_error', h)
    return () => this.socket.off('connect_error', h)
  }

  reconectar(): void {
    if (!this.socket.connected) this.socket.connect()
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

  close(): void {
    clearInterval(this.intervalo)
    clearInterval(this.vigilancia)
    this.socket.close()
  }
}
