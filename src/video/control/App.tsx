import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProyectoResumen } from '../../shared/types'
import { cancionPara, esVideo, nombreDe, parecido } from '../nombres'
import type { ApiVideo, EstadoApp, VideoGuardado } from '../tipos'
import { alinearVideo } from './alinear'

declare global {
  interface Window {
    airtracksVideo: ApiVideo
  }
}

const api = window.airtracksVideo

function segundos(ms: number): string {
  return `${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')} s`
}

function textoDesfase(ms: number): string {
  if (Math.abs(ms) < 50) return 'El video y la canción empiezan juntos'
  return ms > 0 ? `El video tiene ${segundos(ms)} más al principio` : `La canción empieza ${segundos(ms)} antes que el video`
}

function textoEstado(v: VideoGuardado): { texto: string; tipo: 'ok' | 'aviso' | 'error' | 'info' } {
  switch (v.estado) {
    case 'alineando':
      return { texto: 'Alineando con la canción…', tipo: 'info' }
    case 'esperando-musica':
      return { texto: 'Se alinea cuando pare la música en AirTracks', tipo: 'info' }
    case 'sin-conexion':
      return { texto: 'Se alinea al conectar con AirTracks', tipo: 'info' }
    case 'listo':
      return v.alineacion?.manual
        ? { texto: 'Listo (ajustado a mano) · al darle ▶ a esta canción en AirTracks, el video aparece solo', tipo: 'ok' }
        : {
            texto: `Listo · coincide en el ${Math.round((v.alineacion?.coincide ?? 1) * 100)} % de la canción · al darle ▶ a esta canción en AirTracks, el video aparece solo`,
            tipo: 'ok'
          }
    case 'revisar':
      return {
        texto: 'No coincide del todo: ¿es la misma grabación? Probalo con la canción y ajustá el inicio a mano',
        tipo: 'aviso'
      }
    case 'desactualizado':
      return { texto: 'Para alinear hay que actualizar AirTracks en la compu principal (ver arriba)', tipo: 'error' }
    default:
      return { texto: v.mensaje ?? 'No se pudo alinear', tipo: 'error' }
  }
}

function Conexion({ e }: { e: EstadoApp }) {
  const c = e.conexion
  const [codigo, setCodigo] = useState('')
  const [direccion, setDireccion] = useState('')
  const [escribir, setEscribir] = useState(false)
  if (c.estado === 'conectado' && c.desactualizado)
    return (
      <div className="conexion aviso" role="alert">
        <span className="punto amarillo" /> Conectado a <b>{c.nombreServidor ?? c.servidor}</b>, pero tiene una versión de AirTracks de antes de los
        videos: actualizala con el instalador de siempre (Descargas) para alinear y mostrar los videos.
      </div>
    )
  if (c.estado === 'conectado')
    return (
      <div className="conexion ok">
        <span className="punto verde" /> Conectado a <b>{c.nombreServidor ?? c.servidor}</b>
        {e.cancionActiva && (
          <span className="suena">
            · Arriba: <b>{e.cancionActiva.nombre}</b>
          </span>
        )}
      </div>
    )
  if (c.estado === 'codigo')
    return (
      <form
        className="conexion aviso"
        onSubmit={(ev) => {
          ev.preventDefault()
          api.usarCodigo(codigo)
        }}
      >
        <span>
          {c.motivoCodigo === 'codigo-incorrecto'
            ? 'Ese no es el código de la banda.'
            : c.motivoCodigo === 'codigo-bloqueado'
              ? 'Demasiados intentos: esperá un minuto.'
              : 'AirTracks pide el código de la banda.'}
        </span>
        <input value={codigo} onChange={(ev) => setCodigo(ev.target.value)} inputMode="numeric" maxLength={8} placeholder="Código" aria-label="Código de la banda" />
        <button className="primario">Entrar</button>
      </form>
    )
  return (
    <div className={`conexion ${c.estado === 'ocupado' ? 'aviso' : ''}`}>
      <span className="punto amarillo" />
      {c.estado === 'ocupado'
        ? 'Ya hay otra pantalla de video conectada a AirTracks.'
        : c.estado === 'conectando'
          ? `Conectando con ${c.nombreServidor ?? c.servidor}…`
          : 'Buscando la compu de AirTracks en la red… (tiene que estar abierta y en el mismo router)'}
      {escribir ? (
        <form
          className="direccion"
          onSubmit={(ev) => {
            ev.preventDefault()
            api.usarDireccion(direccion)
            setEscribir(false)
          }}
        >
          <input value={direccion} onChange={(ev) => setDireccion(ev.target.value)} placeholder="192.168.0.10:4848" aria-label="Dirección de la compu de AirTracks" />
          <button className="primario">Conectar</button>
        </form>
      ) : (
        <button className="enlace" onClick={() => setEscribir(true)}>
          Escribir la dirección
        </button>
      )}
    </div>
  )
}

function Proyector({ e }: { e: EstadoApp }) {
  const secundaria = e.pantallas.some((p) => !p.principal)
  return (
    <section className="tarjeta">
      <h2>Proyector</h2>
      {!secundaria && e.pantallaId === null && (
        <p className="aviso-texto">No hay una segunda pantalla. Conectá el proyector (como pantalla extendida) para que se vea el video.</p>
      )}
      <div className="fila">
        <label>
          Mostrar el video en{' '}
          <select value={e.pantallaId ?? ''} onChange={(ev) => api.elegirPantalla(Number(ev.target.value))} aria-label="Pantalla del proyector">
            {e.pantallaId === null && <option value="">(elegí una)</option>}
            {e.pantallas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => api.probarPantalla()}>Probar</button>
      </div>
      {e.pantallas.find((p) => p.id === e.pantallaId)?.principal && (
        <p className="aviso-texto">
          Elegiste la pantalla principal (sirve para probar sin proyector): mientras suene una canción con video, el video tapa esta pantalla.
          Para sacarlo, pará la canción en AirTracks.
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={e.inicioConWindows} onChange={(ev) => api.inicioConWindows(ev.target.checked)} />
        Abrir AirTracks Video al prender la compu
      </label>
      <p className="ayuda">
        El video aparece encima de todo (también de Holyrics) solo mientras suena una canción que tiene video, y se va al pararla. No le saca
        el teclado ni el mouse a Holyrics.
      </p>
    </section>
  )
}

function FilaVideo({
  v,
  suena,
  sinCancion,
  progreso,
  onCambiar
}: {
  v: VideoGuardado
  suena: boolean
  sinCancion: boolean
  progreso: { texto: string; fraccion: number | null } | null
  onCambiar: () => void
}) {
  const est = sinCancion
    ? { texto: 'Esta canción no está en AirTracks: elegí de qué canción es con "Cambiar canción"', tipo: 'aviso' as const }
    : v.estado === 'alineando' && progreso
      ? { texto: progreso.texto, tipo: 'info' as const }
      : textoEstado(v)
  const mover = (ms: number): void => {
    void api.actualizarVideo(v.proyectoId, {
      desfaseMs: (v.desfaseMs ?? 0) + ms,
      estado: 'listo',
      alineacion: v.alineacion ? { ...v.alineacion, manual: true } : { desfaseMs: 0, confianza: 0, ventaja: 0, coincide: 0, segura: false, manual: true }
    })
  }
  return (
    <li className={`video ${suena ? 'suena' : ''}`}>
      <div className="video-arriba">
        <div className="video-nombres">
          <b>{v.cancion}</b>
          <small title={v.nombreArchivo}>{v.nombreArchivo}</small>
        </div>
        {suena && <span className="etiqueta">suena ahora</span>}
        <button className="chico" title="Este video es de otra canción" onClick={onCambiar}>
          Cambiar canción
        </button>
        <button
          className="chico"
          disabled={v.estado === 'alineando'}
          title="Volver a calcular dónde empieza la canción en el video"
          onClick={() => void api.actualizarVideo(v.proyectoId, { estado: 'alineando', mensaje: undefined })}
        >
          Alinear de nuevo
        </button>
        <button
          className="chico peligro"
          onClick={() => {
            if (confirm(`¿Quitar el video de "${v.cancion}"? Se borra de la carpeta de videos.`)) void api.quitarVideo(v.proyectoId)
          }}
        >
          Quitar
        </button>
      </div>
      <div className={`video-estado ${est.tipo}`}>{est.texto}</div>
      {v.estado === 'alineando' && (
        <div className={`barra-progreso ${progreso?.fraccion == null ? 'indefinida' : ''}`} role="progressbar" aria-label="Alineando">
          <i style={progreso?.fraccion != null ? { width: `${Math.round(progreso.fraccion * 100)}%` } : undefined} />
        </div>
      )}
      {v.desfaseMs !== null && (
        <div className="video-desfase">
          <span>{textoDesfase(v.desfaseMs)}</span>
          <span className="botones">
            <span className="rotulo">Si la letra llega tarde:</span>
            <button className="chico" onClick={() => mover(100)}>
              +0,1 s
            </button>
            <button className="chico" onClick={() => mover(1000)}>
              +1 s
            </button>
            <span className="rotulo">temprano:</span>
            <button className="chico" onClick={() => mover(-100)}>
              −0,1 s
            </button>
            <button className="chico" onClick={() => mover(-1000)}>
              −1 s
            </button>
          </span>
        </div>
      )}
    </li>
  )
}

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

function Carpeta({ e }: { e: EstadoApp }) {
  const [moviendo, setMoviendo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function cambiar(): Promise<void> {
    setError(null)
    setMoviendo(true)
    const r = await api.elegirCarpeta()
    setMoviendo(false)
    if (r.error) setError(r.error)
  }
  const elegir = (
    <button onClick={() => void cambiar()} disabled={moviendo}>
      {moviendo ? 'Moviendo los videos…' : e.carpetaConfirmada ? 'Cambiar…' : 'Elegir otra carpeta…'}
    </button>
  )
  if (!e.carpetaConfirmada)
    return (
      <section className="tarjeta destacada" aria-label="Carpeta de los videos">
        <h2>¿Dónde se guardan los videos?</h2>
        <p className="texto">
          En <code className="ruta">{e.carpeta}</code>. Cada video queda con el nombre de su canción y, al lado, un archivito con su
          alineación.
        </p>
        <p className="ayuda">
          Para pasar todo a otra compu, copiá esa carpeta y elegila allá: los videos aparecen ya alineados, sin volver a procesar.
        </p>
        <div className="fila arriba">
          <button className="primario" onClick={() => api.confirmarCarpeta()}>
            Usar esta carpeta
          </button>
          {elegir}
        </div>
        {error && <p className="error-texto">{error}</p>}
      </section>
    )
  return (
    <section className="tarjeta" aria-label="Carpeta de los videos">
      <h2>Carpeta de los videos</h2>
      <div className="fila">
        <code className="ruta">{e.carpeta}</code>
        <button onClick={() => api.abrirCarpeta()}>Abrir</button>
        {elegir}
      </div>
      {error && <p className="error-texto">{error}</p>}
      <p className="ayuda">
        Un video que dejes acá con el nombre de la canción se vincula y se alinea solo. Para otra compu, copiá la carpeta entera (con los
        archivitos .airtracks-video.json) y elegila allá: los videos ya vienen alineados.
      </p>
    </section>
  )
}

/** La ruta de un archivo arrastrado (Electron 22: el File la trae). */
const rutaDe = (f: File): string => (f as File & { path?: string }).path ?? ''

export function App() {
  const [e, setE] = useState<EstadoApp | null>(null)
  /** videos que esperan que se elija su cancion (el primero se muestra) */
  const [cola, setCola] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copiando, setCopiando] = useState<string | null>(null)
  const [arrastrando, setArrastrando] = useState(false)
  const [progreso, setProgreso] = useState<Record<string, { texto: string; fraccion: number | null }>>({})
  const trabajando = useRef(false)

  useEffect(() => {
    void api.estado().then(setE)
    api.onEstado(setE)
  }, [])

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

  if (!e) return null
  const conectado = e.conexion.estado === 'conectado' && !e.conexion.desactualizado
  const conVideo = new Map(e.videos.map((v) => [v.proyectoId, v.archivo]))
  return (
    <div className="app">
      <header>
        <h1>
          AirTracks <span>Video</span>
        </h1>
        <Conexion e={e} />
      </header>
      <main>
        {!e.carpetaConfirmada && <Carpeta e={e} />}
        <section className="tarjeta">
          <div className="titulo-seccion">
            <h2>Videos con la letra</h2>
            <button className="primario" onClick={() => void agregar()} disabled={copiando !== null}>
              + Agregar videos
            </button>
          </div>
          <p className="ayuda arriba">O arrastrá los videos a esta ventana: el que tiene el nombre de la canción se vincula solo.</p>
          {copiando && <p className="info-texto">{copiando}</p>}
          {error && <p className="error-texto">{error}</p>}
          {e.videos.length === 0 && e.sueltos.length === 0 ? (
            <p className="vacio">
              Todavía no hay videos. Agregá el video con la letra de una canción (la misma grabación que la multitrack): el programa encuentra
              solo dónde empieza la canción en el video, y en el culto el video sigue a la banda.
            </p>
          ) : (
            <ul className="videos">
              {e.videos.map((v) => (
                <FilaVideo
                  key={v.proyectoId}
                  v={v}
                  suena={e.cancionActiva?.id === v.proyectoId}
                  sinCancion={e.sinCancion.includes(v.proyectoId)}
                  progreso={progreso[v.proyectoId] ?? null}
                  onCambiar={() => setCola((c) => (c.includes(v.archivo) ? c : [...c, v.archivo]))}
                />
              ))}
              {e.sueltos.map((a) => (
                <li key={a} className="video suelto">
                  <div className="video-arriba">
                    <div className="video-nombres">
                      <b>{a}</b>
                      <small>Sin canción</small>
                    </div>
                    <button className="chico" disabled={!conectado} onClick={() => setCola((c) => (c.includes(a) ? c : [...c, a]))}>
                      Elegir canción
                    </button>
                    <button
                      className="chico peligro"
                      onClick={() => {
                        if (confirm(`¿Borrar "${a}" de la carpeta de videos?`)) void api.borrarSuelto(a)
                      }}
                    >
                      Borrar
                    </button>
                  </div>
                  <div className="video-estado aviso">
                    {conectado
                      ? 'No se sabe de qué canción es (el nombre no coincide, o esa canción ya tiene video): elegila'
                      : 'Al conectar con AirTracks se vincula sola, si el nombre es el de la canción'}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {e.copiandose > 0 && (
            <p className="ayuda">
              {e.copiandose === 1 ? 'Hay un video copiándose a la carpeta' : `Hay ${e.copiandose} videos copiándose a la carpeta`}: se agrega cuando
              termine.
            </p>
          )}
        </section>
        <Proyector e={e} />
        {e.carpetaConfirmada && <Carpeta e={e} />}
        <p className="version">AirTracks Video {e.version} · funciona sin internet, por la red del router</p>
      </main>
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
          Soltá los videos acá
        </div>
      )}
    </div>
  )
}
