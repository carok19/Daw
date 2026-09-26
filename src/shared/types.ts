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
  /**
   * marcada a mano en la compu: 'click'/'guia' van al oido izquierdo con "Click y
   * guia a la izquierda"; 'normal' = no (aunque el nombre lo parezca). Sin marca: automatico.
   */
  rol?: RolPista
}

export type RolPista = 'click' | 'guia' | 'normal'

export interface Marcador {
  id: string
  nombre: string
  tiempoMs: number
  color?: string
  /** de donde salio: puesto a mano, leido de los archivos del zip, o detectado por la voz guia */
  origen?: 'manual' | 'archivo' | 'guia'
}

/** Tempo detectado a partir de la pista de click. */
export interface TempoProyecto {
  bpm: number
  /** pulsos por compas (4 = 4/4, 3 = 3/4, 6 = 6/8...) */
  compas: number
  /** inicio (ms) de cada compas, de principio a fin de la cancion */
  compasesMs: number[]
  clickPistaId: string | null
  /** false = no se distinguio el acento del "1": los compases se contaron desde el primer golpe */
  acentoClaro: boolean
  /** con click sin acento, el "1" se dedujo de donde termina de hablar la voz guia */
  faseDesdeGuia?: boolean
}

/** Frase hablada de la voz guia, recortada para reconocerla ("Verso uno", "Coro"...). */
export interface CueVoz {
  n: number
  inicioMs: number
  finMs: number
  /** audio 16 kHz mono float32 servido en /media/<proyecto>/analisis/cue-<n>.f32 */
  archivo: string
}

export type EstadoAnalisis =
  | 'analizando' // click/tempo/guia en curso en el servidor
  | 'esperando-voz' // falta reconocer las frases de la guia (lo hace la compu)
  | 'reconociendo'
  | 'falta-modelo' // no esta descargado el reconocedor de voz
  | 'listo'
  | 'sin-guia'
  | 'error'

export interface AnalisisProyecto {
  estado: EstadoAnalisis
  /** de donde salieron las secciones automaticas */
  fuente: 'archivo' | 'guia' | null
  guiaPistaId: string | null
  cues?: CueVoz[]
  mensaje?: string
  /** si al terminar se deben reemplazar las secciones existentes (pedido explicito "Detectar") */
  reemplazar?: boolean
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
  tempo?: TempoProyecto | null
  analisis?: AnalisisProyecto
  /** subcarpeta de la biblioteca ("Adoración", "Navidad/2024"...) */
  categoria?: string
  /** ultima vez que se abrio en el setlist o se reprodujo (ISO) */
  usadoEn?: string
  /** sube cada vez que se reemplaza el audio (zip actualizado): los dispositivos descartan lo que tenian */
  revision?: number
  /**
   * alguien toco las secciones a mano (agrego, movio, renombro o borro): ya son
   * del usuario, y ni un zip actualizado ni un analisis automatico las pisan
   * (solo "Detectar", que lo pide explicitamente)
   */
  seccionesEditadas?: boolean
}

/** Resumen liviano de proyecto guardado en disco, para la lista de "Canciones guardadas". */
export interface ProyectoResumen {
  id: string
  nombre: string
  creadoEn: string
  duracionTotalMs: number
  cantidadPistas: number
  cantidadMarcadores: number
  categoria: string
  usadoEn: string | null
  bpm: number | null
  compas: number | null
  analisis: EstadoAnalisis | null
}

/** Estado de la carpeta de biblioteca (importacion automatica de .zip). */
export interface EstadoBiblioteca {
  ruta: string | null
  /** canciones esperando/importandose */
  pendientes: number
  importando: string | null
  /** true mientras se espera a que termine de sonar la cancion para importar */
  esperandoSilencio: boolean
  ultimoError: string | null
}

export type EstadoModeloVoz = 'listo' | 'falta' | 'descargando' | 'error'

export interface InfoModeloVoz {
  estado: EstadoModeloVoz
  progreso?: number
  mensaje?: string
  /** URL base (del servidor local) desde donde el reconocedor carga el modelo */
  url?: string
}

/** Pedido de reconocimiento de voz que la compu tiene que resolver. */
export interface PedidoVoz {
  proyectoId: string
  nombre: string
  cues: CueVoz[]
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
  /** lo que suena hasta `referenceServerTime` (puede a su vez tener un comando pendiente: cadena corta) */
  previo?: PlaybackState
}

export interface TabResumen {
  tabId: string
  nombre: string
  proyectoId: string
  /** donde arranca esta cancion si se pasa a ella (queda pausada donde se la dejo); los celulares precargan desde ahi */
  posicionMs: number
}

/**
 * Cuando se elige una seccion con la cancion sonando, el salto se hace en el
 * limite (al terminar la seccion actual, o en el proximo compas) para que la
 * musica siga sin cortes; 'inmediato' salta enseguida (con el margen de sync).
 */
export type ModoSalto = 'seccion' | 'compas' | 'inmediato'

/** Salto elegido que todavia no llego a su limite (se puede cambiar o cancelar). */
export interface SaltoPendiente {
  /** inicio de la seccion a la que se va */
  destinoMs: number
  nombre: string
  /** posicion de la cancion donde se salta (fin de la seccion actual o un compas) */
  limiteMs: number
  /** hora del servidor en la que suena el salto */
  tSalto: number
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
  modoSalto: ModoSalto
  saltoPendiente: SaltoPendiente | null
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
  /** codigo de la banda, si la compu lo pide */
  codigo?: string
}

/** Por que la compu no dejo conectar a un celular (error de conexion con mensaje "codigo"). */
export type MotivoCodigo = 'codigo-requerido' | 'codigo-incorrecto' | 'codigo-bloqueado'

/** Lo que hace falta para sumar otro celular (QR, enlaces, codigo, WiFi). */
export interface DatosInvitacion {
  /** http://IP:puerto (la IP de la compu en la red de quien pregunta) */
  url: string
  /** http://IP, si la compu pudo usar el puerto 80 */
  urlCorta: string | null
  /** http://airtracks.local(:puerto): no cambia aunque cambie la IP (iPhone y la app Android) */
  urlFija: string
  codigo: string | null
  wifi: { ssid: string; clave: string } | null
  /** la compu tiene la app Android para bajar */
  apk: boolean
}

/** Ajustes de conexion que ve y cambia la compu. */
export interface AjustesConexion {
  codigoBanda: string | null
  wifi: { ssid: string; clave: string } | null
  direcciones: string[]
  puerto: number
  puertoCorto: number | null
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
  /** sonando: saltar ya, sin esperar el proximo compas */
  inmediato?: boolean
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
/** Ir a una seccion: por posicion (el inicio de la seccion) o relativa a la actual/pendiente (±1). */
export interface SeccionSaltarPayload {
  posicionMs?: number
  relativo?: number
  /** saltar ya, sin esperar el limite (Shift en la compu) */
  inmediato?: boolean
}
export interface MarcadorRestaurarPayload {
  marcador: Marcador
}

export type PatchPista = Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre' | 'color'>> & { rol?: RolPista | null }

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
  /** ultimas mediciones del dispositivo (WiFi, colchon, cortes) */
  diag?: DiagnosticoDispositivo | null
}

export interface SyncReportPayload {
  driftMs: number | null
  buffer?: EstadoBuffer | null
  error?: string | null
  audio?: boolean
  diag?: DiagnosticoDispositivo | null
}

/** Lo que mide el motor de audio de un dispositivo (para ver si el WiFi alcanza y si hubo cortes). */
export interface DiagnosticoAudio {
  /** 'mezcla' = una pista estereo mezclada por la compu; 'pistas' = todas las pistas sueltas */
  modo: 'mezcla' | 'pistas'
  /** lo que hace falta bajar para que suene (Mbps) */
  mbpsNecesarios: number
  /** lo que bajo en los ultimos 20 s (Mbps) */
  mbpsRecibidos: number
  /** la velocidad que dio el WiFi mientras bajaba (Mbps); null = todavia no hay datos */
  mbpsCapacidad: number | null
  /** segundos de audio listos por delante */
  colchonSeg: number
  /** veces que se quedo sin audio mientras sonaba */
  cortes: number
  /** correcciones finas de sync */
  correcciones: number
  /** pedidos de audio que fallaron */
  errores: number
  /** demora promedio de cada pedido de audio (ms) */
  latenciaMs: number | null
  /** audio guardado en memoria (MB) */
  memoriaMB: number
  /** latencia de salida de audio del dispositivo (ms) */
  salidaMs: number
}

/** Licencia de la compu (ver shared/licencia.ts y server/licencia.ts). */
export interface EstadoLicencia {
  /** la app usa licencias (trae la clave publica del vendedor) */
  configuradas: boolean
  activa: boolean
  /** sin licencia valida: version de prueba (hasta `celularesPrueba` celulares) */
  prueba: boolean
  celularesPrueba: number
  /** codigo de esta compu (para licencias atadas a una compu) */
  equipo: string
  nombre?: string
  /** celulares a la vez que permite la licencia (0 = sin limite) */
  celulares?: number
  vence?: string | null
  atadaAEquipo?: boolean
  id?: string
  /** por que la licencia guardada no vale (vencio, es de otra compu...) */
  error?: string
}

/** Todo lo que la compu junta para "Copiar diagnostico". */
export interface DiagnosticoServidor {
  version: string
  sistema: string
  direcciones: string[]
  puerto: number
  puertoCorto: number | null
  mezcla: { pedidos: number; aciertosCache: number; mezclados: number; msPromedio: number; msMax: number; bytes: number } | null
  licencia: string
  cancion: { nombre: string; pistas: number; duracionMs: number; bpm: number | null } | null
  dispositivos: DispositivoInfo[]
}

export interface DiagnosticoDispositivo extends DiagnosticoAudio {
  /** resincronizaciones duras (desfase grande o vuelta despues de un corte) */
  resyncs: number
  /** "Android · Chrome", "iPhone · Safari", "App Android"... */
  plataforma: string
}

export interface DeviceRenamePayload {
  nombre: string
}
