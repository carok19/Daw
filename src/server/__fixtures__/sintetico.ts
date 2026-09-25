import fs from 'node:fs'
import path from 'node:path'

/**
 * Audio sintetico para las pruebas: WAV, click con acento y una pista de voz
 * guia armada con anuncios en español (voz sintetica de espeak-ng, guardada
 * en __fixtures__/guia para que las pruebas no dependan de tenerlo instalado).
 */

// los tests se compilan a out/main/*.cjs: los fixtures se leen desde el codigo fuente
export const FIXTURES = path.resolve(__dirname, '../../src/server/__fixtures__/guia')
export const SR = 44100
export const SR_GUIA = 16000

export function wav16(muestras: Float32Array, sr: number, extra: Buffer[] = []): Buffer {
  const data = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(muestras[i] * 32767))), i * 2)
  const extras = Buffer.concat(extra)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length + extras.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data, extras])
}

/** Click sintetico: golpes cortos; el "1" de cada compas mas agudo y fuerte (si `acento`). */
export function generarClick(bpm: number, compas: number, segundos: number, acento = true, inicio = 0.5): Float32Array {
  const x = new Float32Array(Math.round(segundos * SR))
  const periodo = 60 / bpm
  for (let k = 0; ; k++) {
    const t = inicio + k * periodo
    if (t > segundos - 0.05) break
    const fuerte = acento && k % compas === 0
    const f = fuerte ? 1600 : 1000
    const a = fuerte ? 0.9 : 0.55
    const i0 = Math.round(t * SR)
    for (let i = 0; i < 0.03 * SR && i0 + i < x.length; i++) x[i0 + i] += a * Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-i / (0.006 * SR))
  }
  return x
}

/** Arma una pista de guia (16 kHz) con anuncios de voz sintetica en momentos conocidos. */
export function armarGuia(anuncios: [string, number][], segundos: number, sr = SR_GUIA): Float32Array {
  const x = new Float32Array(Math.round(segundos * sr))
  for (const [archivo, inicioSeg] of anuncios) {
    const buf = fs.readFileSync(path.join(FIXTURES, `${archivo}.wav`))
    let off = 12
    while (buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4)
    const n = buf.readUInt32LE(off + 4) / 2
    const i0 = Math.round(inicioSeg * sr)
    for (let i = 0; i < n && i0 + i < x.length; i++) x[i0 + i] += buf.readInt16LE(off + 8 + i * 2) / 32768
  }
  return x
}

