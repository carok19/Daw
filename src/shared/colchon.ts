import type { AjustesColchon, ColchonActivo, Proyecto } from './types'
import { PAN_BANDA } from './mezcla'
import { tonalidadOriginal, transponerTonalidad } from './tonalidad'

/**
 * Colchón: el click y un pad de ambiente sonando sin la banda.
 *
 * - Como canción de la lista ("Colchón · D"): no tiene pistas; play arranca
 *   el pad (y el click, si se eligió) y stop lo apaga despacio. Para la
 *   oración, la ministración o entre canciones.
 * - Dentro de una canción: en el próximo compás la banda se apaga en un
 *   compás, el click sigue en el mismo pulso (se funde con el de la canción,
 *   el mismo sonido) y entra el pad en el tono de la canción. Tocando una
 *   sección, la canción vuelve en el "1" del próximo compás.
 *
 * El click no es audio de la canción: cada dispositivo programa los golpes a
 * la hora de la compu (como la cuenta), así suena en todos a la vez sin
 * importar cuánto dure. El pad es un loop que la compu sintetiza una vez por
 * tono (ver server/pads.ts).
 */

/** Notas del pad (con sostenidos: así se llaman los archivos). */
export const NOTAS_PAD = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export type NotaPad = (typeof NOTAS_PAD)[number]

const BEMOLES: Record<string, NotaPad> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E' }

/**
 * La nota del pad para una tonalidad ("D", "F#m", "Bb" -> "D", "F#", "A#"). El
 * pad no tiene tercera (raíz, quinta y octava): sirve igual en mayor y en
 * menor. null = no se sabe.
 */
export function notaDelPad(tonalidad: string | null | undefined): NotaPad | null {
  const m = /^([A-G])([#b]?)/.exec((tonalidad ?? '').trim())
  if (!m) return null
  const nota = `${m[1]}${m[2]}`
  if ((NOTAS_PAD as readonly string[]).includes(nota)) return nota as NotaPad
  return BEMOLES[nota] ?? null
}

/** La nota del pad para una canción: la de la tonalidad que suena (con el tono cambiado, la nueva). */
export function padDeCancion(p: Pick<Proyecto, 'nombre' | 'tonalidad' | 'tonoAplicado'>): NotaPad | null {
  const original = tonalidadOriginal(p)
  return original ? notaDelPad(transponerTonalidad(original, p.tonoAplicado ?? 0)) : null
}

/** Pad: entra en este tiempo (colchón de la lista; dentro de una canción, en 2 compases). */
export const ENTRADA_PAD_SOLO_MS = 3000
/** Al terminar, el pad se apaga en esto. */
export const SALIDA_PAD_MS = 4000
/** Volviendo a la canción, el pad se va en esto (la banda ya entró). */
export const SALIDA_PAD_VUELTA_MS = 1500

/** El pad suena del lado de la banda (con el paneo por defecto, a la derecha). */
export const PAN_PAD = PAN_BANDA / 100
/** El click del colchón de la lista, del lado del click. */
export const PAN_CLICK_COLCHON = -1

export const AJUSTES_COLCHON_POR_DEFECTO: AjustesColchon = { tonalidad: 'D', bpm: 72, compas: 4, click: true, volumenPad: 80, volumenClick: 80 }

/** Duración del pulso (ms). */
export function pulsoMs(c: Pick<ColchonActivo, 'compasMs' | 'pulsos'>): number {
  return c.compasMs / Math.max(1, c.pulsos)
}

/** BPM del colchón. */
export function bpmDeColchon(c: Pick<ColchonActivo, 'compasMs' | 'pulsos'>): number {
  return 60000 / pulsoMs(c)
}

/** Duración del compás de la canción que empieza en `ms` (el de antes, si es el último). */
export function largoDeCompas(compasesMs: number[], ms: number): number {
  let i = compasesMs.findIndex((c) => c >= ms - 1)
  if (i === -1) i = compasesMs.length - 1
  if (i + 1 < compasesMs.length) return compasesMs[i + 1] - compasesMs[i]
  return i > 0 ? compasesMs[i] - compasesMs[i - 1] : 2000
}

/** Primer golpe del colchón en `t` o después (hora del servidor). */
export function proximoPulso(c: Pick<ColchonActivo, 'inicio' | 'compasMs' | 'pulsos'>, t: number): number {
  if (t <= c.inicio) return c.inicio
  const p = pulsoMs(c)
  return c.inicio + Math.ceil((t - c.inicio) / p - 1e-9) * p
}

/** Primer "1" de compás del colchón en `t` o después (hora del servidor). */
export function proximoCompas(c: Pick<ColchonActivo, 'inicio' | 'compasMs'>, t: number): number {
  if (t <= c.inicio) return c.inicio
  return c.inicio + Math.ceil((t - c.inicio) / c.compasMs - 1e-9) * c.compasMs
}

/**
 * Golpes del click del colchón entre `desde` y `hasta` (horas del servidor;
 * `hasta` no incluido) y antes de que termine: `n` = número del golpe en el
 * compás (1 = el acentuado).
 */
export function golpesDeColchon(c: Pick<ColchonActivo, 'inicio' | 'compasMs' | 'pulsos' | 'hasta'>, desde: number, hasta: number): { t: number; n: number }[] {
  const p = pulsoMs(c)
  const fin = c.hasta !== null ? Math.min(hasta, c.hasta) : hasta
  const res: { t: number; n: number }[] = []
  let k = Math.max(0, Math.ceil((desde - c.inicio) / p - 1e-9))
  for (;;) {
    const t = c.inicio + k * p
    if (t >= fin - 1e-6) break
    res.push({ t, n: (k % Math.max(1, c.pulsos)) + 1 })
    k++
  }
  return res
}

/** Compás y pulso que suenan en `t` ("compás 12, 3"): 0 antes de empezar. */
export function compasYPulso(c: Pick<ColchonActivo, 'inicio' | 'compasMs' | 'pulsos'>, t: number): { compas: number; pulso: number } {
  if (t < c.inicio) return { compas: 0, pulso: 0 }
  const k = Math.floor((t - c.inicio) / pulsoMs(c) + 1e-9)
  return { compas: Math.floor(k / Math.max(1, c.pulsos)) + 1, pulso: (k % Math.max(1, c.pulsos)) + 1 }
}

/** El nombre de un colchón de la lista: "Colchón · D · 72 BPM". */
export function nombreDeColchon(a: AjustesColchon): string {
  return ['Colchón', a.tonalidad ?? 'sin pad', a.click ? `${Math.round(a.bpm)} BPM` : null].filter(Boolean).join(' · ')
}

/** Ajustes válidos (lo que llega de la red se limpia acá). null = no sirven. */
export function normalizarAjustesColchon(x: unknown, base: AjustesColchon = AJUSTES_COLCHON_POR_DEFECTO): AjustesColchon | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Partial<AjustesColchon>
  const tonalidad = o.tonalidad === undefined ? base.tonalidad : o.tonalidad === null ? null : notaDelPad(o.tonalidad)
  if (o.tonalidad !== undefined && o.tonalidad !== null && !tonalidad) return null
  const num = (v: unknown, min: number, max: number, def: number): number | null =>
    v === undefined ? def : typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
  const bpm = num(o.bpm, 30, 240, base.bpm)
  const compas = num(o.compas, 2, 12, base.compas)
  const volumenPad = num(o.volumenPad, 0, 100, base.volumenPad)
  const volumenClick = num(o.volumenClick, 0, 100, base.volumenClick)
  if (bpm === null || compas === null || volumenPad === null || volumenClick === null) return null
  const click = o.click === undefined ? base.click : o.click === true
  return { tonalidad, bpm: Math.round(bpm), compas: Math.round(compas), click, volumenPad: Math.round(volumenPad), volumenClick: Math.round(volumenClick) }
}
