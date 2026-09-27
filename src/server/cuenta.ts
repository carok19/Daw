import fs from 'node:fs'
import path from 'node:path'
import type { Proyecto } from '../shared/types'
import { bytesPorFrame, decodePcmSegment, totalFrames, type WavInfo } from '../shared/wav'
import { encabezadoWav16, leerInfoWav } from './audio'
import { LARGO_SONIDO_CUENTA_SEC } from '../shared/cuenta'

/**
 * Sonidos de la cuenta: el golpe del "1" y un golpe comun, recortados de la
 * propia pista de click de la cancion (asi la cuenta suena igual que su
 * click). Un WAV mono de 16 bits: el "1" en el primer cuarto de segundo y el
 * golpe comun en el segundo. null si la cancion no tiene click detectado.
 */


function leerTramo(fd: number, info: WavInfo, desdeFrame: number, frames: number): Float32Array {
  const bpf = bytesPorFrame(info)
  const inicio = Math.max(0, desdeFrame)
  const cantidad = Math.max(0, Math.min(frames, totalFrames(info) - inicio))
  const buf = Buffer.alloc(cantidad * bpf)
  fs.readSync(fd, buf, 0, buf.length, info.dataOffset + inicio * bpf)
  const canales = decodePcmSegment(info, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  const mono = new Float32Array(cantidad)
  for (const c of canales) for (let i = 0; i < cantidad; i++) mono[i] += c[i] / canales.length
  return mono
}

/** El golpe que empieza cerca de `ms`: desde su ataque, con `largo` muestras y un final suave. null si ahi no suena nada. */
function golpeEn(fd: number, info: WavInfo, ms: number, largo: number): Float32Array | null {
  const sr = info.sampleRate
  const ventana = Math.round(0.04 * sr)
  const desde = Math.round((ms / 1000) * sr) - ventana
  const zona = leerTramo(fd, info, desde, ventana * 2)
  let pico = 0
  for (const v of zona) pico = Math.max(pico, Math.abs(v))
  if (pico < 0.01) return null
  let ataque = zona.findIndex((v) => Math.abs(v) >= pico * 0.3)
  ataque = Math.max(0, ataque - Math.round(0.001 * sr))
  const golpe = leerTramo(fd, info, desde + ataque, largo)
  const fundido = Math.min(golpe.length, Math.round(0.015 * sr))
  for (let i = 0; i < fundido; i++) golpe[golpe.length - 1 - i] *= i / fundido
  return golpe
}

export function sonidosDeCuenta(dirProyecto: string, p: Proyecto): Buffer | null {
  const tempo = p.tempo
  const click = tempo?.clickPistaId ? p.pistas.find((x) => x.id === tempo.clickPistaId) : null
  const compases = tempo?.compasesMs
  if (!tempo || !click || !compases || compases.length < 3) return null
  const ruta = path.join(dirProyecto, click.archivo)
  let fd: number
  try {
    fd = fs.openSync(ruta, 'r')
  } catch {
    return null
  }
  try {
    const info = leerInfoWav(ruta)
    const sr = info.sampleRate
    const pulsos = tempo.compas > 0 ? Math.round(tempo.compas) : 4
    const hueco = Math.round(LARGO_SONIDO_CUENTA_SEC * sr)
    // el primer compas donde se oye el "1" y el golpe siguiente (el 0 puede ser una cuenta propia distinta)
    for (let k = 1; k < Math.min(compases.length - 1, 24); k++) {
      const pulso = (compases[k + 1] - compases[k]) / pulsos
      const largo = Math.min(hueco, Math.round(((pulso - 15) / 1000) * sr))
      if (largo < 0.02 * sr) return null
      const uno = golpeEn(fd, info, compases[k], largo)
      const comun = golpeEn(fd, info, compases[k] + pulso, largo)
      if (!uno || !comun) continue
      const muestras = new Int16Array(hueco * 2)
      uno.forEach((v, i) => (muestras[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767)))
      comun.forEach((v, i) => (muestras[hueco + i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767)))
      const datos = Buffer.from(muestras.buffer)
      return Buffer.concat([encabezadoWav16(1, sr, datos.length), datos])
    }
    return null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}
