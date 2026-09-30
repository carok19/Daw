import fs from 'node:fs'
import { coeficientesPaneo, type CanalMezcla } from '../shared/mezcla'
import { bytesPorFrame, decodePcmSegment, type WavInfo } from '../shared/wav'

/**
 * La cuenta de la mezcla de un segmento (ver mezclador.ts). Separada para
 * poder hacerla en hilos de trabajo (mezclaWorker.ts): con muchos celulares,
 * la compu mezcla en varios nucleos a la vez y el servidor nunca se traba.
 */

export interface InfoPista {
  ruta: string
  info: WavInfo
  frames: number
}

/** Todo lo necesario para mezclar un segmento (se manda tal cual a un hilo de trabajo). */
export interface TrabajoMezcla {
  /** solo las pistas que suenan, por id */
  pistas: Record<string, InfoPista>
  canales: CanalMezcla[]
  sr: number
  /** primer frame (a la frecuencia `sr`) y cuantos */
  desde: number
  cantidad: number
  /** la voz que avisa un salto (ver voces.ts), si cae en este segmento */
  anuncio?: AnuncioEnMezcla
}

/** La voz que avisa un salto dentro de la mezcla: suena en [desde, hasta) y mientras tanto la guia se calla. */
export interface AnuncioEnMezcla {
  /** frames (a la frecuencia `sr`) de la cancion */
  desde: number
  hasta: number
  /** la voz, mono, desde `desde` */
  muestras: Float32Array
  /** la guia de la cancion (se calla) */
  guiaPistaId: string | null
  /** volumen y paneo de la voz (los de la guia en esta mezcla); null = no suena (la guia esta muteada aca) */
  canal: CanalMezcla | null
}

/** Fundido de la guia al callarse y al volver (seg). */
const FUNDIDO_GUIA_SEC = 0.01

/** Mezcla el segmento y lo devuelve como WAV estereo de 16 bits. `ceder`: entre pista y pista (en el hilo principal). */
export async function calcularMezcla(t: TrabajoMezcla, ceder?: () => Promise<void>): Promise<Buffer> {
  const L = new Float32Array(t.cantidad)
  const R = new Float32Array(t.cantidad)
  const a = t.anuncio && t.anuncio.hasta > t.desde && t.anuncio.desde < t.desde + t.cantidad ? t.anuncio : null
  for (const canal of t.canales) {
    const pista = t.pistas[canal.pistaId]
    if (!pista || canal.ganancia <= 0) continue
    if (a && canal.pistaId === a.guiaPistaId) await sumarGuiaCallada(pista, canal, t, a, L, R)
    else await sumarPista(pista, canal, t.sr, t.desde, t.cantidad, L, R)
    if (ceder) await ceder()
  }
  if (a?.canal) sumarAnuncio(a, a.canal, t, L, R)
  return aWav16(L, R, t.sr)
}

/** La guia, callada mientras suena la voz del salto (con fundidos cortos al callarse y al volver). */
async function sumarGuiaCallada(pista: InfoPista, canal: CanalMezcla, t: TrabajoMezcla, a: AnuncioEnMezcla, L: Float32Array, R: Float32Array): Promise<void> {
  const gL = new Float32Array(t.cantidad)
  const gR = new Float32Array(t.cantidad)
  await sumarPista(pista, canal, t.sr, t.desde, t.cantidad, gL, gR)
  const f = Math.max(1, Math.round(FUNDIDO_GUIA_SEC * t.sr))
  for (let i = 0; i < t.cantidad; i++) {
    const x = t.desde + i
    const g = x < a.desde - f || x >= a.hasta + f ? 1 : x < a.desde ? (a.desde - x) / f : x >= a.hasta ? (x - a.hasta) / f : 0
    L[i] += gL[i] * g
    R[i] += gR[i] * g
  }
}

function sumarAnuncio(a: AnuncioEnMezcla, canal: CanalMezcla, t: TrabajoMezcla, L: Float32Array, R: Float32Array): void {
  const { aLL, aRR } = coeficientesPaneo(canal.pan, 1)
  const gl = canal.ganancia * aLL
  const gr = canal.ganancia * aRR
  const ini = Math.max(t.desde, a.desde)
  const fin = Math.min(t.desde + t.cantidad, a.hasta, a.desde + a.muestras.length)
  for (let x = ini; x < fin; x++) {
    const v = a.muestras[x - a.desde]
    L[x - t.desde] += v * gl
    R[x - t.desde] += v * gr
  }
}

/** Lee `frames` frames desde `desdeFrame` (lo que exista: al final de la pista, menos). */
async function leerFrames(pista: InfoPista, desdeFrame: number, frames: number): Promise<Buffer> {
  const bpf = bytesPorFrame(pista.info)
  const hasta = Math.min(pista.frames, desdeFrame + frames)
  if (hasta <= desdeFrame) return Buffer.alloc(0)
  const largo = (hasta - desdeFrame) * bpf
  // memoria propia (offset 0): se puede ver como Int16Array sin copiar
  const buf = Buffer.from(new ArrayBuffer(largo))
  const fh = await fs.promises.open(pista.ruta, 'r')
  try {
    let leidos = 0
    while (leidos < largo) {
      const { bytesRead } = await fh.read(buf, leidos, largo - leidos, pista.info.dataOffset + desdeFrame * bpf + leidos)
      if (bytesRead <= 0) break
      leidos += bytesRead
    }
    return leidos === largo ? buf : buf.subarray(0, leidos - (leidos % bpf))
  } finally {
    await fh.close()
  }
}

/** Canales de la pista como Float32 (-1..1). Camino rapido para PCM 16 bits (el formato de las canciones importadas). */
function aFloat(pista: InfoPista, bytes: Buffer): Float32Array[] {
  const ch = pista.info.numChannels
  const frames = Math.floor(bytes.length / bytesPorFrame(pista.info))
  if (pista.info.audioFormat === 1 && pista.info.bitsPerSample === 16 && bytes.byteOffset % 2 === 0) {
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, frames * ch)
    const res = Array.from({ length: ch }, () => new Float32Array(frames))
    for (let c = 0; c < ch; c++) {
      const out = res[c]
      for (let i = 0, j = c; i < frames; i++, j += ch) out[i] = s[j] / 32768
    }
    return res
  }
  const copia = new Uint8Array(frames * bytesPorFrame(pista.info))
  copia.set(bytes.subarray(0, copia.length))
  return decodePcmSegment(pista.info, copia.buffer)
}

export async function sumarPista(pista: InfoPista, canal: CanalMezcla, sr: number, desde: number, cantidad: number, L: Float32Array, R: Float32Array): Promise<void> {
  const ch = Math.min(2, pista.info.numChannels)
  const { aLL, aLR, aRL, aRR } = coeficientesPaneo(canal.pan, ch)
  const g = canal.ganancia
  const srPista = pista.info.sampleRate

  // camino rapido (las canciones importadas: PCM 16 bits): se suma directo desde los enteros, sin copias
  if (srPista === sr && pista.info.audioFormat === 1 && pista.info.bitsPerSample === 16 && pista.info.numChannels <= 2) {
    const bytes = await leerFrames(pista, desde, cantidad)
    const n = Math.min(cantidad, Math.floor(bytes.length / (2 * ch)))
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, n * ch)
    const k = g / 32768
    if (ch === 1) {
      const gl = k * aLL
      const gr = k * aRR
      for (let i = 0; i < n; i++) {
        const x = s[i]
        L[i] += x * gl
        R[i] += x * gr
      }
    } else {
      const a = k * aLL
      const b = k * aLR
      const c = k * aRL
      const d = k * aRR
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const l = s[j]
        const r = s[j + 1]
        L[i] += a * l + b * r
        R[i] += c * l + d * r
      }
    }
    return
  }

  // otros formatos u otra frecuencia de muestreo (raro): a float e interpolacion lineal
  const factor = srPista / sr
  const base = Math.floor(desde * factor) // primer frame (de la pista) leido
  const necesarios = Math.ceil((desde + cantidad) * factor) - base + 2
  const canalesF = aFloat(pista, await leerFrames(pista, base, necesarios))
  const entradaL = canalesF[0] ?? new Float32Array(0)
  const entradaR = canalesF[ch === 2 ? 1 : 0] ?? entradaL
  const disponibles = entradaL.length
  for (let i = 0; i < cantidad; i++) {
    const pos = (desde + i) * factor - base
    const i0 = Math.floor(pos)
    if (i0 >= disponibles) break
    const f = pos - i0
    const i1 = Math.min(i0 + 1, disponibles - 1)
    const l = entradaL[i0] + (entradaL[i1] - entradaL[i0]) * f
    if (ch === 1) {
      L[i] += l * g * aLL
      R[i] += l * g * aRR
    } else {
      const r = entradaR[i0] + (entradaR[i1] - entradaR[i0]) * f
      L[i] += g * (aLL * l + aLR * r)
      R[i] += g * (aRL * l + aRR * r)
    }
  }
}

/** Limitador suave: lineal hasta 0,9 y despues se acerca a 1 sin pasarse (sin recorte duro). */
function limitar(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.9) return x
  const y = 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1)
  return x < 0 ? -y : y
}

export function aWav16(L: Float32Array, R: Float32Array, sr: number): Buffer {
  const frames = L.length
  const datos = frames * 4
  const buf = Buffer.alloc(44 + datos)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + datos, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sr, 24)
  buf.writeUInt32LE(sr * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(datos, 40)
  const s = new Int16Array(buf.buffer, buf.byteOffset + 44, frames * 2)
  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    s[j] = Math.round(limitar(L[i]) * 32767)
    s[j + 1] = Math.round(limitar(R[i]) * 32767)
  }
  return buf
}
