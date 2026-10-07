/**
 * "Consola en vivo": lo que sale de la consola (instrumentos, voces y el
 * microfono del talkback, todo en una mezcla) de la compu a los oidos de la
 * banda, por un WebSocket propio, aparte de las ordenes: cada pedazo viaja
 * en una sola trama (por socket.io irian dos: el aviso y los datos) y no
 * espera detras de otros mensajes.
 *
 * Trama: [canal u8][3 libres][n u32][t f64][frecuencia u32] + muestras Int16
 * (todo little endian; la cabecera tiene 20 bytes, asi las muestras quedan
 * alineadas).
 */

/** donde se conecta cada celular: ws://compu:puerto/audio-vivo?llave=… */
export const RUTA_AUDIO_VIVO = '/audio-vivo'
export const CABECERA_AUDIO_VIVO = 20

/** que se escucha (por ahora un solo canal: la consola; la trama ya dice cual, por si hay otros) */
export type CanalVivo = 'consola'
const CODIGOS: Record<CanalVivo, number> = { consola: 2 }
/** el nombre de su fader en "Mi mezcla" (y la clave de su ajuste personal) */
export const FADER_VIVO = 'Consola en vivo'

/** Un pedazo de audio en vivo. */
export interface PedazoVivo {
  canal: CanalVivo
  /** numero de pedazo (seguidos: se pegan sin hueco) */
  n: number
  /** hora del servidor en que se capto la primera muestra */
  t: number
  /** muestras por segundo (la de la compu: 48000 o 44100) */
  sr: number
  /** muestras Int16, una sola via */
  pcm: ArrayBuffer
}

/** Arma la trama (en la compu llega el pedazo por socket.io; a cada celular va asi). */
export function armarTrama(canal: CanalVivo, n: number, t: number, sr: number, pcm: Uint8Array): Uint8Array {
  const trama = new Uint8Array(CABECERA_AUDIO_VIVO + pcm.byteLength)
  const v = new DataView(trama.buffer)
  v.setUint8(0, CODIGOS[canal])
  v.setUint32(4, n >>> 0, true)
  v.setFloat64(8, t, true)
  v.setUint32(16, sr >>> 0, true)
  trama.set(pcm, CABECERA_AUDIO_VIVO)
  return trama
}

/** Lee una trama; null si no es una trama valida. */
export function leerTrama(datos: ArrayBuffer): PedazoVivo | null {
  if (datos.byteLength < CABECERA_AUDIO_VIVO + 2 || (datos.byteLength - CABECERA_AUDIO_VIVO) % 2 !== 0) return null
  const v = new DataView(datos)
  const codigo = v.getUint8(0)
  const canal = codigo === CODIGOS.consola ? 'consola' : null
  const sr = v.getUint32(16, true)
  const t = v.getFloat64(8, true)
  if (!canal || sr < 8000 || sr > 96000 || !Number.isFinite(t)) return null
  return { canal, n: v.getUint32(4, true), t, sr, pcm: datos.slice(CABECERA_AUDIO_VIVO) }
}
