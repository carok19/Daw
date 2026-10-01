import type { PlaybackState } from './types'
import { posicionActualMs, tramoVigente } from './playback'

/**
 * AirTracks Video: donde tiene que estar el video con la letra en cada
 * momento, a partir de lo mismo que reciben los celulares (el estado de
 * reproduccion y el reloj de la compu). El video no manda nada ni frena a
 * nadie: si se atrasa, se corrige solo.
 *
 * Tiempos: la cancion suena a velocidad `v` (sus tiempos ya estan en esa
 * velocidad); el video es la grabacion original, asi que corre a `v` y su
 * tiempo es `posMs * v + desfaseMs` (el desfase sale de la alineacion).
 */

export interface ObjetivoVideo {
  /** mostrar la pantalla del video (si no, se ve lo de abajo: Holyrics) */
  visible: boolean
  /** el video tiene que estar corriendo (si no, quieto en `segundos`) */
  corriendo: boolean
  /** donde tiene que estar el video ahora (s) */
  segundos: number
  /** velocidad de reproduccion (la de la cancion) */
  velocidad: number
}

const OCULTO: ObjetivoVideo = { visible: false, corriendo: false, segundos: 0, velocidad: 1 }

/** Segundo del video que corresponde a `posMs` de la cancion (tal como suena, a velocidad `v`). */
export function segundosDeVideo(posMs: number, v: number, desfaseMs: number): number {
  return (posMs * v + desfaseMs) / 1000
}

/**
 * El video en el instante `ahora` (hora del servidor). `duracionSeg` = largo
 * del video: terminado, se esconde.
 */
export function objetivoVideo(
  playback: PlaybackState | null | undefined,
  ahora: number,
  v: number,
  desfaseMs: number,
  duracionSeg: number
): ObjetivoVideo {
  if (!playback) return OCULTO
  const vigente = tramoVigente(playback, ahora)
  if (vigente.estado === 'stopped') return OCULTO
  // contando (o por arrancar): quieto donde va a entrar; en pausa (o en el colchon), quieto donde quedo
  const corriendo = vigente.estado === 'playing' && ahora >= vigente.referenceServerTime
  const posMs = corriendo ? posicionActualMs(playback, ahora) : vigente.positionMs
  const segundos = segundosDeVideo(posMs, v, desfaseMs)
  if (duracionSeg > 0 && segundos >= duracionSeg - 0.05) return OCULTO
  // antes de que empiece el video (la cancion tiene una intro mas larga): el primer cuadro, quieto
  if (segundos < 0) return { visible: true, corriendo: false, segundos: 0, velocidad: v }
  return { visible: true, corriendo, segundos, velocidad: v }
}

/**
 * Un salto ya programado (una seccion elegida, repetir): cuando pasa y a que
 * segundo del video, para dejar el video listo en ese punto antes y cortar
 * justo. null = no hay.
 */
export function proximoCorte(
  playback: PlaybackState | null | undefined,
  ahora: number,
  v: number,
  desfaseMs: number
): { en: number; segundos: number } | null {
  if (!playback || playback.estado !== 'playing' || playback.referenceServerTime <= ahora || !playback.previo) return null
  const antes = tramoVigente(playback.previo, ahora)
  if (antes.estado !== 'playing') return null
  return { en: playback.referenceServerTime, segundos: Math.max(0, segundosDeVideo(playback.positionMs, v, desfaseMs)) }
}

/** Mas de esto de diferencia sonando: se salta (si no, se alcanza de a poco). */
export const SALTO_SI_DIFIERE_SEG = 0.3
/** Menos de esto: esta bien (la vista no nota 30 ms). */
export const TOLERANCIA_SEG = 0.03

/**
 * Que hacerle al video que esta en `actualSeg` para llegar al objetivo:
 * saltar (lejos, o quieto en otro lado) o apurarlo/frenarlo apenas (cerca).
 */
export function ajusteDeVideo(actualSeg: number, obj: ObjetivoVideo): { saltarA: number | null; velocidad: number } {
  const dif = actualSeg - obj.segundos
  if (!obj.corriendo) return { saltarA: Math.abs(dif) > 0.04 ? obj.segundos : null, velocidad: obj.velocidad }
  if (Math.abs(dif) > SALTO_SI_DIFIERE_SEG) return { saltarA: obj.segundos, velocidad: obj.velocidad }
  if (Math.abs(dif) <= TOLERANCIA_SEG) return { saltarA: null, velocidad: obj.velocidad }
  // se alcanza en ~2 s, sin pasarse de un 8 % (no se nota)
  const correccion = Math.max(-0.08, Math.min(0.08, dif * 0.5))
  return { saltarA: null, velocidad: obj.velocidad * (1 - correccion) }
}
