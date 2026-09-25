import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** Imagen (data URL) del QR de un texto; null mientras se genera o si no hay texto. */
export function useQr(texto: string | null, ancho = 440): string | null {
  const [imagen, setImagen] = useState<string | null>(null)
  useEffect(() => {
    let cancelado = false
    setImagen(null)
    if (!texto) return
    QRCode.toDataURL(texto, { width: ancho, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelado) setImagen(url)
      })
      .catch(() => undefined)
    return () => {
      cancelado = true
    }
  }, [texto, ancho])
  return imagen
}
