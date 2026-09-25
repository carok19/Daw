/** m:ss */
export function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return `${mm}:${String(ss).padStart(2, '0')}`
}

/** "3 min 42 s" / "42 s" */
export function formatDuracion(ms: number): string {
  if (!ms || ms <= 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  return mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss} s`
}

/** Fader 0-100 (curva cuadratica, ver StreamingEngine.aplicarMezcla) expresado en dB. */
export function formatDb(volumen: number): string {
  if (volumen <= 0) return '−∞'
  const db = 40 * Math.log10(volumen / 100)
  if (Math.abs(db) < 0.05) return '0.0'
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`
}

export function formatPan(pan: number): string {
  if (pan === 0) return 'C'
  return pan < 0 ? `L${-pan}` : `R${pan}`
}

export function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return ''
  }
}

export function haceCuanto(ts: number | null, ahora = Date.now()): string {
  if (!ts) return ''
  const seg = Math.max(0, Math.round((ahora - ts) / 1000))
  if (seg < 60) return 'hace instantes'
  const min = Math.round(seg / 60)
  if (min < 60) return `hace ${min} min`
  return `hace ${Math.round(min / 60)} h`
}
