/// <reference lib="webworker" />
import { alinear, calcularHuella, huellaABytes, huellaDeBytes, type Alineacion } from '../../shared/huella'

/**
 * Las cuentas pesadas de la alineacion (filtrar el audio, la correlacion) en
 * un hilo aparte: la ventana no se traba, ni Holyrics en una compu vieja.
 */
export type PedidoCalculo = { id: number; tipo: 'huella'; pcm: Float32Array } | { id: number; tipo: 'alinear'; cancion: Uint8Array; video: Uint8Array }
export type RespuestaCalculo = { id: number; huella?: Uint8Array; alineacion?: Alineacion | null; error?: string }

self.onmessage = (e: MessageEvent<PedidoCalculo>) => {
  const m = e.data
  try {
    if (m.tipo === 'huella') {
      const huella = huellaABytes(calcularHuella(m.pcm))
      ;(self as unknown as Worker).postMessage({ id: m.id, huella } satisfies RespuestaCalculo, [huella.buffer])
    } else {
      const alineacion = alinear(huellaDeBytes(m.cancion), huellaDeBytes(m.video))
      ;(self as unknown as Worker).postMessage({ id: m.id, alineacion } satisfies RespuestaCalculo)
    }
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id: m.id, error: String((err as Error)?.message ?? err) } satisfies RespuestaCalculo)
  }
}
