import type { Marcador, PlaybackState, TramoReproduccion } from './types'

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
  const limpio: PlaybackState = { estado: nuevo.estado, positionMs: nuevo.positionMs, referenceServerTime: nuevo.referenceServerTime }
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
