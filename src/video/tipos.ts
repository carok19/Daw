import type { PlaybackState, ProyectoResumen } from '../shared/types'
import type { Alineacion } from '../shared/huella'

/**
 * AirTracks Video: programa aparte que va en la compu del proyector (la del
 * data, con Holyrics). Tiene los videos con la letra; la compu de AirTracks
 * solo le dice que suena y en que momento (como a los celulares, pero sin
 * audio), y el video sigue la cancion: play, pausa, saltos de seccion,
 * repetir, velocidad. Corre en Windows 7 en adelante (Electron 22).
 */

export type EstadoConexion =
  /** buscando la compu de AirTracks en la red */
  | 'buscando'
  | 'conectando'
  | 'conectado'
  /** la compu pide el codigo de la banda (o el que se puso no es) */
  | 'codigo'
  /** ya hay otra pantalla de video conectada */
  | 'ocupado'

export interface InfoConexion {
  estado: EstadoConexion
  /** direccion de la compu (http://ip:puerto) */
  servidor: string | null
  /** nombre de la compu ("AirTracks · PC-IGLESIA") */
  nombreServidor: string | null
  /** el codigo que se puso no es / se bloqueo por intentos */
  motivoCodigo?: 'codigo-requerido' | 'codigo-incorrecto' | 'codigo-bloqueado'
  /** la compu tiene una version de AirTracks de antes de los videos (hay que actualizarla) */
  desactualizado?: boolean
}

export type EstadoVideo =
  /** calculando la huella del video y comparandola con la cancion */
  | 'alineando'
  /** la compu de AirTracks esta tocando: se alinea cuando pare la musica */
  | 'esperando-musica'
  /** sin conexion con la compu: se alinea al conectar */
  | 'sin-conexion'
  | 'listo'
  /** no se pudo alinear solo (otra version, o editado): ajustar a mano */
  | 'revisar'
  /** la compu de AirTracks tiene una version de antes de los videos */
  | 'desactualizado'
  | 'error'

export interface VideoGuardado {
  proyectoId: string
  /** nombre de la cancion en AirTracks (al vincularlo) */
  cancion: string
  /** el archivo, en la carpeta de videos ("Santo.mp4") */
  archivo: string
  /** nombre original del archivo (para mostrar) */
  nombreArchivo: string
  duracionSeg: number
  /** tiempo del video = tiempo de la cancion + desfaseMs (null = todavia no se sabe) */
  desfaseMs: number | null
  alineacion: (Alineacion & { segura: boolean; manual: boolean }) | null
  estado: EstadoVideo
  mensaje?: string
  agregado: string
}

export interface PantallaDisponible {
  id: number
  nombre: string
  principal: boolean
}

export interface EstadoApp {
  conexion: InfoConexion
  videos: VideoGuardado[]
  pantallas: PantallaDisponible[]
  /** pantalla donde se muestra el video (el proyector); null = la que no es la principal, si hay */
  pantallaId: number | null
  inicioConWindows: boolean
  /** la cancion que esta arriba en AirTracks */
  cancionActiva: { id: string; nombre: string } | null
  version: string
  /** carpeta de los videos (cada uno con su alineacion al lado: se copia a otra compu tal cual) */
  carpeta: string
  /** false = todavia no se confirmo donde guardarlos (la primera vez) */
  carpetaConfirmada: boolean
  /** videos de la carpeta que no son de ninguna cancion (todavia) */
  sueltos: string[]
  /** videos que se estan copiando a la carpeta (se miran cuando terminen) */
  copiandose: number
  /** canciones de los videos que no estan en este AirTracks (proyectoId) */
  sinCancion: string[]
}

/** Lo que la ventana del proyector necesita para seguir la cancion. */
export interface Reproduccion {
  conectado: boolean
  proyectoId: string | null
  /** velocidad a la que suena la cancion (1 = la original) */
  velocidad: number
  playback: PlaybackState | null
  /** hora del servidor - hora de esta compu (ms) */
  relojMs: number
  videos: VideoGuardado[]
}

export type RespuestaHuellaCancion =
  | { estado: 'lista'; huella: Uint8Array; duracionMs: number }
  /** la compu la esta calculando: `hechas` de `total` pasos */
  | { estado: 'calculando'; hechas: number; total: number }
  | { estado: 'esperando' }
  | { estado: 'sin-conexion' }
  /** la compu tiene una version de AirTracks de antes de los videos */
  | { estado: 'desactualizado' }
  | { estado: 'error'; mensaje: string }

/** Lo que el preload le da a las ventanas (window.airtracksVideo). */
export interface ApiVideo {
  estado(): Promise<EstadoApp>
  onEstado(cb: (e: EstadoApp) => void): void
  canciones(): Promise<ProyectoResumen[]>
  elegirArchivos(): Promise<string[]>
  /** `ruta`: el archivo (o solo el nombre, si ya esta en la carpeta de videos) */
  agregarVideo(ruta: string, proyectoId: string, cancion: string): Promise<VideoGuardado | { error: string }>
  /** lo copia a la carpeta sin cancion (sin conexion: se vincula solo al conectar) */
  copiarSuelto(ruta: string): Promise<{ archivo: string } | { error: string }>
  borrarSuelto(archivo: string): Promise<void>
  quitarVideo(proyectoId: string): Promise<void>
  elegirCarpeta(): Promise<{ ok: boolean; error?: string }>
  confirmarCarpeta(): void
  abrirCarpeta(): void
  actualizarVideo(proyectoId: string, cambio: Partial<Pick<VideoGuardado, 'desfaseMs' | 'alineacion' | 'estado' | 'mensaje' | 'duracionSeg'>>): Promise<void>
  huellaCancion(proyectoId: string): Promise<RespuestaHuellaCancion>
  /** huella del video ya calculada (para no decodificarlo de nuevo) */
  leerHuellaVideo(proyectoId: string): Promise<Uint8Array | null>
  guardarHuellaVideo(proyectoId: string, huella: Uint8Array): Promise<void>
  usarCodigo(codigo: string): void
  usarDireccion(direccion: string | null): void
  elegirPantalla(id: number): void
  probarPantalla(): void
  inicioConWindows(activo: boolean): void
  /** direccion para el <video> y para leer el archivo (protocolo propio, con saltos) */
  urlDeVideo(archivo: string): string
  // ---- ventana del proyector ----
  onReproduccion(cb: (r: Reproduccion) => void): void
  onPrueba(cb: () => void): void
  mostrarPantalla(visible: boolean): void
}
