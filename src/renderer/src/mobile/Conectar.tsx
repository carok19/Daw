import { useEffect, useState } from 'react'
import { Check, Copy, Download, KeyRound, Lock, MessageCircle, Share, Share2, Smartphone, Users, Wifi } from 'lucide-react'
import type { DatosInvitacion, MotivoCodigo } from '@shared/types'
import type { AppController } from '../app/useAppController'
import {
  abiertaPorIp,
  copiarTexto,
  direccionVisible,
  enlaceConCodigo,
  enPantallaDeInicio,
  esAndroid,
  esIOS,
  mensajeInvitacion,
  puenteAndroid,
  textoQrWifi
} from '../conexion'
import { useQr } from '../ui/useQr'
import { Hoja } from './Hojas'

// ---------- codigo de la banda ----------

const MENSAJE_CODIGO: Record<MotivoCodigo, string | null> = {
  'codigo-requerido': null,
  'codigo-incorrecto': 'Ese código no es. Probá de nuevo.',
  'codigo-bloqueado': 'Demasiados intentos. Esperá un minuto y probá de nuevo.'
}

/** Pantalla completa: la compu pide el codigo de la banda para dejar entrar a este celular. */
export function PantallaCodigo({ controller }: { controller: AppController }) {
  const pedido = controller.pedidoCodigo!
  const [codigo, setCodigo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const app = puenteAndroid()

  // cada rechazo nuevo habilita otro intento
  useEffect(() => {
    setEnviando(false)
    if (pedido.motivo === 'codigo-incorrecto') setCodigo('')
  }, [pedido])

  function enviar(e: React.FormEvent): void {
    e.preventDefault()
    if (codigo.length < 4 || enviando) return
    setEnviando(true)
    controller.enviarCodigo(codigo)
  }

  const mensaje = MENSAJE_CODIGO[pedido.motivo]
  return (
    <div className="pantalla-codigo" role="dialog" aria-modal aria-labelledby="titulo-codigo">
      <KeyRound size={40} color="var(--accent)" />
      <h1 id="titulo-codigo">Código de la banda</h1>
      <p>Pedíselo a quien maneja la computadora (o a alguien de la banda: lo ve en “Invitar”).</p>
      <form onSubmit={enviar}>
        <input
          className="codigo-input num"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={8}
          placeholder="••••"
          value={codigo}
          autoFocus
          aria-label="Código de la banda"
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 8))}
        />
        {mensaje && (
          <p className="error-texto" role="alert">
            {mensaje}
          </p>
        )}
        <button className="btn-primario codigo-boton" disabled={codigo.length < 4 || enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      {app && (
        <button className="btn-fantasma" onClick={() => app.cambiarCompu()}>
          Elegir otra computadora
        </button>
      )}
    </div>
  )
}

// ---------- sin lugar (licencia) ----------

/**
 * Pantalla completa: la compu ya tiene todos los celulares que permite la
 * version de prueba (o la licencia). Se reintenta sola cada unos segundos.
 */
export function PantallaLicencia({ controller }: { controller: AppController }) {
  const pedido = controller.pedidoLicencia!
  const [probando, setProbando] = useState(false)
  const app = puenteAndroid()

  useEffect(() => setProbando(false), [pedido])

  return (
    <div className="pantalla-codigo" role="dialog" aria-modal aria-labelledby="titulo-licencia">
      <Users size={40} color="var(--warn)" />
      <h1 id="titulo-licencia">No hay más lugar</h1>
      <p>
        {pedido.prueba
          ? `La versión de prueba permite ${pedido.limite} celulares a la vez y ya están conectados. Para sumar más, quien maneja la computadora tiene que activar una licencia.`
          : `La licencia de esta computadora permite ${pedido.limite} celulares a la vez y ya están conectados.`}
      </p>
      <p style={{ fontSize: 13, color: 'var(--text-3)' }}>Si alguien se desconecta, entrás solo.</p>
      <button
        className="btn-primario codigo-boton"
        disabled={probando}
        onClick={() => {
          setProbando(true)
          controller.reintentarConexion()
        }}
      >
        {probando ? 'Probando…' : 'Probar de nuevo'}
      </button>
      {app && (
        <button className="btn-fantasma" onClick={() => app.cambiarCompu()}>
          Elegir otra computadora
        </button>
      )}
    </div>
  )
}

// ---------- invitar a alguien ----------

function useDatosInvitacion(controller: AppController): { datos: DatosInvitacion | null; error: boolean } {
  const [datos, setDatos] = useState<DatosInvitacion | null>(null)
  const [error, setError] = useState(false)
  const pedir = controller.datosInvitacion // estable (el controller se rearma en cada render)
  useEffect(() => {
    let cancelado = false
    pedir()
      .then((d) => !cancelado && setDatos(d))
      .catch(() => !cancelado && setError(true))
    return () => {
      cancelado = true
    }
  }, [pedir])
  return { datos, error }
}

/** fetch de JSON con tiempo maximo (sin AbortSignal.timeout: no esta en iPhones viejos). */
async function pedirJson<T>(url: string, ms: number): Promise<T> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), ms)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: control.signal })
    return (await r.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Para el que llega tarde: cualquiera que ya esta conectado le muestra el QR
 * (o se lo manda por WhatsApp) sin molestar al que maneja la compu.
 */
export function HojaInvitar({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const { datos, error } = useDatosInvitacion(controller)
  const [copiado, setCopiado] = useState(false)
  const enlace = datos ? enlaceConCodigo(datos.url, datos.codigo) : null
  const qrEnlace = useQr(enlace)
  const qrWifi = useQr(datos?.wifi ? textoQrWifi(datos.wifi) : null)
  const app = puenteAndroid()

  function copiar(): void {
    if (!datos) return
    if (copiarTexto(mensajeInvitacion(datos))) {
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2500)
    }
  }

  return (
    <Hoja titulo="Invitar a alguien" onCerrar={onCerrar}>
      {error && <p className="error-texto">No se pudieron pedir los datos a la computadora. Revisá la conexión.</p>}
      {!datos && !error && <p className="ayuda">Cargando…</p>}
      {datos && (
        <>
          {datos.wifi && (
            <div className="invitar-paso">
              <h3>
                <span className="invitar-numero">1</span> Conectarse al WiFi
              </h3>
              <div className="invitar-qr-fila">
                {qrWifi ? <img className="invitar-qr" src={qrWifi} alt="QR del WiFi" /> : <div className="invitar-qr" />}
                <div className="invitar-datos">
                  <span>Red</span>
                  <strong>{datos.wifi.ssid}</strong>
                  {datos.wifi.clave && (
                    <>
                      <span>Clave</span>
                      <strong className="invitar-clave">{datos.wifi.clave}</strong>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="invitar-paso">
            <h3>
              {datos.wifi && <span className="invitar-numero">2</span>} Abrir la app
            </h3>
            <div className="invitar-qr-fila">
              {qrEnlace ? <img className="invitar-qr" src={qrEnlace} alt="QR para entrar a la app" data-enlace={enlace ?? ''} /> : <div className="invitar-qr" />}
              <div className="invitar-datos">
                <span>Con la cámara, o escribiendo</span>
                <strong className="invitar-direccion">{direccionVisible(datos.urlCorta ?? datos.url)}</strong>
                {datos.codigo && (
                  <>
                    <span>Código de la banda</span>
                    <strong className="invitar-codigo num">{datos.codigo}</strong>
                  </>
                )}
              </div>
            </div>
            {!datos.wifi && <p className="ayuda">Tiene que estar en el mismo WiFi que la computadora.</p>}
          </div>
          <div className="invitar-botones">
            <a
              className="boton-enlace btn-primario"
              href={`https://wa.me/?text=${encodeURIComponent(mensajeInvitacion(datos))}`}
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircle size={18} /> WhatsApp
            </a>
            {app?.compartir ? (
              <button onClick={() => app.compartir!(mensajeInvitacion(datos))}>
                <Share2 size={17} /> Compartir
              </button>
            ) : (
              <button onClick={copiar}>
                {copiado ? <Check size={17} /> : <Copy size={17} />} {copiado ? 'Copiado' : 'Copiar'}
              </button>
            )}
          </div>
          {datos.apk && (
            <p className="ayuda">
              <Smartphone size={14} /> Con Android conviene la app: la próxima vez encuentra la compu sola, sin QR. Está en el mensaje.
            </p>
          )}
        </>
      )}
    </Hoja>
  )
}

// ---------- entrar mas rapido la proxima vez ----------

/**
 * La forma de no escanear el QR en cada ensayo, segun el celular: la app en
 * Android; en iPhone, el icono en la pantalla de inicio con la direccion
 * fija (airtracks.local no cambia aunque cambie la IP de la compu).
 */
export function AccesoFijo({ controller }: { controller: AppController }) {
  const app = puenteAndroid()
  const [datos, setDatos] = useState<DatosInvitacion | null>(null)
  /** null: probando; true: airtracks.local responde y es ESTA compu */
  const [fijaAnda, setFijaAnda] = useState<boolean | null>(null)

  const pedir = controller.datosInvitacion
  useEffect(() => {
    if (app) return
    let cancelado = false
    pedir()
      .then(async (d) => {
        if (cancelado) return
        setDatos(d)
        if (!esIOS() || !abiertaPorIp()) return setFijaAnda(false)
        try {
          // que responda Y que sea esta misma compu (otra compu con la app en la red tambien se llamaria asi)
          const esta = await pedirJson<{ id?: string }>('/api/info', 2500)
          const fija = await pedirJson<{ id?: string }>(`${d.urlFija}/api/info`, 2500)
          if (!cancelado) setFijaAnda(!!esta.id && esta.id === fija.id)
        } catch {
          if (!cancelado) setFijaAnda(false)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelado = true
    }
  }, [pedir, app])

  if (app) {
    return (
      <>
        <p className="ayuda" style={{ marginTop: 0 }}>
          Estás usando la app: la próxima vez abrila y encuentra la computadora sola.
        </p>
        <button className="btn-fantasma" onClick={() => app.cambiarCompu()}>
          Elegir otra computadora
        </button>
      </>
    )
  }

  if (esAndroid()) {
    return datos?.apk ? (
      <>
        <p className="ayuda" style={{ marginTop: 0 }}>
          Bajá la app para Android: en cada ensayo la abrís y encuentra la computadora sola (sin QR ni internet). Recuerda tu nombre y tu mezcla.
        </p>
        <a className="boton-enlace btn-primario" href="/app/airtracks.apk" download>
          <Download size={17} /> Bajar la app para Android
        </a>
        <p className="ayuda" style={{ marginBottom: 0 }}>
          Si el celular pregunta, permití “instalar apps de este origen”.
        </p>
      </>
    ) : (
      <p className="ayuda" style={{ margin: 0 }}>
        Menú ⋮ → “Agregar a la pantalla principal”. Si la computadora cambia de dirección, vas a tener que escanear el QR de nuevo.
      </p>
    )
  }

  if (esIOS()) {
    if (enPantallaDeInicio()) {
      return (
        <p className="ayuda" style={{ margin: 0 }}>
          <Check size={14} /> Ya la tenés en la pantalla de inicio.
        </p>
      )
    }
    if (abiertaPorIp() && fijaAnda && datos) {
      return (
        <>
          <p className="ayuda" style={{ marginTop: 0 }}>
            Esta red permite la dirección fija <b>{direccionVisible(datos.urlFija)}</b>, que no cambia aunque cambie la IP de la computadora:
          </p>
          <ol className="pasos">
            <li>Abrila con este botón.</li>
            <li>
              Tocá <Share size={14} /> <b>Compartir</b> → <b>Agregar a inicio</b>.
            </li>
            <li>En cada ensayo, tocá el ícono “Alabanza”.</li>
          </ol>
          <a className="boton-enlace btn-primario" href={enlaceConCodigo(datos.urlFija, datos.codigo)}>
            <Wifi size={17} /> Abrir con la dirección fija
          </a>
        </>
      )
    }
    return (
      <>
        <ol className="pasos" style={{ marginTop: 0 }}>
          <li>
            Tocá <Share size={14} /> <b>Compartir</b> → <b>Agregar a inicio</b>.
          </li>
          <li>En cada ensayo, tocá el ícono “Alabanza”.</li>
        </ol>
        {abiertaPorIp() && fijaAnda === false && (
          <p className="ayuda" style={{ marginBottom: 0 }}>
            <Lock size={13} /> Esta red no deja usar la dirección fija: si la computadora cambia de IP, vas a tener que escanear el QR de nuevo.
          </p>
        )}
      </>
    )
  }

  return (
    <p className="ayuda" style={{ margin: 0 }}>
      Guardá esta página en favoritos. Dirección fija (si la red la permite): <b>{datos ? direccionVisible(datos.urlFija) : 'airtracks.local'}</b>
    </p>
  )
}
