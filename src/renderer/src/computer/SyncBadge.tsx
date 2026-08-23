import { UMBRAL_DURO_MS, UMBRAL_SUAVE_MS } from '../sync/driftConfig'

/**
 * 🟢/🟡/🔴 segun el mismo drift (ms) que decide el sistema de correccion
 * continua (ver useAppController) — no es un adorno separado, muestra
 * exactamente la zona en la que el sistema real esta actuando.
 */
export function SyncBadge({ driftMs }: { driftMs: number | null }) {
  if (driftMs === null) {
    return <span className="sync-badge sync-badge-sin-datos">○ sin datos</span>
  }
  const abs = Math.abs(driftMs)
  const signo = driftMs > 0 ? '+' : ''
  if (abs < UMBRAL_SUAVE_MS) {
    return <span className="sync-badge sync-badge-verde">🟢 {signo}{Math.round(driftMs)}ms</span>
  }
  if (abs < UMBRAL_DURO_MS) {
    return <span className="sync-badge sync-badge-amarillo">🟡 {signo}{Math.round(driftMs)}ms</span>
  }
  return <span className="sync-badge sync-badge-rojo">🔴 {signo}{Math.round(driftMs)}ms</span>
}
