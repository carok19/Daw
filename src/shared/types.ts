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
   * 'click'/'guia' = va al oido izquierdo en el paneo automatico; 'normal' = no
   * (aunque el nombre lo parezca). Sin marca: se detecta sola.
   */
  rol?: RolPista
  /**
   * el paneo lo puso la app (click y guia a la izquierda, el resto a la
   * derecha) y se reacomoda si cambia la deteccion; false = se movio a mano
   * y no se toca mas. Sin marca: cancion de antes (ver aplicarPaneoAutomatico).
   */
  panAutomatico?: boolean
}

export type RolPista = 'click' | 'guia' | 'normal'

export interface Marcador {
  id: string
  nombre: string
  tiempoMs: number
  color?: string
  /** de donde salio: puesto a mano, leido de los archivos del zip, o detectado por la voz guia */
  origen?: 'manual' | 'archivo' | 'guia'
  /**
   * la cancion cambia de tonalidad aca ("Coro final: E"): rige desde esta
   * seccion hasta otra que diga otra. En la tonalidad original (con el tono
   * cambiado, se transpone igual que la de la cancion)
   */
  tonalidad?: string
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
  /**
   * compases de cuenta que trae la cancion al principio (desde el primer
   * compas la banda esta en silencio mientras cuentan la guia o el click); 0 =
   * entra directo; sin: todavia no se reviso (ver server/cuenta.ts)
   */
  cuentaPropia?: number
  /** version del detector que lo calculo (las de antes se vuelven a detectar solas, ver VERSION_TEMPO) */
  version?: number
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
  /** tono elegido, en semitonos (−6 a +6; sin o 0 = el original) */
  tono?: number
  /**
   * tono con el que suena ahora (pistas ya preparadas): mientras se prepara
   * el nuevo, sigue sonando este
   */
  tonoAplicado?: number
  /**
   * pistas que suenan preparadas (tono y/o velocidad): con otro tono solo, el
   * click, la guia y la bateria no; con otra velocidad, todas
   */
  tonoPistas?: string[]
  /** velocidad elegida (1 = la original, 0,8 a 1,2; ver shared/velocidad.ts) */
  velocidad?: number
  /**
   * velocidad a la que suena ahora (pistas ya preparadas). Los tiempos de la
   * cancion (secciones, compases, duracion) estan en esta velocidad.
   */
  velocidadAplicada?: number
  /** es un colchón de la lista (pad y click, sin pistas; ver shared/colchon.ts) */
  colchon?: AjustesColchon
  /** tonalidad original puesta a mano ("A", "F#m"); sin: se lee del nombre de la cancion */
  tonalidad?: string
  /** compases de cuenta al dar play (0 = sin cuenta); sin: automatica (2, o 1 en las lentas) */
  cuenta?: 0 | 1 | 2
}

/** Una red en la que esta la compu (Windows la marca como publica o privada). */
export interface RedWindows {
  /** nombre del WiFi (o "Red 2") */
  nombre: string
  categoria: 'publica' | 'privada' | 'dominio'
}

/**
 * ¿El firewall de Windows deja que los celulares encuentren la compu en las
 * redes donde esta? ('desconocido': no es Windows o no se pudo leer.)
 */
export interface EstadoFirewall {
  estado: 'ok' | 'bloqueado' | 'desconocido'
  redes: RedWindows[]
  /** las redes donde la app esta bloqueada */
  bloqueadas: RedWindows[]
}

/** Cuantas pistas ya estan listas del tono que se esta preparando (total 0 = ya no se prepara nada). */
export interface ProgresoTono {
  proyectoId: string
  semitonos: number
  /** velocidad que se esta preparando (1 = la original) */
  velocidad?: number
  hechos: number
  total: number
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
  /** es un colchón (pad y click, sin pistas) */
  colchon?: boolean
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

/**
 * Una lista de canciones para un dia o evento ("Sabado 17/10 · 19 hs"),
 * opcionalmente dentro de una carpeta ("Congreso Juvenil 2026").
 */
export interface ListaResumen {
  id: string
  nombre: string
  /** '' = sin carpeta */
  carpeta: string
  /** AAAA-MM-DD, si se le puso fecha */
  fecha: string | null
  creadoEn: string
  actualizadoEn: string
  /** en orden (las que ya no existen en la compu no se listan) */
  canciones: { id: string; nombre: string; duracionMs: number; bpm: number | null; categoria: string }[]
  /** canciones de la lista que ya no estan en la compu */
  faltantes: number
}

/** La lista cargada en la barra de arriba (lo que se cambie ahi se guarda en ella). */
export interface ListaActiva {
  id: string
  nombre: string
  carpeta: string
}

/** Lo que estaba abierto la ultima vez, si la app se abrio despues de mas de 2 horas ("Seguir donde quede"). */
export interface SesionAnterior {
  lista: string | null
  canciones: number
  /** 1 = la primera */
  actual: number
  nombreActual: string | null
}

export interface DatosListas {
  listas: ListaResumen[]
  carpetas: string[]
  activa: string | null
  sesionAnterior: SesionAnterior | null
}

export type EstadoTransporte = 'stopped' | 'paused' | 'playing'

/** Un tramo de reproduccion: posicion valida en `referenceServerTime` (Date.now() del server). */
export interface TramoReproduccion {
  estado: EstadoTransporte
  positionMs: number
  referenceServerTime: number
  /** cuenta antes de que entre la musica (play desde parado o en pausa) */
  cuenta?: CuentaProgramada
}

/** Un golpe de la cuenta: a que hora (del servidor) suena y que numero es dentro del compas (1 = el "1"). */
export interface GolpeCuenta {
  t: number
  n: number
}

/**
 * Cuenta antes de la cancion ("1 2 3 4, 1 2 3 4"): cada dispositivo la toca
 * con el sonido del click de la cancion, programada con el mismo reloj que la
 * musica, que entra justo despues (en el tiempo de la cancion).
 */
export interface CuentaProgramada {
  golpes: GolpeCuenta[]
  pulsosPorCompas: number
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
  /** la voz que lo avisa ("Coro… 3, 4"); null = sin voces importadas o no entra */
  anuncio?: AnuncioSalto | null
  /** "Terminar con fundido": en el limite la cancion no salta, se apaga (ver FundidoFinal) y para */
  fin?: boolean
}

/**
 * La cancion se esta apagando ("Terminar con fundido"): desde `desde` (hora
 * del servidor) baja a silencio en `ms`, igual en todos los dispositivos, y
 * ahi para (vuelve al principio, como al terminar sola).
 */
export interface FundidoFinal {
  desde: number
  ms: number
}

/** Aviso del servidor: empieza el fundido o (con `vuelve`) se cancelo a mitad y la musica vuelve a esa hora. */
export interface AvisoFundido extends FundidoFinal {
  tabId: string
  vuelve?: number
}

/** Duraciones del fundido que se pueden elegir (ms). */
export const DURACIONES_FUNDIDO = [2000, 4000, 6000, 8000]
export const FUNDIDO_POR_DEFECTO_MS = 4000

/**
 * Voz que avisa un salto (ver shared/anuncio.ts): suena en el ultimo compas
 * antes del salto, con el volumen y el paneo de la guia, y mientras tanto la
 * guia de la cancion no se escucha. Los celulares lo reciben ya dentro de su
 * mezcla (piden esos pedazos con `&a=<id>`); la compu baja /anuncio/<id>.wav.
 */
export interface AnuncioSalto {
  id: string
  /** posicion de la cancion donde empieza y termina (= donde se salta) */
  desdeMs: number
  hastaMs: number
  /** pista con cuyo volumen y paneo suena la voz (la guia; si no hay, el click) */
  pistaId: string | null
  /** la guia de la cancion, que se calla mientras tanto */
  guiaPistaId: string | null
}

/** Un colchón de la lista: pad y click, sin pistas (ver shared/colchon.ts). */
export interface AjustesColchon {
  /** tonalidad del pad ("D", "F#"); null = sin pad (solo click) */
  tonalidad: string | null
  bpm: number
  /** pulsos por compás */
  compas: number
  /** con click (si no, solo el pad) */
  click: boolean
  /** 0-100 */
  volumenPad: number
  volumenClick: number
}

/**
 * Colchón sonando (de la lista, o dentro de una canción: la banda paró y
 * siguen el click y el pad). Cada dispositivo programa el click y el pad a
 * estas horas del servidor.
 */
export interface ColchonActivo {
  id: string
  tabId: string
  /** hora del servidor en que empezó (entra el pad; dentro de una canción, se empieza a ir la banda) */
  empezo: number
  /**
   * hora del servidor de un "1" de compás: los golpes se cuentan desde acá
   * (es `empezo`, salvo que se haya cambiado el BPM sonando: ahí, el primer "1" del pulso nuevo)
   */
  inicio: number
  /**
   * hora del servidor en que el pad empieza a entrar: dentro de una canción,
   * por debajo de la banda antes de que se vaya (cuando se va, ya está
   * entero); de la lista, `empezo`
   */
  padDesde?: number
  /** de que pads se trata ('app' o el pack propio): va en la direccion del pad (nadie usa los de antes guardados) */
  padsRevision?: string
  /** se prendio con la cancion parada o en pausa: no hay banda que se vaya (el click entra entero y el pad despacio) */
  sinBanda?: boolean
  compasMs: number
  pulsos: number
  /** dentro de una canción: la banda se apaga en el primer compás (de `empezo` a `empezo + compasMs`) */
  desdeCancion: boolean
  /** nota del pad ("D", "F#"); null = sin pad */
  pad: string | null
  click: boolean
  /** 0-100 */
  volumenPad: number
  volumenClick: number
  /** hora del servidor en que termina (vuelve la canción o se apaga): el click para ahí; null = sigue */
  hasta: number | null
  /** en cuánto se apaga el pad desde `hasta` (volviendo a la canción, rápido; al terminar, despacio) */
  salidaPadMs: number
}

/** Forma de onda de la cancion entera (el "recorrido"): la banda, sin click ni guia (ver server/onda.ts). */
export interface OndaCancion {
  /** revision del audio con la que se calculo */
  revision: number
  msPorPunto: number
  /** 0 a 100 */
  puntos: number[]
}

/** El pack de voces importado en la compu (para avisar los saltos). */
export interface InfoVoces {
  idioma: 'es' | 'en' | 'otro'
  /** avisar los saltos con voz (se puede apagar sin borrar el pack) */
  activo: boolean
  /** son las voces que trae la app (no se importo ningun pack) */
  deFabrica?: boolean
  cantidad: number
  /** tiene los numeros para contar ("3, 4") */
  numeros: boolean
  /** algunas secciones que trae (Coro, Verso...) */
  ejemplos: string[]
}

/** Pads propios del colchón (importados en la compu, en vez de los de la app). */
export interface InfoPads {
  /** nombre del archivo que se importó */
  nombre: string
  /** usarlos (si no, suenan los de la app) */
  activo: boolean
  /** los tonos que trae el pack; los demás se hicieron con rubberband desde el más cercano */
  originales: string[]
  revision: string
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
  /** la cancion se esta apagando ("Terminar con fundido"; null = no) */
  fundido?: FundidoFinal | null
  /** cuanto tarda en apagarse con "Terminar" (ms) */
  fundidoMs?: number
  /** voces para avisar los saltos (null = no se importo ningun pack) */
  voces?: InfoVoces | null
  /** pads propios del colchón (null = no se importaron: suenan los de la app) */
  pads?: InfoPads | null
  /** colchón sonando en la canción de arriba (null = no) */
  colchon?: ColchonActivo | null
  /** la lista del dia cargada arriba (null = canciones sueltas) */
  lista: ListaActiva | null
  /** AirTracks Video (null = nunca se conecto) */
  pantallaVideo?: EstadoPantallaVideo | null
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

/** `video`: AirTracks Video, la compu del proyector (no cuenta como celular: no frena ni cambia nada de los celulares) */
export type OrigenCliente = 'compu' | 'celular' | 'video'

/**
 * Para que usa la app cada celular: cada uno ve (y escucha) lo suyo.
 * - director: maneja la cancion (play, secciones, repetir, colchon)
 * - musico: su mezcla y por donde va la cancion (sin controles)
 * - voz: la seccion bien grande, lo que sigue y el tono; mezcla simple
 * - sonido: va a la consola: la banda sola, sin click ni guia (y sin voces de aviso ni talkback)
 * - multimedia: lo que sigue y cuanto falta, para las pantallas (sin audio salvo que lo pida)
 */
export type RolDispositivo = 'director' | 'musico' | 'voz' | 'sonido' | 'multimedia'

export const ROLES: RolDispositivo[] = ['director', 'musico', 'voz', 'sonido', 'multimedia']

/** El celular de Sonido: ademas de la banda, que va a los parlantes (para un ensayo, por ejemplo). */
export interface SalidaSonido {
  click: boolean
  guia: boolean
}

/** AirTracks Video (la compu del proyector): si esta conectada y para que canciones tiene video. */
export interface EstadoPantallaVideo {
  conectada: boolean
  /** nombre de la compu del proyector */
  nombre: string
  /** canciones (ids) con video cargado */
  canciones: string[]
}

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
  /** el rol que tenia guardado este celular (si la compu no lo conoce, se usa este) */
  rol?: string
  salida?: SalidaSonido
  /** el celular cambio de rol sin conexion: manda el suyo (si no, manda lo que recuerda la compu) */
  rolPendiente?: boolean
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
  /** tonalidad: null = sin cambio de tono en esta seccion */
  patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>> & { tonalidad?: string | null }
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
  /** para que lo usa (solo celulares; null = todavia no eligio: como Musico) */
  rol: RolDispositivo | null
  /** el celular de Sonido: que mas va a la consola ademas de la banda */
  salida: SalidaSonido | null
  /** ajuste fino de sincronizacion del dispositivo (ms; + = suena despues) */
  ajusteMs: number
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
  /** (sin este campo: no cambia el desfase anotado; p.ej. un aviso de que cambio el ajuste fino) */
  driftMs?: number | null
  /** ajuste fino de este dispositivo (ms) */
  ajusteMs?: number
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
  /** espera desde que se toca play hasta que suena, y lo que tarda en llegarle una orden al celular mas lento (ida y vuelta) */
  arranque?: { margenMs: number; peorEntregaMs: number | null }
}

/** Lo que mide cada celular del talkback (la compu hablando a los oidos) o de la banda en vivo. */
export interface MedicionTalkback {
  /** cuanto despues de hablar se escucha (la espera que se ajusta sola) */
  objetivoMs: number
  /** cuanto tarda en llegar por el WiFi (el 95 % de los pedazos llega en menos); null = todavia no llego nada */
  redMs: number | null
  /** cuanto tarda el celular en sacar el audio (parlante o auriculares; con Bluetooth, mucho mas) */
  salidaMs?: number
  /** pedazos que llegaron tarde (de los ultimos 500) */
  tardes: number
}

export interface DiagnosticoDispositivo extends DiagnosticoAudio {
  /** resincronizaciones duras (desfase grande o vuelta despues de un corte) */
  resyncs: number
  /** talkback recibido (null = nunca le hablaron) */
  talkback?: MedicionTalkback | null
  /** banda en vivo recibida (null = todavia no le llego) */
  banda?: MedicionTalkback | null
  /** "Android · Chrome", "iPhone · Safari", "App Android"... */
  plataforma: string
}

export interface DeviceRenamePayload {
  nombre: string
}
