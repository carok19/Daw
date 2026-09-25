import { useEffect, useMemo, useState } from 'react'
import { FileArchive, ListMusic, Music, Plus, Save, Trash2 } from 'lucide-react'
import type { ImportProgreso, ProyectoResumen, SetlistResumen } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { Modal } from '../ui/Modal'
import { useConfirmar } from '../ui/Confirmar'
import { formatDuracion, formatFecha } from '../format'

interface Props {
  controller: AppController
  vistaInicial?: 'canciones' | 'setlists'
  onCerrar: () => void
}

function textoProgreso(p: ImportProgreso): string {
  if (p.etapa === 'extrayendo') return 'Descomprimiendo el zip…'
  return `Preparando pistas ${p.actual}/${p.total}${p.pista ? ` — ${p.pista}` : ''}`
}

export function ProjectsScreen({ controller, vistaInicial = 'canciones', onCerrar }: Props) {
  const confirmar = useConfirmar()
  const [vista, setVista] = useState(vistaInicial)
  const [proyectos, setProyectos] = useState<ProyectoResumen[] | null>(null)
  const [setlists, setSetlists] = useState<SetlistResumen[] | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [nombreSetlist, setNombreSetlist] = useState('')
  const abiertos = new Set(controller.estado?.tabs.map((t) => t.proyectoId))
  const hayCanciones = (controller.estado?.tabs.length ?? 0) > 0

  async function recargar(): Promise<void> {
    const [p, s] = await Promise.all([controller.listSavedProjects(), controller.listSetlists()])
    setProyectos(p)
    setSetlists(s)
  }

  useEffect(() => {
    void recargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return (proyectos ?? []).filter((p) => !q || p.nombre.toLowerCase().includes(q))
  }, [proyectos, busqueda])

  async function importar(): Promise<void> {
    setError(null)
    setOcupado('importar')
    const r = await controller.loadZip()
    setOcupado(null)
    if (r.ok) onCerrar()
    else if (r.error) setError(r.error)
  }

  async function abrir(id: string): Promise<void> {
    setError(null)
    setOcupado(id)
    const r = await controller.openSavedProject(id)
    setOcupado(null)
    if (r.ok) onCerrar()
    else setError(r.error ?? 'No se pudo abrir la canción')
  }

  async function borrar(p: ProyectoResumen): Promise<void> {
    const ok = await confirmar({
      titulo: 'Borrar canción',
      mensaje: (
        <>
          Se va a borrar <b>{p.nombre}</b> de esta computadora, con sus pistas y secciones. No se puede deshacer.
        </>
      ),
      confirmar: 'Borrar',
      peligro: true
    })
    if (!ok) return
    await controller.deleteSavedProject(p.id)
    void recargar()
  }

  async function guardarSetlist(): Promise<void> {
    setError(null)
    const r = await controller.saveSetlist(nombreSetlist)
    if (!r.ok) {
      setError(r.error ?? 'No se pudo guardar')
      return
    }
    setNombreSetlist('')
    void recargar()
    controller.avisar({ tipo: 'info', texto: 'Setlist guardado' })
  }

  async function abrirSetlist(s: SetlistResumen): Promise<void> {
    if (hayCanciones) {
      const ok = await confirmar({
        titulo: 'Abrir setlist',
        mensaje: (
          <>
            Se van a reemplazar las canciones abiertas por las de <b>{s.nombre}</b>. Si algo está sonando, se detiene.
          </>
        ),
        confirmar: 'Abrir setlist'
      })
      if (!ok) return
    }
    setOcupado(s.id)
    const r = await controller.openSetlist(s.id)
    setOcupado(null)
    if (r.ok) {
      if (r.error) controller.avisar({ tipo: 'error', texto: r.error })
      onCerrar()
    } else setError(r.error ?? 'No se pudo abrir el setlist')
  }

  async function borrarSetlist(s: SetlistResumen): Promise<void> {
    const ok = await confirmar({
      titulo: 'Borrar setlist',
      mensaje: (
        <>
          Se borra el setlist <b>{s.nombre}</b> (las canciones no se tocan).
        </>
      ),
      confirmar: 'Borrar',
      peligro: true
    })
    if (!ok) return
    await controller.deleteSetlist(s.id)
    void recargar()
  }

  return (
    <Modal
      titulo={
        <div className="segmentado">
          <button className={vista === 'canciones' ? 'activo' : ''} onClick={() => setVista('canciones')}>
            <Music size={15} /> Canciones
          </button>
          <button className={vista === 'setlists' ? 'activo' : ''} onClick={() => setVista('setlists')}>
            <ListMusic size={15} /> Setlists
          </button>
        </div>
      }
      tamano="ancho"
      onCerrar={onCerrar}
    >
      {controller.importProgreso && (
        <div className="importando">
          {textoProgreso(controller.importProgreso)}
          <div className="progreso">
            <div
              style={{
                width: `${controller.importProgreso.total ? (controller.importProgreso.actual / controller.importProgreso.total) * 100 : 5}%`
              }}
            />
          </div>
        </div>
      )}

      {vista === 'canciones' ? (
        <>
          <div className="barra-busqueda">
            <button className="btn-primario" onClick={importar} disabled={!!ocupado}>
              <FileArchive size={16} /> {ocupado === 'importar' ? 'Importando…' : 'Importar canción (.zip)'}
            </button>
            <input
              type="search"
              placeholder="Buscar canción…"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              aria-label="Buscar canción"
            />
          </div>
          <p className="ayuda" style={{ marginTop: 0 }}>
            El zip tiene que traer una pista por archivo (WAV, MP3, M4A, AIFF, FLAC u OGG). Se convierten solas para que suenen en
            todos los celulares.
          </p>
          {error && <p className="error-texto">{error}</p>}
          {proyectos === null ? (
            <p className="vacio">Cargando…</p>
          ) : filtrados.length === 0 ? (
            <p className="vacio">{busqueda ? 'No hay canciones con ese nombre.' : 'Todavía no hay canciones guardadas.'}</p>
          ) : (
            <ul className="lista">
              {filtrados.map((p) => (
                <li key={p.id} className="lista-fila clic" onClick={() => !ocupado && abrir(p.id)}>
                  <div className="lista-principal">
                    <span className="lista-titulo">{p.nombre}</span>
                    <span className="lista-meta num">
                      {formatDuracion(p.duracionTotalMs)} · {p.cantidadPistas} pistas · {p.cantidadMarcadores} secciones ·{' '}
                      {formatFecha(p.creadoEn)}
                    </span>
                  </div>
                  {abiertos.has(p.id) && <span className="lista-etiqueta">En el setlist</span>}
                  <button className="btn-chico" disabled={!!ocupado} onClick={(e) => (e.stopPropagation(), abrir(p.id))}>
                    {ocupado === p.id ? 'Abriendo…' : abiertos.has(p.id) ? 'Ir' : <><Plus size={14} /> Agregar</>}
                  </button>
                  <button
                    className="btn-fantasma btn-icono"
                    title="Borrar canción"
                    aria-label={`Borrar ${p.nombre}`}
                    onClick={(e) => (e.stopPropagation(), borrar(p))}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="barra-busqueda">
            <input
              placeholder="Nombre para guardar el setlist actual (ej: Domingo 10 hs)"
              value={nombreSetlist}
              maxLength={60}
              onChange={(e) => setNombreSetlist(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && guardarSetlist()}
            />
            <button className="btn-primario" onClick={guardarSetlist} disabled={!hayCanciones || !nombreSetlist.trim()}>
              <Save size={16} /> Guardar actual
            </button>
          </div>
          {error && <p className="error-texto">{error}</p>}
          {setlists === null ? (
            <p className="vacio">Cargando…</p>
          ) : setlists.length === 0 ? (
            <p className="vacio">Todavía no hay setlists. Armá el orden de canciones arriba y guardalo con un nombre.</p>
          ) : (
            <ul className="lista">
              {setlists.map((s) => (
                <li key={s.id} className="lista-fila clic" onClick={() => !ocupado && abrirSetlist(s)}>
                  <div className="lista-principal">
                    <span className="lista-titulo">{s.nombre}</span>
                    <span className="lista-meta">
                      {s.canciones.length} canciones · {s.canciones.join(' → ')}
                    </span>
                  </div>
                  <button className="btn-chico" disabled={!!ocupado} onClick={(e) => (e.stopPropagation(), abrirSetlist(s))}>
                    {ocupado === s.id ? 'Abriendo…' : 'Abrir'}
                  </button>
                  <button
                    className="btn-fantasma btn-icono"
                    title="Borrar setlist"
                    aria-label={`Borrar setlist ${s.nombre}`}
                    onClick={(e) => (e.stopPropagation(), borrarSetlist(s))}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  )
}
