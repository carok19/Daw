// Parseo minimo de encabezado WAV (chunks RIFF/fmt/data) y conversion de PCM
// crudo a Float32 por canal. Existe para que el receptor pueda pedir, por HTTP
// Range, EXACTAMENTE los bytes de un segmento (sin descargar el archivo
// entero) y decodificarlos el mismo sin pasar por `decodeAudioData` (que no
// es incremental — ver README "Streaming progresivo"). Solo WAV: es el unico
// formato sin estado entre frames, seguro de cortar en cualquier punto.

export interface WavInfo {
  audioFormat: number
  numChannels: number
  sampleRate: number
  bitsPerSample: number
  /** offset (bytes, dentro del archivo) donde empiezan los samples crudos. */
  dataOffset: number
  /** tamano (bytes) del chunk "data" segun su propio encabezado. */
  dataLength: number
}

const FORMATO_PCM_ENTERO = 1
const FORMATO_PCM_FLOAT = 3
const FORMATO_EXTENSIBLE = 0xfffe

/** Cuantos bytes hay que pedir de encabezado para encontrar el chunk "data" con margen de sobra. */
export const WAV_HEADER_FETCH_BYTES = 65536

export class WavHeaderError extends Error {}

/**
 * Recorre los chunks RIFF de un WAV (a partir de sus primeros
 * `WAV_HEADER_FETCH_BYTES`) hasta encontrar "fmt " y "data". Lanza
 * `WavHeaderError` si el archivo no es un WAV valido o el chunk "data" no
 * aparece dentro de los bytes provistos (encabezados anormalmente grandes:
 * no deberia pasar con exports normales de un DAW).
 */
export function parseWavHeader(bytes: ArrayBuffer): WavInfo {
  const view = new DataView(bytes)
  if (bytes.byteLength < 12 || leerAscii(view, 0, 4) !== 'RIFF' || leerAscii(view, 8, 4) !== 'WAVE') {
    throw new WavHeaderError('No es un archivo WAV valido')
  }

  let offset = 12
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null = null

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = leerAscii(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataStart = offset + 8

    if (chunkId === 'fmt ') {
      let audioFormat = view.getUint16(chunkDataStart, true)
      const numChannels = view.getUint16(chunkDataStart + 2, true)
      const sampleRate = view.getUint32(chunkDataStart + 4, true)
      const bitsPerSample = view.getUint16(chunkDataStart + 14, true)
      if (audioFormat === FORMATO_EXTENSIBLE && chunkSize >= 24 && chunkDataStart + 26 <= bytes.byteLength) {
        // WAVE_FORMAT_EXTENSIBLE: el formato real esta en los primeros 2 bytes del GUID de sub-formato.
        audioFormat = view.getUint16(chunkDataStart + 24, true)
      }
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample }
    } else if (chunkId === 'data') {
      if (!fmt) throw new WavHeaderError('Chunk "data" antes que "fmt " en el WAV')
      return { ...fmt, dataOffset: chunkDataStart, dataLength: chunkSize }
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2) // los chunks se alinean a 2 bytes
  }

  throw new WavHeaderError('No se encontro el chunk "data" (encabezado WAV demasiado grande o truncado)')
}

/** bytes por frame (todas las pistas), para calcular rangos de bytes exactos por indice de sample. */
export function bytesPorFrame(info: WavInfo): number {
  return info.numChannels * (info.bitsPerSample / 8)
}

/** Cantidad total de frames (samples por canal) que tiene el "data" chunk. */
export function totalFrames(info: WavInfo): number {
  return Math.floor(info.dataLength / bytesPorFrame(info))
}

/**
 * Convierte bytes PCM crudos (recibidos via Range, alineados a frame) a
 * Float32Array por canal. Soporta PCM entero de 16/24/32 bits y float32 —
 * los formatos que exportan los DAWs habituales.
 */
export function decodePcmSegment(info: WavInfo, bytes: ArrayBuffer): Float32Array<ArrayBuffer>[] {
  const bpf = bytesPorFrame(info)
  const frames = Math.floor(bytes.byteLength / bpf)
  const canales: Float32Array<ArrayBuffer>[] = Array.from({ length: info.numChannels }, () => new Float32Array(frames))
  const view = new DataView(bytes)
  const bytesPorSample = info.bitsPerSample / 8

  for (let frame = 0; frame < frames; frame++) {
    const base = frame * bpf
    for (let ch = 0; ch < info.numChannels; ch++) {
      const pos = base + ch * bytesPorSample
      canales[ch][frame] = leerSample(view, pos, info)
    }
  }
  return canales
}

function leerSample(view: DataView, pos: number, info: WavInfo): number {
  if (info.audioFormat === FORMATO_PCM_FLOAT && info.bitsPerSample === 32) {
    return view.getFloat32(pos, true)
  }
  switch (info.bitsPerSample) {
    case 16:
      return view.getInt16(pos, true) / 32768
    case 24: {
      // no hay getInt24: se arma a mano desde 3 bytes little-endian con signo
      const b0 = view.getUint8(pos)
      const b1 = view.getUint8(pos + 1)
      const b2 = view.getUint8(pos + 2)
      let valor = b0 | (b1 << 8) | (b2 << 16)
      if (valor & 0x800000) valor |= ~0xffffff // extension de signo a 32 bits
      return valor / 8388608
    }
    case 32:
      return view.getInt32(pos, true) / 2147483648
    default:
      throw new WavHeaderError(`bitsPerSample no soportado: ${info.bitsPerSample}`)
  }
}

function leerAscii(view: DataView, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}
