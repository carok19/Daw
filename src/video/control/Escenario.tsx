import { useEffect, useMemo, useRef, useState } from 'react'
import { BANDAS_HUELLA, huellaDeBytes, MS_POR_CUADRO } from '../../shared/huella'
import type { CancionDeHoy, VideoGuardado } from '../tipos'
import { api, estadoDe, mmss, segundos, textoDesfase, useMiniatura, usePantalla, usePosicion, useReproduccion, useVistaPrevia } from './estado'

/**
 * La parte grande de la ventana: el monitor (lo que se ve en el proyector, en
 * chiquito), las secciones de la cancion con el cabezal y el ajuste del
 * inicio con el sonido de la cancion y el del video encimados.
 */

interface PropsEscenario {
  cancion: CancionDeHoy | null
  /** el nombre, si la cancion no esta abierta en AirTracks */
  nombre: string | null
  proyectoId: string | null
  video: VideoGuardado | null
  progreso: { texto: string; fraccion: number | null } | null
  conectado: boolean
  sinCancion: boolean
  onElegirVideo: () => void
  onCambiarCancion: () => void
}

export function Escenario(p: PropsEscenario) {
  const rep = useReproduccion()
  const pantalla = usePantalla()
  const pos = usePosicion(rep, p.proyectoId)
  const activa = !!p.proyectoId && rep?.proyectoId === p.proyectoId
  const [local, setLocal] = useState<number | null>(null)
  const posicion = pos ?? local

  return (
    <section className="tarjeta escenario" aria-label="En el proyector">
      <Monitor {...p} activa={activa} pos={pos} onPosLocal={setLocal} />
      <Recorrido cancion={p.cancion} pos={posicion} />
      {p.video ? (
        <Ajuste video={p.video} progreso={p.progreso} conectado={p.conectado} sinCancion={p.sinCancion} pos={posicion} onCambiarCancion={p.onCambiarCancion} />
      ) : p.proyectoId && !p.cancion?.colchon ? (
        <div className="sin-video-panel">
          <div>
            <b>Esta canción no tiene video</b>
            <span>En el proyector se ve Holyrics, como siempre. Arrastrá el video acá o elegilo:</span>
          </div>
          <button className="primario" onClick={p.onElegirVideo}>
            Elegir el video…
          </button>
        </div>
      ) : null}
      {pantalla && !pantalla.visible && pantalla.prueba === null && rep?.prueba && <p className="ayuda">Preparando el video en el proyector…</p>}
    </section>
  )
}

// ---------- el monitor ----------

function Monitor(p: PropsEscenario & { activa: boolean; pos: number | null; onPosLocal: (ms: number | null) => void }) {
  const rep = useReproduccion()
  const pantalla = usePantalla()
  const vista = useVistaPrevia()
  const mini = useMiniatura(p.video)
  const suena = rep?.playback?.estado === 'playing'
  const enProyector = !!pantalla?.visible && pantalla.proyectoId === p.proyectoId && !!vista
  const revisando = !!rep?.prueba && rep.prueba.proyectoId === p.proyectoId
  const nombre = p.cancion?.nombre ?? p.nombre
  const local = useRef<HTMLVideoElement>(null)
  const [reproduciendo, setReproduciendo] = useState(false)
  const listo = !!p.video && p.video.desfaseMs !== null

  // al cambiar de cancion (o salir al proyector), la vista previa de esta compu se para
  useEffect(() => {
    setReproduciendo(false)
    p.onPosLocal(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.proyectoId, enProyector])

  useEffect(() => {
    const v = local.current
    if (!v || !reproduciendo || !p.video) return
    const desfase = (p.video.desfaseMs ?? 0) / 1000
    const alPos = p.onPosLocal
    const t = setInterval(() => alPos((v.currentTime - desfase) * 1000), 100)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reproduciendo, p.video?.desfaseMs, p.video?.archivo])

  let insignia: { texto: string; clase: string } = { texto: 'Se ve Holyrics', clase: 'apagado' }
  if (pantalla?.prueba === 'cartel') insignia = { texto: 'Probando el proyector', clase: 'prueba' }
  else if (enProyector && revisando) insignia = { texto: 'En el proyector · revisando', clase: 'prueba' }
  else if (enProyector) insignia = pantalla!.corriendo ? { texto: 'En vivo', clase: 'vivo' } : { texto: suena ? 'Contando' : 'En pausa', clase: 'quieto' }
  else if (reproduciendo) insignia = { texto: 'Vista previa · no sale en el proyector', clase: 'previa' }

  const dif = pantalla?.difMs ?? null
  return (
    <>
      <div className="escenario-titulo">
        <h2>En el proyector</h2>
        <span className={`insignia ${insignia.clase}`}>
          <i /> {insignia.texto}
        </span>
        <span className="sp" />
        {listo && !suena && (
          <button
            className={`chico ${revisando ? 'activo' : ''}`}
            onClick={() => api.verEnProyector(revisando ? null : p.proyectoId)}
            title="Para revisar la letra en el proyector, con la música parada (al dar ▶ en AirTracks vuelve solo)"
          >
            {revisando ? 'Dejar de ver en el proyector' : 'Ver en el proyector'}
          </button>
        )}
      </div>
      <div className="monitor">
        <div className="pantalla">
          {enProyector ? (
            <img className="vivo" src={vista!} alt="Lo que se ve en el proyector" />
          ) : reproduciendo && p.video ? (
            <video
              ref={local}
              className="previa"
              src={api.urlDeVideo(p.video.archivo)}
              muted
              autoPlay
              onLoadedMetadata={(e) => (e.currentTarget.currentTime = Math.max(0, (p.video!.desfaseMs ?? 0) / 1000))}
              onEnded={() => setReproduciendo(false)}
            />
          ) : (
            <div className={`pantalla-vacia ${mini ? 'con-cuadro' : ''}`} style={mini ? { backgroundImage: `url(${mini})` } : undefined}>
              <div className="pantalla-texto">
                {!nombre ? (
                  <>
                    <b>Elegí una canción</b>
                    <span>A la derecha están las de hoy en AirTracks</span>
                  </>
                ) : p.cancion?.colchon ? (
                  <>
                    <b>Colchón</b>
                    <span>No lleva video: en el proyector se ve Holyrics</span>
                  </>
                ) : !p.video ? (
                  <>
                    <b>Sin video</b>
                    <span>En el proyector se ve Holyrics</span>
                  </>
                ) : (
                  <>
                    <b>{p.activa ? 'Se ve Holyrics' : nombre}</b>
                    <span>{p.activa ? 'El video aparece solo al darle ▶ en AirTracks' : 'No está sonando en AirTracks'}</span>
                    {listo && (
                      <button className="ver-aca" onClick={() => setReproduciendo(true)}>
                        ▶ Ver acá
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {enProyector && !revisando && (
            <span className={`sync ${!pantalla!.corriendo ? 'quieto' : dif !== null && Math.abs(dif) <= 60 ? 'ok' : 'ajustando'}`}>
              {!pantalla!.corriendo ? 'Quieto en el cuadro justo' : dif === null ? 'Midiendo…' : Math.abs(dif) <= 60 ? `✓ En sync · ${Math.abs(dif)} ms` : `Ajustando · ${Math.abs(dif)} ms`}
            </span>
          )}
          {reproduciendo && (
            <button className="parar-previa" onClick={() => setReproduciendo(false)}>
              ■ Parar
            </button>
          )}
          {nombre && (enProyector || reproduciendo) && (
            <div className="etiquetas">
              <span>▶ {nombre}</span>
              {p.cancion && p.pos !== null && (
                <span>
                  {seccionEn(p.cancion, p.pos)} · {mmss(p.pos)} / {mmss(p.cancion.duracionMs)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function seccionEn(c: CancionDeHoy, ms: number): string {
  let nombre = c.secciones[0]?.nombre ?? ''
  for (const s of c.secciones) if (s.inicioMs <= ms + 1) nombre = s.nombre
  return nombre
}

// ---------- las secciones, con el cabezal ----------

function Recorrido({ cancion, pos }: { cancion: CancionDeHoy | null; pos: number | null }) {
  if (!cancion || cancion.duracionMs <= 0) return null
  const dur = cancion.duracionMs
  return (
    <div className="recorrido">
      <div className="secciones">
        {cancion.secciones.map((s, i) => (
          <div
            key={i}
            className={pos !== null && pos >= s.inicioMs && pos < s.finMs ? 'actual' : ''}
            style={{ flex: Math.max(1, s.finMs - s.inicioMs), background: s.color }}
            title={`${s.nombre} · ${mmss(s.inicioMs)}`}
          >
            <span>{s.nombre}</span>
          </div>
        ))}
        {pos !== null && <i className="cabezal" style={{ left: `${Math.min(100, Math.max(0, (pos / dur) * 100))}%` }} />}
      </div>
      <div className="tiempos">
        <span>{pos !== null ? mmss(pos) : '0:00'}</span>
        <span>El video sigue a la banda: saltos de sección, repetir, pausa y velocidad</span>
        <span>{mmss(dur)}</span>
      </div>
    </div>
  )
}

// ---------- el ajuste del inicio ----------

function Ajuste(p: {
  video: VideoGuardado
  progreso: { texto: string; fraccion: number | null } | null
  conectado: boolean
  sinCancion: boolean
  pos: number | null
  onCambiarCancion: () => void
}) {
  const v = p.video
  const est = estadoDe(v)
  const repetir = useRef<{ espera: ReturnType<typeof setTimeout>; cada: ReturnType<typeof setInterval> | null } | null>(null)
  const desfase = useRef(v.desfaseMs ?? 0)
  desfase.current = v.desfaseMs ?? 0

  const mover = (ms: number): void => {
    desfase.current += ms
    void api.actualizarVideo(v.proyectoId, {
      desfaseMs: desfase.current,
      estado: 'listo',
      alineacion: v.alineacion ? { ...v.alineacion, manual: true } : { desfaseMs: 0, confianza: 0, ventaja: 0, coincide: 0, segura: false, manual: true }
    })
  }
  // tocar: 0,1 s; dejar apretado: sigue moviendo
  const apretar = (ms: number): void => {
    mover(ms)
    soltar()
    repetir.current = { espera: setTimeout(() => repetir.current && (repetir.current.cada = setInterval(() => mover(ms), 90)), 400), cada: null }
  }
  const soltar = (): void => {
    if (!repetir.current) return
    clearTimeout(repetir.current.espera)
    if (repetir.current.cada) clearInterval(repetir.current.cada)
    repetir.current = null
  }
  useEffect(() => soltar, [])

  return (
    <div className="ajuste">
      <div className="ajuste-arriba">
        <span className={`estado-texto ${p.sinCancion ? 'aviso' : est.tono}`}>
          {p.sinCancion
            ? 'Esta canción no está en AirTracks: elegí de qué canción es'
            : v.estado === 'alineando' && p.progreso
              ? p.progreso.texto
              : est.largo}
          {!p.sinCancion && est.ayuda && <small>{est.ayuda}</small>}
        </span>
        <span className="acciones">
          <button className="chico" onClick={p.onCambiarCancion} title="Este video es de otra canción">
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
        </span>
      </div>
      {v.estado === 'alineando' && (
        <div className={`barra-progreso ${p.progreso?.fraccion == null ? 'indefinida' : ''}`} role="progressbar" aria-label="Alineando">
          <i style={p.progreso?.fraccion != null ? { width: `${Math.round(p.progreso.fraccion * 100)}%` } : undefined} />
        </div>
      )}
      {v.desfaseMs !== null && (
        <div className="ajuste-abajo">
          <div className="encimadas-caja">
            <div className="rotulo">
              Sonido de la <b className="azul">canción</b> y del <b className="rosa">video</b>, encimados: los picos tienen que coincidir
            </div>
            <Encimadas proyectoId={v.proyectoId} desfaseMs={v.desfaseMs} conectado={p.conectado} pos={p.pos} />
          </div>
          <div className="empujar" onPointerUp={soltar} onPointerLeave={soltar}>
            <button onPointerDown={() => apretar(100)} title="Si la letra llega tarde (dejalo apretado para mover más)" aria-label="La letra antes">
              ◀ Letra antes
            </button>
            <div className="valor">
              <b className="num">{segundos(v.desfaseMs)}</b>
              <small>{textoDesfase(v.desfaseMs)}</small>
            </div>
            <button onPointerDown={() => apretar(-100)} title="Si la letra llega temprano (dejalo apretado para mover más)" aria-label="La letra después">
              Letra después ▶
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** La fuerza de los ataques en cada cuadro de 10 ms (todas las bandas juntas, un poco suavizada). */
function envolvente(bytes: Uint8Array): Float32Array {
  const h = huellaDeBytes(bytes)
  const n = h.length / BANDAS_HUELLA
  const e = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let s = 0
    for (let b = 0; b < BANDAS_HUELLA; b++) s += h[f * BANDAS_HUELLA + b]
    e[f] = s
  }
  const out = new Float32Array(n)
  for (let f = 0; f < n; f++) out[f] = (e[Math.max(0, f - 1)] + 2 * e[f] + e[Math.min(n - 1, f + 1)]) / 4
  return out
}

const VENTANA_MS = 14000

/** La cancion arriba (azul) y el video abajo (rosa, corrido por el desfase): si estan alineados, los picos caen juntos. */
function Encimadas({ proyectoId, desfaseMs, conectado, pos }: { proyectoId: string; desfaseMs: number; conectado: boolean; pos: number | null }) {
  const [curvas, setCurvas] = useState<{ cancion: Float32Array; video: Float32Array } | null | 'falta'>(null)
  const lienzo = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let vivo = true
    setCurvas(null)
    void (async () => {
      let h = await api.leerHuellas(proyectoId)
      // la de la cancion la tiene AirTracks (si ya la calculo, contesta enseguida)
      if (!h.cancion && conectado) {
        const r = await api.huellaCancion(proyectoId)
        if (r.estado === 'lista') {
          await api.guardarHuellaCancion(proyectoId, r.huella)
          h = { ...h, cancion: r.huella }
        }
      }
      if (!vivo) return
      setCurvas(h.cancion && h.video ? { cancion: envolvente(h.cancion), video: envolvente(h.video) } : 'falta')
    })()
    return () => {
      vivo = false
    }
  }, [proyectoId, conectado])

  // la parte de la cancion que se muestra: alrededor de donde suena; si no, la mas movida
  const centroFijo = useMemo(() => {
    if (!curvas || curvas === 'falta') return 0
    const c = curvas.cancion
    const largo = Math.round(4000 / MS_POR_CUADRO)
    let mejor = 0
    let suma = 0
    let mejorSuma = -1
    const desde = Math.floor(c.length * 0.15)
    const hasta = Math.floor(c.length * 0.85)
    for (let f = desde; f < hasta; f++) {
      suma += c[f] - (f - largo >= desde ? c[f - largo] : 0)
      if (suma > mejorSuma) {
        mejorSuma = suma
        mejor = f - largo / 2
      }
    }
    return mejor * MS_POR_CUADRO
  }, [curvas])
  const centro = pos ?? centroFijo
  const inicio = Math.max(0, Math.round((centro - VENTANA_MS / 2) / 500) * 500)

  useEffect(() => {
    const c = lienzo.current
    if (!c || !curvas || curvas === 'falta') return
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    const n = Math.round(VENTANA_MS / MS_POR_CUADRO)
    const valores = (curva: Float32Array, corrimientoMs: number): number[] => {
      const v: number[] = []
      for (let i = 0; i < n; i++) {
        const f = Math.round((inicio + corrimientoMs) / MS_POR_CUADRO) + i
        v.push(f >= 0 && f < curva.length ? curva[f] : 0)
      }
      const orden = [...v].sort((a, b) => a - b)
      const tope = Math.max(1e-6, orden[Math.floor(orden.length * 0.97)])
      return v.map((x) => Math.min(1, x / tope))
    }
    const medio = h / 2
    const dibujar = (v: number[], color: string, hacia: 1 | -1): void => {
      g.beginPath()
      g.moveTo(0, medio)
      v.forEach((x, i) => g.lineTo((i / (n - 1)) * w, medio - hacia * x * (medio - 3)))
      g.lineTo(w, medio)
      g.closePath()
      const grad = g.createLinearGradient(0, medio, 0, medio - hacia * medio)
      grad.addColorStop(0, `${color}22`)
      grad.addColorStop(1, `${color}cc`)
      g.fillStyle = grad
      g.fill()
    }
    dibujar(valores(curvas.cancion, 0), '#5b7cff', 1)
    // el video, en el mismo instante de la cancion: su cuadro = el de la cancion + el desfase
    dibujar(valores(curvas.video, desfaseMs), '#f472b6', -1)
    g.fillStyle = 'rgba(255,255,255,0.18)'
    g.fillRect(0, medio - 0.5 * devicePixelRatio, w, devicePixelRatio)
  }, [curvas, desfaseMs, inicio])

  if (curvas === 'falta')
    return <p className="encimadas-falta">Se dibujan cuando el video se alinea en esta compu (con AirTracks conectado).</p>
  return (
    <div className="encimadas">
      <canvas ref={lienzo} aria-label="El sonido de la canción y el del video, encimados" />
      <span className="encimadas-tiempo">
        {mmss(inicio)} – {mmss(inicio + VENTANA_MS)}
      </span>
    </div>
  )
}
