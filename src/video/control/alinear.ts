import { alineacionSegura, SR_HUELLA, type Alineacion } from '../../shared/huella'
import type { ApiVideo, VideoGuardado } from '../tipos'
import type { PedidoCalculo, RespuestaCalculo } from './calculo.worker'

/**
 * Alinea cada video con su cancion, de a uno y en segundo plano:
 * 1. la huella del video (su audio, decodificado una vez por la compu del data);
 * 2. la de la cancion (la calcula la compu de AirTracks con la musica parada);
 * 3. donde coinciden: el desfase. Si no es claro, queda para ajustar a mano.
 */

let worker: Worker | null = null
let siguiente = 1
const esperas = new Map<number, (r: RespuestaCalculo) => void>()

type SinId<T> = T extends unknown ? Omit<T, 'id'> : never

function calcular(pedido: SinId<PedidoCalculo>, transferir: Transferable[] = []): Promise<RespuestaCalculo> {
  if (!worker) {
    worker = new Worker('calculo.js')
    worker.onmessage = (e: MessageEvent<RespuestaCalculo>) => {
      esperas.get(e.data.id)?.(e.data)
      esperas.delete(e.data.id)
    }
  }
  const id = siguiente++
  return new Promise((resolve) => {
    esperas.set(id, resolve)
    worker!.postMessage({ ...pedido, id }, transferir)
  })
}

/** Duracion del video (de sus datos, sin reproducirlo). */
function duracionDe(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => {
      resolve(Number.isFinite(v.duration) ? v.duration : 0)
      v.removeAttribute('src')
      v.load()
    }
    v.onerror = () => resolve(0)
    v.src = url
  })
}

/** Audio del video en mono a la frecuencia de la huella. */
async function audioDelVideo(url: string): Promise<Float32Array> {
  const datos = await (await fetch(url)).arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, SR_HUELLA)
  let audio: AudioBuffer
  try {
    audio = await ctx.decodeAudioData(datos)
  } catch {
    throw new Error('No se pudo leer el sonido del video (¿no tiene sonido?): ajustá el inicio a mano')
  }
  const mono = new Float32Array(audio.length)
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c)
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels
  }
  return mono
}

export type ResultadoAlineacion =
  | { estado: 'listo' | 'revisar'; desfaseMs: number; alineacion: Alineacion & { segura: boolean; manual: boolean }; duracionSeg: number }
  | { estado: 'esperando-musica' | 'sin-conexion'; duracionSeg: number }
  | { estado: 'error'; mensaje: string; duracionSeg: number }

export async function alinearVideo(api: ApiVideo, v: VideoGuardado): Promise<ResultadoAlineacion> {
  const url = api.urlDeVideo(v.archivo)
  const duracionSeg = v.duracionSeg || (await duracionDe(url))
  try {
    let huellaVideo = await api.leerHuellaVideo(v.proyectoId)
    if (!huellaVideo) {
      const pcm = await audioDelVideo(url)
      const r = await calcular({ tipo: 'huella', pcm }, [pcm.buffer])
      if (!r.huella) throw new Error(r.error ?? 'No se pudo calcular la huella del video')
      huellaVideo = r.huella
      await api.guardarHuellaVideo(v.proyectoId, huellaVideo)
    }
    const cancion = await api.huellaCancion(v.proyectoId)
    if (cancion.estado === 'esperando') return { estado: 'esperando-musica', duracionSeg }
    if (cancion.estado === 'sin-conexion') return { estado: 'sin-conexion', duracionSeg }
    if (cancion.estado === 'error') return { estado: 'error', mensaje: cancion.mensaje, duracionSeg }
    const r = await calcular({ tipo: 'alinear', cancion: cancion.huella, video: huellaVideo })
    if (!r.alineacion) return { estado: 'error', mensaje: r.error ?? 'El video o la canción son demasiado cortos para alinear', duracionSeg }
    const segura = alineacionSegura(r.alineacion)
    return { estado: segura ? 'listo' : 'revisar', desfaseMs: r.alineacion.desfaseMs, alineacion: { ...r.alineacion, segura, manual: false }, duracionSeg }
  } catch (err) {
    return { estado: 'error', mensaje: String((err as Error).message ?? err), duracionSeg }
  }
}
