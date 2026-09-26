import type { Pista, Proyecto } from './types'

/**
 * Mezcla hecha en la compu para cada celular: en vez de bajar todas las
 * pistas (15-20 WAV = 20-28 Mbps por celular), el celular pide UNA pista
 * estereo ya mezclada con la mezcla del director y su "Mi mezcla"
 * (~1,4 Mbps). Aca esta lo que comparten el celular (que arma el pedido) y el
 * servidor (que mezcla), para que los dos calculen exactamente lo mismo.
 */

/** Duracion (seg) de cada segmento de audio (el mismo en la mezcla y en las pistas sueltas). */
export const SEGMENTO_SEC = 2

/** Ajuste personal de una pista en ESTE dispositivo ("Mi mezcla"), por nombre de pista. */
export interface AjustePersonal {
  /** multiplicador sobre la mezcla del director: 0 a 2 (1 = igual que el director) */
  ganancia: number
  mute: boolean
}

export type MezclaPersonal = Record<string, AjustePersonal>

/** Clave estable por nombre de pista ("Click", "click ", "CLICK" -> "click"), para que el ajuste siga de cancion en cancion. */
export function clavePista(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const sinAcentos = (nombre: string): string =>
  nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Nombres tipicos de la pista de click. */
export function pareceNombreDeClick(nombre: string): boolean {
  return /(^|[^a-z])(click|clic|clik|clk|metronomo|metronome|metro)([^a-z]|$)/.test(sinAcentos(nombre))
}

/** Nombres tipicos de la pista de voz guia (la que anuncia "Verso", "Coro"...). */
export function pareceNombreDeGuia(nombre: string): boolean {
  return /(^|[^a-z])(guia|guias|guide|guides|cue|cues|cueing|guia hablada|voz guia|spoken)([^a-z]|$)/.test(sinAcentos(nombre))
}

/**
 * ¿Es click o guia? (lo que va al oido izquierdo con "Click y guia a la
 * izquierda"). Manda lo que se marco a mano en la compu; si no, lo que
 * detecto el analisis (la pista del click por como suena, la de la guia) o
 * el nombre de la pista.
 */
export function esClickOGuia(proyecto: Pick<Proyecto, 'tempo' | 'analisis'>, pista: Pista): boolean {
  if (pista.rol === 'normal') return false
  if (pista.rol === 'click' || pista.rol === 'guia') return true
  if (proyecto.tempo?.clickPistaId === pista.id || proyecto.analisis?.guiaPistaId === pista.id) return true
  return pareceNombreDeClick(pista.nombre) || pareceNombreDeGuia(pista.nombre)
}

/** Ids de las pistas que van a la izquierda con "Click y guia a la izquierda". */
export function pistasClickYGuia(proyecto: Pick<Proyecto, 'pistas' | 'tempo' | 'analisis'>): Set<string> {
  return new Set(proyecto.pistas.filter((p) => esClickOGuia(proyecto, p)).map((p) => p.id))
}

/** Una pista dentro de la mezcla: ganancia lineal final y paneo (-1 izquierda, 1 derecha). */
export interface CanalMezcla {
  pistaId: string
  ganancia: number
  pan: number
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/**
 * Ganancia y paneo finales de cada pista: fader del director (curva
 * cuadratica), mute/solo del director y "Mi mezcla" del dispositivo. Las
 * pistas que no suenan no se incluyen (el servidor ni las lee).
 *
 * `izquierda` ("Click y guia a la izquierda"): esas pistas van todas al oido
 * izquierdo y el resto de la banda al derecho, 3 dB mas bajo (al pasar una
 * pista del centro a un solo lado suena 3 dB mas fuerte de ese lado: asi el
 * volumen queda parejo).
 */
export function mezclaEfectiva(pistas: Pista[], personal: MezclaPersonal = {}, izquierda: Set<string> | null = null): CanalMezcla[] {
  const haySolo = pistas.some((p) => p.solo)
  const res: CanalMezcla[] = []
  for (const p of pistas) {
    const ajuste = personal[clavePista(p.nombre)]
    if (p.mute || (haySolo && !p.solo) || ajuste?.mute) continue
    const v = clamp(p.volumen, 0, 100) / 100
    const ganancia = v * v * (ajuste ? clamp(ajuste.ganancia, 0, 2) : 1)
    if (ganancia <= 0) continue
    if (izquierda) res.push({ pistaId: p.id, ganancia: ganancia * Math.SQRT1_2, pan: izquierda.has(p.id) ? -1 : 1 })
    else res.push({ pistaId: p.id, ganancia, pan: clamp(p.pan, -100, 100) / 100 })
  }
  return res
}

/**
 * Texto compacto para la URL: "id_ganancia_pan.id_ganancia_pan" (ganancia en
 * diezmilesimos, pan en centesimos). Sin caracteres que haya que escapar.
 */
export function codificarMezcla(canales: CanalMezcla[]): string {
  return canales.map((c) => `${c.pistaId}_${Math.round(c.ganancia * 10000)}_${Math.round(c.pan * 100)}`).join('.')
}

const CANAL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d{1,6})_(-?\d{1,3})$/i

/** null si el texto no es una mezcla valida (se rechaza el pedido). */
export function decodificarMezcla(texto: unknown): CanalMezcla[] | null {
  if (typeof texto !== 'string' || texto.length > 8000) return null
  if (texto === '') return []
  const res: CanalMezcla[] = []
  for (const parte of texto.split('.')) {
    const m = CANAL_RE.exec(parte)
    if (!m) return null
    const ganancia = Number(m[2]) / 10000
    const pan = Number(m[3]) / 100
    if (ganancia > 4 || pan < -1 || pan > 1) return null
    res.push({ pistaId: m[1].toLowerCase(), ganancia, pan })
  }
  return res
}

/**
 * Coeficientes del paneo "equal power" de Web Audio (StereoPannerNode), para
 * que la mezcla de la compu suene igual que la que antes hacia el celular:
 *   L = aLL*inL + aLR*inR ;  R = aRL*inL + aRR*inR
 * (con una pista mono, inL = inR = la unica senal y se usan aLL y aRR).
 */
export function coeficientesPaneo(pan: number, canales: number): { aLL: number; aLR: number; aRL: number; aRR: number } {
  const p = clamp(pan, -1, 1)
  if (canales === 1) {
    const x = ((p + 1) / 2) * (Math.PI / 2)
    return { aLL: Math.cos(x), aLR: 0, aRL: 0, aRR: Math.sin(x) }
  }
  if (p <= 0) {
    const x = (p + 1) * (Math.PI / 2)
    return { aLL: 1, aLR: Math.cos(x), aRL: 0, aRR: Math.sin(x) }
  }
  const x = p * (Math.PI / 2)
  return { aLL: Math.cos(x), aLR: 0, aRL: Math.sin(x), aRR: 1 }
}
