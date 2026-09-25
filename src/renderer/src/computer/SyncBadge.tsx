import { UMBRAL_DURO_MS, UMBRAL_SUAVE_MS } from '../sync/driftConfig'

/**
 * Verde/amarillo/rojo segun el mismo drift (ms) que usa el sistema de
 * correccion continua: muestra exactamente la zona en la que esta actuando.
 */
export function SyncBadge({ driftMs }: { driftMs: number | null }) {
  if (driftMs === null) {
    return (
      <span className="dispositivo-estado texto-gris">
        <span className="punto gris" /> midiendo…
      </span>
    )
  }
  const redondeado = Math.round(driftMs)
  const abs = Math.abs(redondeado)
  const signo = redondeado > 0 ? '+' : redondeado < 0 ? '−' : ''
  const [clase, punto] = abs < UMBRAL_SUAVE_MS ? ['texto-verde', 'verde'] : abs < UMBRAL_DURO_MS ? ['texto-amarillo', 'amarillo'] : ['texto-rojo', 'rojo']
  return (
    <span className={`dispositivo-estado num ${clase}`} title="Desfase respecto al reloj del servidor">
      <span className={`punto ${punto}`} />
      {signo}
      {abs} ms
    </span>
  )
}
