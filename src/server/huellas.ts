import fs from 'node:fs'
import path from 'node:path'
import type { Proyecto } from '../shared/types'
import { calcularHuellaDeAPoco, huellaABytes, SR_HUELLA } from '../shared/huella'
import { esClickOGuia } from '../shared/mezcla'
import { ceder, decodificarMono } from './analisis/decodificar'

/** Version de la huella guardada (si cambia el calculo, se rehace). */
const ARCHIVO = 'huella-video-v1.bin'

export type RespuestaHuella =
  | { estado: 'lista'; huella: Uint8Array; duracionMs: number }
  /** se esta calculando: `hechas` de `total` pasos (una pista cada uno, y la huella) */
  | { estado: 'calculando'; hechas: number; total: number }
  /** suena musica: se calcula cuando pare */
  | { estado: 'esperando' }
  | { estado: 'error'; mensaje: string }

interface Tarea {
  hechas: number
  total: number
  /** suena musica: esta esperando para seguir */
  pausada: boolean
  error: string | null
}

/**
 * Huella del audio de cada cancion para AirTracks Video (ver shared/huella.ts):
 * la suma de sus pistas originales sin el click ni la guia (lo que se oye en
 * el video), una vez y guardada al lado de la cancion. Se calcula solo con la
 * musica parada (nunca compite con los celulares) y de a poco (el servidor
 * no se traba). El pedido contesta enseguida: lista, o cuanto va.
 */
export class Huellas {
  private tareas = new Map<string, Tarea>()

  constructor(
    private readonly dirDe: (proyectoId: string) => string,
    private readonly algoSuena: () => boolean
  ) {}

  pedir(p: Proyecto): RespuestaHuella {
    const archivo = path.join(this.dirDe(p.id), ARCHIVO)
    try {
      if (fs.existsSync(archivo)) return { estado: 'lista', huella: new Uint8Array(fs.readFileSync(archivo)), duracionMs: p.duracionTotalMs }
    } catch (err) {
      return { estado: 'error', mensaje: String((err as Error).message ?? err).slice(0, 200) }
    }
    const tarea = this.tareas.get(p.id)
    if (tarea) {
      if (tarea.error) {
        this.tareas.delete(p.id)
        return { estado: 'error', mensaje: tarea.error }
      }
      return tarea.pausada ? { estado: 'esperando' } : { estado: 'calculando', hechas: tarea.hechas, total: tarea.total }
    }
    if (this.algoSuena()) return { estado: 'esperando' }
    const pistas = p.pistas.filter((x) => !esClickOGuia(p, x))
    if (pistas.length === 0) return { estado: 'error', mensaje: 'La canción no tiene pistas de la banda' }
    const nueva: Tarea = { hechas: 0, total: pistas.length + 1, pausada: false, error: null }
    this.tareas.set(p.id, nueva)
    void this.calcular(p, pistas, archivo, nueva).then(
      () => this.tareas.delete(p.id),
      (err) => (nueva.error = String((err as Error).message ?? err).slice(0, 200))
    )
    return { estado: 'calculando', hechas: 0, total: nueva.total }
  }

  private async esperarSilencio(t: Tarea): Promise<void> {
    while (this.algoSuena()) {
      t.pausada = true
      await new Promise((r) => setTimeout(r, 1000))
    }
    t.pausada = false
  }

  private async calcular(p: Proyecto, pistas: Proyecto['pistas'], archivo: string, t: Tarea): Promise<void> {
    let mezcla: Float32Array | null = null
    for (const pista of pistas) {
      // de a una pista (poca memoria); si empieza a sonar algo, se espera
      await this.esperarSilencio(t)
      const x = await decodificarMono(path.join(this.dirDe(p.id), pista.archivo), SR_HUELLA)
      if (!mezcla || x.length > mezcla.length) {
        const mas = new Float32Array(x.length)
        if (mezcla) mas.set(mezcla)
        mezcla = mas
      }
      for (let i = 0; i < x.length; i++) mezcla[i] += x[i]
      t.hechas++
      await ceder()
    }
    await this.esperarSilencio(t)
    const bytes = huellaABytes(await calcularHuellaDeAPoco(mezcla!, ceder))
    fs.writeFileSync(archivo, bytes)
    t.hechas++
  }
}
