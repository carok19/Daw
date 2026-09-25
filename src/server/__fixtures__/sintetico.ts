import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

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


// ---- Cancion de prueba completa ----
// 90 BPM 4/4 (compas = 2.667 s, el primero en 0.5 s), con una voz guia que
// anuncia cada parte terminando ~0.25 s antes del compas en el que empieza.
export const BPM_GUIA = 90
const COMPAS_SEG = (60 / BPM_GUIA) * 4
export const inicioCompas = (k: number): number => 0.5 + k * COMPAS_SEG
/** [archivo de voz, texto que "reconoce" el Whisper falso, compas donde empieza la seccion] */
export const ANUNCIOS: [string, string, number][] = [
  ['verso-uno', 'Verso uno.', 2],
  ['coro', 'Coro.', 6],
  ['verso-dos', 'Verso dos.', 10],
  ['coro', '¡Coro!', 14],
  ['puente', 'Puente', 18],
  ['final', 'Final', 22]
]
export const DURACION_GUIA_S = 64

function duracionFixture(archivo: string): number {
  const buf = fs.readFileSync(path.join(FIXTURES, `${archivo}.wav`))
  let off = 12
  while (buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4)
  return buf.readUInt32LE(off + 4) / 2 / SR_GUIA
}

/** Zip "Click + Guía + Pad" con la voz guia de ANUNCIOS. */
export function zipConGuia(dir: string, nombre: string, extra: Record<string, Buffer> = {}): string {
  const zip = new AdmZip()
  zip.addFile('01 Click.wav', wav16(generarClick(BPM_GUIA, 4, DURACION_GUIA_S), SR))
  const guia = armarGuia(
    ANUNCIOS.map(([archivo, , compas]) => [archivo, inicioCompas(compas) - 0.25 - duracionFixture(archivo)]),
    DURACION_GUIA_S
  )
  zip.addFile('02 Guía.wav', wav16(guia, SR_GUIA))
  zip.addFile(
    '03 Pad.wav',
    wav16(new Float32Array(DURACION_GUIA_S * SR).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR)), SR)
  )
  for (const [n, b] of Object.entries(extra)) zip.addFile(n, b)
  const destino = path.join(dir, `${nombre}.zip`)
  zip.writeZip(destino)
  return destino
}

/** Lo que "diria" el reconocedor para la frase que termina en `finMs` (Whisper falso de las pruebas). */
export function textoDeFrase(finMs: number): string {
  return ANUNCIOS.find(([, , compas]) => Math.abs(inicioCompas(compas) * 1000 - 250 - finMs) < 200)?.[1] ?? ''
}
