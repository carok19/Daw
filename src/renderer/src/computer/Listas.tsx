import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Folder,
  FolderPlus,
  GripVertical,
  Library,
  ListMusic,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { DatosListas, ListaResumen, ProyectoResumen } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { useConfirmar } from '../ui/Confirmar'
import { formatDuracion } from '../format'

/**
 * Listas por dia: cada lista es el orden de canciones de un dia ("Sabado
 * 17/10 · 19 hs"), en una carpeta opcional ("Congreso Juvenil 2026"). La que
 * se usa se carga en la barra de arriba, y lo que se cambie ahi queda
 * guardado en ella (lo hace el servidor).
 */

const TODAS = '\u0000todas'

// ---------- fechas (la fecha de la compu, no UTC) ----------

export function hoyISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function deISO(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d, 12)
}

function sumarDias(iso: string, n: number): string {
  const d = deISO(iso)
  d.setDate(d.getDate() + n)
  return hoyISO(d)
}

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

/** "Sábado 17/10" */
export function nombreDeFecha(iso: string): string {
  const d = deISO(iso)
  return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
}

function etiquetaFecha(iso: string | null, hoy: string): string | null {
  if (!iso) return null
  if (iso === hoy) return 'HOY'
  if (iso === sumarDias(hoy, -1)) return 'AYER'
  if (iso === sumarDias(hoy, 1)) return 'MAÑANA'
  return null
}

/** "sáb 17/10/2026" */
function fechaLarga(iso: string): string {
  const d = deISO(iso)
  return `${DIAS[d.getDay()].slice(0, 3).toLowerCase()} ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
}

function duracionLista(l: Pick<ListaResumen, 'canciones'>): string {
  const ms = l.canciones.reduce((t, c) => t + c.duracionMs, 0)
  const min = Math.round(ms / 60000)
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`
}

/** Hoy primero, despues las que vienen (la mas cercana primero), las sin fecha y al final las pasadas. */
function ordenarListas(listas: ListaResumen[], hoy: string): ListaResumen[] {
  const grupo = (l: ListaResumen): number => (!l.fecha ? 2 : l.fecha === hoy ? 0 : l.fecha > hoy ? 1 : 3)
  return [...listas].sort((a, b) => {
    const ga = grupo(a)
    const gb = grupo(b)
    if (ga !== gb) return ga - gb
    if (ga === 1) return a.fecha!.localeCompare(b.fecha!)
    if (ga === 3) return b.fecha!.localeCompare(a.fecha!)
    return b.actualizadoEn.localeCompare(a.actualizadoEn)
  })
}

function textoCanciones(n: number): string {
  return `${n} ${n === 1 ? 'canción' : 'canciones'}`
}

/**
 * Cargar una lista arriba. Pide confirmacion si algo suena (se corta) o si lo
 * de arriba son canciones sueltas (que no estan guardadas en ninguna lista).
 */
function useUsarLista(controller: AppController): (l: { id: string; nombre: string }) => Promise<boolean> {
  const confirmar = useConfirmar()
  return async (l) => {
    const e = controller.estado
    const sonando = e?.playbackActivo?.estado === 'playing'
    const sueltas = (e?.tabs.length ?? 0) > 0 && !e?.lista
    if (sonando || sueltas) {
      const ok = await confirmar({
        titulo: `Usar “${l.nombre}”`,
        mensaje: sonando
          ? 'Se corta la canción que está sonando y arriba se cargan las canciones de esta lista.'
          : 'Las canciones de arriba (que no son de ninguna lista) se reemplazan por las de esta lista. Siguen en la biblioteca.',
        confirmar: 'Usar esta lista',
        peligro: sonando
      })
      if (!ok) return false
    }
    const r = await controller.usarLista(l.id)
    if (!r.ok) {
      controller.avisar({ tipo: 'error', texto: r.error ?? 'No se pudo cargar la lista' })
      return false
    }
    if (r.error) controller.avisar({ tipo: 'error', texto: r.error })
    return true
  }
}

/** Datos de listas que se recargan solos cuando algo cambia (en esta u otra ventana, o por las pestanas de arriba). */
function useDatosListas(controller: AppController): { datos: DatosListas | null; recargar: () => void } {
  const [datos, setDatos] = useState<DatosListas | null>(null)
  const obtener = controller.obtenerListas
  const [pedido, setPedido] = useState(0)
  useEffect(() => {
    let cancelado = false
    obtener()
      .then((d) => !cancelado && setDatos(d))
      .catch(() => undefined)
    return () => {
      cancelado = true
    }
  }, [obtener, controller.versionListas, controller.versionProyectos, pedido])
  return { datos, recargar: () => setPedido((n) => n + 1) }
}

// ==========================================================================
// Pantalla de listas
// ==========================================================================

interface PropsListas {
  controller: AppController
  /** se cargo una lista arriba: volver al escenario */
  onUsada: () => void
  onEditar: (id: string) => void
  /** la biblioteca (importar o abrir una cancion suelta) */
  onCanciones: () => void
  /** volver al escenario sin cambiar nada (si hay canciones arriba) */
  onVolver: (() => void) | null
}

export function ListasScreen({ controller, onUsada, onEditar, onCanciones, onVolver }: PropsListas) {
  const confirmar = useConfirmar()
  const usarLista = useUsarLista(controller)
  const { datos } = useDatosListas(controller)
  const [carpeta, setCarpeta] = useState<string | null>(null)
  const [creandoCarpeta, setCreandoCarpeta] = useState(false)
  const [nombreCarpeta, setNombreCarpeta] = useState('')
  const [renombrando, setRenombrando] = useState(false)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hoy = hoyISO()
  const estado = controller.estado
  const hayArriba = (estado?.tabs.length ?? 0) > 0
  const activa = estado?.lista ?? null

  // la primera vez: la carpeta de la lista de hoy, o la de la lista en uso, o todas
  useEffect(() => {
    if (!datos || carpeta !== null) return
    const deHoy = datos.listas.find((l) => l.fecha === hoy)
    const enUso = datos.listas.find((l) => l.id === datos.activa)
    setCarpeta((deHoy ?? enUso)?.carpeta || TODAS)
  }, [datos, carpeta, hoy])

  const sel = carpeta ?? TODAS
  const listas = datos?.listas ?? []
  const carpetas = datos?.carpetas ?? []
  const haySinCarpeta = listas.some((l) => !l.carpeta)
  // si la carpeta elegida ya no existe (la borraron o la renombraron en otra ventana), se vuelve a "Todas"
  const selValida = sel === TODAS || (sel === '' ? haySinCarpeta : carpetas.includes(sel)) ? sel : TODAS
  const visibles = ordenarListas(
    listas.filter((l) => selValida === TODAS || l.carpeta === selValida),
    hoy
  )
  const deHoy = visibles.filter((l) => l.fecha === hoy)
  const resto = visibles.filter((l) => l.fecha !== hoy)
  const cuenta = (c: string): number => listas.filter((l) => l.carpeta === c).length
  const titulo = selValida === TODAS ? 'Todas las listas' : selValida === '' ? 'Sin carpeta' : selValida

  async function usar(l: ListaResumen): Promise<void> {
    setOcupado(l.id)
    setError(null)
    const ok = await usarLista(l)
    setOcupado(null)
    if (ok) onUsada()
  }

  async function nueva(desdeActual = false): Promise<void> {
    setError(null)
    const r = await controller.crearLista({
      nombre: nombreDeFecha(hoy),
      fecha: hoy,
      carpeta: selValida === TODAS ? '' : selValida,
      desdeActual
    })
    if (r.ok && r.id) onEditar(r.id)
    else setError(r.error ?? 'No se pudo crear la lista')
  }

  async function duplicar(l: ListaResumen): Promise<void> {
    const r = await controller.duplicarLista(l.id)
    if (r.ok && r.id) onEditar(r.id)
  }

  async function borrar(l: ListaResumen): Promise<void> {
    const ok = await confirmar({
      titulo: 'Borrar lista',
      mensaje: `Se borra la lista “${l.nombre}”. Las canciones no se tocan (siguen en la biblioteca).`,
      confirmar: 'Borrar',
      peligro: true
    })
    if (ok) await controller.borrarLista(l.id)
  }

  async function crearCarpeta(): Promise<void> {
    const nombre = nombreCarpeta.trim()
    if (!nombre) return setCreandoCarpeta(false)
    const r = await controller.crearCarpeta(nombre)
    setCreandoCarpeta(false)
    setNombreCarpeta('')
    if (r.ok && r.nombre) setCarpeta(r.nombre)
  }

  async function renombrarCarpeta(nuevo: string): Promise<void> {
    setRenombrando(false)
    const limpio = nuevo.trim()
    if (!limpio || limpio === selValida || selValida === TODAS || selValida === '') return
    const r = await controller.renombrarCarpeta(selValida, limpio)
    if (r.ok) setCarpeta(limpio)
    else if (r.error) setError(r.error)
  }

  async function borrarCarpeta(): Promise<void> {
    const n = cuenta(selValida)
    const ok = await confirmar({
      titulo: 'Borrar carpeta',
      mensaje:
        n > 0
          ? `Se borra la carpeta “${selValida}”. ${n === 1 ? 'Su lista queda' : `Sus ${n} listas quedan`} en “Sin carpeta” (no se borra ninguna lista).`
          : `Se borra la carpeta “${selValida}” (está vacía).`,
      confirmar: 'Borrar carpeta',
      peligro: true
    })
    if (!ok) return
    await controller.borrarCarpeta(selValida)
    setCarpeta(TODAS)
  }

  async function seguir(): Promise<void> {
    setOcupado('seguir')
    const r = await controller.seguirSesion()
    setOcupado(null)
    if (r.ok) onUsada()
  }

  const seguirDatos = !hayArriba ? (datos?.sesionAnterior ?? null) : null

  return (
    <div className="listas">
      <aside className="listas-lateral" aria-label="Carpetas">
        <h3>Carpetas</h3>
        <button className={`carpeta ${selValida === TODAS ? 'activo' : ''}`} onClick={() => setCarpeta(TODAS)}>
          <ListMusic size={16} /> <span className="carpeta-nombre">Todas las listas</span> <span className="num">{listas.length}</span>
        </button>
        {carpetas.map((c) => (
          <button key={c} className={`carpeta ${selValida === c ? 'activo' : ''}`} onClick={() => setCarpeta(c)}>
            <Folder size={16} /> <span className="carpeta-nombre">{c}</span> <span className="num">{cuenta(c)}</span>
          </button>
        ))}
        {haySinCarpeta && (
          <button className={`carpeta ${selValida === '' ? 'activo' : ''}`} onClick={() => setCarpeta('')}>
            <Folder size={16} className="texto-gris" /> <span className="carpeta-nombre">Sin carpeta</span> <span className="num">{cuenta('')}</span>
          </button>
        )}
        {creandoCarpeta ? (
          <input
            className="carpeta-input"
            autoFocus
            maxLength={60}
            placeholder="Nombre (ej: Congreso 2026)"
            value={nombreCarpeta}
            onChange={(e) => setNombreCarpeta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void crearCarpeta()
              if (e.key === 'Escape') setCreandoCarpeta(false)
            }}
            onBlur={() => void crearCarpeta()}
            aria-label="Nombre de la carpeta nueva"
          />
        ) : (
          <button className="carpeta carpeta-nueva" onClick={() => setCreandoCarpeta(true)}>
            <FolderPlus size={16} /> Nueva carpeta
          </button>
        )}
        <button className="carpeta carpeta-biblioteca" onClick={onCanciones}>
          <Library size={16} /> <span className="carpeta-nombre">Canciones (biblioteca)</span>
        </button>
      </aside>

      <section className="listas-principal">
        <div className="listas-cabecera">
          <div className="listas-titulo">
            {renombrando ? (
              <input
                className="listas-renombrar"
                autoFocus
                defaultValue={selValida}
                maxLength={60}
                aria-label="Nuevo nombre de la carpeta"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void renombrarCarpeta(e.currentTarget.value)
                  if (e.key === 'Escape') setRenombrando(false)
                }}
                onBlur={(e) => void renombrarCarpeta(e.currentTarget.value)}
              />
            ) : (
              <h1>{titulo}</h1>
            )}
            <p>
              {visibles.length === 0
                ? 'Sin listas todavía'
                : `${visibles.length} ${visibles.length === 1 ? 'lista' : 'listas'} · tocá “Usar” para cargarla arriba`}
            </p>
          </div>
          <div className="listas-acciones">
            {onVolver && (
              <button onClick={onVolver} title="Volver a la canción que está arriba">
                <ArrowLeft size={16} /> Volver
              </button>
            )}
            {selValida !== TODAS && selValida !== '' && !renombrando && (
              <>
                <button onClick={() => setRenombrando(true)} title="Cambiar el nombre de la carpeta">
                  <Pencil size={15} /> Renombrar
                </button>
                <button className="btn-fantasma btn-icono" onClick={() => void borrarCarpeta()} title="Borrar la carpeta" aria-label="Borrar la carpeta">
                  <Trash2 size={16} />
                </button>
              </>
            )}
            {hayArriba && !activa && (
              <button onClick={() => void nueva(true)} title="Guardar las canciones de arriba como una lista">
                <Save size={15} /> Guardar lo de arriba
              </button>
            )}
            <button className="btn-primario" onClick={() => void nueva()}>
              <Plus size={16} /> Nueva lista
            </button>
          </div>
        </div>

        {error && <p className="error-texto">{error}</p>}

        {datos === null ? (
          <p className="vacio">Cargando…</p>
        ) : visibles.length === 0 ? (
          <div className="listas-vacio">
            <ListMusic size={30} />
            <p>
              {listas.length === 0
                ? 'Armá la lista de canciones de cada día (por ejemplo, una carpeta por evento y una lista por día).'
                : 'No hay listas en esta carpeta.'}
            </p>
            <div className="vacio-acciones">
              <button className="btn-primario" onClick={() => void nueva()}>
                <Plus size={16} /> Nueva lista
              </button>
              <button onClick={onCanciones}>
                <Library size={16} /> Importar o abrir canción
              </button>
            </div>
          </div>
        ) : (
          <div className="listas-contenido">
            {deHoy.map((l) => (
              <TarjetaLista
                key={l.id}
                lista={l}
                hoy={hoy}
                grande
                mostrarCarpeta={selValida === TODAS}
                enUso={l.id === activa?.id}
                ocupado={ocupado === l.id}
                onUsar={() => void usar(l)}
                onEditar={() => onEditar(l.id)}
                onDuplicar={() => void duplicar(l)}
                onBorrar={() => void borrar(l)}
              />
            ))}
            <div className="listas-grilla">
              {resto.map((l) => (
                <TarjetaLista
                  key={l.id}
                  lista={l}
                  hoy={hoy}
                  mostrarCarpeta={selValida === TODAS}
                  enUso={l.id === activa?.id}
                  ocupado={ocupado === l.id}
                  onUsar={() => void usar(l)}
                  onEditar={() => onEditar(l.id)}
                  onDuplicar={() => void duplicar(l)}
                  onBorrar={() => void borrar(l)}
                />
              ))}
            </div>
          </div>
        )}

        {seguirDatos && (
          <div className="listas-seguir">
            <RotateCcw size={16} />
            <span>
              La última vez estabas en {seguirDatos.lista ? <b>{seguirDatos.lista}</b> : 'unas canciones sueltas'}
              {seguirDatos.nombreActual ? (
                <>
                  {' '}
                  (canción {seguirDatos.actual} de {seguirDatos.canciones}: {seguirDatos.nombreActual})
                </>
              ) : null}
              .
            </span>
            <button className="btn-chico" disabled={ocupado === 'seguir'} onClick={() => void seguir()}>
              {ocupado === 'seguir' ? 'Abriendo…' : 'Seguir donde quedé'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function TarjetaLista({
  lista: l,
  hoy,
  grande = false,
  mostrarCarpeta,
  enUso,
  ocupado,
  onUsar,
  onEditar,
  onDuplicar,
  onBorrar
}: {
  lista: ListaResumen
  hoy: string
  grande?: boolean
  mostrarCarpeta: boolean
  enUso: boolean
  ocupado: boolean
  onUsar: () => void
  onEditar: () => void
  onDuplicar: () => void
  onBorrar: () => void
}) {
  const etiqueta = etiquetaFecha(l.fecha, hoy)
  const pasada = !!l.fecha && l.fecha < hoy && !etiqueta
  return (
    <article className={`tarjeta-lista ${grande ? 'grande' : ''} ${enUso ? 'en-uso' : ''} ${pasada ? 'pasada' : ''}`} aria-label={l.nombre}>
      <div className="tarjeta-lista-info">
        <div className="tarjeta-lista-fila">
          {etiqueta && <span className={`etiqueta-dia ${etiqueta === 'HOY' ? 'hoy' : ''}`}>{etiqueta}</span>}
          {enUso && <span className="etiqueta-dia en-uso">ARRIBA</span>}
          <h2>{l.nombre}</h2>
        </div>
        <div className="tarjeta-lista-meta">
          {textoCanciones(l.canciones.length)}
          {l.canciones.length > 0 && ` · ${duracionLista(l)}`}
          {l.fecha && !etiqueta && ` · ${fechaLarga(l.fecha)}`}
          {mostrarCarpeta && l.carpeta && ` · ${l.carpeta}`}
          {l.faltantes > 0 && <span className="texto-amarillo"> · {l.faltantes} ya no está(n) en la compu</span>}
        </div>
        <div className="tarjeta-lista-canciones">
          {l.canciones.length === 0 ? 'Vacía: tocá Editar para sumar canciones' : l.canciones.map((c) => c.nombre).join(' → ')}
        </div>
      </div>
      <div className="tarjeta-lista-acciones">
        <button className={grande ? 'btn-play' : 'btn-chico'} disabled={ocupado || l.canciones.length === 0} onClick={onUsar}>
          <Play size={grande ? 16 : 13} /> {ocupado ? 'Cargando…' : enUso ? 'Recargar' : grande ? 'Usar esta lista' : 'Usar'}
        </button>
        <button className={grande ? '' : 'btn-chico'} onClick={onEditar}>
          <Pencil size={grande ? 15 : 13} /> Editar
        </button>
        <button className="btn-fantasma btn-icono" onClick={onDuplicar} title="Duplicar (para usarla de base otro día)" aria-label={`Duplicar ${l.nombre}`}>
          <Copy size={15} />
        </button>
        <button className="btn-fantasma btn-icono" onClick={onBorrar} title="Borrar la lista (las canciones no se tocan)" aria-label={`Borrar ${l.nombre}`}>
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  )
}

// ==========================================================================
// Editor de una lista
// ==========================================================================

const NUEVA_CARPETA = '\u0000nueva'

interface PropsEditor {
  controller: AppController
  listaId: string
  onListo: () => void
  onUsada: () => void
}

export function ListaEditor({ controller, listaId, onListo, onUsada }: PropsEditor) {
  const usarLista = useUsarLista(controller)
  const { datos, recargar } = useDatosListas(controller)
  /** guardados en camino: mientras tanto, lo que llega del servidor no pisa lo que se esta editando */
  const pendientes = useRef(0)
  const [biblioteca, setBiblioteca] = useState<ProyectoResumen[] | null>(null)
  const [nombre, setNombre] = useState<string | null>(null)
  const [fecha, setFecha] = useState('')
  const [carpeta, setCarpeta] = useState('')
  const [creandoCarpeta, setCreandoCarpeta] = useState(false)
  const [proyectos, setProyectos] = useState<string[] | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [categoria, setCategoria] = useState(TODAS)
  const [error, setError] = useState<string | null>(null)
  const [arrastrando, setArrastrando] = useState<number | null>(null)
  const [destino, setDestino] = useState<number | null>(null)
  const timerNombre = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lista = datos?.listas.find((l) => l.id === listaId) ?? null
  const estado = controller.estado
  const esActiva = estado?.lista?.id === listaId
  const sonandoId = esActiva && estado?.playbackActivo?.estado === 'playing' ? (estado.proyectoActivo?.id ?? null) : null

  const listar = controller.listSavedProjects
  useEffect(() => {
    let cancelado = false
    listar()
      .then((p) => !cancelado && setBiblioteca(p))
      .catch(() => undefined)
    return () => {
      cancelado = true
    }
  }, [listar, controller.versionProyectos])

  // campos: se cargan una vez; las canciones se siguen actualizando (p.ej. si se cambian arriba)
  useEffect(() => {
    if (!lista) return
    if (nombre === null) {
      setNombre(lista.nombre)
      setFecha(lista.fecha ?? '')
      setCarpeta(lista.carpeta)
    }
    if (pendientes.current === 0) setProyectos(lista.canciones.map((c) => c.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lista])

  useEffect(() => () => void (timerNombre.current && clearTimeout(timerNombre.current)), [])

  async function guardar(cambio: { nombre?: string; fecha?: string | null; carpeta?: string; proyectos?: string[] }): Promise<void> {
    setError(null)
    pendientes.current++
    let r: { ok: boolean; error?: string }
    try {
      r = await controller.guardarLista({ id: listaId, ...cambio })
    } catch {
      r = { ok: false, error: 'No se pudo guardar (sin conexión con el programa)' }
    }
    pendientes.current--
    if (!r.ok) {
      setError(r.error ?? 'No se pudo guardar')
      if (pendientes.current === 0) recargar() // vuelve a lo que quedo guardado
    }
  }

  function cambiarProyectos(nuevos: string[]): void {
    setProyectos(nuevos)
    void guardar({ proyectos: nuevos })
  }

  const porId = useMemo(() => new Map((biblioteca ?? []).map((p) => [p.id, p])), [biblioteca])
  const enLista = new Set(proyectos ?? [])
  const categorias = useMemo(() => {
    const c = new Map<string, number>()
    for (const p of biblioteca ?? []) c.set(p.categoria, (c.get(p.categoria) ?? 0) + 1)
    return [...c.entries()].filter(([k]) => k).sort((a, b) => a[0].localeCompare(b[0], 'es'))
  }, [biblioteca])
  const q = normalizar(busqueda.trim())
  const filtradas = (biblioteca ?? [])
    .filter((p) => (!q || normalizar(p.nombre).includes(q)) && (categoria === TODAS || p.categoria === categoria))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base', numeric: true }))
  const cancionesLista = (proyectos ?? []).map((id) => porId.get(id)).filter((p): p is ProyectoResumen => !!p)
  const totalMs = cancionesLista.reduce((t, p) => t + p.duracionTotalMs, 0)

  function mover(desde: number, hasta: number): void {
    if (!proyectos || desde === hasta || hasta < 0 || hasta >= proyectos.length) return
    const nuevos = [...proyectos]
    nuevos.splice(hasta, 0, ...nuevos.splice(desde, 1))
    cambiarProyectos(nuevos)
  }

  if (!datos || !proyectos || nombre === null) {
    return (
      <div className="lista-editor">
        <p className="vacio">{datos && !lista ? 'Esa lista ya no existe.' : 'Cargando…'}</p>
        {datos && !lista && (
          <div style={{ textAlign: 'center' }}>
            <button onClick={onListo}>Volver a las listas</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="lista-editor">
      <div className="lista-editor-campos">
        <label className="campo campo-nombre">
          <span>Nombre de la lista</span>
          <input
            value={nombre}
            maxLength={60}
            placeholder="Ej: Sábado 17/10 · 19 hs"
            aria-label="Nombre de la lista"
            onChange={(e) => {
              const v = e.target.value
              setNombre(v)
              if (timerNombre.current) clearTimeout(timerNombre.current)
              if (v.trim()) timerNombre.current = setTimeout(() => void guardar({ nombre: v }), 500)
            }}
          />
        </label>
        <label className="campo">
          <span>Fecha</span>
          <input
            type="date"
            value={fecha}
            aria-label="Fecha de la lista"
            onChange={(e) => {
              setFecha(e.target.value)
              void guardar({ fecha: e.target.value || null })
            }}
          />
        </label>
        <label className="campo">
          <span>Carpeta</span>
          {creandoCarpeta ? (
            <input
              autoFocus
              maxLength={60}
              placeholder="Nombre de la carpeta nueva"
              aria-label="Carpeta nueva"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setCreandoCarpeta(false)
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim()
                setCreandoCarpeta(false)
                if (!v) return
                setCarpeta(v)
                void guardar({ carpeta: v })
              }}
            />
          ) : (
            <select
              value={carpeta}
              aria-label="Carpeta de la lista"
              onChange={(e) => {
                if (e.target.value === NUEVA_CARPETA) return setCreandoCarpeta(true)
                setCarpeta(e.target.value)
                void guardar({ carpeta: e.target.value })
              }}
            >
              <option value="">Sin carpeta</option>
              {[...new Set([...datos.carpetas, ...(carpeta ? [carpeta] : [])])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={NUEVA_CARPETA}>+ Nueva carpeta…</option>
            </select>
          )}
        </label>
        <div className="lista-editor-listo">
          <button className="btn-primario" onClick={onListo}>
            <Check size={16} /> Listo
          </button>
        </div>
      </div>

      <div className="lista-editor-cuerpo">
        <section className="lista-editor-biblioteca" aria-label="Biblioteca">
          <h3>
            Biblioteca <span>· tocá + para sumar a la lista</span>
          </h3>
          <div className="buscar-con-icono">
            <Search size={15} />
            <input type="search" placeholder="Buscar canción…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} aria-label="Buscar canción" />
          </div>
          {categorias.length > 0 && (
            <div className="categorias">
              <button className={categoria === TODAS ? 'activo' : ''} onClick={() => setCategoria(TODAS)}>
                Todas <span className="num">{biblioteca?.length ?? 0}</span>
              </button>
              {categorias.map(([c, n]) => (
                <button key={c} className={categoria === c ? 'activo' : ''} onClick={() => setCategoria(c)}>
                  {c.split('/').join(' › ')} <span className="num">{n}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="lista">
            {biblioteca === null ? (
              <li className="vacio">Cargando…</li>
            ) : filtradas.length === 0 ? (
              <li className="vacio">{busqueda ? 'No hay canciones con ese nombre.' : 'Todavía no hay canciones: importalas desde “Canciones”.'}</li>
            ) : (
              filtradas.map((p) => {
                const ya = enLista.has(p.id)
                return (
                  <li key={p.id} className={`lista-fila ${ya ? 'ya-en-lista' : 'clic'}`} onClick={() => !ya && cambiarProyectos([...proyectos, p.id])}>
                    <div className="lista-principal">
                      <span className="lista-titulo">{p.nombre}</span>
                      <span className="lista-meta num">
                        {formatDuracion(p.duracionTotalMs)}
                        {p.bpm ? ` · ${Math.round(p.bpm)} BPM` : ''}
                        {p.categoria ? ` · ${p.categoria.split('/').join(' › ')}` : ''}
                        {ya ? ` · ya está en la lista (${proyectos.indexOf(p.id) + 1})` : ''}
                      </span>
                    </div>
                    <button
                      className={`btn-sumar ${ya ? 'hecho' : ''}`}
                      disabled={ya}
                      aria-label={ya ? `${p.nombre} ya está en la lista` : `Sumar ${p.nombre} a la lista`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!ya) cambiarProyectos([...proyectos, p.id])
                      }}
                    >
                      {ya ? <Check size={15} /> : <Plus size={16} />}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </section>

        <section className="lista-editor-lista" aria-label="Canciones de la lista">
          <h3>
            La lista <span>· arrastrá para cambiar el orden</span>
          </h3>
          {error && <p className="error-texto">{error}</p>}
          {cancionesLista.length === 0 ? (
            <p className="vacio">Todavía no tiene canciones: sumalas desde la biblioteca.</p>
          ) : (
            <ol className="lista lista-orden">
              {cancionesLista.map((p, i) => {
                const suena = p.id === sonandoId
                return (
                  <li
                    key={p.id}
                    className={`lista-fila fila-orden ${arrastrando === i ? 'arrastrando' : ''} ${destino === i && arrastrando !== i ? 'destino' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setArrastrando(i)
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDestino(i)
                    }}
                    onDrop={() => arrastrando !== null && mover(arrastrando, i)}
                    onDragEnd={() => {
                      setArrastrando(null)
                      setDestino(null)
                    }}
                  >
                    <GripVertical size={16} className="asa" aria-hidden />
                    <span className="orden num">{i + 1}</span>
                    <div className="lista-principal">
                      <span className="lista-titulo">{p.nombre}</span>
                      <span className="lista-meta num">
                        {formatDuracion(p.duracionTotalMs)}
                        {p.bpm ? ` · ${Math.round(p.bpm)} BPM` : ''}
                        {suena ? ' · sonando' : ''}
                      </span>
                    </div>
                    <div className="fila-orden-botones">
                      <button className="btn-fantasma btn-icono" disabled={i === 0} onClick={() => mover(i, i - 1)} aria-label={`Subir ${p.nombre}`} title="Subir">
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="btn-fantasma btn-icono"
                        disabled={i === cancionesLista.length - 1}
                        onClick={() => mover(i, i + 1)}
                        aria-label={`Bajar ${p.nombre}`}
                        title="Bajar"
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="btn-fantasma btn-icono"
                        disabled={suena}
                        onClick={() => cambiarProyectos(proyectos.filter((id) => id !== p.id))}
                        aria-label={`Sacar ${p.nombre} de la lista`}
                        title={suena ? 'Está sonando: pará la música para sacarla' : 'Sacar de la lista (la canción sigue en la biblioteca)'}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
          <div className="lista-editor-pie">
            <span>
              <b className="num">
                {textoCanciones(cancionesLista.length)}
                {cancionesLista.length > 0 && ` · ${formatDuracion(totalMs)}`}
              </b>{' '}
              · se guarda sola
            </span>
            {esActiva ? (
              <span className="etiqueta-dia en-uso">ES LA LISTA DE ARRIBA</span>
            ) : (
              <button
                className="btn-play"
                disabled={cancionesLista.length === 0}
                onClick={async () => {
                  if (await usarLista({ id: listaId, nombre: nombre || lista?.nombre || 'la lista' })) onUsada()
                }}
              >
                <Play size={16} /> Usar esta lista
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}
