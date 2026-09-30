import fs from 'node:fs'
import path from 'node:path'
import type { OndaCancion, Proyecto } from '../shared/types'
import { esClickOGuia } from '../shared/mezcla'
import { bytesPorFrame, decodePcmSegment, totalFrames } from '../shared/wav'
import { leerInfoWav } from './audio'
import { archivoQueSuena } from './tono'

/**
 * Forma de onda de la cancion entera, para el "recorrido" de la pantalla
 * principal (compu y celulares): cuanto suena la banda en cada momento, sin
 * el click ni la guia (que suenan parejo todo el tiempo y taparian la forma
 * de la cancion). Un valor de 0 a 100 por punto, ~1200 puntos por cancion.
 *
 * Se calcula una vez por revision del audio (leyendo un pedacito de cada
 * pista en cada punto, no la pista entera) y queda guardada en la carpeta de
 * la cancion (onda.json).
 */

export const PUNTOS_ONDA = 1200
/** Frames que se leen de cada pista en cada punto (el promedio de energia de ese pedacito). */
const VENTANA_FRAMES = 1024

function rutaCache(dirProyecto: string): string {
  return path.join(dirProyecto, 'onda.json')
}

export function leerOndaGuardada(dirProyecto: string, revision: number): OndaCancion | null {
  try {
    const o = JSON.parse(fs.readFileSync(rutaCache(dirProyecto), 'utf-8')) as OndaCancion
    return o.revision === revision && Array.isArray(o.puntos) ? o : null
  } catch {
    return null
  }
}

export async function calcularOnda(dirProyecto: string, p: Proyecto): Promise<OndaCancion> {
  const revision = p.revision ?? 0
  const dur = Math.max(1, p.duracionTotalMs)
  const msPorPunto = Math.max(20, Math.ceil(dur / PUNTOS_ONDA))
  const n = Math.ceil(dur / msPorPunto)
  const energia = new Float64Array(n)
  const banda = p.pistas.filter((x) => !esClickOGuia(p, x))
  for (const pista of banda.length ? banda : p.pistas) {
    // lo que suena (a otra velocidad, las pistas preparadas: la duracion de la cancion es esa)
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
      for (let k = 0; k < n; k++) {
        const centro = Math.round((((k + 0.5) * msPorPunto) / 1000) * info.sampleRate)
        const desde = Math.max(0, Math.min(frames - VENTANA_FRAMES, centro - VENTANA_FRAMES / 2))
        if (desde < 0 || centro >= frames) continue
        const { bytesRead } = await fh.read(buf, 0, buf.length, info.dataOffset + desde * bpf)
        const utiles = bytesRead - (bytesRead % bpf)
        if (utiles <= 0) continue
        const copia = new Uint8Array(utiles)
        copia.set(buf.subarray(0, utiles))
        let suma = 0
        let cuenta = 0
        for (const canal of decodePcmSegment(info, copia.buffer)) {
          for (const v of canal) suma += v * v
          cuenta += canal.length
        }
        if (cuenta) energia[k] += suma / cuenta
      }
    } catch {
      // una pista ilegible no frena a las demas
    } finally {
      await fh.close()
    }
  }
  let max = 0
  const rms = Array.from(energia, (e) => {
    const r = Math.sqrt(e)
    max = Math.max(max, r)
    return r
  })
  // un poco comprimida: las partes suaves se siguen viendo
  const puntos = rms.map((r) => (max > 0 ? Math.round(Math.pow(r / max, 0.75) * 100) : 0))
  const onda: OndaCancion = { revision, msPorPunto, puntos }
  try {
    const tmp = `${rutaCache(dirProyecto)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(onda))
    fs.renameSync(tmp, rutaCache(dirProyecto))
  } catch {
    // no se pudo guardar: se vuelve a calcular la proxima vez
  }
  return onda
}

/** Las ondas ya calculadas (y las que se estan calculando), por cancion y revision. */
export class Ondas {
  private cache = new Map<string, Promise<OndaCancion>>()

  constructor(private readonly dirProyecto: (id: string) => string) {}

  obtener(p: Proyecto): Promise<OndaCancion> {
    const clave = `${p.id}:${p.revision ?? 0}`
    let o = this.cache.get(clave)
    if (!o) {
      const dir = this.dirProyecto(p.id)
      const guardada = leerOndaGuardada(dir, p.revision ?? 0)
      o = guardada ? Promise.resolve(guardada) : calcularOnda(dir, p)
      o.catch(() => this.cache.delete(clave))
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(clave, o)
    }
    return o
  }
}
