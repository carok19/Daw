import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { DispositivoInfo } from '@shared/types'
import { SyncBadge } from './SyncBadge'

export function ConnectionPanel({
  dispositivos,
  onCerrar
}: {
  dispositivos: DispositivoInfo[]
  onCerrar: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelado = false
    ;(async () => {
      if (!window.electronAPI) return
      const info = await window.electronAPI.getConnectionInfo()
      if (cancelado) return
      if (!info.ip) {
        setError('No se detectó una red WiFi local. Conectá la computadora a la misma red que los celulares.')
      }
      setUrl(info.url)
      const dataUrl = await QRCode.toDataURL(info.url, { width: 260, margin: 1 })
      if (!cancelado) setQrDataUrl(dataUrl)
    })()
    return () => {
      cancelado = true
    }
  }, [])

  const celularesConectados = dispositivos.filter((d) => d.origen === 'celular' && d.conectado).length

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="panel panel-conexion" onClick={(e) => e.stopPropagation()}>
        <h2>Conectar celulares</h2>
        <p>Escaneá este código con la cámara del celular, conectado a la misma red WiFi.</p>
        {error && <p className="aviso">{error}</p>}
        {qrDataUrl && <img className="qr" src={qrDataUrl} alt="Código QR de conexión" />}
        {url && (
          <p className="conexion-url">
            o entrá manualmente a: <code>{url}</code>
          </p>
        )}
        <p className="conexion-contador">
          🟢 {celularesConectados} {celularesConectados === 1 ? 'celular conectado' : 'celulares conectados'}
        </p>

        <h3 className="dispositivos-titulo">Dispositivos</h3>
        <ul className="lista-dispositivos">
          {dispositivos.length === 0 && <li className="markers-vacio">Nadie conectado todavía.</li>}
          {dispositivos.map((d) => (
            <li key={d.id} className="dispositivo-row">
              <span className={`dispositivo-punto ${d.conectado ? 'conectado' : 'desconectado'}`}>
                {d.conectado ? '🟢' : '🔴'}
              </span>
              <span className="dispositivo-etiqueta">
                {d.etiqueta}
                {!d.conectado && ' — Desconectado'}
              </span>
              {d.conectado && d.origen === 'celular' && <SyncBadge driftMs={d.driftMs} />}
            </li>
          ))}
        </ul>

        <button onClick={onCerrar}>Cerrar</button>
      </div>
    </div>
  )
}
