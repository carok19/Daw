import fs from 'node:fs'
import path from 'node:path'
import type { Pista, Proyecto } from '../shared/types'
import { esClickOGuia } from '../shared/mezcla'
import { bytesPorFrame, decodePcmSegment, totalFrames, type WavInfo } from '../shared/wav'
import { encabezadoWav16, leerInfoWav } from './audio'
import { LARGO_SONIDO_CUENTA_SEC } from '../shared/cuenta'
import { archivoQueSuena } from './tono'

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
  // el click que suena (a otra velocidad, el preparado: los compases estan en ese tiempo)
  const ruta = path.join(dirProyecto, archivoQueSuena(p, click))
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

// ---- la cuenta que ya trae la cancion ----

/** Compases de cuenta propia que se buscan al principio, como mucho. */
const MAX_CUENTA_PROPIA = 4
/** Compases que se miran para saber cuanto suena la banda. */
const COMPASES_REVISADOS = 12
/**
 * La banda "no suena" en un compas si tiene 24 dB menos que el compas mas
 * fuerte del principio (un pad bajito de fondo durante la cuenta no engaña;
 * una intro suave, si, suena).
 */
const SILENCIO_RELATIVO = 10 ** (-24 / 10)
/** Silencio de verdad (-60 dBFS): la cuenta es solo el click. */
const SILENCIO_ABSOLUTO = 10 ** (-60 / 10)
const VENTANA_FRAMES = 1024

/**
 * Energia de un grupo de pistas en cada uno de los primeros `k` compases:
 * ventanitas repartidas en la primera `fraccion` del compas; la media (o el
 * pico) de las ventanas, sumando las pistas.
 */
async function energiaPorCompas(
  dirProyecto: string,
  p: Proyecto,
  pistas: Pista[],
  compases: number[],
  k: number,
  fraccion: number,
  modo: 'media' | 'pico'
): Promise<number[]> {
  const total = new Array<number>(k).fill(0)
  const ventanas = 12
  for (const pista of pistas) {
    const ruta = path.join(dirProyecto, archivoQueSuena(p, pista))
    let fh: fs.promises.FileHandle
    try {
      fh = await fs.promises.open(ruta, 'r')
    } catch {
      continue
    }
    try {
      const info = leerInfoWav(ruta)
      const bpf = bytesPorFrame(info)
      const frames = totalFrames(info)
      const buf = Buffer.alloc(VENTANA_FRAMES * bpf)
      for (let j = 0; j < k; j++) {
        const largo = compases[j + 1] - compases[j]
        let suma = 0
        let pico = 0
        for (let w = 0; w < ventanas; w++) {
          const ms = compases[j] + largo * (0.02 + ((fraccion - 0.06) * w) / (ventanas - 1))
          const desde = Math.round((ms / 1000) * info.sampleRate)
          if (desde < 0 || desde + VENTANA_FRAMES > frames) continue
          const { bytesRead } = await fh.read(buf, 0, buf.length, info.dataOffset + desde * bpf)
          const utiles = bytesRead - (bytesRead % bpf)
          if (utiles <= 0) continue
          const copia = new Uint8Array(utiles)
          copia.set(buf.subarray(0, utiles))
          let e = 0
          let n = 0
          for (const canal of decodePcmSegment(info, copia.buffer)) {
            for (const v of canal) e += v * v
            n += canal.length
          }
          const media = n ? e / n : 0
          suma += media
          pico = Math.max(pico, media)
        }
        total[j] += modo === 'media' ? suma / ventanas : pico
      }
    } catch {
      // una pista ilegible no frena a las demas
    } finally {
      await fh.close()
    }
  }
  return total
}

/**
 * Cuantos compases de cuenta trae la cancion al principio: desde el primer
 * compas, la banda (todo menos el click y la guia) en silencio mientras la
 * guia cuenta ("1, 2, 3, 4") o, sin guia, suena solo el click; y despues
 * entra la banda. 0 = entra directo (o no se puede saber). Se mira la
 * primera parte de cada compas: una entrada de bateria en el ultimo pulso
 * de la cuenta no la esconde.
 */
export async function detectarCuentaPropia(dirProyecto: string, p: Proyecto): Promise<number> {
  const c = p.tempo?.compasesMs
  if (!c || c.length < 3) return 0
  const banda = p.pistas.filter((x) => !esClickOGuia(p, x))
  if (banda.length === 0) return 0
  const guias = p.pistas.filter((x) => esClickOGuia(p, x) && x.id !== p.tempo?.clickPistaId)
  const k = Math.min(COMPASES_REVISADOS, c.length - 1)
  const eBanda = await energiaPorCompas(dirProyecto, p, banda, c, k, 0.72, 'media')
  const ref = Math.max(...eBanda)
  if (!(ref > SILENCIO_ABSOLUTO)) return 0
  let n = 0
  while (n < Math.min(MAX_CUENTA_PROPIA, k - 1) && eBanda[n] < ref * SILENCIO_RELATIVO) n++
  // nada al principio, o un silencio largo que no es una cuenta
  if (n === 0 || eBanda[n] < ref * SILENCIO_RELATIVO) return 0
  // alguien cuenta: la guia habla en esos compases, o es solo el click (la banda en silencio de verdad)
  const eGuia = guias.length ? await energiaPorCompas(dirProyecto, p, guias, c, k, 1, 'pico') : []
  const refGuia = Math.max(0, ...eGuia)
  const hablaLaGuia = refGuia > SILENCIO_ABSOLUTO && eGuia.slice(0, n).some((e) => e > refGuia * 0.05)
  const soloClick = eBanda.slice(0, n).every((e) => e < SILENCIO_ABSOLUTO)
  return hablaLaGuia || soloClick ? n : 0
}
