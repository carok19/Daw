// Modelo de datos (ver spec seccion 4) + protocolo de sincronizacion (seccion 7).
// Compartido entre server (Node) y renderer (browser) — sin dependencias de plataforma.

export interface Pista {
  id: string
  nombre: string
  /** ruta relativa dentro de la carpeta del proyecto */
  archivo: string
  /** 0 a 100 */
  volumen: number
  /** -100 (izquierda) a 100 (derecha), 0 = centro */
  pan: number
  mute: boolean
  solo: boolean
}

export interface Marcador {
  id: string
  nombre: string
  tiempoMs: number
  color?: string
}

export interface Proyecto {
  id: string
  nombre: string
  /** ISO date */
  creadoEn: string
  pistas: Pista[]
  marcadores: Marcador[]
  /** duracion de la pista mas larga */
  duracionTotalMs: number
}

/** Resumen liviano de proyecto guardado en disco, para la lista de "Proyectos guardados". */
export interface ProyectoResumen {
  id: string
  nombre: string
  creadoEn: string
  duracionTotalMs: number
  cantidadPistas: number
  cantidadMarcadores: number
}

export type EstadoTransporte = 'stopped' | 'paused' | 'playing'

/**
 * Estado de reproduccion de una pestana/proyecto, tal como lo administra el servidor.
 * `positionMs` es la posicion valida en `referenceServerTime` (Date.now() del server).
 * Si `estado === 'playing'`, la posicion real en un instante `now >= referenceServerTime`
 * se calcula como `positionMs + (now - referenceServerTime)`.
 */
export interface PlaybackState {
  estado: EstadoTransporte
  positionMs: number
  referenceServerTime: number
}

export interface TabResumen {
  tabId: string
  nombre: string
}

/** Snapshot completo enviado a un cliente que se conecta o reconecta. */
export interface EstadoCompleto {
  tabs: TabResumen[]
  activeTabId: string | null
  locked: boolean
  proyectoActivo: Proyecto | null
  /**
   * Datos completos (pistas, archivos) de TODAS las pestanas abiertas, en el
   * mismo orden que `tabs` (mismo indice = misma pestana) — no solo la
   * activa. Necesario para que un cliente pueda precargar en segundo plano
   * la/las siguientes canciones del setlist antes de que se activen (ver
   * README, "Precarga y cache de audio").
   */
  proyectos: Proyecto[]
  playbackActivo: PlaybackState | null
  serverTime: number
}

export type AccionProgramada = 'play' | 'pause' | 'stop' | 'seek'

/**
 * Comando de reproduccion programado a futuro (seccion 7.3). Todos los clientes
 * traducen `executeAtServerTime` a su reloj local usando el offset calculado
 * en la sincronizacion de reloj, y usan Web Audio API para programar la accion
 * exactamente en ese instante.
 */
export interface ComandoProgramado {
  tabId: string
  accion: AccionProgramada
  positionMs: number
  executeAtServerTime: number
}

export type OrigenCliente = 'compu' | 'celular'

// ---- Payloads de eventos Socket.IO ----

export interface HelloPayload {
  origen: OrigenCliente
}

export interface ClockSyncAck {
  tServer: number
}

// Todos estos comandos operan implicitamente sobre `activeTabId` en el servidor:
// solo la pestana activa reproduce audio (ver README, "Decisiones de diseno"),
// asi que no hace falta que el cliente indique de que pestana habla.

export interface TransportPlayPayload {
  /** si se omite, se reanuda desde la posicion actual */
  positionMs?: number
}
export interface TransportSeekPayload {
  positionMs: number
}
export type TransportSimplePayload = Record<string, never>

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

export interface MixerActualizarPayload {
  pistaId: string
  patch: Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre'>>
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

export interface LockSetPayload {
  locked: boolean
}

export interface ErrorPayload {
  mensaje: string
}

/**
 * Fila del panel "Dispositivos conectados" (seccion 27) / contador junto al QR
 * (seccion 26). Un dispositivo desconectado NO se quita de la lista: queda
 * marcado `conectado: false` para que el operador vea si alguien se cayo a
 * mitad de un culto, en vez de simplemente desaparecer.
 */
export interface DispositivoInfo {
  id: string
  origen: OrigenCliente
  etiqueta: string
  conectado: boolean
  /**
   * Ultimo drift (ms) reportado por ese dispositivo (ver sistema de
   * sincronizacion continua). `null` = todavia no reporto ninguno (recien
   * conectado, o no esta reproduciendo).
   */
  driftMs: number | null
  /** Estado de precarga de cada proyecto que este dispositivo esta siguiendo (ver PreparacionProyecto). */
  preparaciones: PreparacionProyecto[]
}

export interface SyncReportPayload {
  driftMs: number | null
}

/**
 * Distingue "tengo los bytes" de "el audio ya esta realmente listo para
 * reproducirse" (seccion pedida explicitamente: descarga != preparacion):
 * - 'sin-preparar': todavia no se empezo (puede estar en cola detras de
 *   una precarga de mayor prioridad).
 * - 'descargando': bajando el archivo por WiFi (`progreso` 0-1 disponible).
 * - 'preparando': ya se bajaron los bytes, decodificando a AudioBuffer.
 * - 'listo': decodificado y activable desde cache al instante.
 * - 'error': fallo la descarga o la decodificacion.
 */
export type EstadoPreparacion = 'sin-preparar' | 'descargando' | 'preparando' | 'listo' | 'error'

export interface PreparacionProyecto {
  proyectoId: string
  estado: EstadoPreparacion
  /** 0 a 1, solo tiene sentido durante 'descargando'. */
  progreso?: number
}
