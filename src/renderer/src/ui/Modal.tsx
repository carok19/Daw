import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface Props {
  titulo: ReactNode
  onCerrar: () => void
  children: ReactNode
  pie?: ReactNode
  tamano?: 'chico' | 'normal' | 'ancho'
  icono?: ReactNode
}

/** Ventana modal: se cierra con Esc, con la X o tocando afuera (siempre igual en toda la app). */
export function Modal({ titulo, onCerrar, children, pie, tamano = 'normal', icono }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCerrar()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCerrar])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()} data-modal>
      <div className={`modal ${tamano === 'chico' ? 'modal-chico' : tamano === 'ancho' ? 'modal-ancho' : ''}`} role="dialog" aria-modal>
        <div className="modal-cabecera">
          {icono}
          <h2>{titulo}</h2>
          <button className="btn-fantasma btn-icono" onClick={onCerrar} title="Cerrar (Esc)" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </div>
    </div>
  )
}
