import { io, type Socket } from 'socket.io-client'
import type { ComandoProgramado, EstadoCompleto, ProyectoResumen } from '../../shared/types'
import type { InfoConexion, RespuestaHuellaCancion } from '../tipos'
import { buscarCompu } from './descubrir'

export interface OpcionesConexion {
  deviceId: string
  /** nombre de esta compu (se ve en AirTracks) */
  nombre: string
  codigo(): string | null
  /** la ultima compu donde se conecto (se prueba primero) */
  servidorGuardado(): string | null
  guardarServidor(url: string): void
  /** cambio la conexion (para la ventana de control) */
  alCambiar(): void
  /** llego algo de la reproduccion (estado o un comando programado) */
  alReproduccion(): void
  alConectar(): void
  /** puerto de la busqueda (los tests usan otro) */
  puertoBusqueda?: number
}

const MUESTRAS_RELOJ = 7

/**
 * La conexion con la compu de AirTracks: la busca en la red, entra como
 * "pantalla de video" (no cuenta como celular: no recibe audio ni cambia
 * nada de los celulares) y sigue la reproduccion con el mismo reloj.
 */
export class ConexionAirTracks {
  info: InfoConexion = { estado: 'buscando', servidor: null, nombreServidor: null }
  /** hora del servidor - hora de esta compu (ms) */
  relojMs = 0
  estado: EstadoCompleto | null = null
  private socket: Socket | null = null
  private fallos = 0
  private buscando = false
  private detenido = false
  private timerReloj: ReturnType<typeof setInterval> | null = null
  private timerOcupado: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly op: OpcionesConexion) {}

  iniciar(): void {
    const guardado = this.op.servidorGuardado()
    if (guardado) this.conectar(guardado, null)
    else void this.buscar()
  }

  detener(): void {
    this.detenido = true
    this.cerrarSocket()
  }

  get conectado(): boolean {
    return this.info.estado === 'conectado'
  }

  /** El usuario puso el codigo de la banda: se reintenta con ese. */
  reintentar(): void {
    if (this.socket && !this.socket.connected) this.socket.connect()
    else if (!this.socket) void this.buscar()
  }

  /** Direccion escrita a mano (null = volver a buscar sola). */
  usarDireccion(url: string | null): void {
    this.cerrarSocket()
    if (url) this.conectar(url, null)
    else void this.buscar()
  }

  private cambiar(info: Partial<InfoConexion>): void {
    this.info = { ...this.info, ...info }
    this.op.alCambiar()
  }

  private cerrarSocket(): void {
    if (this.timerReloj) clearInterval(this.timerReloj)
    if (this.timerOcupado) clearTimeout(this.timerOcupado)
    this.timerReloj = null
    this.timerOcupado = null
    this.socket?.removeAllListeners()
    this.socket?.close()
    this.socket = null
    this.estado = null
    this.op.alReproduccion()
  }

  /** Busca la compu en la red hasta encontrarla. */
  private async buscar(): Promise<void> {
    if (this.buscando || this.detenido) return
    this.buscando = true
    this.cambiar({ estado: 'buscando' })
    try {
      while (!this.detenido && !this.socket) {
        const [compu] = await buscarCompu(2500, this.op.puertoBusqueda)
        if (compu) {
          this.conectar(compu.url, compu.nombre)
          break
        }
      }
    } finally {
      this.buscando = false
    }
  }

  private conectar(url: string, nombre: string | null): void {
    if (this.detenido) return
    this.cerrarSocket()
    this.fallos = 0
    this.cambiar({ estado: 'conectando', servidor: url, nombreServidor: nombre ?? this.info.nombreServidor, motivoCodigo: undefined })
    const socket = io(url, {
      auth: (cb) => cb({ origen: 'video', deviceId: this.op.deviceId, nombre: this.op.nombre, codigo: this.op.codigo() ?? undefined }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    })
    this.socket = socket
    socket.on('connect', () => {
      this.fallos = 0
      this.op.guardarServidor(url)
      this.cambiar({ estado: 'conectado', motivoCodigo: undefined })
      void this.sincronizarReloj().then(() => this.pedirEstado())
      if (this.timerReloj) clearInterval(this.timerReloj)
      this.timerReloj = setInterval(() => void this.sincronizarReloj(), 60_000)
      this.op.alConectar()
    })
    socket.on('disconnect', () => {
      if (this.socket !== socket) return
      this.cambiar({ estado: 'conectando' })
      this.op.alReproduccion()
    })
    socket.on('connect_error', (err: Error & { data?: { motivo?: InfoConexion['motivoCodigo'] } }) => {
      if (this.socket !== socket) return
      if (err.message === 'codigo') {
        this.cambiar({ estado: 'codigo', motivoCodigo: err.data?.motivo ?? 'codigo-requerido' })
        return
      }
      if (err.message === 'video-ocupado') {
        // otra pantalla de video conectada: se vuelve a probar en un rato
        this.cambiar({ estado: 'ocupado' })
        this.timerOcupado = setTimeout(() => socket.connect(), 10_000)
        return
      }
      // la compu no contesta: puede haber cambiado de direccion (otro WiFi, el router le dio otra IP)
      this.fallos++
      if (this.fallos >= 3) {
        this.cerrarSocket()
        void this.buscar()
      }
    })
    socket.on('estado:actualizado', (e: EstadoCompleto) => {
      this.estado = e
      this.revisarVersion(e)
      this.op.alReproduccion()
    })
    socket.on('playback:scheduled', (cmd: ComandoProgramado) => {
      if (!this.estado || cmd.tabId !== this.estado.activeTabId) return
      this.estado = { ...this.estado, playbackActivo: cmd.playback }
      this.op.alReproduccion()
    })
  }

  private async pedirEstado(): Promise<void> {
    const e = await this.pedir<EstadoCompleto>('state:request', {})
    if (e) {
      this.estado = e
      this.revisarVersion(e)
      this.op.alReproduccion()
    }
  }

  /** Las versiones de AirTracks que saben de videos siempre mandan `pantallaVideo` (aunque sea null). */
  private revisarVersion(e: EstadoCompleto): void {
    const desactualizado = !('pantallaVideo' in e)
    if (desactualizado !== !!this.info.desactualizado) this.cambiar({ desactualizado })
  }

  /** Como los celulares: varias idas y vueltas, y se queda con la mas rapida. */
  private async sincronizarReloj(): Promise<void> {
    let mejor = { rtt: Infinity, offset: this.relojMs }
    for (let i = 0; i < MUESTRAS_RELOJ; i++) {
      const t0 = Date.now()
      const r = await this.pedir<{ tServer: number }>('clock:sync', {}, 2000)
      const t1 = Date.now()
      if (r && t1 - t0 < mejor.rtt) mejor = { rtt: t1 - t0, offset: r.tServer - (t0 + t1) / 2 }
    }
    this.relojMs = mejor.offset
    this.op.alReproduccion()
  }

  private pedir<T>(evento: string, payload: unknown, ms = 10_000): Promise<T | null> {
    const socket = this.socket
    if (!socket?.connected) return Promise.resolve(null)
    return new Promise((resolve) => socket.timeout(ms).emit(evento, payload, (err: unknown, r: T) => resolve(err ? null : r)))
  }

  emitir(evento: string, payload: unknown): void {
    if (this.socket?.connected) this.socket.emit(evento, payload)
  }

  async canciones(): Promise<ProyectoResumen[]> {
    return (await this.pedir<ProyectoResumen[]>('projects:list', {})) ?? []
  }

  /** La huella de la cancion: lista, o cuanto le falta a la compu para tenerla (se vuelve a preguntar). */
  async huella(proyectoId: string): Promise<RespuestaHuellaCancion> {
    if (this.info.desactualizado) return { estado: 'desactualizado' }
    if (!this.socket?.connected) return { estado: 'sin-conexion' }
    type R =
      | { estado: 'lista'; huella: ArrayBuffer | Uint8Array; duracionMs: number }
      | { estado: 'calculando'; hechas: number; total: number }
      | { estado: 'esperando' }
      | { estado: 'error'; mensaje: string }
    const r = await this.pedir<R>('video:huella', { proyectoId }, 30_000)
    if (!r) return this.info.desactualizado ? { estado: 'desactualizado' } : { estado: 'sin-conexion' }
    if (r.estado === 'lista') return { ...r, huella: r.huella instanceof Uint8Array ? r.huella : new Uint8Array(r.huella) }
    return r
  }
}
