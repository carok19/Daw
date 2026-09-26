/**
 * Tonalidad de una cancion y cambio de tono (semitonos). La tonalidad
 * original sale del nombre ("... - 98 bpm - A", "Digno (Bb)", "Key of F#m")
 * o la pone el director a mano; el tono transpuesto se calcula de ahi.
 */

/** Cuanto se puede subir o bajar el tono (semitonos). */
export const TONO_MIN = -6
export const TONO_MAX = 6

/** Como se escribe cada nota (lo mas comun en alabanza: Bb y no A#, F# y no Gb). */
const MAYORES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MENORES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']
const BASE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** Todas las tonalidades (para elegir a mano). */
export const TONALIDADES = [...MAYORES, ...MENORES]

function leer(nota: string, alteracion: string | undefined, menor: boolean): string {
  let i = BASE[nota.toUpperCase()]
  if (alteracion === '#' || alteracion === '♯') i += 1
  if (alteracion === 'b' || alteracion === '♭') i -= 1
  i = ((i % 12) + 12) % 12
  return menor ? MENORES[i] : MAYORES[i]
}

/** "a#", "Bb", "F#m", "Gmin", "D menor" -> la tonalidad escrita como en TONALIDADES; null si no es una. */
export function normalizarTonalidad(texto: unknown): string | null {
  if (typeof texto !== 'string') return null
  const m = /^\s*([A-Ga-g])\s*(#|b|♯|♭)?\s*(m|min|menor|minor|-)?\s*(mayor|major|maj)?\s*$/.exec(texto)
  if (!m) return null
  return leer(m[1], m[2], !!m[3])
}

/**
 * La tonalidad escrita al final del nombre de la cancion (o entre
 * parentesis): "Gracia Sublime Es - 98 bpm - A", "Digno (Bb)", "Oceans -
 * Key of D". La nota tiene que estar en mayuscula y separada, para no
 * confundirla con una palabra.
 */
export function tonalidadDesdeNombre(nombre: string): string | null {
  const m = /(?:^|[\s\-–—_(\[|,])(?:(?:tono|tonalidad|key(?:\s+of)?|en|in)\s*:?\s*)?([A-G])(#|b|♯|♭)?(m|min|menor|minor)?(?:\s*(?:mayor|major))?\s*[)\]]?\s*$/.exec(nombre.trim())
  if (!m) return null
  return leer(m[1], m[2], !!m[3])
}

/** Tonalidad original de la cancion: la puesta a mano o, si no, la del nombre. */
export function tonalidadOriginal(p: { nombre: string; tonalidad?: string }): string | null {
  return normalizarTonalidad(p.tonalidad) ?? tonalidadDesdeNombre(p.nombre)
}

/** La tonalidad `semitonos` mas arriba (o abajo): "A" +2 -> "B", "Am" -1 -> "G#m". */
export function transponerTonalidad(tonalidad: string, semitonos: number): string {
  const menor = tonalidad.endsWith('m')
  const lista = menor ? MENORES : MAYORES
  const i = lista.indexOf(tonalidad)
  if (i === -1) return tonalidad
  return lista[(((i + semitonos) % 12) + 12) % 12]
}

/** "+2", "−1", "0" */
export function textoSemitonos(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'
}

/** Relacion de frecuencias para `semitonos` (lo que usa rubberband). */
export function factorDeTono(semitonos: number): number {
  return 2 ** (semitonos / 12)
}

/** Pistas de voces (coros, voz principal): al cambiar el tono conservan el timbre (formantes), asi no suenan "chillonas". */
export function pareceVoz(nombre: string): boolean {
  const n = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return /(^|[^a-z])(voz|voces|vox|vocal|vocals|bgv|bgvs|coro|coros|choir|backing|lead|soprano|alto|tenor|harmony|armonia)([^a-z]|$)/.test(n)
}

/**
 * Bateria y percusion: no se transponen (no tienen tonalidad, y asi el bombo
 * y el redoblante siguen sonando naturales y con el ataque exacto).
 */
export function pareceBateria(nombre: string): boolean {
  const n = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return /(^|[^a-z])(drum|drums|bateria|kick|kicks|bombo|snare|snares|redoblante|tambor|hat|hats|hihat|hihats|hi hat|overhead|overheads|oh|room|rooms|tom|toms|cymbal|cymbals|platillo|platillos|perc|percs|percu|percusion|percussion|percusiones|shaker|shakers|clap|claps|cajon)([^a-z]|$)/.test(n)
}
