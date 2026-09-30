import type { Marcador, PlaybackState, TempoProyecto, TramoReproduccion } from './types'

function posicionDeTramo(tramo: TramoReproduccion, nowMs: number): number {
  if (tramo.estado === 'playing' && nowMs > tramo.referenceServerTime) {
    return tramo.positionMs + (nowMs - tramo.referenceServerTime)
  }
  return tramo.positionMs
}

/**
 * Tramo que esta vigente en `nowMs`: mientras un comando programado no llego a
 * su horario, lo que suena es el `previo` (que a su vez puede tener otro
 * comando pendiente, si se emitieron dos seguidos dentro del margen, p.ej.
 * "repetir seccion" con secciones cortas).
 */
export function tramoVigente(playback: PlaybackState, nowMs: number): TramoReproduccion {
  let pb: PlaybackState = playback
  while (pb.previo && nowMs < pb.referenceServerTime) pb = pb.previo
  return pb
}

/**
 * Posicion real (ms) en el instante `nowMs` (mismo reloj que
 * `playback.referenceServerTime`: tiempo de servidor, o tiempo local ya
 * corregido por el offset de reloj).
 */
export function posicionActualMs(playback: PlaybackState, nowMs: number): number {
  return posicionDeTramo(tramoVigente(playback, nowMs), nowMs)
}

/** true si en `nowMs` esta sonando (considerando los tramos previos). */
export function estaSonando(playback: PlaybackState | null | undefined, nowMs: number): boolean {
  if (!playback) return false
  return tramoVigente(playback, nowMs).estado === 'playing'
}

/**
 * Lo que va a sonar desde `nowMs` segun la cadena `pb` (sin lo que ya paso).
 * undefined si no suena nada en todo ese tramo.
 */
function podar(pb: PlaybackState | undefined, nowMs: number): PlaybackState | undefined {
  if (!pb) return undefined
  const tramo: PlaybackState = { estado: pb.estado, positionMs: pb.positionMs, referenceServerTime: pb.referenceServerTime }
  if (nowMs >= pb.referenceServerTime) return pb.estado === 'playing' ? tramo : undefined
  const anterior = podar(pb.previo, nowMs)
  if (!anterior && pb.estado !== 'playing') return undefined
  return anterior ? { ...tramo, previo: anterior } : tramo
}

/**
 * Nuevo estado de reproduccion a partir de `anterior`, conservando como
 * `previo` lo que suena desde `nowMs` hasta que el nuevo comando llega a su
 * horario, para que la transicion no "salte" antes de tiempo.
 */
export function nuevoPlayback(
  anterior: PlaybackState | null | undefined,
  nuevo: TramoReproduccion,
  nowMs: number
): PlaybackState {
  const limpio: PlaybackState = {
    estado: nuevo.estado,
    positionMs: nuevo.positionMs,
    referenceServerTime: nuevo.referenceServerTime,
    ...(nuevo.cuenta ? { cuenta: nuevo.cuenta } : {})
  }
  if (nuevo.referenceServerTime <= nowMs) return limpio
  const previo = podar(anterior ?? undefined, nowMs)
  return previo ? { ...limpio, previo } : limpio
}

export interface Seccion {
  indice: number
  marcador: Marcador | null
  nombre: string
  inicioMs: number
  finMs: number
}

/**
 * Divide la cancion en secciones a partir de los marcadores: cada marcador
 * abre una seccion que termina en el siguiente (o al final de la cancion).
 * Si el primer marcador no esta en 0, el tramo inicial es una seccion sin
 * marcador ("Inicio").
 */
export function calcularSecciones(marcadores: Marcador[], duracionMs: number): Seccion[] {
  const ordenados = [...marcadores].sort((a, b) => a.tiempoMs - b.tiempoMs)
  const fin = Math.max(duracionMs, ordenados.length ? ordenados[ordenados.length - 1].tiempoMs + 1 : 0)
  const secciones: Seccion[] = []
  if (ordenados.length === 0 || ordenados[0].tiempoMs > 0) {
    secciones.push({
      indice: 0,
      marcador: null,
      nombre: 'Inicio',
      inicioMs: 0,
      finMs: ordenados.length ? ordenados[0].tiempoMs : fin
    })
  }
  ordenados.forEach((m, i) => {
    secciones.push({
      indice: secciones.length,
      marcador: m,
      nombre: m.nombre,
      inicioMs: m.tiempoMs,
      finMs: i + 1 < ordenados.length ? ordenados[i + 1].tiempoMs : fin
    })
  })
  return secciones
}

/** Seccion que contiene `posicionMs` (la ultima cuyo inicio es <= posicion). */
export function seccionEn(secciones: Seccion[], posicionMs: number): Seccion | null {
  let actual: Seccion | null = null
  for (const s of secciones) {
    if (s.inicioMs <= posicionMs + 1) actual = s
    else break
  }
  return actual
}

/**
 * Compases que faltan para que termine la seccion que suena en `posMs`,
 * contando el que suena (en el ultimo, 1): el "9 BARS" de los reproductores
 * de vivo, para que la bateria prepare la entrada y el director elija a
 * tiempo. Si hay un salto elegido antes del final (`limiteMs`), hasta el
 * salto. null = sin tempo (no se sabe) o antes del primer compas.
 */
export function compasesQueFaltan(
  compasesMs: number[] | null | undefined,
  seccion: Pick<Seccion, 'finMs'> | null,
  posMs: number,
  limiteMs?: number | null
): number | null {
  if (!compasesMs || compasesMs.length < 2 || !seccion) return null
  const fin = limiteMs != null && limiteMs > posMs && limiteMs < seccion.finMs ? limiteMs : seccion.finMs
  let actual = -1
  for (let i = 0; i < compasesMs.length && compasesMs[i] <= posMs + 1; i++) actual = i
  if (actual === -1) return null
  let n = 0
  for (let i = actual; i < compasesMs.length && compasesMs[i] < fin - 50; i++) n++
  return n > 0 ? n : null
}

/** "faltan 3" / "último compás" (null = no se sabe). */
export function textoQueFaltan(n: number | null): string | null {
  return n === null ? null : n === 1 ? 'último compás' : `faltan ${n}`
}

/**
 * Largo "tipico" del compas `k` (ms): la mediana de ese y los de al lado. Un
 * 2/4 o un 3/4 suelto no cambia el pulso de la cuenta ni del colchon; un
 * cambio de tempo, si (a partir de ahi, los de al lado ya son los nuevos).
 */
export function largoTipicoDeCompas(compasesMs: number[], k: number): number {
  const n = compasesMs.length - 1 // compases con largo conocido
  if (n < 1) return 0
  const largo = (i: number): number => compasesMs[i + 1] - compasesMs[i]
  if (n < 3) return largo(Math.max(0, Math.min(k, n - 1)))
  const i0 = Math.max(0, Math.min(k - 1, n - 3))
  const largos = [largo(i0), largo(i0 + 1), largo(i0 + 2)].sort((a, b) => a - b)
  return largos[1]
}

/**
 * BPM de un tramo de la cancion (la mediana del largo de sus compases): en una
 * cancion que cambia de tempo, el de la parte que suena. null = sin tempo.
 */
export function bpmDeTramo(tempo: Pick<TempoProyecto, 'compasesMs' | 'compas'> | null | undefined, desdeMs: number, hastaMs: number): number | null {
  const c = tempo?.compasesMs
  if (!c || c.length < 2 || !(tempo!.compas > 0)) return null
  const largos: number[] = []
  let k = 0
  for (let i = 0; i + 1 < c.length; i++) {
    if (c[i] <= desdeMs + 1) k = i
    if (c[i] >= desdeMs - 1 && c[i] < hastaMs - 50) largos.push(c[i + 1] - c[i])
  }
  // tramo mas corto que un compas: el que lo contiene
  if (largos.length === 0) largos.push(largoTipicoDeCompas(c, k))
  largos.sort((a, b) => a - b)
  const m = largos.length % 2 ? largos[(largos.length - 1) / 2] : (largos[largos.length / 2 - 1] + largos[largos.length / 2]) / 2
  return m > 0 ? (60000 * tempo!.compas) / m : null
}

/**
 * El BPM de la seccion que suena, si es otro que el de la cancion (una parte
 * lenta, un popurri): null si es el mismo (±3 %) o no se sabe.
 */
export function bpmDistintoEnSeccion(tempo: Pick<TempoProyecto, 'compasesMs' | 'compas' | 'bpm'> | null | undefined, seccion: Pick<Seccion, 'inicioMs' | 'finMs'> | null): number | null {
  if (!tempo || !seccion) return null
  const b = bpmDeTramo(tempo, seccion.inicioMs, seccion.finMs)
  return b !== null && Math.abs(b / tempo.bpm - 1) > 0.03 ? b : null
}
