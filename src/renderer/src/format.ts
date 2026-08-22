/** mm:ss (seccion 5.2) */
export function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}
