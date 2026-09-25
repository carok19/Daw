import { AlertTriangle, Info, X } from 'lucide-react'
import type { Aviso } from '../app/useAppController'

export function Avisos({ avisos, onCerrar }: { avisos: Aviso[]; onCerrar: (id: number) => void }) {
  if (avisos.length === 0) return null
  return (
    <div className="avisos" role="status">
      {avisos.map((a) => (
        <div key={a.id} className={`aviso ${a.tipo === 'error' ? 'aviso-error' : ''}`}>
          {a.tipo === 'error' ? <AlertTriangle size={18} color="#ff7a7a" /> : <Info size={18} color="#8fb0ff" />}
          <span>{a.texto}</span>
          {a.accion && (
            <button
              className="btn-chico btn-primario"
              onClick={() => {
                a.accion!.fn()
                onCerrar(a.id)
              }}
            >
              {a.accion.etiqueta}
            </button>
          )}
          <button className="btn-fantasma btn-icono" onClick={() => onCerrar(a.id)} aria-label="Cerrar aviso">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
