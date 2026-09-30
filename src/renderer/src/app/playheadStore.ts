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

// golpe de la cuenta que esta sonando (1..N; 0 = no se esta contando)
let golpe = 0
const oyentesGolpe = new Set<() => void>()

export function setGolpeCuenta(n: number): void {
  if (n === golpe) return
  golpe = n
  for (const o of oyentesGolpe) o()
}

/** Numero de la cuenta que suena ahora ("1 2 3 4" antes de la cancion); 0 si no se esta contando. */
export function useGolpeCuenta(): number {
  return useSyncExternalStore(
    (cb) => {
      oyentesGolpe.add(cb)
      return () => oyentesGolpe.delete(cb)
    },
    () => golpe,
    () => golpe
  )
}

// colchon: compas y golpe que suenan ahora (compas * 100 + golpe; 0 = no hay colchon sonando)
let golpeColchon = 0
const oyentesColchon = new Set<() => void>()

export function setGolpeColchon(n: number): void {
  if (n === golpeColchon) return
  golpeColchon = n
  for (const o of oyentesColchon) o()
}

/** Compas y golpe del colchon que suena ("compás 12, golpe 3"); null si no hay colchon sonando. */
export function useGolpeColchon(): { compas: number; golpe: number } | null {
  const n = useSyncExternalStore(
    (cb) => {
      oyentesColchon.add(cb)
      return () => oyentesColchon.delete(cb)
    },
    () => golpeColchon,
    () => golpeColchon
  )
  return n > 0 ? { compas: Math.floor(n / 100), golpe: n % 100 } : null
}
