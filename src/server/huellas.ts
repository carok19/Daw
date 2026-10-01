import fs from 'node:fs'
import path from 'node:path'
import type { Proyecto } from '../shared/types'
import { calcularHuella, huellaABytes, SR_HUELLA } from '../shared/huella'
import { esClickOGuia } from '../shared/mezcla'
import { decodificarMono } from './analisis/decodificar'

/** Version de la huella guardada (si cambia el calculo, se rehace). */
const ARCHIVO = 'huella-video-v1.bin'

export type RespuestaHuella =
  | { estado: 'lista'; huella: Uint8Array; duracionMs: number }
  | { estado: 'esperando' }
  | { estado: 'error'; mensaje: string }

/**
 * Huella del audio de cada cancion para AirTracks Video (ver shared/huella.ts):
 * la suma de sus pistas originales sin el click ni la guia (lo que se oye en
 * el video), una vez y guardada al lado de la cancion. Se calcula solo con la
 * musica parada: nunca compite con los celulares.
 */
export class Huellas {
  private calculando = new Map<string, Promise<Uint8Array>>()

  constructor(
    private readonly dirDe: (proyectoId: string) => string,
    private readonly algoSuena: () => boolean
  ) {}

  async pedir(p: Proyecto): Promise<RespuestaHuella> {
    const archivo = path.join(this.dirDe(p.id), ARCHIVO)
    try {
      if (fs.existsSync(archivo)) return { estado: 'lista', huella: new Uint8Array(fs.readFileSync(archivo)), duracionMs: p.duracionTotalMs }
      if (this.algoSuena()) return { estado: 'esperando' }
      let tarea = this.calculando.get(p.id)
      if (!tarea) {
        tarea = this.calcular(p, archivo).finally(() => this.calculando.delete(p.id))
        this.calculando.set(p.id, tarea)
      }
      return { estado: 'lista', huella: await tarea, duracionMs: p.duracionTotalMs }
    } catch (err) {
      return { estado: 'error', mensaje: String((err as Error).message ?? err).slice(0, 200) }
    }
  }

  private async calcular(p: Proyecto, archivo: string): Promise<Uint8Array> {
    const pistas = p.pistas.filter((x) => !esClickOGuia(p, x))
    if (pistas.length === 0) throw new Error('La canción no tiene pistas de la banda')
    let mezcla: Float32Array | null = null
    for (const pista of pistas) {
      // de a una pista (poca memoria); si empieza a sonar algo, se espera
      while (this.algoSuena()) await new Promise((r) => setTimeout(r, 1000))
      const x = await decodificarMono(path.join(this.dirDe(p.id), pista.archivo), SR_HUELLA)
      if (!mezcla || x.length > mezcla.length) {
        const mas = new Float32Array(x.length)
        if (mezcla) mas.set(mezcla)
        mezcla = mas
      }
      for (let i = 0; i < x.length; i++) mezcla[i] += x[i]
    }
    const bytes = huellaABytes(calcularHuella(mezcla!))
    fs.writeFileSync(archivo, bytes)
    return bytes
  }
}
