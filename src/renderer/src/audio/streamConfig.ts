// Parametros del streaming progresivo por segmentos hacia el receptor (celular),
// ver README "Streaming progresivo (buffer deslizante)". Centralizados aca para
// poder probar distintos valores durante pruebas de campo sin tocar la logica
// de StreamingEngine.

/** Duracion (seg) de cada segmento de audio pedido al Host por HTTP Range. */
export const SEGMENT_DURATION_SEC = 2

/** Buffer objetivo (seg de audio futuro ya disponible): por encima de esto, estado normal (verde). */
export const BUFFER_TARGET_SEC = 8

/** Por debajo de esto, buffer critico (rojo): prioridad maxima para pedir segmentos. */
export const BUFFER_CRITICAL_SEC = 3

/** Minimo de buffer (seg) requerido antes de programar un arranque/reingreso a sync. */
export const BUFFER_MIN_START_SEC = 3
