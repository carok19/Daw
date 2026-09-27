import { MARGIN_MS } from './transport'

/**
 * Cuanto tardan en llegar las ordenes de la compu a cada celular. Para
 * arrancar todos juntos, cada play/pausa se programa un poco a futuro (el
 * "margen"), asi la orden llega a todos antes de su hora. Antes era siempre
 * 1,5 s; ahora se mide: la compu le manda a cada celular una pregunta cada
 * 2 s y cuenta cuanto tarda en volver la respuesta (ida y vuelta: incluye
 * las demoras del WiFi y del ahorro de energia del celular). El margen es lo
 * que tardo el peor celular en el ultimo minuto, mas un colchon; con buen
 * WiFi, medio segundo.
 *
 * Si una orden igual llega tarde a algun celular, se vuelve al margen
 * completo por un par de minutos.
 */

/** Nunca menos que esto (el celular tambien necesita un momento para programar el audio). */
export const MARGEN_MIN_MS = 450
/** Colchon sobre lo que tardo el peor celular. */
export const COLCHON_MS = 250
/** Cuantas mediciones por celular se miran (~1 minuto). */
const MUESTRAS = 30
/** Con menos mediciones que estas (recien conectado), el margen completo. */
const MIN_MUESTRAS = 5
/** Despues de una orden que llego tarde, margen completo por este tiempo. */
const CASTIGO_MS = 120_000

export class MedidorEntrega {
  private medidas = new Map<string, number[]>()
  private completoHasta = 0

  /** Ida y vuelta (ms) de una pregunta a un celular. */
  registrar(id: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const l = this.medidas.get(id) ?? []
    l.push(ms)
    if (l.length > MUESTRAS) l.shift()
    this.medidas.set(id, l)
  }

  olvidar(id: string): void {
    this.medidas.delete(id)
  }

  /** Una orden llego tarde a un celular: margen completo por un rato. */
  tarde(ahora = Date.now()): void {
    this.completoHasta = ahora + CASTIGO_MS
  }

  /** Lo que tardo el peor de estos celulares (null si alguno todavia no tiene mediciones suficientes). */
  peor(ids: string[]): number | null {
    let peor = 0
    for (const id of ids) {
      const l = this.medidas.get(id)
      if (!l || l.length < MIN_MUESTRAS) return null
      peor = Math.max(peor, ...l)
    }
    return peor
  }

  /** Margen (ms) para programar una orden con estos celulares conectados. */
  margen(ids: string[], ahora = Date.now()): number {
    if (ahora < this.completoHasta) return MARGIN_MS
    const peor = this.peor(ids)
    if (peor === null) return MARGIN_MS
    return Math.round(Math.min(MARGIN_MS, Math.max(MARGEN_MIN_MS, peor + COLCHON_MS)))
  }
}
