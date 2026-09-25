// Parametros del streaming por segmentos (ver README "Streaming progresivo").
// Centralizados aca para poder probar distintos valores en pruebas de campo
// sin tocar la logica de StreamingEngine.
import { SEGMENTO_SEC } from '@shared/mezcla'

/** Duracion (seg) de cada segmento de audio pedido al servidor. */
export const SEGMENT_DURATION_SEC = SEGMENTO_SEC

/**
 * Colchon: segundos de audio futuro ya bajado. Con la mezcla hecha en la compu
 * (celulares) es una sola pista estereo (~1,4 Mbps): 20 s aguantan un bajon
 * largo del WiFi sin que se note. Con todas las pistas sueltas (la compu,
 * que las lee de su propio disco) alcanza con menos.
 */
export const BUFFER_TARGET_SEC = { mezcla: 20, pistas: 8 } as const

/** Por debajo de esto el buffer se considera critico (se avisa en la compu). */
export const BUFFER_CRITICAL_SEC = 3

/** Minimo de buffer (seg) requerido antes de programar un arranque/reingreso a sync. */
export const BUFFER_MIN_START_SEC = 3

/**
 * Cuanto audio se deja programado (encadenado en Web Audio) por delante. Lo
 * demas espera bajado en memoria: asi una correccion de sync o un cambio de
 * mezcla se aplican en segundos, sin rehacer mucho.
 */
export const HORIZONTE_PROGRAMADO_SEC = 4

/** Pedidos HTTP simultaneos por pista (en modo mezcla hay una sola). */
export const MAX_FETCHES_POR_PISTA = { mezcla: 4, pistas: 3 } as const

/** Pedidos HTTP simultaneos en total (como minimo uno por pista): el navegador baja ~6 a la vez por servidor. */
export const MAX_FETCHES_GLOBAL = 8

/**
 * Cuantos marcadores (secciones) se mantienen "precargados": los primeros
 * segundos de cada seccion quedan en memoria para que un salto de marcador o
 * "repetir seccion" arranque en sync sin esperar la red.
 */
export const MAX_CUES = 16

/** Segmentos precargados por cada marcador (2 x 2s cubren el minimo de arranque). */
export const SEGMENTOS_POR_CUE = 2

/**
 * Segmentos del principio de la SIGUIENTE cancion del setlist que se bajan de
 * antemano (con la actual ya asegurada y de a poco): al pasar de cancion, el
 * celular arranca sin esperar la red.
 */
export const SEGMENTOS_PRECARGA_SIGUIENTE = 2

/** Un cambio de mezcla (fader) se aplica como mucho cada tanto mientras se arrastra. */
export const INTERVALO_CAMBIO_MEZCLA_MS = 300

/** Fundido al pasar a la mezcla nueva (sin "clicks"). */
export const FUNDIDO_MEZCLA_SEC = 0.02
