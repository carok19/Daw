import { spawn } from 'node:child_process'
import { rutaFfmpeg } from '../audio'

/**
 * Decodifica un archivo de audio a Float32 mono en la frecuencia pedida, con
 * ffmpeg en un proceso aparte (no bloquea el servidor mientras suena un culto).
 */
export function decodificarMono(ruta: string, sampleRate: number): Promise<Float32Array> {
  const ffmpeg = rutaFfmpeg()
  if (!ffmpeg) return Promise.reject(new Error('No se encontró ffmpeg'))
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', ruta, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const partes: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => partes.push(d))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg terminó con código ${code}`))
      const todo = Buffer.concat(partes)
      const muestras = new Float32Array(Math.floor(todo.length / 4))
      for (let i = 0; i < muestras.length; i++) muestras[i] = todo.readFloatLE(i * 4)
      resolve(muestras)
    })
  })
}

/** Cede el hilo cada tanto en los loops largos, para no frenar al servidor (sockets, sync). */
export function ceder(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}
