import { useEffect, useState } from 'react'
import type { ProyectoResumen } from '@shared/types'
import type { AppController } from '../App'

interface Props {
  controller: AppController
  cargando: boolean
  error: string | null
  onCargarZip: () => void
  onCerrar: () => void
  puedeCerrar: boolean
}

export function ProjectsScreen({ controller, cargando, error, onCargarZip, onCerrar, puedeCerrar }: Props) {
  const [proyectos, setProyectos] = useState<ProyectoResumen[]>([])
  const [cargandoLista, setCargandoLista] = useState(true)

  async function recargar(): Promise<void> {
    setCargandoLista(true)
    setProyectos(await controller.listSavedProjects())
    setCargandoLista(false)
  }

  useEffect(() => {
    void recargar()
  }, [])

  async function abrir(id: string): Promise<void> {
    const r = await controller.openSavedProject(id)
    if (r.ok) onCerrar()
  }

  async function eliminar(id: string): Promise<void> {
    if (!confirm('¿Eliminar este proyecto guardado? No se puede deshacer.')) return
    await controller.deleteSavedProject(id)
    void recargar()
  }

  return (
    <div className="overlay">
      <div className="panel panel-proyectos" onClick={(e) => e.stopPropagation()}>
        <h2>Proyectos guardados</h2>

        <button className="btn-primario" onClick={onCargarZip} disabled={cargando}>
          {cargando ? 'Cargando…' : 'Cargar nuevo proyecto desde .zip'}
        </button>
        {error && <p className="aviso">{error}</p>}

        {cargandoLista ? (
          <p>Cargando proyectos…</p>
        ) : proyectos.length === 0 ? (
          <p>No hay proyectos guardados todavía.</p>
        ) : (
          <ul className="lista-proyectos">
            {proyectos.map((p) => (
              <li key={p.id}>
                <button className="proyecto-item" onClick={() => abrir(p.id)}>
                  <span className="proyecto-nombre">{p.nombre}</span>
                  <span className="proyecto-meta">
                    {p.cantidadPistas} pistas · {p.cantidadMarcadores} marcadores
                  </span>
                </button>
                <button className="proyecto-borrar" onClick={() => eliminar(p.id)} title="Eliminar proyecto">
                  🗑
                </button>
              </li>
            ))}
          </ul>
        )}

        {puedeCerrar && (
          <button className="btn-cerrar-panel" onClick={onCerrar}>
            Cerrar
          </button>
        )}
      </div>
    </div>
  )
}
