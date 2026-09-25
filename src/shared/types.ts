// Modelo de datos + protocolo de sincronizacion, compartido entre server (Node)
// y renderer (browser) — sin dependencias de plataforma.

export interface Pista {
  id: string
  nombre: string
  /** ruta relativa dentro de la carpeta del proyecto (siempre un WAV PCM 16-bit normalizado, ver server/audio.ts) */
  archivo: string
  /** 0 a 100 */
  volumen: number
  /** -100 (izquierda) a 100 (derecha), 0 = centro */
  pan: number
  mute: boolean
  solo: boolean
  /** color de la pista en la UI (#rrggbb), asignado al importar por orden */
  color: string
}

export interface Marcador {
  id: string
  nombre: string
  tiempoMs: number
  color?: string
}

/** Version del formato en disco: 2 = todas las pistas normalizadas a WAV + duracion calculada por el servidor. */
export const FORMATO_PROYECTO_ACTUAL = 2

export interface Proyecto {
  id: string
  nombre: string
  /** ISO date */
  creadoEn: string
  pistas: Pista[]
  marcadores: Marcador[]
  /** duracion de la pista mas larga */
  duracionTotalMs: number
  formato?: number
}

/** Resumen liviano de proyecto guardado en disco, para la lista de "Canciones guardadas". */
export interface ProyectoResumen {
  id: string
  nombre: string
  creadoEn: string
  duracionTotalMs: number
  cantidadPistas: number
  cantidadMarcadores: number
}

export interface SetlistResumen {
  id: string
  nombre: string
  creadoEn: string
  /** nombres de las canciones, en orden (las que ya no existen en disco no se listan) */
  canciones: string[]
}

export type EstadoTransporte = 'stopped' | 'paused' | 'playing'

/** Un tramo de reproduccion: posicion valida en `referenceServerTime` (Date.now() del server). */
export interface TramoReproduccion {
  estado: EstadoTransporte
  positionMs: number
  referenceServerTime: number
}

/**
 * Estado de reproduccion de la pestana activa, tal como lo administra el servidor.
 * Si `estado === 'playing'`, la posicion en `now >= referenceServerTime` es
 * `positionMs + (now - referenceServerTime)`.
 *
 * `previo`: los comandos se programan a futuro (margen para que lleguen a todos
 * los celulares), asi que entre que se emite un salto/pausa y su horario de
 * ejecucion, lo que REALMENTE esta sonando es el tramo anterior. `previo`
 * describe ese tramo (solo si estaba sonando) para que la UI, el monitor de
 * drift y un celular que se une justo en ese momento vean la posicion real y
 * no la futura (ver `posicionActualMs`).
 */
export interface PlaybackState extends TramoReproduccion {
  previo?: TramoReproduccion
}

export interface TabResumen {
  tabId: string
  nombre: string
  proyectoId: string
}

/** Snapshot completo enviado a un cliente que se conecta o ante cambios estructurales. */
export interface EstadoCompleto {
  tabs: TabResumen[]
  activeTabId: string | null
  locked: boolean
  /** repetir la seccion actual (entre el marcador actual y el siguiente) de la pestana activa */
  loop: boolean
  proyectoActivo: Proyecto | null
  /** Proyectos completos de TODAS las pestanas abiertas, mismo orden/indice que `tabs`. */
  proyectos: Proyecto[]
  playbackActivo: PlaybackState | null
  serverTime: number
}

export type AccionProgramada = 'play' | 'pause' | 'stop' | 'seek'

/**
 * Comando de reproduccion programado a futuro. Todos los clientes traducen
 * `executeAtServerTime` a su reloj local usando el offset de reloj y programan
 * el audio con Web Audio para ese instante exacto. `playback` es el nuevo
 * estado autoritativo (incluye `previo`), para que todos lo apliquen igual.
 */
export interface ComandoProgramado {
  tabId: string
  accion: AccionProgramada
  positionMs: number
  executeAtServerTime: number
  playback: PlaybackState
}

export type OrigenCliente = 'compu' | 'celular'

// ---- Payloads de eventos Socket.IO ----

/** `auth` del handshake de Socket.IO. `token` solo lo conoce la ventana de Electron (ver main/index.ts). */
export interface AuthHandshake {
  origen?: OrigenCliente
  token?: string
  /** id estable del dispositivo (localStorage), para no duplicarlo al reconectar */
  deviceId?: string
  /** nombre elegido en el propio celular ("Bateria", "Guitarra"...) */
  nombre?: string
}

export interface ClockSyncAck {
  tServer: number
}

export interface TransportPlayPayload {
  /** si se omite, se reanuda desde la posicion actual */
  positionMs?: number
}
export interface TransportSeekPayload {
  positionMs: number
}

export interface MarcadorCrearPayload {
  tiempoMs: number
  nombre?: string
}
export interface MarcadorActualizarPayload {
  marcadorId: string
  patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>
}
export interface MarcadorEliminarPayload {
  marcadorId: string
}
export interface MarcadorSaltarPayload {
  marcadorId: string
}
export interface MarcadorRestaurarPayload {
  marcador: Marcador
}

export type PatchPista = Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre' | 'color'>>

export interface MixerActualizarPayload {
  pistaId: string
  patch: PatchPista
}
/** Broadcast liviano del mixer (en vez del estado completo en cada movimiento de fader). */
export interface MixerActualizadoPayload {
  proyectoId: string
  pista: Pista
}
export interface PistasReordenarPayload {
  orden: string[]
}

export interface TabsSwitchPayload {
  tabId: string
}
export interface TabsClosePayload {
  tabId: string
}
export interface TabsReordenarPayload {
  orden: string[]
}

export interface LockSetPayload {
  locked: boolean
}
export interface LoopSetPayload {
  activo: boolean
}

export interface ErrorPayload {
  mensaje: string
}

export interface ImportProgreso {
  etapa: 'extrayendo' | 'convirtiendo' | 'listo'
  actual: number
  total: number
  pista?: string
}

export type EstadoBuffer = 'normal' | 'rellenando' | 'critico'

/**
 * Fila del panel "Dispositivos". Un dispositivo desconectado NO se quita de la
 * lista (queda `conectado: false`) para que el operador note si alguien se cayo
 * a mitad de un culto. Se identifica por `deviceId` estable: reconectar
 * reutiliza la misma fila en vez de crear una nueva.
 */
export interface DispositivoInfo {
  id: string
  origen: OrigenCliente
  etiqueta: string
  conectado: boolean
  /** ultimo drift (ms) reportado; null = no esta reproduciendo o todavia no midio */
  driftMs: number | null
  /** estado del buffer de audio (solo mientras reproduce) */
  buffer: EstadoBuffer | null
  /** problema de audio reportado por el dispositivo (p.ej. una pista que no se pudo leer) */
  error: string | null
  /** false = el celular esta conectado pero todavia no toco "Activar audio" (no va a sonar) */
  audio: boolean
  /** Date.now() del server cuando se desconecto (para mostrar "hace X min") */
  desconectadoDesde: number | null
}

export interface SyncReportPayload {
  driftMs: number | null
  buffer?: EstadoBuffer | null
  error?: string | null
  audio?: boolean
}

export interface DeviceRenamePayload {
  nombre: string
}
