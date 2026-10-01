/**
 * Comparar el nombre de un video con el de las canciones de AirTracks
 * ("Fiesta En El Desierto (Lyric Video).mp4" con "Fiesta En El Desierto-E-125BPM"),
 * para vincularlo solo cuando no hay dudas.
 */

const EXTENSIONES = ['.mp4', '.m4v', '.mov', '.webm', '.mkv']

export function esVideo(nombre: string): boolean {
  const i = nombre.lastIndexOf('.')
  return i > 0 && EXTENSIONES.includes(nombre.slice(i).toLowerCase())
}

/** "C:\\Videos\\Santo.mp4" -> "Santo.mp4" */
export const nombreDe = (ruta: string): string => ruta.split(/[\\/]/).pop() ?? ruta

const RELLENO = new Set(['lyric', 'lyrics', 'video', 'oficial', 'official', 'letra', 'con', 'hd', 'audio', 'en', 'vivo', 'live', 'the', 'el', 'la', 'de'])

/** "Fiesta En El Desierto-E-125BPM (Lyric Video)" -> palabras para comparar nombres (sin tonalidad, BPM ni "lyric video"). */
export function palabras(nombre: string): string[] {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/\d{2,3}([.,]\d+)?\s*bpm/g, ' ')
    .split(/[^a-z0-9ñ]+/)
    .filter((p) => p.length > 1 && !RELLENO.has(p) && !/^[a-g]b?m?$/.test(p))
}

/** 0 (nada que ver) a 1 (las mismas palabras). */
export function parecido(a: string, b: string): number {
  const pa = new Set(palabras(a))
  const pb = new Set(palabras(b))
  if (!pa.size || !pb.size) return 0
  let comunes = 0
  for (const p of pa) if (pb.has(p)) comunes++
  return comunes / Math.max(pa.size, pb.size)
}

/**
 * La cancion que mas se parece al nombre del video. `segura`: se parece mucho
 * y ninguna otra se le acerca (se puede vincular sin preguntar).
 */
export function cancionPara<T extends { nombre: string }>(nombreVideo: string, canciones: T[]): { cancion: T; puntaje: number; segura: boolean } | null {
  const orden = canciones.map((c) => ({ c, puntaje: parecido(nombreVideo, c.nombre) })).sort((a, b) => b.puntaje - a.puntaje)
  const [mejor, segunda] = orden
  if (!mejor || mejor.puntaje <= 0) return null
  return { cancion: mejor.c, puntaje: mejor.puntaje, segura: mejor.puntaje >= 0.75 && (!segunda || segunda.puntaje <= mejor.puntaje - 0.2) }
}
