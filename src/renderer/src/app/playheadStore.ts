import { useSyncExternalStore } from 'react'

/**
 * Posicion de reproduccion (ms) como store externo: se actualiza ~30 veces por
 * segundo desde un loop de requestAnimationFrame, y SOLO se re-renderizan los
 * componentes que la usan (reloj, timeline, seccion actual), no la app entera
 * (el mixer con muchas pistas no tiene por que redibujarse en cada frame).
 */
let valor = 0
const oyentes = new Set<() => void>()

export function setPlayheadMs(ms: number): void {
  const redondeado = Math.round(ms)
  if (redondeado === valor) return
  valor = redondeado
  for (const o of oyentes) o()
}

export function getPlayheadMs(): number {
  return valor
}

function subscribe(cb: () => void): () => void {
  oyentes.add(cb)
  return () => oyentes.delete(cb)
}

export function usePlayheadMs(): number {
  return useSyncExternalStore(subscribe, getPlayheadMs, getPlayheadMs)
}

/** Igual que usePlayheadMs pero con menor resolucion (solo re-renderiza al cambiar de paso): para textos mm:ss o la seccion actual. */
export function usePlayheadPaso(pasoMs = 250): number {
  const snapshot = (): number => Math.floor(valor / pasoMs) * pasoMs
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
