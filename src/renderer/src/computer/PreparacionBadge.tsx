import type { PreparacionProyecto } from '@shared/types'

/**
 * Distingue "tengo los bytes" de "el audio ya esta realmente preparado"
 * (pedido explicito): 🟡 cubre tanto descarga como decodificacion porque
 * para el operador ambas son "todavia no puedo tocar Play tranquilo".
 */
export function PreparacionBadge({ preparacion }: { preparacion: PreparacionProyecto | undefined }) {
  if (!preparacion || preparacion.estado === 'sin-preparar') {
    return <span className="prep-badge prep-badge-espera">⚪ en cola</span>
  }
  if (preparacion.estado === 'descargando') {
    const pct = preparacion.progreso !== undefined ? ` ${Math.round(preparacion.progreso * 100)}%` : ''
    return <span className="prep-badge prep-badge-preparando">🟡 descargando{pct}</span>
  }
  if (preparacion.estado === 'preparando') {
    return <span className="prep-badge prep-badge-preparando">🟡 preparando</span>
  }
  if (preparacion.estado === 'listo') {
    return <span className="prep-badge prep-badge-listo">🟢 listo</span>
  }
  return <span className="prep-badge prep-badge-error">🔴 error</span>
}
