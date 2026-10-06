import type { Pista, Proyecto, SalidaSonido } from './types'

/**
 * Mezcla hecha en la compu para cada celular: en vez de bajar todas las
 * pistas (15-20 WAV = 20-28 Mbps por celular), el celular pide UNA pista
 * estereo ya mezclada con la mezcla del director y su "Mi mezcla"
 * (~1,4 Mbps). Aca esta lo que comparten el celular (que arma el pedido) y el
 * servidor (que mezcla), para que los dos calculen exactamente lo mismo.
 */

/**
 * Duracion (seg) de cada segmento de audio (el mismo en la mezcla y en las
 * pistas sueltas). 1 s: un mute o un fader se oyen en ~0,5 s aun con el WiFi
 * cargado (con 2 s tardaban 0,7-1,5 s: el pedazo que hay que volver a bajar
 * pesa el doble).
 */
export const SEGMENTO_SEC = 1

/** Ajuste personal de una pista en ESTE dispositivo ("Mi mezcla"), por nombre de pista. */
export interface AjustePersonal {
  /** multiplicador sobre la mezcla del director: 0 a 2 (1 = igual que el director) */
  ganancia: number
  mute: boolean
  /** solo en este celular: si alguna pista esta en solo aca, se escuchan solo esas (en lugar del solo de la compu) */
  solo?: boolean
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

/** Que es cada pista: el click, la guia (la voz que anuncia "Verso", "Coro"...) o la banda (todo lo demas). */
export type TipoPista = 'click' | 'guia' | 'banda'

/**
 * Manda la marca de la pista, si tiene; si no, lo que detecto el analisis (la
 * guia, porque habla; el click, por como suena) o el nombre de la pista. Una
 * pista que habla es la guia aunque tambien traiga el click.
 */
export function tipoDePista(proyecto: Pick<Proyecto, 'tempo' | 'analisis'>, pista: Pista): TipoPista {
  if (pista.rol === 'normal') return 'banda'
  if (pista.rol === 'click' || pista.rol === 'guia') return pista.rol
  if (proyecto.analisis?.guiaPistaId === pista.id) return 'guia'
  if (proyecto.tempo?.clickPistaId === pista.id) return 'click'
  if (pareceNombreDeGuia(pista.nombre)) return 'guia'
  if (pareceNombreDeClick(pista.nombre)) return 'click'
  return 'banda'
}

/** ¿Es click o guia? (lo que va al oido izquierdo en el paneo automatico, y lo que no va a la consola). */
export function esClickOGuia(proyecto: Pick<Proyecto, 'tempo' | 'analisis'>, pista: Pista): boolean {
  return tipoDePista(proyecto, pista) !== 'banda'
}

/** Paneo por defecto (como en los reproductores de multitracks para vivo): click y guia al oido izquierdo... */
export const PAN_CLICK_GUIA = -100
/** ...y el resto de la banda al derecho. */
export const PAN_BANDA = 100

/**
 * Pone el paneo por defecto en las pistas que no se tocaron a mano (click y
 * guia en L, el resto en R). Las canciones de antes (sin marca en ninguna
 * pista) se acomodan solo si nadie toco el paneo (todo al centro); si alguna
 * estaba paneada a mano, se dejan como estan. Devuelve si cambio algo.
 */
export function aplicarPaneoAutomatico(proyecto: Pick<Proyecto, 'pistas' | 'tempo' | 'analisis'>): boolean {
  let cambio = false
  const sinMarca = proyecto.pistas.filter((p) => p.panAutomatico === undefined)
  if (sinMarca.length) {
    const intactas = sinMarca.every((p) => p.pan === 0)
    for (const p of sinMarca) p.panAutomatico = intactas
    cambio = true
  }
  for (const p of proyecto.pistas) {
    if (!p.panAutomatico) continue
    const pan = esClickOGuia(proyecto, p) ? PAN_CLICK_GUIA : PAN_BANDA
    if (p.pan !== pan) {
      p.pan = pan
      cambio = true
    }
  }
  return cambio
}

/** Una pista dentro de la mezcla: ganancia lineal final y paneo (-1 izquierda, 1 derecha). */
export interface CanalMezcla {
  pistaId: string
  ganancia: number
  pan: number
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** ¿Esta pista queda afuera por un solo? El solo de este celular manda sobre el de la compu (el mute de la compu vale igual). */
export function fueraDelSolo(pistas: Pista[], personal: MezclaPersonal, pista: Pista): boolean {
  const soloPersonal = pistas.some((p) => personal[clavePista(p.nombre)]?.solo)
  if (soloPersonal) return !personal[clavePista(pista.nombre)]?.solo
  return pistas.some((p) => p.solo) && !pista.solo
}

/**
 * Ganancia y paneo finales de cada pista: fader y paneo del director (curva
 * cuadratica), mute/solo del director y "Mi mezcla" del dispositivo (con su
 * propio mute y solo). Las pistas que no suenan no se incluyen (el servidor
 * ni las lee).
 */
export function mezclaEfectiva(pistas: Pista[], personal: MezclaPersonal = {}): CanalMezcla[] {
  const res: CanalMezcla[] = []
  for (const p of pistas) {
    const ajuste = personal[clavePista(p.nombre)]
    if (p.mute || ajuste?.mute || fueraDelSolo(pistas, personal, p)) continue
    const v = clamp(p.volumen, 0, 100) / 100
    const ganancia = v * v * (ajuste ? clamp(ajuste.ganancia, 0, 2) : 1)
    if (ganancia <= 0) continue
    res.push({ pistaId: p.id, ganancia, pan: clamp(p.pan, -100, 100) / 100 })
  }
  return res
}

/**
 * "Mezcla rapida" de "Mi mezcla": un volumen para todo el click, toda la guia
 * y toda la banda, encima de lo de cada pista. Se guarda en la misma mezcla
 * personal con estas claves (ningun nombre de pista empieza con "~").
 */
export const CLAVE_GRUPO: Record<TipoPista, string> = { click: '~click', guia: '~guia', banda: '~banda' }

/** Aplica los volumenes de la mezcla rapida (click, guia, banda) a una mezcla ya calculada. */
export function aplicarGrupos(proyecto: Pick<Proyecto, 'pistas' | 'tempo' | 'analisis'>, canales: CanalMezcla[], personal: MezclaPersonal): CanalMezcla[] {
  const grupos = (Object.keys(CLAVE_GRUPO) as TipoPista[]).map((t) => [t, personal[CLAVE_GRUPO[t]]] as const).filter(([, a]) => a)
  if (grupos.length === 0) return canales
  const factor = new Map(grupos.map(([t, a]) => [t, a!.mute ? 0 : clamp(a!.ganancia, 0, 2)]))
  const tipos = new Map(proyecto.pistas.map((p) => [p.id, tipoDePista(proyecto, p)]))
  return canales.map((c) => ({ ...c, ganancia: c.ganancia * (factor.get(tipos.get(c.pistaId) ?? 'banda') ?? 1) })).filter((c) => c.ganancia > 0)
}

/**
 * La mezcla del celular de Sonido (el que va a la consola): la del director
 * (sus faders, mute y solo), sin el click ni la guia —salvo que se pidan, para
 * un ensayo— y todo al centro: en estereo de verdad, no con la banda a un lado
 * como en los oidos. Sin "Mi mezcla": lo fino se hace en la consola.
 */
export function mezclaDeSonido(proyecto: Pick<Proyecto, 'pistas' | 'tempo' | 'analisis'>, salida: SalidaSonido): CanalMezcla[] {
  const tipos = new Map(proyecto.pistas.map((p) => [p.id, tipoDePista(proyecto, p)]))
  return mezclaEfectiva(proyecto.pistas)
    .filter((c) => {
      const tipo = tipos.get(c.pistaId)
      return tipo === 'banda' || (tipo === 'click' && salida.click) || (tipo === 'guia' && salida.guia)
    })
    .map((c) => ({ ...c, pan: 0 }))
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
