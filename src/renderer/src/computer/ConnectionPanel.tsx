import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ClipboardCopy, KeyRound, Laptop, Printer, Smartphone, Trash2, Wifi } from 'lucide-react'
import type { AjustesConexion, DatosInvitacion, DispositivoInfo } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { copiarTexto, direccionVisible, enlaceConCodigo, textoQrWifi } from '../conexion'
import { informeTexto, nivelDiagnostico, resumenCorto } from '../diagnostico'
import { Modal } from '../ui/Modal'
import { useQr } from '../ui/useQr'
import { SyncBadge } from './SyncBadge'
import { haceCuanto } from '../format'

function EstadoDispositivo({ d, sonando }: { d: DispositivoInfo; sonando: boolean }) {
  if (!d.conectado) {
    return (
      <span className="dispositivo-estado texto-rojo">
        <span className="punto rojo" /> Desconectado {haceCuanto(d.desconectadoDesde)}
      </span>
    )
  }
  if (d.origen === 'compu') return <span className="dispositivo-estado texto-gris">Director</span>
  if (d.error) {
    return (
      <span className="dispositivo-estado texto-rojo" title={d.error}>
        <span className="punto rojo" /> Error de audio
      </span>
    )
  }
  if (!d.audio) {
    return (
      <span className="dispositivo-estado texto-amarillo" title="En ese celular hay que tocar “Tocá para empezar”">
        <span className="punto amarillo" /> Falta activar el audio
      </span>
    )
  }
  if (d.buffer === 'critico') {
    return (
      <span className="dispositivo-estado texto-rojo" title="El WiFi no alcanza a traer el audio a tiempo">
        <span className="punto rojo" /> Conexión lenta
      </span>
    )
  }
  if (sonando) return <SyncBadge driftMs={d.driftMs} />
  return (
    <span className="dispositivo-estado texto-verde">
      <span className="punto verde" /> Listo
    </span>
  )
}

/** Copia un informe de texto (compu, cancion, WiFi y cortes de cada celular) para mandarlo por chat. */
function BotonDiagnostico({ controller }: { controller: AppController }) {
  const [estado, setEstado] = useState<'listo' | 'copiado' | 'error'>('listo')
  async function copiar(): Promise<void> {
    try {
      const datos = await controller.diagnosticoServidor()
      setEstado(datos && copiarTexto(informeTexto(datos)) ? 'copiado' : 'error')
    } catch {
      setEstado('error')
    }
    setTimeout(() => setEstado('listo'), 2500)
  }
  return (
    <button onClick={() => void copiar()} title="Copia un informe para mandarlo por chat (WiFi, cortes y desfase de cada celular)">
      {estado === 'copiado' ? <Check size={16} /> : <ClipboardCopy size={16} />}
      {estado === 'copiado' ? 'Copiado' : estado === 'error' ? 'No se pudo copiar' : 'Copiar diagnóstico'}
    </button>
  )
}

function codigoAlAzar(): string {
  const n = new Uint32Array(1)
  crypto.getRandomValues(n)
  return String(1000 + (n[0] % 9000))
}

export function ConnectionPanel({ controller, sonando, onCerrar }: { controller: AppController; sonando: boolean; onCerrar: () => void }) {
  const { dispositivos } = controller
  const [datos, setDatos] = useState<DatosInvitacion | null>(null)
  const [ajustes, setAjustes] = useState<AjustesConexion | null>(null)
  const pedirDatos = controller.datosInvitacion
  const pedirAjustes = controller.ajustesConexion

  const refrescar = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([pedirDatos(), pedirAjustes()])
      setDatos(d)
      setAjustes(a)
    } catch {
      // sin conexion con el servidor local: se reintenta al reabrir
    }
  }, [pedirDatos, pedirAjustes])

  useEffect(() => {
    void refrescar()
  }, [refrescar])

  const enlace = datos ? enlaceConCodigo(datos.url, datos.codigo) : null
  const qr = useQr(enlace)
  const otras = ajustes && datos ? ajustes.direcciones.map((ip) => `http://${ip}:${ajustes.puerto}`).filter((u) => u !== datos.url) : []
  const sinRed = ajustes !== null && ajustes.direcciones.length === 0

  const celulares = dispositivos.filter((d) => d.origen === 'celular')
  const conectados = celulares.filter((d) => d.conectado).length
  const desconectados = celulares.filter((d) => !d.conectado).length

  return (
    <Modal
      titulo="Conectar celulares"
      icono={<Wifi size={20} color="var(--accent)" />}
      tamano="ancho"
      onCerrar={onCerrar}
      pie={
        <>
          <span className="ayuda" style={{ marginRight: 'auto', alignSelf: 'center' }}>
            Hoja con los QR del WiFi y de la app, para pegar en el ensayo.
          </span>
          <BotonDiagnostico controller={controller} />
          <button onClick={() => window.print()} disabled={!datos}>
            <Printer size={16} /> Imprimir hoja para la banda
          </button>
        </>
      }
    >
      <div className="conexion">
        <div>
          {qr ? <img className="qr" src={qr} alt="Código QR para conectar un celular" data-enlace={enlace ?? ''} /> : <div className="qr" />}
          {datos && (
            <div className="conexion-url">
              o escribí en el navegador:
              <code>{direccionVisible(datos.urlCorta ?? datos.url)}</code>
              <span className="conexion-fija">
                iPhone, siempre la misma: <b>{direccionVisible(datos.urlFija)}</b>
              </span>
            </div>
          )}
        </div>
        <div>
          <p className="ayuda" style={{ marginTop: 0 }}>
            1. Conectá el celular a la <b>misma red WiFi</b> que esta computadora.
            <br />
            2. Escaneá el código con la cámara y abrí el link.
            <br />
            3. En el celular, tocá <b>“Tocá para empezar”</b> y conectá los auriculares.
            <br />
            Los que ya están conectados pueden sumar a otros desde <b>“Invitar”</b> en su celular.
            {datos?.apk && (
              <>
                <br />
                Android: con la app (se baja desde “Invitar”) encuentra la compu sola en cada ensayo, sin QR.
              </>
            )}
          </p>
          {sinRed && <p className="error-texto">No se detectó una red WiFi. Conectá la computadora a la red de los celulares.</p>}
          {otras.length > 0 && (
            <p className="ayuda conexion-otras">
              ¿No conecta? Probá con: {otras.map((u) => <code key={u}>{direccionVisible(u)}</code>)}
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 8px' }}>
            <strong>
              <span className="num">{conectados}</span> {conectados === 1 ? 'celular conectado' : 'celulares conectados'}
            </strong>
            {desconectados > 0 && (
              <button className="btn-chico btn-fantasma" onClick={() => controller.forgetDevice('*')}>
                Limpiar desconectados
              </button>
            )}
          </div>
          <ul className="lista">
            {dispositivos.length === 0 && <li className="vacio">Nadie conectado todavía.</li>}
            {dispositivos.map((d) => (
              <li key={d.id} className="lista-fila">
                {d.origen === 'compu' ? <Laptop size={18} color="var(--text-3)" /> : <Smartphone size={18} color="var(--text-3)" />}
                <div className="lista-principal">
                  <span className="lista-titulo">{d.etiqueta}</span>
                  {d.error && d.conectado && <span className="lista-meta texto-rojo">{d.error}</span>}
                  {d.diag && d.conectado && d.origen === 'celular' && (
                    <span className={`lista-meta diag-${nivelDiagnostico(d.diag)}`} title={d.diag.plataforma}>
                      {resumenCorto(d.diag)}
                    </span>
                  )}
                </div>
                <EstadoDispositivo d={d} sonando={sonando} />
                {!d.conectado && (
                  <button
                    className="btn-fantasma btn-icono"
                    title="Quitar de la lista"
                    onClick={() => controller.forgetDevice(d.id)}
                    aria-label={`Quitar ${d.etiqueta}`}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {ajustes && (
        <div className="conexion-ajustes">
          <CodigoBanda controller={controller} ajustes={ajustes} onCambio={() => void refrescar()} />
          <WifiInvitacion controller={controller} ajustes={ajustes} onCambio={() => void refrescar()} />
        </div>
      )}

      {datos && createPortal(<HojaImpresa datos={datos} />, document.body)}
    </Modal>
  )
}

function CodigoBanda({ controller, ajustes, onCambio }: { controller: AppController; ajustes: AjustesConexion; onCambio: () => void }) {
  const [editando, setEditando] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actual = ajustes.codigoBanda

  async function guardar(codigo: string | null): Promise<void> {
    const r = await controller.setCodigoBanda(codigo)
    if (!r.ok) return setError(r.error ?? 'No se pudo guardar')
    setError(null)
    setEditando(null)
    onCambio()
  }

  return (
    <section className="conexion-tarjeta">
      <h3>
        <KeyRound size={16} /> Código de la banda
      </h3>
      {editando !== null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void guardar(editando)
          }}
        >
          <div className="hoja-fila">
            <input
              className="codigo-chico num"
              inputMode="numeric"
              maxLength={8}
              value={editando}
              autoFocus
              aria-label="Código de la banda (4 a 8 números)"
              onChange={(e) => setEditando(e.target.value.replace(/\D/g, '').slice(0, 8))}
            />
            <button type="submit" className="btn-primario" disabled={editando.length < 4}>
              Guardar
            </button>
            <button type="button" className="btn-fantasma" onClick={() => setEditando(null)}>
              Cancelar
            </button>
          </div>
          <p className="ayuda" style={{ marginBottom: 0 }}>
            De 4 a 8 números. Los celulares lo ponen una sola vez (queda guardado).
          </p>
        </form>
      ) : actual ? (
        <>
          <div className="conexion-codigo num">{actual}</div>
          <p className="ayuda">
            Los celulares nuevos lo tienen que poner una vez. Los que ya están conectados siguen sin cortes. Va incluido en el QR.
          </p>
          <div className="hoja-fila">
            <button onClick={() => setEditando(actual)}>Cambiar</button>
            <button className="btn-fantasma" onClick={() => void guardar(null)}>
              Quitar el código
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="ayuda" style={{ marginTop: 0 }}>
            Ahora cualquiera conectado al WiFi puede entrar. Con un código, solo entra la banda.
          </p>
          <button onClick={() => setEditando(codigoAlAzar())}>Pedir un código</button>
        </>
      )}
      {error && <p className="error-texto">{error}</p>}
    </section>
  )
}

function WifiInvitacion({ controller, ajustes, onCambio }: { controller: AppController; ajustes: AjustesConexion; onCambio: () => void }) {
  const [ssid, setSsid] = useState(ajustes.wifi?.ssid ?? '')
  const [clave, setClave] = useState(ajustes.wifi?.clave ?? '')
  const cambiado = ssid.trim() !== (ajustes.wifi?.ssid ?? '') || clave !== (ajustes.wifi?.clave ?? '')

  async function guardar(wifi: { ssid: string; clave: string } | null): Promise<void> {
    const r = await controller.setWifiInvitacion(wifi)
    if (r.ok) {
      if (!wifi) {
        setSsid('')
        setClave('')
      }
      onCambio()
    }
  }

  return (
    <section className="conexion-tarjeta">
      <h3>
        <Wifi size={16} /> WiFi para invitar
      </h3>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Opcional: aparece como QR en “Invitar” y en la hoja impresa, así el que llega se conecta sin preguntar la clave.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void guardar(ssid.trim() ? { ssid: ssid.trim(), clave } : null)
        }}
      >
        <div className="conexion-wifi">
          <input placeholder="Nombre de la red" value={ssid} maxLength={64} onChange={(e) => setSsid(e.target.value)} aria-label="Nombre de la red WiFi" />
          <input placeholder="Clave (vacía si no tiene)" value={clave} maxLength={64} onChange={(e) => setClave(e.target.value)} aria-label="Clave del WiFi" />
        </div>
        <div className="hoja-fila">
          <button type="submit" className="btn-primario" disabled={!cambiado}>
            Guardar
          </button>
          {ajustes.wifi && (
            <button type="button" className="btn-fantasma" onClick={() => void guardar(null)}>
              Quitar
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

/** Hoja para imprimir (solo se ve al imprimir): QR del WiFi, QR de la app, codigo y pasos. */
function HojaImpresa({ datos }: { datos: DatosInvitacion }) {
  const qrWifi = useQr(datos.wifi ? textoQrWifi(datos.wifi) : null, 700)
  const qrApp = useQr(enlaceConCodigo(datos.url, datos.codigo), 700)
  let n = 0
  return (
    <div className="hoja-impresa" aria-hidden>
      <h1>Multitrack Alabanza</h1>
      <p className="impresa-sub">La pista de la banda en tu celular, con tu propia mezcla</p>
      <div className="impresa-qrs">
        {datos.wifi && (
          <section>
            <h2>{++n} · Conectate al WiFi</h2>
            {qrWifi && <img src={qrWifi} alt="" />}
            <p>
              Red: <b>{datos.wifi.ssid}</b>
              {datos.wifi.clave && (
                <>
                  <br />
                  Clave: <b>{datos.wifi.clave}</b>
                </>
              )}
            </p>
          </section>
        )}
        <section>
          <h2>{++n} · Abrí la app</h2>
          {qrApp && <img src={qrApp} alt="" />}
          <p>
            Con la cámara, o escribí <b>{direccionVisible(datos.urlCorta ?? datos.url)}</b>
            {datos.codigo && (
              <>
                <br />
                Código de la banda: <b className="impresa-codigo">{datos.codigo}</b>
              </>
            )}
          </p>
        </section>
      </div>
      <h2>{++n} · Tocá “Tocá para empezar” y poné los auriculares</h2>
      <ul>
        <li>
          <b>iPhone:</b> abrí <b>{direccionVisible(datos.urlFija)}</b> y agregala a la pantalla de inicio (Compartir → Agregar a inicio): sirve para
          siempre.
        </li>
        {datos.apk && (
          <li>
            <b>Android:</b> bajá la app desde “Invitar” o en <b>{direccionVisible(datos.url)}/app/alabanza.apk</b>: en cada ensayo encuentra la compu
            sola.
          </li>
        )}
        <li>Si la computadora cambia de red, imprimí esta hoja de nuevo.</li>
      </ul>
    </div>
  )
}
