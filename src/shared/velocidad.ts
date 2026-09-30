import type { Proyecto } from './types'

/**
 * Velocidad de una cancion (sin cambiar el tono): 1 = la original, de 0,8
 * (20 % mas lenta) a 1,2 (20 % mas rapida). La compu prepara todas las
 * pistas a esa velocidad (ver server/tono.ts, junto con el tono) y, cuando
 * estan, la cancion pasa a sonar asi.
 *
 * Mientras suena a otra velocidad, TODOS los tiempos de la cancion (secciones,
 * compases, BPM, duracion) estan en el tiempo que suena: asi el resto de la
 * app (saltos, cuenta, voz del salto, celulares) no se entera. La ficha de la
 * cancion los guarda en el tiempo original.
 */

export const VELOCIDAD_MIN = 0.8
export const VELOCIDAD_MAX = 1.2

export function esVelocidadValida(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= VELOCIDAD_MIN - 1e-9 && v <= VELOCIDAD_MAX + 1e-9
}

/** 4 decimales (la velocidad sale de un BPM elegido: 76 / 72 = 1,0556). */
export function redondearVelocidad(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** La velocidad a la que suena (1 si no se cambio). */
export function velocidadAplicada(p: Pick<Proyecto, 'velocidadAplicada'>): number {
  return esVelocidadValida(p.velocidadAplicada) ? p.velocidadAplicada : 1
}

/** El BPM original de la cancion (el que tiene a velocidad 1). */
export function bpmOriginal(p: Pick<Proyecto, 'tempo' | 'velocidadAplicada'>): number | null {
  return p.tempo ? p.tempo.bpm / velocidadAplicada(p) : null
}

/**
 * Pasa los tiempos de la cancion de sonar a velocidad `desde` a sonar a
 * velocidad `hasta` (mas rapido = todo antes): secciones, compases, BPM y
 * duracion.
 */
export function reescalarTiempos(p: Pick<Proyecto, 'marcadores' | 'tempo' | 'duracionTotalMs'>, desde: number, hasta: number): void {
  const k = desde / hasta
  if (Math.abs(k - 1) < 1e-9) return
  for (const m of p.marcadores) m.tiempoMs = Math.round(m.tiempoMs * k)
  if (p.tempo) p.tempo = { ...p.tempo, bpm: p.tempo.bpm / k, compasesMs: p.tempo.compasesMs.map((c) => c * k) }
  p.duracionTotalMs = Math.round(p.duracionTotalMs * k)
}

/** "+6 %", "−10 %", "0 %" (respecto de la original). */
export function textoPorcentaje(v: number): string {
  const n = Math.round((v - 1) * 100)
  return n > 0 ? `+${n} %` : n < 0 ? `−${-n} %` : '0 %'
}
