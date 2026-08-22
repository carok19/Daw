import { useState } from 'react'
import type { Marcador, Proyecto } from '@shared/types'
import { formatMmSs } from '../format'

interface Props {
  proyecto: Proyecto
  playheadMs: number
  onJump: (marcadorId: string) => void
  onCreate: (tiempoMs: number, nombre?: string) => void
  onUpdate: (marcadorId: string, patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs'>>) => void
  onDelete: (marcadorId: string) => void
}

export function MarkersPanel({ proyecto, playheadMs, onJump, onCreate, onUpdate, onDelete }: Props) {
  const [nombreNuevo, setNombreNuevo] = useState('')
  const ordenados = [...proyecto.marcadores].sort((a, b) => a.tiempoMs - b.tiempoMs)

  function agregar(): void {
    onCreate(playheadMs, nombreNuevo.trim() || undefined)
    setNombreNuevo('')
  }

  return (
    <div className="markers-panel">
      <h3>Marcadores</h3>
      <p className="markers-ayuda">
        Con la canción sonando, presioná <kbd>M</kbd> para marcar el punto exacto, o escribí un nombre acá y tocá el
        botón. También podés arrastrar los banderines amarillos sobre la barra de progreso para reacomodarlos.
      </p>
      <div className="markers-nuevo">
        <input
          placeholder="Nombre (opcional)"
          value={nombreNuevo}
          onChange={(e) => setNombreNuevo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && agregar()}
        />
        <button onClick={agregar} title="Agregar marcador en la posición actual (tecla M)">
          + En {formatMmSs(playheadMs)}
        </button>
      </div>
      <ul className="markers-lista">
        {ordenados.map((m) => (
          <MarkerRow key={m.id} marcador={m} onJump={onJump} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
        {ordenados.length === 0 && <li className="markers-vacio">Sin marcadores todavía.</li>}
      </ul>
    </div>
  )
}

function MarkerRow({
  marcador,
  onJump,
  onUpdate,
  onDelete
}: {
  marcador: Marcador
  onJump: (id: string) => void
  onUpdate: (id: string, patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs'>>) => void
  onDelete: (id: string) => void
}) {
  const [editando, setEditando] = useState(false)
  const [nombreTmp, setNombreTmp] = useState(marcador.nombre)

  function confirmar(): void {
    setEditando(false)
    if (nombreTmp.trim() && nombreTmp.trim() !== marcador.nombre) onUpdate(marcador.id, { nombre: nombreTmp.trim() })
  }

  return (
    <li className="marker-row">
      <button className="marker-tiempo" onClick={() => onJump(marcador.id)}>
        {formatMmSs(marcador.tiempoMs)}
      </button>
      {editando ? (
        <input
          autoFocus
          value={nombreTmp}
          onChange={(e) => setNombreTmp(e.target.value)}
          onBlur={confirmar}
          onKeyDown={(e) => e.key === 'Enter' && confirmar()}
        />
      ) : (
        <span className="marker-nombre" onDoubleClick={() => setEditando(true)}>
          {marcador.nombre}
        </span>
      )}
      <button className="marker-borrar" onClick={() => onDelete(marcador.id)} title="Eliminar">
        🗑
      </button>
    </li>
  )
}
