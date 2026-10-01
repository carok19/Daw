import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProyectoResumen } from '../../shared/types'
import type { ApiVideo, EstadoApp, VideoGuardado } from '../tipos'
import { alinearVideo } from './alinear'

declare global {
  interface Window {
    airtracksVideo: ApiVideo
  }
}

const api = window.airtracksVideo

/** "Fiesta En El Desierto-E-125BPM (Lyric Video)" -> palabras para comparar nombres. */
function palabras(nombre: string): string[] {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/\d{2,3}([.,]\d+)?\s*bpm/g, ' ')
    .split(/[^a-z0-9ñ]+/)
    .filter((p) => p.length > 1 && !['lyric', 'lyrics', 'video', 'oficial', 'official', 'letra', 'con', 'hd', 'audio', 'en', 'vivo', 'live', 'the', 'el', 'la', 'de'].includes(p))
}

function parecido(a: string, b: string): number {
  const pa = new Set(palabras(a))
  const pb = new Set(palabras(b))
  if (!pa.size || !pb.size) return 0
  let comunes = 0
  for (const p of pa) if (pb.has(p)) comunes++
  return comunes / Math.max(pa.size, pb.size)
}

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
        ? { texto: 'Listo (ajustado a mano)', tipo: 'ok' }
        : { texto: `Listo · coincide en el ${Math.round((v.alineacion?.coincide ?? 1) * 100)} % de la canción`, tipo: 'ok' }
    case 'revisar':
      return {
        texto: 'No coincide del todo: ¿es la misma grabación? Probalo con la canción y ajustá el inicio a mano',
        tipo: 'aviso'
      }
    default:
      return { texto: v.mensaje ?? 'No se pudo alinear', tipo: 'error' }
  }
}

function Conexion({ e }: { e: EstadoApp }) {
  const c = e.conexion
  const [codigo, setCodigo] = useState('')
  const [direccion, setDireccion] = useState('')
  const [escribir, setEscribir] = useState(false)
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

function FilaVideo({ v, suena }: { v: VideoGuardado; suena: boolean }) {
  const est = textoEstado(v)
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
        <button
          className="chico"
          disabled={v.estado === 'alineando'}
          title="Volver a calcular dónde empieza la canción en el video"
          onClick={() => void api.actualizarVideo(v.proyectoId, { estado: 'alineando', mensaje: undefined })}
        >
          Alinear de nuevo
        </button>
        <button className="chico peligro" onClick={() => void api.quitarVideo(v.proyectoId)}>
          Quitar
        </button>
      </div>
      <div className={`video-estado ${est.tipo}`}>{est.texto}</div>
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

function ElegirCancion({ archivo, onElegir, onCerrar }: { archivo: string; onElegir: (p: ProyectoResumen) => void; onCerrar: () => void }) {
  const [canciones, setCanciones] = useState<ProyectoResumen[] | null>(null)
  const [busqueda, setBusqueda] = useState('')
  useEffect(() => {
    void api.canciones().then((c) => setCanciones(c.filter((p) => !p.colchon)))
  }, [])
  const nombreArchivo = archivo.split(/[\\/]/).pop() ?? archivo
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

export function App() {
  const [e, setE] = useState<EstadoApp | null>(null)
  const [elegido, setElegido] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiando, setCopiando] = useState(false)
  const trabajando = useRef(false)

  useEffect(() => {
    void api.estado().then(setE)
    api.onEstado(setE)
  }, [])

  // alinear de a un video: los nuevos enseguida; los que esperan (musica sonando, sin conexion), cada 20 s
  const ultimoIntento = useRef(new Map<string, number>())
  useEffect(() => {
    if (!e || trabajando.current) return
    const conectado = e.conexion.estado === 'conectado'
    const ahora = Date.now()
    const pendiente = e.videos.find(
      (v) =>
        v.estado === 'alineando' ||
        (conectado && (v.estado === 'esperando-musica' || v.estado === 'sin-conexion') && ahora - (ultimoIntento.current.get(v.proyectoId) ?? 0) > 20_000)
    )
    if (!pendiente) return
    trabajando.current = true
    ultimoIntento.current.set(pendiente.proyectoId, ahora)
    void (async () => {
      if (pendiente.estado !== 'alineando') await api.actualizarVideo(pendiente.proyectoId, { estado: 'alineando' })
      const r = await alinearVideo(api, pendiente)
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

  async function agregar(): Promise<void> {
    setError(null)
    const ruta = await api.elegirArchivo()
    if (ruta) setElegido(ruta)
  }

  async function vincular(p: ProyectoResumen): Promise<void> {
    const ruta = elegido!
    setElegido(null)
    setCopiando(true)
    const r = await api.agregarVideo(ruta, p.id, p.nombre)
    setCopiando(false)
    if ('error' in r) setError(r.error)
  }

  if (!e) return null
  return (
    <div className="app">
      <header>
        <h1>
          AirTracks <span>Video</span>
        </h1>
        <Conexion e={e} />
      </header>
      <main>
        <section className="tarjeta">
          <div className="titulo-seccion">
            <h2>Videos con la letra</h2>
            <button className="primario" onClick={() => void agregar()} disabled={copiando}>
              {copiando ? 'Copiando…' : '+ Agregar video'}
            </button>
          </div>
          {error && <p className="error-texto">{error}</p>}
          {e.videos.length === 0 ? (
            <p className="vacio">
              Todavía no hay videos. Agregá el video con la letra de una canción (la misma grabación que la multitrack): el programa encuentra
              solo dónde empieza la canción en el video, y en el culto el video sigue a la banda.
            </p>
          ) : (
            <ul className="videos">
              {e.videos.map((v) => (
                <FilaVideo key={v.proyectoId} v={v} suena={e.cancionActiva?.id === v.proyectoId} />
              ))}
            </ul>
          )}
        </section>
        <Proyector e={e} />
        <p className="version">AirTracks Video {e.version} · funciona sin internet, por la red del router</p>
      </main>
      {elegido && <ElegirCancion archivo={elegido} onElegir={(p) => void vincular(p)} onCerrar={() => setElegido(null)} />}
    </div>
  )
}
