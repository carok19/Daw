import type { ReactNode } from 'react'

export function Toggle({
  activo,
  onCambiar,
  children,
  titulo,
  variante
}: {
  activo: boolean
  onCambiar: (v: boolean) => void
  children: ReactNode
  titulo?: string
  variante?: 'warn'
}) {
  return (
    <button
      className={`toggle ${activo ? 'on' : ''} ${variante === 'warn' ? 'toggle-warn' : ''}`}
      onClick={() => onCambiar(!activo)}
      title={titulo}
      role="switch"
      aria-checked={activo}
    >
      <span className="toggle-pista" />
      {children}
    </button>
  )
}
