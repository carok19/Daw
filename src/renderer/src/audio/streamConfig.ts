// Parametros del streaming por segmentos (ver README "Streaming progresivo").
// Centralizados aca para poder probar distintos valores en pruebas de campo
// sin tocar la logica de StreamingEngine.

/** Duracion (seg) de cada segmento de audio pedido al servidor por HTTP Range. */
export const SEGMENT_DURATION_SEC = 2

/** Buffer objetivo (seg de audio futuro ya encadenado) durante la reproduccion. */
export const BUFFER_TARGET_SEC = 8

/** Por debajo de esto el buffer se considera critico (se avisa en la compu). */
export const BUFFER_CRITICAL_SEC = 3

/** Minimo de buffer (seg) requerido antes de programar un arranque/reingreso a sync. */
export const BUFFER_MIN_START_SEC = 3

/** Pedidos HTTP simultaneos por pista. */
export const MAX_FETCHES_POR_PISTA = 3

/**
 * Cuantos marcadores (secciones) se mantienen "precargados": los primeros
 * segundos de cada seccion quedan en memoria para que un salto de marcador o
 * "repetir seccion" arranque en sync sin esperar la red.
 */
export const MAX_CUES = 16

/** Segmentos precargados por cada marcador (2 x 2s cubren el minimo de arranque). */
export const SEGMENTOS_POR_CUE = 2
