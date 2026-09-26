import { useEffect, useMemo, useState } from 'react'
import { FileArchive, FolderOpen, FolderSync, LoaderCircle, Music, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { EstadoAnalisis, EstadoBiblioteca, ImportProgreso, ProyectoResumen } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { Modal } from '../ui/Modal'
import { useConfirmar } from '../ui/Confirmar'
import { formatDuracion, formatFecha } from '../format'

interface Props {
  controller: AppController
  onCerrar: () => void
}

function textoProgreso(p: ImportProgreso): string {
  if (p.etapa === 'extrayendo') return p.total ? `Descomprimiendo ${p.actual}/${p.total}…` : 'Descomprimiendo…'
  return `Preparando pistas ${p.actual}/${p.total}${p.pista ? ` — ${p.pista}` : ''}`
}

type Orden = 'recientes' | 'az'
const TODAS = '\u0000todas'

function leerOrden(): Orden {
  try {
    return localStorage.getItem('canciones-orden') === 'az' ? 'az' : 'recientes'
  } catch {
    return 'recientes'
  }
}

function textoCompas(compas: number): string {
  return compas === 6 ? '6/8' : `${compas}/4`
}

const ETIQUETA_ANALISIS: Partial<Record<EstadoAnalisis, string>> = {
  analizando: 'Analizando…',
  'esperando-voz': 'Leyendo la guía…',
  reconociendo: 'Leyendo la guía…',
  'falta-modelo': 'Falta el reconocedor',
  error: 'Error de análisis'
}

/** "Alabanza/Rápidas" -> "Alabanza › Rápidas" */
function nombreCategoria(c: string): string {
  return c ? c.split('/').join(' › ') : 'Sin categoría'
}

/** Biblioteca: todas las canciones de la compu (importar, sumar arriba, borrar). */
export function ProjectsScreen({ controller, onCerrar }: Props) {
  const confirmar = useConfirmar()
  const [proyectos, setProyectos] = useState<ProyectoResumen[] | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [categoria, setCategoria] = useState<string>(TODAS)
  const [orden, setOrdenEstado] = useState<Orden>(leerOrden)
  function setOrden(o: Orden): void {
    setOrdenEstado(o)
    try {
      localStorage.setItem('canciones-orden', o)
    } catch {
      /* sin almacenamiento: solo por esta vez */
    }
  }
  const abiertos = new Set(controller.estado?.tabs.map((t) => t.proyectoId))
  const lista = controller.estado?.lista ?? null

  async function recargar(): Promise<void> {
    setProyectos(await controller.listSavedProjects())
  }

  // se recarga sola cuando cambia algo (importacion de la biblioteca, analisis terminado...)
  useEffect(() => {
    void recargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.versionProyectos])

  const categorias = useMemo(() => {
    const cuenta = new Map<string, number>()
    for (const p of proyectos ?? []) cuenta.set(p.categoria, (cuenta.get(p.categoria) ?? 0) + 1)
    return [...cuenta.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0], 'es')))
  }, [proyectos])
  const hayCategorias = categorias.some(([c]) => c !== '')
  // si la categoria elegida se quedo sin canciones, se vuelve a "Todas"
  const categoriaActiva = categoria !== TODAS && categorias.some(([c]) => c === categoria) ? categoria : TODAS

  const filtrados = useMemo(() => {
    const q = normalizar(busqueda.trim())
    const lista = (proyectos ?? []).filter(
      (p) => (!q || normalizar(p.nombre).includes(q)) && (categoriaActiva === TODAS || p.categoria === categoriaActiva)
    )
    return lista.sort((a, b) =>
      orden === 'az'
        ? a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base', numeric: true })
        : (b.usadoEn ?? b.creadoEn).localeCompare(a.usadoEn ?? a.creadoEn)
    )
  }, [proyectos, busqueda, categoriaActiva, orden])

  async function importar(): Promise<void> {
    setError(null)
    setOcupado('importar')
    const r = await controller.loadZip()
    setOcupado(null)
    if (r.ok) {
      avisarSiNoSeActivo(r.activada)
      onCerrar()
    } else if (r.error) setError(r.error)
  }

  async function abrir(id: string): Promise<void> {
    setError(null)
    setOcupado(id)
    const r = await controller.openSavedProject(id)
    setOcupado(null)
    if (r.ok) {
      avisarSiNoSeActivo(r.activada)
      onCerrar()
    } else setError(r.error ?? 'No se pudo abrir la canción')
  }

  function avisarSiNoSeActivo(activada: boolean | undefined): void {
    if (activada === false) {
      controller.avisar({ tipo: 'info', texto: `Se agregó al final ${lista ? `de “${lista.nombre}”` : 'de la lista'} sin cortar la canción que está sonando.` })
    }
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

  return (
    <Modal
      titulo={lista ? `Canciones · sumar a “${lista.nombre}”` : 'Canciones'}
      icono={<Music size={20} color="var(--accent)" />}
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

      <BarraBiblioteca
        biblioteca={controller.biblioteca}
        onAbrir={controller.abrirCarpetaBiblioteca}
        onCambiar={async () => {
          const r = await controller.elegirCarpetaBiblioteca()
          if (!r.ok && r.error) setError(r.error)
        }}
        onEscanear={controller.escanearBiblioteca}
      />
      <div className="barra-busqueda">
        <button className="btn-primario" onClick={importar} disabled={!!ocupado}>
          <FileArchive size={16} /> {ocupado === 'importar' ? 'Importando…' : 'Importar .zip / .rar'}
        </button>
        <input
          type="search"
          placeholder="Buscar canción…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          aria-label="Buscar canción"
        />
        <div className="segmentado segmentado-chico" role="group" aria-label="Orden">
          <button className={orden === 'recientes' ? 'activo' : ''} onClick={() => setOrden('recientes')} title="Las últimas usadas primero">
            Recientes
          </button>
          <button className={orden === 'az' ? 'activo' : ''} onClick={() => setOrden('az')} title="Por nombre">
            A–Z
          </button>
        </div>
      </div>
      {hayCategorias && (
        <div className="categorias" role="tablist" aria-label="Categorías">
          <button
            role="tab"
            aria-selected={categoriaActiva === TODAS}
            className={categoriaActiva === TODAS ? 'activo' : ''}
            onClick={() => setCategoria(TODAS)}
          >
            Todas <span className="num">{proyectos?.length ?? 0}</span>
          </button>
          {categorias.map(([c, n]) => (
            <button
              key={c || '-'}
              role="tab"
              aria-selected={categoriaActiva === c}
              className={categoriaActiva === c ? 'activo' : ''}
              onClick={() => setCategoria(c)}
            >
              {nombreCategoria(c)} <span className="num">{n}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-texto">{error}</p>}
      {proyectos === null ? (
        <p className="vacio">Cargando…</p>
      ) : filtrados.length === 0 ? (
        <p className="vacio">
          {busqueda
            ? 'No hay canciones con ese nombre.'
            : 'Todavía no hay canciones. Importá un .zip o .rar, o copialo en la carpeta de la biblioteca.'}
        </p>
      ) : (
        <ul className="lista">
          {filtrados.map((p) => (
            <li key={p.id} className="lista-fila clic" onClick={() => !ocupado && abrir(p.id)}>
              <div className="lista-principal">
                <span className="lista-titulo">{p.nombre}</span>
                <span className="lista-meta num">
                  {formatDuracion(p.duracionTotalMs)} · {p.cantidadPistas} pistas · {p.cantidadMarcadores} secciones
                  {p.bpm ? ` · ${Math.round(p.bpm)} BPM ${textoCompas(p.compas ?? 4)}` : ''}
                  {categoriaActiva === TODAS && p.categoria ? ` · ${nombreCategoria(p.categoria)}` : ''}
                  {' · '}
                  {p.usadoEn ? `usada ${formatFecha(p.usadoEn)}` : formatFecha(p.creadoEn)}
                </span>
              </div>
              {p.analisis && ETIQUETA_ANALISIS[p.analisis] && (
                <span className={`lista-etiqueta ${p.analisis === 'error' ? 'etiqueta-error' : 'etiqueta-suave'}`}>
                  {ETIQUETA_ANALISIS[p.analisis]}
                </span>
              )}
              {abiertos.has(p.id) && <span className="lista-etiqueta">{lista ? 'En la lista' : 'Arriba'}</span>}
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
    </Modal>
  )
}

function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** La carpeta vigilada: lo que se copie ahi (con subcarpetas como categorias) se importa solo. */
function BarraBiblioteca({
  biblioteca,
  onAbrir,
  onCambiar,
  onEscanear
}: {
  biblioteca: EstadoBiblioteca | null
  onAbrir: (ruta: string) => void
  onCambiar: () => void
  onEscanear: () => void
}) {
  const esCompu = !!window.electronAPI?.elegirCarpeta
  if (!biblioteca) return null
  const { ruta } = biblioteca
  let estado: JSX.Element | null = null
  if (biblioteca.esperandoSilencio)
    estado = (
      <span className="biblioteca-estado">
        {biblioteca.pendientes} {biblioteca.pendientes === 1 ? 'canción nueva espera' : 'canciones nuevas esperan'} a que pare la
        música para importarse
      </span>
    )
  else if (biblioteca.importando)
    estado = (
      <span className="biblioteca-estado">
        <LoaderCircle size={13} className="girando" /> Importando “{biblioteca.importando}”
        {biblioteca.pendientes > 1 ? ` (y ${biblioteca.pendientes - 1} más)` : ''}…
      </span>
    )
  else if (biblioteca.ultimoError) estado = <span className="biblioteca-estado error-texto">{biblioteca.ultimoError}</span>

  return (
    <div className="biblioteca">
      <div className="biblioteca-fila">
        <FolderSync size={16} className="biblioteca-icono" />
        <div className="biblioteca-texto">
          <span className="biblioteca-titulo">Carpeta de canciones</span>
          <span className="biblioteca-ruta" title={ruta ?? ''}>
            {ruta ?? 'Sin carpeta'}
          </span>
        </div>
        {esCompu && ruta && (
          <button className="btn-chico" onClick={() => onAbrir(ruta)} title="Abrir la carpeta en el explorador">
            <FolderOpen size={14} /> Abrir
          </button>
        )}
        {esCompu && (
          <button className="btn-chico" onClick={onCambiar} title="Elegir otra carpeta (por ejemplo, una sincronizada con Drive o Dropbox)">
            Cambiar…
          </button>
        )}
        <button className="btn-fantasma btn-icono" onClick={onEscanear} title="Buscar canciones nuevas ahora" aria-label="Buscar canciones nuevas">
          <RefreshCw size={15} />
        </button>
      </div>
      {estado ?? (
        <span className="biblioteca-estado">
          Copiá los .zip o .rar acá y se importan solos (una pista por archivo: WAV, MP3, M4A, AIFF, FLAC u OGG). Usá subcarpetas para
          ordenarlas: <i>Adoración</i>, <i>Alabanza</i>, <i>Navidad</i>… Al lado de cada canción queda su ficha (
          <i>.multitrack.json</i>) con las secciones, la mezcla y el tempo: copiando esta carpeta a otra compu, todo vuelve igual.
        </span>
      )}
    </div>
  )
}
