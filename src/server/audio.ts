import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { duracionMsDeWav, parseWavHeader, type WavInfo } from '../shared/wav'

/**
 * Normalizacion de audio al importar: TODAS las pistas quedan en disco como
 * WAV PCM 16-bit (misma frecuencia de muestreo que el original), que es el
 * unico formato que el receptor puede pedir por HTTP Range y decodificar por
 * segmentos sin cortes (ver README "Streaming progresivo"). Asi un .mp3,
 * .m4a, .aiff o .flac suena en los celulares exactamente igual que un .wav.
 *
 * Ademas, si una pista estereo es en realidad "dual mono" (L == R, muy comun
 * en click, guia, bajo, bombo...), se guarda en mono: la mitad de bytes por
 * WiFi para cada celular, sin ninguna diferencia audible (el StereoPanner la
 * sigue ubicando en el estereo igual).
 */

export const EXTENSIONES_AUDIO = new Set(['.wav', '.mp3', '.m4a', '.aac', '.aif', '.aiff', '.flac', '.ogg'])

export class ConversionError extends Error {}

/** Ruta al binario de ffmpeg (ffmpeg-static). Dentro de un paquete de Electron vive en app.asar.unpacked. */
export function rutaFfmpeg(): string | null {
  if (process.env.MULTITRACK_FFMPEG) return process.env.MULTITRACK_FFMPEG
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ruta = require('ffmpeg-static') as string | null
    if (!ruta) return null
    const real = ruta.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    return fs.existsSync(real) ? real : null
  } catch {
    return null
  }
}

function correrFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = rutaFfmpeg()
  if (!ffmpeg) return Promise.reject(new ConversionError('No se encontro ffmpeg para convertir el audio'))
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', (err) => reject(new ConversionError(err.message)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new ConversionError(stderr.trim().split('\n').pop() || `ffmpeg termino con codigo ${code}`))
    })
  })
}

export function leerInfoWav(ruta: string): WavInfo {
  const fd = fs.openSync(ruta, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const leidos = fs.readSync(fd, buf, 0, buf.length, 0)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + leidos) as ArrayBuffer
    const info = parseWavHeader(ab)
    // ffmpeg a veces deja el tamano del chunk "data" en 0/0xFFFFFFFF (salida no "seekable"): se corrige con el tamano real
    const tamanoReal = fs.fstatSync(fd).size - info.dataOffset
    if (info.dataLength === 0 || info.dataLength > tamanoReal) info.dataLength = tamanoReal
    return info
  } finally {
    fs.closeSync(fd)
  }
}

function encabezadoWav(numChannels: number, sampleRate: number, bitsPerSample: number, dataLength: number): Buffer {
  const h = Buffer.alloc(44)
  const blockAlign = numChannels * (bitsPerSample / 8)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataLength, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(numChannels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * blockAlign, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bitsPerSample, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataLength, 40)
  return h
}

/** Tolerancia (en LSB de 16 bits) para considerar L == R: absorbe el dithering/redondeo de algunos exports. */
const TOLERANCIA_DUAL_MONO = 2

/**
 * Si el WAV (16-bit estereo) es dual mono, lo reescribe en mono en el mismo
 * lugar. Devuelve true si lo convirtio.
 */
function monoSiEsDualMono(ruta: string, info: WavInfo): boolean {
  if (info.numChannels !== 2 || info.bitsPerSample !== 16 || info.audioFormat !== 1) return false
  const data = fs.readFileSync(ruta).subarray(info.dataOffset, info.dataOffset + info.dataLength)
  const frames = Math.floor(data.length / 4)
  for (let i = 0; i < frames; i++) {
    const l = data.readInt16LE(i * 4)
    const r = data.readInt16LE(i * 4 + 2)
    if (Math.abs(l - r) > TOLERANCIA_DUAL_MONO) return false
  }
  const mono = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) mono.writeInt16LE(data.readInt16LE(i * 4), i * 2)
  const tmp = ruta + '.mono.tmp'
  fs.writeFileSync(tmp, Buffer.concat([encabezadoWav(1, info.sampleRate, 16, mono.length), mono]))
  fs.renameSync(tmp, ruta)
  return true
}

export interface ResultadoNormalizacion {
  duracionMs: number
  canales: number
}

/**
 * Convierte `entrada` (cualquier formato soportado por ffmpeg) a `salida` como
 * WAV PCM 16-bit, estereo como maximo, y mono si es dual mono.
 */
export async function normalizarAWav(entrada: string, salida: string): Promise<ResultadoNormalizacion> {
  const tmp = salida + '.tmp.wav'
  try {
    await correrFfmpeg(['-i', entrada, '-vn', '-map_metadata', '-1', '-fflags', '+bitexact', '-c:a', 'pcm_s16le', tmp])
    let info = leerInfoWav(tmp)
    if (info.numChannels > 2) {
      // stems multicanal (5.1, etc.): se baja a estereo
      await correrFfmpeg(['-i', entrada, '-vn', '-map_metadata', '-1', '-fflags', '+bitexact', '-c:a', 'pcm_s16le', '-ac', '2', tmp])
      info = leerInfoWav(tmp)
    }
    if (monoSiEsDualMono(tmp, info)) info = leerInfoWav(tmp)
    fs.renameSync(tmp, salida)
    return { duracionMs: Math.round(duracionMsDeWav(info)), canales: info.numChannels }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Ejecuta tareas async con un maximo de `limite` en paralelo, preservando el orden de resultados. */
export async function enParalelo<T, R>(items: T[], limite: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(items.length)
  let siguiente = 0
  async function trabajador(): Promise<void> {
    while (siguiente < items.length) {
      const i = siguiente++
      resultados[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador))
  return resultados
}
