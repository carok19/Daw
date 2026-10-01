import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { EstadoApp } from '../tipos'
import { api, usePantalla } from './estado'

/**
 * Arriba: el logo y unas pastillas con lo que importa de un vistazo (si esta
 * conectado, la lista del dia, el proyector, la carpeta). Cada una se abre
 * para cambiar lo suyo.
 */

/** Una pastilla que se abre (se cierra tocando afuera o con Esc). */
function Desplegable({ boton, titulo, clase, children }: { boton: ReactNode; titulo: string; clase?: string; children: (cerrar: () => void) => ReactNode }) {
  const [abierto, setAbierto] = useState(false)
  const caja = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!abierto) return
    const fuera = (e: MouseEvent): void => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false)
    }
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAbierto(false)
    }
    document.addEventListener('mousedown', fuera)
    document.addEventListener('keydown', tecla)
    return () => {
      document.removeEventListener('mousedown', fuera)
      document.removeEventListener('keydown', tecla)
    }
  }, [abierto])
  return (
    <div className="desplegable" ref={caja}>
      <button className={`pastilla ${clase ?? ''} ${abierto ? 'abierta' : ''}`} onClick={() => setAbierto(!abierto)} aria-expanded={abierto} title={titulo}>
        {boton}
      </button>
      {abierto && (
        <div className="globo" role="dialog" aria-label={titulo}>
          {children(() => setAbierto(false))}
        </div>
      )}
    </div>
  )
}

function Conexion({ e }: { e: EstadoApp }) {
  const c = e.conexion
  const [direccion, setDireccion] = useState('')
  const ok = c.estado === 'conectado' && !c.desactualizado
  const texto = ok
    ? 'Conectado a'
    : c.estado === 'conectado'
      ? 'AirTracks viejo en'
      : c.estado === 'conectando'
        ? 'Conectando con'
        : c.estado === 'codigo'
          ? 'Pide el código'
          : c.estado === 'ocupado'
            ? 'Ya hay otra pantalla de video'
            : 'Buscando AirTracks…'
  const nombre = c.estado === 'conectado' || c.estado === 'conectando' ? (c.nombreServidor ?? c.servidor) : null
  return (
    <Desplegable
      titulo="Conexión con AirTracks"
      clase={ok ? '' : 'alerta'}
      boton={
        <>
          <span className={`punto ${ok ? 'verde' : 'amarillo latiendo'}`} />
          {texto} {nombre && <b>{nombre.replace(/^AirTracks · /, '')}</b>}
        </>
      }
    >
      {(cerrar) => (
        <div className="globo-cuerpo">
          <h3>Conexión con AirTracks</h3>
          <p className="ayuda">
            {ok
              ? `Conectado a ${c.servidor}. Funciona sin internet, por la red del router.`
              : 'AirTracks tiene que estar abierto en la compu principal, en el mismo router. Se encuentra solo; si no aparece, escribí la dirección que muestra AirTracks en "Conectar celulares".'}
          </p>
          <form
            className="fila"
            onSubmit={(ev) => {
              ev.preventDefault()
              api.usarDireccion(direccion)
              cerrar()
            }}
          >
            <input value={direccion} onChange={(ev) => setDireccion(ev.target.value)} placeholder="192.168.0.10:4848" aria-label="Dirección de la compu de AirTracks" />
            <button className="primario">Conectar</button>
          </form>
          {c.servidor && (
            <button
              className="enlace"
              onClick={() => {
                api.usarDireccion(null)
                cerrar()
              }}
            >
              Volver a buscarla sola
            </button>
          )}
        </div>
      )}
    </Desplegable>
  )
}

/** Las pantallas dibujadas como en Windows: la del proyector, resaltada. */
function Pantallitas({ e, grandes, onElegir }: { e: EstadoApp; grandes?: boolean; onElegir?: (id: number) => void }) {
  return (
    <span className={`pantallitas ${grandes ? 'grandes' : ''}`}>
      {e.pantallas.map((p, i) => {
        const clase = `pantallita ${p.id === e.pantallaId ? 'elegida' : ''}`
        return onElegir ? (
          <button key={p.id} className={clase} onClick={() => onElegir(p.id)} title={p.nombre} aria-pressed={p.id === e.pantallaId}>
            <b>{i + 1}</b>
            <small>{p.principal ? 'esta compu' : 'proyector'}</small>
          </button>
        ) : (
          <span key={p.id} className={clase} />
        )
      })}
    </span>
  )
}

function Proyector({ e }: { e: EstadoApp }) {
  const pantalla = usePantalla()
  const elegida = e.pantallas.find((p) => p.id === e.pantallaId)
  const indice = elegida ? e.pantallas.indexOf(elegida) + 1 : 0
  return (
    <Desplegable
      titulo="El proyector"
      clase={elegida ? '' : 'alerta'}
      boton={
        <>
          <Pantallitas e={e} />
          {elegida ? (
            <>
              Proyector: <b>pantalla {indice}</b>
            </>
          ) : (
            'Sin proyector'
          )}
        </>
      }
    >
      {() => (
        <div className="globo-cuerpo">
          <h3>¿Cuál es el proyector?</h3>
          <Pantallitas e={e} grandes onElegir={(id) => api.elegirPantalla(id)} />
          {e.pantallas.length < 2 && <p className="aviso-texto">Hay una sola pantalla: conectá el proyector como pantalla extendida.</p>}
          {elegida?.principal && (
            <p className="aviso-texto">
              Elegiste la pantalla de esta compu (sirve para probar): mientras suene una canción con video, el video la tapa. Para sacarlo, pará la
              canción en AirTracks.
            </p>
          )}
          <div className="fila">
            <button onClick={() => api.probarPantalla()} disabled={!elegida || pantalla?.prueba === 'cartel'}>
              {pantalla?.prueba === 'cartel' ? 'Mirá el proyector…' : 'Probar (3 s)'}
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={e.inicioConWindows} onChange={(ev) => api.inicioConWindows(ev.target.checked)} />
            Abrir AirTracks Video al prender la compu
          </label>
          <p className="ayuda">
            El video aparece encima de todo (también de Holyrics) solo mientras suena una canción que tiene video, y se va al pararla. No le saca el
            teclado ni el mouse a Holyrics.
          </p>
        </div>
      )}
    </Desplegable>
  )
}

function Carpeta({ e }: { e: EstadoApp }) {
  const [moviendo, setMoviendo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Desplegable titulo="La carpeta de los videos" boton={<>📁 Carpeta de videos</>}>
      {() => (
        <div className="globo-cuerpo">
          <h3>La carpeta de los videos</h3>
          <code className="ruta">{e.carpeta}</code>
          <div className="fila">
            <button onClick={() => api.abrirCarpeta()}>Abrir</button>
            <button
              disabled={moviendo}
              onClick={async () => {
                setError(null)
                setMoviendo(true)
                const r = await api.elegirCarpeta()
                setMoviendo(false)
                if (r.error) setError(r.error)
              }}
            >
              {moviendo ? 'Moviendo los videos…' : 'Cambiar…'}
            </button>
          </div>
          {error && <p className="error-texto">{error}</p>}
          <p className="ayuda">
            Cada video está con el nombre de su canción y, al lado, un archivito con su alineación. Un video que dejes acá con el nombre de la
            canción se vincula y se alinea solo. Para otra compu, copiá la carpeta entera y elegila allá: los videos ya vienen alineados.
          </p>
        </div>
      )}
    </Desplegable>
  )
}

export function Encabezado({ e }: { e: EstadoApp }) {
  const conectado = e.conexion.estado === 'conectado'
  return (
    <header>
      <div className="logo">
        <img src="icono.svg" alt="" />
        <span>
          AirTracks <b>Video</b>
        </span>
      </div>
      <Conexion e={e} />
      {conectado && (
        <span className="pastilla quieta">
          {e.hoy.lista ? (
            <>
              Lista: <b>{e.hoy.lista}</b>
            </>
          ) : (
            <>
              <b>{e.hoy.canciones.length}</b> {e.hoy.canciones.length === 1 ? 'canción abierta' : 'canciones abiertas'}
            </>
          )}
        </span>
      )}
      <span className="sp" />
      <Proyector e={e} />
      <Carpeta e={e} />
    </header>
  )
}

/** Lo que hay que resolver antes de nada: el codigo de la banda, otra pantalla conectada, AirTracks viejo. */
export function AvisoConexion({ e }: { e: EstadoApp }) {
  const c = e.conexion
  const [codigo, setCodigo] = useState('')
  if (c.estado === 'codigo')
    return (
      <form
        className="aviso-grande"
        onSubmit={(ev) => {
          ev.preventDefault()
          api.usarCodigo(codigo)
        }}
      >
        <div>
          <b>
            {c.motivoCodigo === 'codigo-incorrecto'
              ? 'Ese no es el código de la banda'
              : c.motivoCodigo === 'codigo-bloqueado'
                ? 'Demasiados intentos: esperá un minuto'
                : 'AirTracks pide el código de la banda'}
          </b>
          <span>Es el mismo que ponen los celulares (está en AirTracks, en "Conectar celulares").</span>
        </div>
        <input value={codigo} onChange={(ev) => setCodigo(ev.target.value)} inputMode="numeric" maxLength={8} placeholder="Código" aria-label="Código de la banda" />
        <button className="primario">Entrar</button>
      </form>
    )
  if (c.estado === 'ocupado')
    return (
      <div className="aviso-grande">
        <div>
          <b>Ya hay otra pantalla de video conectada a AirTracks</b>
          <span>Puede haber una sola a la vez: cerrá AirTracks Video en la otra compu.</span>
        </div>
      </div>
    )
  if (c.estado === 'conectado' && c.desactualizado)
    return (
      <div className="aviso-grande error">
        <div>
          <b>Hay que actualizar AirTracks en la compu principal</b>
          <span>Tiene una versión de antes de los videos: instalá la nueva con el instalador de siempre (Descargas). Al actualizarla, sigue sola.</span>
        </div>
      </div>
    )
  return null
}

/** La primera vez: donde se guardan los videos. */
export function PrimeraVezCarpeta({ e }: { e: EstadoApp }) {
  const [moviendo, setMoviendo] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="aviso-grande destacado" aria-label="Carpeta de los videos">
      <div>
        <b>¿Dónde se guardan los videos?</b>
        <span>
          En <code className="ruta">{e.carpeta}</code>. Cada video queda con el nombre de su canción y, al lado, un archivito con su alineación: para
          pasar todo a otra compu, se copia esa carpeta.
        </span>
        {error && <span className="error-texto">{error}</span>}
      </div>
      <button className="primario" onClick={() => api.confirmarCarpeta()}>
        Usar esta carpeta
      </button>
      <button
        disabled={moviendo}
        onClick={async () => {
          setError(null)
          setMoviendo(true)
          const r = await api.elegirCarpeta()
          setMoviendo(false)
          if (r.error) setError(r.error)
        }}
      >
        {moviendo ? 'Moviendo los videos…' : 'Elegir otra…'}
      </button>
    </section>
  )
}
