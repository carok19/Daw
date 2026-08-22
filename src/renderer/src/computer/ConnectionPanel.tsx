import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function ConnectionPanel({ onCerrar }: { onCerrar: () => void }) {
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

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>Conectar celulares</h2>
        <p>Escaneá este código con la cámara del celular, conectado a la misma red WiFi.</p>
        {error && <p className="aviso">{error}</p>}
        {qrDataUrl && <img className="qr" src={qrDataUrl} alt="Código QR de conexión" />}
        {url && (
          <p className="conexion-url">
            o entrá manualmente a: <code>{url}</code>
          </p>
        )}
        <button onClick={onCerrar}>Cerrar</button>
      </div>
    </div>
  )
}
