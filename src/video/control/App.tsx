import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProyectoResumen } from '../../shared/types'
import { cancionPara, esVideo, nombreDe, parecido } from '../nombres'
import type { CancionDeHoy, EstadoApp, VideoGuardado } from '../tipos'
import { alinearVideo } from './alinear'
import { AvisoConexion, Encabezado, PrimeraVezCarpeta } from './Encabezado'
import { Escenario } from './Escenario'
import { api, estadoDe, useMiniatura, useReproduccion } from './estado'

/**
 * AirTracks Video, la ventana de control: a la izquierda lo que se ve en el
 * proyector (en vivo), las secciones de la cancion y el ajuste del inicio; a
 * la derecha las canciones de hoy en AirTracks, cada una con su video (o un
 * lugar para soltarlo). Los videos se agregan arrastrandolos: a la ventana
 * (se vinculan por el nombre) o encima de la cancion.
 */

/** La ruta de un archivo arrastrado (Electron 22: el File la trae). */
const rutaDe = (f: File): string => (f as File & { path?: string }).path ?? ''

type Progreso = { texto: string; fraccion: number | null }

function ElegirCancion({
  archivo,
  conVideo,
  onElegir,
  onCerrar
}: {
  archivo: string
  /** canciones que ya tienen video (proyectoId -> nombre del archivo) */
  conVideo: Map<string, string>
  onElegir: (p: ProyectoResumen) => void
  onCerrar: () => void
}) {
  const [canciones, setCanciones] = useState<ProyectoResumen[] | null>(null)
  const [busqueda, setBusqueda] = useState('')
  useEffect(() => {
    void api.canciones().then((c) => setCanciones(c.filter((p) => !p.colchon)))
  }, [])
  const nombreArchivo = nombreDe(archivo)
  const lista = useMemo(() => {
    const todas = canciones ?? []
    const q = busqueda.trim()
    return [...todas]
      .map((p) => ({ p, puntaje: q ? parecido(q, p.nombre) + (p.nombre.toLowerCase().includes(q.toLowerCase()) ? 1 : 0) : parecido(nombreArchivo, p.nombre) }))
      .filter((x) => !q || x.puntaje > 0)
      .sort((a, b) => b.puntaje - a.puntaje || a.p.nombre.localeCompare(b.p.nombre))
  }, [canciones, busqueda, nombreArchivo])
  return (
    <div className="fondo-modal" onClick={onCerrar}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()} role="dialog" aria-label="¿De qué canción es el video?">
        <h2>¿De qué canción es?</h2>
        <p className="ayuda">
          Video: <b>{nombreArchivo}</b>
        </p>
        <input autoFocus value={busqueda} onChange={(ev) => setBusqueda(ev.target.value)} placeholder="Buscar canción…" aria-label="Buscar canción" />
        {canciones === null ? (
          <p className="ayuda">Pidiendo las canciones a AirTracks…</p>
        ) : canciones.length === 0 ? (
          <p className="aviso-texto">No llegaron canciones: revisá que AirTracks esté abierto y conectado.</p>
        ) : (
          <ul className="canciones">
            {lista.slice(0, 60).map(({ p, puntaje }, i) => (
              <li key={p.id}>
                <button className={i === 0 && puntaje >= 0.5 && !busqueda ? 'sugerida' : ''} onClick={() => onElegir(p)}>
                  {p.nombre}
                  {p.bpm ? <small> · {Math.round(p.bpm)} BPM</small> : null}
                  {conVideo.has(p.id) && conVideo.get(p.id) !== nombreArchivo && <small> · ya tiene video (se reemplaza)</small>}
                  {i === 0 && puntaje >= 0.5 && !busqueda && <span className="etiqueta">parece esta</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pie">
          <button onClick={onCerrar}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

/** Una cancion de la lista: su video (cuadro), el tono y el BPM y como esta. Se le puede soltar un video encima. */
function TarjetaCancion(p: {
  numero: number | null
  nombre: string
  detalle: string | null
  colchon?: boolean
  video: VideoGuardado | null
  /** es la que esta arriba en AirTracks */
  arriba: boolean
  /** y esta sonando */
  suena: boolean
  elegida: boolean
  arrastrando: boolean
  sinCancion?: boolean
  progreso: Progreso | null
  onElegir: () => void
  onSoltar: (rutas: string[]) => void
}) {
  const mini = useMiniatura(p.video)
  const [encima, setEncima] = useState(false)
  const est = p.video ? estadoDe(p.video) : null
  const fraccion = p.video?.estado === 'alineando' ? (p.progreso?.fraccion ?? null) : null
  const aceptaVideo = !p.colchon
  return (
    <li
      className={`cancion ${p.arriba ? 'arriba' : ''} ${p.elegida ? 'elegida' : ''} ${p.colchon ? 'colchon' : ''} ${aceptaVideo && p.arrastrando ? 'puede-soltar' : ''} ${encima ? 'encima' : ''}`}
      onClick={p.onElegir}
      onDragOver={(ev) => {
        if (!aceptaVideo) return
        ev.preventDefault()
        ev.stopPropagation()
        setEncima(true)
      }}
      onDragLeave={() => setEncima(false)}
      onDrop={(ev) => {
        if (!aceptaVideo) return
        ev.preventDefault()
        ev.stopPropagation()
        setEncima(false)
        const rutas = [...ev.dataTransfer.files].map(rutaDe).filter(Boolean)
        if (rutas.length) p.onSoltar(rutas)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => ev.key === 'Enter' && p.onElegir()}
      aria-label={p.nombre}
      aria-current={p.elegida}
    >
      <div className={`mini ${p.video ? '' : 'vacia'}`} style={mini ? { backgroundImage: `url(${mini})` } : undefined}>
        {!p.video && <span>{p.colchon ? '〰' : '＋'}</span>}
        {p.suena && <i className="mini-suena" />}
      </div>
      <div className="cancion-datos">
        <b>{p.nombre}</b>
        {p.detalle && <small>{p.detalle}</small>}
        {p.colchon ? (
          <span className="chip apagado">Sin video: se ve Holyrics</span>
        ) : encima || (p.arrastrando && !p.video) ? (
          <span className="chip soltar">Soltá el video acá</span>
        ) : !p.video ? (
          <span className="chip apagado">Sin video</span>
        ) : p.sinCancion ? (
          <span className="chip aviso">No está en AirTracks</span>
        ) : (
          <span className={`chip ${est!.tono}`}>
            {p.video.estado === 'alineando' && <span className="anillo" style={{ '--avance': `${Math.round((fraccion ?? 0.25) * 100)}%` } as React.CSSProperties} />}
            {p.video.estado === 'listo' && '✓ '}
            {p.video.estado === 'alineando' && fraccion !== null ? `Alineando · ${Math.round(fraccion * 100)} %` : est!.corto}
          </span>
        )}
      </div>
      {p.numero !== null && <span className="cancion-n num">{p.numero}</span>}
    </li>
  )
}

export function App() {
  const [e, setE] = useState<EstadoApp | null>(null)
  /** videos que esperan que se elija su cancion (el primero se muestra); `para`: el video que cambia de cancion */
  const [cola, setCola] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copiando, setCopiando] = useState<string | null>(null)
  const [arrastrando, setArrastrando] = useState(false)
  const [progreso, setProgreso] = useState<Record<string, Progreso>>({})
  /** la cancion que se esta mirando (por defecto, la que esta arriba en AirTracks) */
  const [elegida, setElegida] = useState<string | null>(null)
  const [verOtros, setVerOtros] = useState(false)
  const trabajando = useRef(false)
  const rep = useReproduccion()

  useEffect(() => {
    void api.estado().then(setE)
    api.onEstado(setE)
  }, [])

  // cuando AirTracks pasa a otra cancion, se mira esa
  const activa = e?.cancionActiva?.id ?? null
  useEffect(() => {
    if (activa) setElegida(activa)
  }, [activa])
  useEffect(() => {
    if (!elegida && e) setElegida(e.cancionActiva?.id ?? e.hoy.canciones[0]?.proyectoId ?? e.videos[0]?.proyectoId ?? null)
  }, [e, elegida])

  // alinear de a un video: los nuevos enseguida; los que esperan (musica sonando, sin conexion), cada 20 s
  const ultimoIntento = useRef(new Map<string, number>())
  useEffect(() => {
    if (!e || trabajando.current) return
    const conectado = e.conexion.estado === 'conectado' && !e.conexion.desactualizado
    const ahora = Date.now()
    const pendiente = e.videos.find(
      (v) =>
        v.estado === 'alineando' ||
        (conectado &&
          (v.estado === 'esperando-musica' || v.estado === 'sin-conexion' || v.estado === 'desactualizado') &&
          ahora - (ultimoIntento.current.get(v.proyectoId) ?? 0) > 20_000)
    )
    if (!pendiente) return
    trabajando.current = true
    ultimoIntento.current.set(pendiente.proyectoId, ahora)
    void (async () => {
      if (pendiente.estado !== 'alineando') await api.actualizarVideo(pendiente.proyectoId, { estado: 'alineando' })
      const id = pendiente.proyectoId
      const r = await alinearVideo(api, pendiente, (texto, fraccion) => setProgreso((x) => ({ ...x, [id]: { texto, fraccion } })))
      setProgreso((x) => {
        const { [id]: _, ...resto } = x
        return resto
      })
      await api.actualizarVideo(pendiente.proyectoId, {
        estado: r.estado,
        duracionSeg: r.duracionSeg,
        ...('desfaseMs' in r ? { desfaseMs: r.desfaseMs, alineacion: r.alineacion } : {}),
        mensaje: r.estado === 'error' ? r.mensaje : undefined
      })
      trabajando.current = false
      setE((x) => (x ? { ...x } : x)) // re-evaluar si hay otro
    })()
  }, [e])
  // los que esperan se reintentan solos
  useEffect(() => {
    const t = setInterval(() => setE((x) => (x ? { ...x } : x)), 20_000)
    return () => clearInterval(t)
  }, [])

  // arrastrar videos a la ventana (en cualquier lado)
  useEffect(() => {
    let dentro = 0
    const conArchivos = (ev: DragEvent): boolean => !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')
    const entra = (ev: DragEvent): void => {
      if (!conArchivos(ev)) return
      dentro++
      setArrastrando(true)
    }
    const sale = (): void => {
      dentro = Math.max(0, dentro - 1)
      if (!dentro) setArrastrando(false)
    }
    const sobre = (ev: DragEvent): void => {
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    }
    const suelta = (ev: DragEvent): void => {
      ev.preventDefault()
      dentro = 0
      setArrastrando(false)
      const rutas = [...(ev.dataTransfer?.files ?? [])].map(rutaDe).filter(Boolean)
      if (rutas.length) void recibir(rutas)
    }
    window.addEventListener('dragenter', entra)
    window.addEventListener('dragleave', sale)
    window.addEventListener('dragover', sobre)
    window.addEventListener('drop', suelta)
    return () => {
      window.removeEventListener('dragenter', entra)
      window.removeEventListener('dragleave', sale)
      window.removeEventListener('dragover', sobre)
      window.removeEventListener('drop', suelta)
    }
  }, [])

  async function agregar(): Promise<void> {
    const rutas = await api.elegirArchivos()
    if (rutas.length) await recibir(rutas)
  }

  /**
   * Videos nuevos (arrastrados o elegidos): el que tiene el nombre de una cancion (sin dudas, y sin video)
   * se vincula solo; por los otros se pregunta. Sin AirTracks, quedan en la carpeta y se vinculan al conectar.
   */
  async function recibir(rutas: string[]): Promise<void> {
    setError(null)
    const noVideos = rutas.filter((r) => !esVideo(nombreDe(r)))
    if (noVideos.length) setError(`${nombreDe(noVideos[0])} no es un video (mp4, mov, webm o mkv)`)
    const videos = rutas.filter((r) => esVideo(nombreDe(r)))
    if (!videos.length) return
    const actual = await api.estado()
    const canciones = actual.conexion.estado === 'conectado' ? (await api.canciones()).filter((p) => !p.colchon) : []
    const preguntar: string[] = []
    for (const [i, r] of videos.entries()) {
      const cuenta = videos.length > 1 ? ` (${i + 1} de ${videos.length})` : ''
      if (!canciones.length) {
        setCopiando(`Copiando ${nombreDe(r)} a la carpeta${cuenta}…`)
        const x = await api.copiarSuelto(r)
        if ('error' in x) setError(x.error)
        continue
      }
      const m = cancionPara(nombreDe(r), canciones)
      const conVideo = new Set((await api.estado()).videos.map((v) => v.proyectoId))
      if (m?.segura && !conVideo.has(m.cancion.id)) {
        setCopiando(`Copiando ${nombreDe(r)}${cuenta}…`)
        const x = await api.agregarVideo(r, m.cancion.id, m.cancion.nombre)
        if ('error' in x) setError(x.error)
      } else preguntar.push(r)
    }
    setCopiando(null)
    if (preguntar.length) setCola((c) => [...c, ...preguntar.filter((r) => !c.includes(r))])
  }

  async function vincular(ruta: string, p: ProyectoResumen): Promise<void> {
    setCola((c) => c.filter((x) => x !== ruta))
    setCopiando(`Copiando ${nombreDe(ruta)}…`)
    const r = await api.agregarVideo(ruta, p.id, p.nombre)
    setCopiando(null)
    if ('error' in r) setError(r.error)
  }


  /** Videos soltados encima de una cancion: el primero va a esa cancion (sin preguntar); los demas, como siempre. */
  async function soltarEn(proyectoId: string, nombre: string, rutas: string[]): Promise<void> {
    setError(null)
    const videos = rutas.filter((r) => esVideo(nombreDe(r)))
    if (!videos.length) return setError(`${nombreDe(rutas[0])} no es un video (mp4, mov, webm o mkv)`)
    setElegida(proyectoId)
    await vincular(videos[0], { id: proyectoId, nombre } as ProyectoResumen)
    if (videos.length > 1) await recibir(videos.slice(1))
  }

  /** "Elegir el video…" de una cancion que no tiene. */
  async function agregarA(proyectoId: string, nombre: string): Promise<void> {
    const rutas = await api.elegirArchivos()
    if (rutas.length) await soltarEn(proyectoId, nombre, rutas)
  }

  if (!e) return null
  const conectado = e.conexion.estado === 'conectado' && !e.conexion.desactualizado
  const conVideo = new Map(e.videos.map((v) => [v.proyectoId, v.archivo]))
  const videoDe = (id: string | null): VideoGuardado | null => (id ? (e.videos.find((v) => v.proyectoId === id) ?? null) : null)
  const enHoy = new Set(e.hoy.canciones.map((c) => c.proyectoId))
  const otros = e.videos.filter((v) => !conectado || !enHoy.has(v.proyectoId))
  const cancionElegida: CancionDeHoy | null = e.hoy.canciones.find((c) => c.proyectoId === elegida) ?? null
  const videoElegido = videoDe(elegida)
  const detalle = (c: CancionDeHoy): string | null => [c.tonalidad, c.bpm ? `${Math.round(c.bpm)} BPM` : null].filter(Boolean).join(' · ') || null
  const tarjetaVideo = (v: VideoGuardado) => (
    <TarjetaCancion
      key={v.proyectoId}
      numero={null}
      nombre={v.cancion}
      detalle={v.nombreArchivo !== v.archivo ? v.nombreArchivo : null}
      video={v}
      arriba={rep?.proyectoId === v.proyectoId}
      suena={rep?.proyectoId === v.proyectoId && rep.playback?.estado === 'playing'}
      elegida={elegida === v.proyectoId}
      arrastrando={arrastrando}
      sinCancion={e.sinCancion.includes(v.proyectoId)}
      progreso={progreso[v.proyectoId] ?? null}
      onElegir={() => setElegida(v.proyectoId)}
      onSoltar={(rutas) => void soltarEn(v.proyectoId, v.cancion, rutas)}
    />
  )

  return (
    <div className="app">
      <Encabezado e={e} />
      {(!e.carpetaConfirmada || e.conexion.estado === 'codigo' || e.conexion.estado === 'ocupado' || e.conexion.desactualizado) && (
        <div className="avisos">
          {!e.carpetaConfirmada && <PrimeraVezCarpeta e={e} />}
          <AvisoConexion e={e} />
        </div>
      )}
      <main>
        <Escenario
          cancion={cancionElegida}
          nombre={cancionElegida?.nombre ?? videoElegido?.cancion ?? null}
          proyectoId={elegida}
          video={videoElegido}
          progreso={elegida ? (progreso[elegida] ?? null) : null}
          conectado={conectado}
          sinCancion={!!elegida && e.sinCancion.includes(elegida)}
          onElegirVideo={() => elegida && void agregarA(elegida, cancionElegida?.nombre ?? videoElegido?.cancion ?? '')}
          onCambiarCancion={() => videoElegido && setCola((c) => (c.includes(videoElegido.archivo) ? c : [...c, videoElegido.archivo]))}
        />
        <section className="tarjeta lista" aria-label="Canciones">
          <div className="lista-cabeza">
            <div>
              <h2>{conectado ? (e.hoy.lista ? 'Canciones de hoy' : 'Canciones abiertas') : 'Tus videos'}</h2>
              <small>{conectado ? 'Arrastrá un video encima de su canción' : 'Al conectar con AirTracks aparecen las canciones de hoy'}</small>
            </div>
            <button className="primario" onClick={() => void agregar()} disabled={copiando !== null}>
              ＋ Videos
            </button>
          </div>
          {copiando && <p className="info-texto">{copiando}</p>}
          {error && <p className="error-texto">{error}</p>}
          <ul className="canciones-hoy">
            {conectado &&
              e.hoy.canciones.map((c, i) => (
                <TarjetaCancion
                  key={c.proyectoId}
                  numero={i + 1}
                  nombre={c.nombre}
                  detalle={c.colchon ? null : detalle(c)}
                  colchon={c.colchon}
                  video={videoDe(c.proyectoId)}
                  arriba={rep?.proyectoId === c.proyectoId}
                  suena={rep?.proyectoId === c.proyectoId && rep.playback?.estado === 'playing'}
                  elegida={elegida === c.proyectoId}
                  arrastrando={arrastrando}
                  progreso={progreso[c.proyectoId] ?? null}
                  onElegir={() => setElegida(c.proyectoId)}
                  onSoltar={(rutas) => void soltarEn(c.proyectoId, c.nombre, rutas)}
                />
              ))}
            {!conectado && otros.map(tarjetaVideo)}
          </ul>
          {conectado && e.hoy.canciones.length === 0 && <p className="vacio">No hay canciones abiertas en AirTracks.</p>}
          {!conectado && e.videos.length === 0 && (
            <p className="vacio">Todavía no hay videos. Arrastrá acá el video con la letra de una canción (la misma grabación que la multitrack).</p>
          )}
          {e.sueltos.length > 0 && (
            <button className="sueltos" disabled={!conectado} onClick={() => setCola((c) => [...c, ...e.sueltos.filter((a) => !c.includes(a))])}>
              <span className="sueltos-icono">🎬</span>
              <span>
                <b>
                  {e.sueltos.length === 1 ? 'Un video en la carpeta sin canción.' : `${e.sueltos.length} videos en la carpeta sin canción.`}
                </b>{' '}
                {conectado ? 'Tocá para elegir de cuál son.' : 'Se vinculan solos al conectar, si tienen el nombre de la canción.'}
              </span>
            </button>
          )}
          {e.copiandose > 0 && (
            <p className="ayuda">
              {e.copiandose === 1 ? 'Hay un video copiándose a la carpeta' : `Hay ${e.copiandose} videos copiándose a la carpeta`}: se agrega cuando termine.
            </p>
          )}
          {conectado && otros.length > 0 && (
            <div className="otros">
              <button className="enlace" onClick={() => setVerOtros(!verOtros)} aria-expanded={verOtros}>
                {verOtros ? '▾' : '▸'} Otros videos ({otros.length}) · de canciones que hoy no están abiertas
              </button>
              {verOtros && <ul className="canciones-hoy chicas">{otros.map(tarjetaVideo)}</ul>}
            </div>
          )}
        </section>
      </main>
      <p className="version">AirTracks Video {e.version} · funciona sin internet, por la red del router</p>
      {cola.length > 0 && (
        <ElegirCancion
          key={cola[0]}
          archivo={cola[0]}
          conVideo={conVideo}
          onElegir={(p) => void vincular(cola[0], p)}
          onCerrar={() => setCola((c) => c.slice(1))}
        />
      )}
      {arrastrando && (
        <div className="soltar" aria-hidden>
          <span>Soltá el video encima de su canción, o en cualquier lado (se vincula por el nombre)</span>
        </div>
      )}
    </div>
  )
}
