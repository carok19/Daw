import type { EstadoCompleto } from '@shared/types'

/**
 * "Terminar con fundido": una rampa que baja (como el fundido de salida en
 * una consola o un programa de audio).
 */
export function IconoFundido({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden className="icono-fundido">
      <path d="M3 5 L21 19 H3 Z" fill="currentColor" fillOpacity={0.3} />
    </svg>
  )
}

/**
 * En que anda "Terminar": 'pendiente' = espera el final de la seccion (o el
 * compas) para empezar a apagarse; 'apagandose' = bajando; null = nada.
 */
export function estadoTerminar(e: EstadoCompleto | null): 'pendiente' | 'apagandose' | null {
  if (e?.fundido) return 'apagandose'
  if (e?.saltoPendiente?.fin) return 'pendiente'
  return null
}

/** Cuando empieza a apagarse con "Terminar", segun el modo de salto. */
export function textoCuandoTermina(modo: EstadoCompleto['modoSalto'] | undefined): string {
  return modo === 'inmediato' ? 'se apaga ya' : modo === 'compas' ? 'se apaga desde el próximo compás' : 'se apaga al terminar la sección'
}
