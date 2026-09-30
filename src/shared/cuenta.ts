import type { CuentaProgramada, Proyecto, TempoProyecto } from './types'
import { largoTipicoDeCompas } from './playback'

/**
 * Cuenta antes de la cancion: al dar play (desde parado o en pausa) suena 1
 * compas de click ("1 2 3 4") y recien entra la musica. Los golpes caen sobre
 * la grilla de compases de la propia cancion (la que se detecta del click),
 * asi la cuenta sigue el mismo pulso que la musica.
 *
 * Muchas canciones ya traen su cuenta (la guia dice "1, 2, 3, 4" con la banda
 * en silencio): desde el principio, la automatica no agrega otra (cuenta la
 * cancion). Desde una seccion o despues de una pausa, si.
 */

/** Cuanto ocupa cada sonido (el "1" y el golpe comun) en el WAV de la cuenta (/cuenta/<cancion>.wav). */
export const LARGO_SONIDO_CUENTA_SEC = 0.25

/**
 * Largo del compas en `ms` de la cancion (el que lo contiene, o el primero):
 * el tipico de ahi, asi entrar en un 2/4 suelto no cuenta al doble de rapido.
 */
function largoDeCompas(compases: number[], ms: number): { k: number; largo: number } {
  let k = 0
  while (k + 1 < compases.length && compases[k + 1] <= ms + 1) k++
  return { k, largo: largoTipicoDeCompas(compases, Math.min(k, compases.length - 2)) }
}

/**
 * ¿Arrancando en `posMs` suena la cuenta que trae la cancion? (queda al menos
 * un compas de ella por delante: desde el principio, o desde adentro de esa cuenta)
 */
export function suenaSuCuenta(tempo: Pick<TempoProyecto, 'compasesMs' | 'cuentaPropia'> | null | undefined, posMs: number): boolean {
  const n = tempo?.cuentaPropia ?? 0
  const c = tempo?.compasesMs
  if (!c || n <= 0 || c.length <= n) return false
  return posMs <= c[n - 1] + 50
}

/**
 * Cuantos compases de cuenta lleva la cancion arrancando en `posMs`: los
 * elegidos, o automatico (1; ninguno si arranca desde el principio y la
 * cancion ya trae su cuenta; 0 sin tempo).
 */
export function compasesDeCuenta(p: Pick<Proyecto, 'cuenta' | 'tempo'>, posMs?: number): 0 | 1 | 2 {
  const compases = p.tempo?.compasesMs
  if (!compases || compases.length < 2) return 0
  if (p.cuenta === 0 || p.cuenta === 1 || p.cuenta === 2) return p.cuenta
  if (posMs !== undefined && suenaSuCuenta(p.tempo, posMs)) return 0
  return 1
}

/**
 * Golpes de la cuenta para que la musica entre en `posMs` (tiempo de la
 * cancion): los pulsos de la grilla de la cancion en los `compases` compases
 * anteriores. Si la cancion arranca antes del primer compas (tiene un
 * silencio o una entrada antes del "1"), la cuenta termina en ese primer "1"
 * y la musica entra un poco antes, mientras se termina de contar. `n` es el
 * numero del golpe en el compas (1 = el "1", acentuado). null = sin cuenta.
 */
export function golpesDeCuenta(
  tempo: Pick<TempoProyecto, 'compasesMs' | 'compas'> | null | undefined,
  posMs: number,
  compases: number
): { golpes: { ms: number; n: number }[]; desdeMs: number } | null {
  const c = tempo?.compasesMs
  if (!c || c.length < 2 || compases <= 0) return null
  const pulsos = tempo!.compas > 0 ? Math.round(tempo!.compas) : 4
  const fin = posMs < c[0] - 30 ? c[0] : posMs
  const { k, largo } = largoDeCompas(c, Math.max(fin, c[0]))
  if (!(largo > 0)) return null
  const pulso = largo / pulsos
  const desde = fin - compases * largo
  const jMin = Math.ceil((desde - c[k]) / pulso - 1e-6)
  const jMax = Math.ceil((fin - c[k]) / pulso - 1e-6) - 1
  const golpes: { ms: number; n: number }[] = []
  for (let j = jMin; j <= jMax; j++) golpes.push({ ms: c[k] + j * pulso, n: (((j % pulsos) + pulsos) % pulsos) + 1 })
  return golpes.length ? { golpes, desdeMs: desde } : null
}

/**
 * La cuenta con horas del servidor: el primer golpe suena en `primerGolpe` y
 * la musica (`posMs`) entra en `inicioMusica` (mas tarde, lo que dura contar).
 */
export function programarCuenta(
  tempo: Pick<TempoProyecto, 'compasesMs' | 'compas'> | null | undefined,
  posMs: number,
  compases: number,
  primerGolpe: number
): { cuenta: CuentaProgramada; inicioMusica: number } | null {
  const g = golpesDeCuenta(tempo, posMs, compases)
  if (!g) return null
  const inicioMusica = Math.round(primerGolpe + (posMs - g.golpes[0].ms))
  return {
    cuenta: {
      golpes: g.golpes.map((x) => ({ t: Math.round(inicioMusica + (x.ms - posMs)), n: x.n })),
      pulsosPorCompas: tempo!.compas > 0 ? Math.round(tempo!.compas) : 4
    },
    inicioMusica
  }
}

/**
 * Golpe de la cuenta que suena en `ahora` (hora del servidor): su numero (1..N)
 * o 0 si no se esta contando.
 */
export function golpeActual(cuenta: CuentaProgramada | undefined, ahora: number): number {
  if (!cuenta || cuenta.golpes.length === 0) return 0
  const g = cuenta.golpes
  const pulso = g.length > 1 ? g[1].t - g[0].t : 500
  if (ahora < g[0].t - 50 || ahora >= g[g.length - 1].t + pulso) return 0
  let n = 0
  for (const x of g) if (x.t <= ahora + 30) n = x.n
  return n
}
