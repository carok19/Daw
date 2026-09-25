import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Laptop, Smartphone, Trash2, Wifi } from 'lucide-react'
import type { DispositivoInfo } from '@shared/types'
import { Modal } from '../ui/Modal'
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

export function ConnectionPanel({
  dispositivos,
  sonando,
  onOlvidar,
  onCerrar
}: {
  dispositivos: DispositivoInfo[]
  sonando: boolean
  onOlvidar: (id: string) => void
  onCerrar: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [sinRed, setSinRed] = useState(false)

  useEffect(() => {
    let cancelado = false
    ;(async () => {
      if (!window.electronAPI) return
      const info = await window.electronAPI.getConnectionInfo()
      if (cancelado) return
      setSinRed(!info.ip)
      setUrl(info.url)
      const dataUrl = await QRCode.toDataURL(info.url, { width: 440, margin: 1 })
      if (!cancelado) setQr(dataUrl)
    })()
    return () => {
      cancelado = true
    }
  }, [])

  const celulares = dispositivos.filter((d) => d.origen === 'celular')
  const conectados = celulares.filter((d) => d.conectado).length
  const desconectados = celulares.filter((d) => !d.conectado).length

  return (
    <Modal titulo="Conectar celulares" icono={<Wifi size={20} color="var(--accent)" />} tamano="ancho" onCerrar={onCerrar}>
      <div className="conexion">
        <div>
          {qr ? <img className="qr" src={qr} alt="Código QR para conectar un celular" /> : <div className="qr" />}
          {url && (
            <p className="conexion-url">
              o escribí en el navegador:
              <code>{url}</code>
            </p>
          )}
        </div>
        <div>
          <p className="ayuda" style={{ marginTop: 0 }}>
            1. Conectá el celular a la <b>misma red WiFi</b> que esta computadora.
            <br />
            2. Escaneá el código con la cámara y abrí el link.
            <br />
            3. En el celular, tocá <b>“Tocá para empezar”</b> y conectá los auriculares.
          </p>
          {sinRed && <p className="error-texto">No se detectó una red WiFi. Conectá la computadora a la red de los celulares.</p>}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 8px' }}>
            <strong>
              <span className="num">{conectados}</span> {conectados === 1 ? 'celular conectado' : 'celulares conectados'}
            </strong>
            {desconectados > 0 && (
              <button className="btn-chico btn-fantasma" onClick={() => onOlvidar('*')}>
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
                </div>
                <EstadoDispositivo d={d} sonando={sonando} />
                {!d.conectado && (
                  <button className="btn-fantasma btn-icono" title="Quitar de la lista" onClick={() => onOlvidar(d.id)} aria-label={`Quitar ${d.etiqueta}`}>
                    <Trash2 size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
