import { useState } from 'react'
import { Flag, Pencil, Trash2 } from 'lucide-react'
import type { Marcador } from '@shared/types'
import type { Seccion } from '@shared/playback'
import { seccionEn } from '@shared/playback'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'

interface Props {
  secciones: Seccion[]
  onJump: (marcadorId: string) => void
  onCreate: (tiempoMs: number, nombre?: string) => void
  onRename: (marcadorId: string, nombre: string) => void
  onDelete: (marcador: Marcador) => void
}

export function MarkersPanel({ secciones, onJump, onCreate, onRename, onDelete }: Props) {
  const [nombreNuevo, setNombreNuevo] = useState('')
  const pos = usePlayheadPaso(100)
  const actual = seccionEn(secciones, pos)
  const conMarcador = secciones.filter((s) => s.marcador)

  function agregar(): void {
    onCreate(pos, nombreNuevo.trim() || undefined)
    setNombreNuevo('')
  }

  return (
    <aside className="secciones">
      <div className="secciones-cabecera">
        <h3>
          Secciones <span className="num">{conMarcador.length}</span>
        </h3>
        <div className="secciones-nueva">
          <input
            placeholder="Nombre (Intro, Coro…)"
            value={nombreNuevo}
            maxLength={60}
            onChange={(e) => setNombreNuevo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && agregar()}
          />
          <button className="btn-primario" onClick={agregar} title="Marcar una sección en la posición actual (M)">
            <Flag size={15} />
            <span className="num">{formatMmSs(pos)}</span>
          </button>
        </div>
      </div>

      <ul className="secciones-lista">
        {conMarcador.length === 0 && (
          <li className="vacio">
            Todavía no hay secciones.
            <br />
            Con la canción sonando, presioná <kbd>M</kbd> en cada parte.
          </li>
        )}
        {conMarcador.map((s, i) => (
          <FilaSeccion
            key={s.marcador!.id}
            seccion={s}
            numero={i + 1}
            actual={actual?.indice === s.indice}
            onJump={() => onJump(s.marcador!.id)}
            onRename={(n) => onRename(s.marcador!.id, n)}
            onDelete={() => onDelete(s.marcador!)}
          />
        ))}
      </ul>

      <div className="secciones-pie">
        <kbd>1</kbd>…<kbd>9</kbd> saltar a una sección · <kbd>←</kbd> <kbd>→</kbd> anterior / siguiente · arrastrá los
        triángulos de la línea de tiempo para mover una sección.
      </div>
    </aside>
  )
}

function FilaSeccion({
  seccion,
  numero,
  actual,
  onJump,
  onRename,
  onDelete
}: {
  seccion: Seccion
  numero: number
  actual: boolean
  onJump: () => void
  onRename: (nombre: string) => void
  onDelete: () => void
}) {
  const [editando, setEditando] = useState(false)
  const [nombre, setNombre] = useState(seccion.nombre)

  function empezar(): void {
    setNombre(seccion.nombre)
    setEditando(true)
  }
  function confirmar(): void {
    setEditando(false)
    if (nombre.trim() && nombre.trim() !== seccion.nombre) onRename(nombre.trim())
  }

  return (
    <li className={`seccion-fila ${actual ? 'actual' : ''}`} onClick={() => !editando && onJump()} title="Click para ir a esta sección">
      <span className="seccion-numero num">{numero <= 9 ? numero : ''}</span>
      <span className="seccion-color" style={{ background: colorDeSeccion(seccion) }} />
      <span className="seccion-tiempo num">{formatMmSs(seccion.inicioMs)}</span>
      {editando ? (
        <input
          className="seccion-nombre-input"
          autoFocus
          value={nombre}
          maxLength={60}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNombre(e.target.value)}
          onBlur={confirmar}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirmar()
            if (e.key === 'Escape') setEditando(false)
          }}
        />
      ) : (
        <span className="seccion-nombre" onDoubleClick={(e) => (e.stopPropagation(), empezar())}>
          {seccion.nombre}
        </span>
      )}
      {!editando && (
        <span className="seccion-acciones">
          <button
            title="Renombrar"
            aria-label={`Renombrar ${seccion.nombre}`}
            onClick={(e) => {
              e.stopPropagation()
              empezar()
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            title="Borrar (se puede deshacer)"
            aria-label={`Borrar ${seccion.nombre}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 size={14} />
          </button>
        </span>
      )}
    </li>
  )
}
