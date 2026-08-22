import type { PlaybackState } from './types'

/**
 * Posicion real (ms) de una pestana en el instante `nowMs` (mismo reloj que
 * `playback.referenceServerTime`, es decir tiempo de servidor o tiempo local
 * ya corregido por el offset de reloj).
 */
export function posicionActualMs(playback: PlaybackState, nowMs: number): number {
  if (playback.estado === 'playing' && nowMs > playback.referenceServerTime) {
    return playback.positionMs + (nowMs - playback.referenceServerTime)
  }
  return playback.positionMs
}
