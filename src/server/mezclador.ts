import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Proyecto } from '../shared/types'
import { SEGMENTO_SEC, type CanalMezcla } from '../shared/mezcla'
import { parseWavHeader, totalFrames, WAV_HEADER_FETCH_BYTES } from '../shared/wav'
import { calcularMezcla, type InfoPista, type TrabajoMezcla } from './mezclaCalculo'

/** El hilo de trabajo (mezclaWorker.ts) compilado como texto por scripts/build-main.mjs (si no esta: se mezcla aca). */
declare const __CODIGO_WORKER_MEZCLA__: string | undefined
const CODIGO_WORKER = typeof __CODIGO_WORKER_MEZCLA__ === 'string' ? __CODIGO_WORKER_MEZCLA__ : null

/**
 * Mezcla, en la compu, el segmento `indice` (2 s) de una cancion con la mezcla
 * que pide cada celular, y lo devuelve como un WAV estereo de 16 bits.
 *
 * - Mezcla en hilos de trabajo, en varios nucleos a la vez: con muchos
 *   celulares el servidor no se traba (los mensajes de sincronizacion siguen
 *   saliendo a tiempo). Sin hilos (no deberia pasar), mezcla aca cediendo el
 *   turno entre pista y pista.
 * - Lo mas urgente primero: con muchos pedidos esperando, sale antes el
 *   segmento que va a sonar antes (no el que se pidio primero): al arrancar
 *   una cancion, el principio de todos los celulares antes que el colchon de
 *   20 s de cada uno.
 * - Cache chica en memoria: los celulares con la misma mezcla (lo mas comun)
 *   comparten los segmentos, y dos pedidos iguales al mismo tiempo se
 *   calculan una sola vez.
 * - Si la suma pasa de 0 dB, un limitador suave en el ultimo 10% evita el
 *   recorte duro (hasta ahi es identico a lo que hacia el celular).
 */

export interface SegmentoMezclado {
  wav: Buffer
  /** es el ultimo segmento de la cancion */
  ultimo: boolean
  ms: number
}

export interface EstadisticasMezcla {
  pedidos: number
  aciertosCache: number
  mezclados: number
  msPromedio: number
  msMax: number
  bytes: number
}

const BYTES_CACHE = 96 * 1024 * 1024
/** Sin hilos: mezclas a la vez en el hilo principal (mas no es mas rapido y harian esperar a los mensajes de sync). */
const MEZCLAS_A_LA_VEZ_SIN_HILOS = 2
/** Hilos de trabajo: los nucleos menos uno (el del servidor y la interfaz), entre 1 y 4. */
const HILOS = Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1))
const cederTurno = (): Promise<void> => new Promise((r) => setImmediate(r))

interface Tarea {
  trabajo: TrabajoMezcla
  /** cuanto falta para que suene (ms; menos = mas urgente), calculado al momento de elegir */
  urgencia: () => number
  resolve: (r: { wav: Buffer; ms: number }) => void
  reject: (e: Error) => void
}

/** Donde se mezcla: un hilo de trabajo, o el hilo principal (sin hilos). */
interface Lugar {
  tarea: Tarea | null
  ejecutar(t: Tarea): void
  cerrar(): void
}

class HiloDeTrabajo implements Lugar {
  tarea: Tarea | null = null
  private worker: Worker | null = null
  private siguienteId = 1

  constructor(
    private readonly codigo: string,
    private readonly libre: () => void
  ) {}

  private crear(): Worker {
    const w = new Worker(this.codigo, { eval: true })
    w.unref() // no mantiene vivo el proceso (tests, cierre de la app)
    w.on('message', (m: { id: number; wav?: ArrayBuffer; ms?: number; error?: string }) => {
      const t = this.tarea
      this.tarea = null
      if (t) {
        if (m.wav) t.resolve({ wav: Buffer.from(m.wav), ms: m.ms ?? 0 })
        else t.reject(new Error(m.error ?? 'no se pudo mezclar'))
      }
      this.libre()
    })
    w.on('error', (err) => {
      // el hilo se cayo: se rechaza lo que tenia y se crea otro con el proximo trabajo
      this.worker = null
      const t = this.tarea
      this.tarea = null
      t?.reject(err instanceof Error ? err : new Error(String(err)))
      this.libre()
    })
    return w
  }

  ejecutar(t: Tarea): void {
    this.tarea = t
    this.worker ??= this.crear()
    this.worker.postMessage({ id: this.siguienteId++, trabajo: t.trabajo })
  }

  cerrar(): void {
    void this.worker?.terminate()
    this.worker = null
  }
}

class HiloPrincipal implements Lugar {
  tarea: Tarea | null = null
  constructor(private readonly libre: () => void) {}
  ejecutar(t: Tarea): void {
    this.tarea = t
    const t0 = performance.now()
    calcularMezcla(t.trabajo, cederTurno)
      .then((wav) => t.resolve({ wav, ms: performance.now() - t0 }), (e: unknown) => t.reject(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        this.tarea = null
        this.libre()
      })
  }
  cerrar(): void {}
}

export class Mezclador {
  private infos = new Map<string, Promise<InfoPista>>()
  private cache = new Map<string, SegmentoMezclado>()
  private bytesEnCache = 0
  private enCurso = new Map<string, Promise<SegmentoMezclado | null>>()
  private stats = { pedidos: 0, aciertosCache: 0, mezclados: 0, msTotal: 0, msMax: 0, bytes: 0 }
  private cola: Tarea[] = []
  private lugares: Lugar[]

  /**
   * `urgencia(proyectoId, indice)`: cuantos ms faltan para que suene ese
   * segmento (menos = antes). Sin ella, en el orden en que llegan.
   * `hilos`: false = mezclar en el hilo principal (tests).
   */
  constructor(
    private readonly dirProyecto: (id: string) => string,
    private readonly urgencia: (proyectoId: string, indice: number) => number = () => 0,
    hilos = process.env.MULTITRACK_HILOS_MEZCLA !== '0'
  ) {
    const libre = (): void => this.despachar()
    this.lugares =
      hilos && CODIGO_WORKER
        ? Array.from({ length: HILOS }, () => new HiloDeTrabajo(CODIGO_WORKER, libre))
        : Array.from({ length: MEZCLAS_A_LA_VEZ_SIN_HILOS }, () => new HiloPrincipal(libre))
  }

  /** Cuantas mezclas se pueden hacer a la vez (hilos de trabajo, o 2 en el hilo principal). */
  get paralelo(): number {
    return this.lugares.length
  }

  cerrar(): void {
    for (const l of this.lugares) l.cerrar()
    for (const t of this.cola.splice(0)) t.reject(new Error('mezclador cerrado'))
  }

  /** Reparte los trabajos que esperan a los lugares libres: el mas urgente primero. */
  private despachar(): void {
    for (;;) {
      const lugar = this.lugares.find((l) => !l.tarea)
      if (!lugar || this.cola.length === 0) return
      let k = 0
      let mejor = Infinity
      for (let i = 0; i < this.cola.length; i++) {
        const u = this.cola[i].urgencia()
        if (u < mejor) {
          mejor = u
          k = i
        }
      }
      lugar.ejecutar(this.cola.splice(k, 1)[0])
    }
  }

  estadisticas(): EstadisticasMezcla {
    const s = this.stats
    return {
      pedidos: s.pedidos,
      aciertosCache: s.aciertosCache,
      mezclados: s.mezclados,
      msPromedio: s.mezclados ? Math.round((s.msTotal / s.mezclados) * 10) / 10 : 0,
      msMax: Math.round(s.msMax * 10) / 10,
      bytes: s.bytes
    }
  }

  /** null = el indice esta despues del final de la cancion. */
  async segmento(proyecto: Proyecto, indice: number, canales: CanalMezcla[], textoMezcla: string): Promise<SegmentoMezclado | null> {
    this.stats.pedidos++
    const clave = `${proyecto.id}:${proyecto.revision ?? 0}:${indice}:${textoMezcla}`
    const cacheado = this.cache.get(clave)
    if (cacheado) {
      this.stats.aciertosCache++
      this.cache.delete(clave)
      this.cache.set(clave, cacheado) // queda como el mas reciente
      this.stats.bytes += cacheado.wav.length
      return cacheado
    }
    let p = this.enCurso.get(clave)
    if (!p) {
      p = this.mezclar(proyecto, indice, canales).finally(() => this.enCurso.delete(clave))
      this.enCurso.set(clave, p)
    } else {
      this.stats.aciertosCache++
    }
    const r = await p
    if (r) {
      this.stats.bytes += r.wav.length
      if (!this.cache.has(clave)) {
        this.cache.set(clave, r)
        this.bytesEnCache += r.wav.length
        for (const [k, v] of this.cache) {
          if (this.bytesEnCache <= BYTES_CACHE) break
          this.cache.delete(k)
          this.bytesEnCache -= v.wav.length
        }
      }
    }
    return r
  }

  /** Olvida lo que tenga de un proyecto (se actualizo el audio o se borro). */
  olvidar(proyectoId: string): void {
    for (const k of [...this.infos.keys()]) if (k.startsWith(`${proyectoId}:`)) this.infos.delete(k)
    for (const [k, v] of [...this.cache]) {
      if (k.startsWith(`${proyectoId}:`)) {
        this.cache.delete(k)
        this.bytesEnCache -= v.wav.length
      }
    }
  }

  private infoDe(proyecto: Proyecto, archivo: string): Promise<InfoPista> {
    const clave = `${proyecto.id}:${proyecto.revision ?? 0}:${archivo}`
    let p = this.infos.get(clave)
    if (!p) {
      const ruta = path.join(this.dirProyecto(proyecto.id), archivo)
      p = (async () => {
        const fh = await fs.promises.open(ruta, 'r')
        try {
          const buf = Buffer.alloc(WAV_HEADER_FETCH_BYTES)
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          const encabezado = new Uint8Array(bytesRead)
          encabezado.set(buf.subarray(0, bytesRead))
          const info = parseWavHeader(encabezado.buffer)
          // el tamano real del archivo manda (un "data" con largo mal escrito no hace leer de mas)
          const { size } = await fh.stat()
          const dataReal = Math.max(0, Math.min(info.dataLength || Infinity, size - info.dataOffset))
          const corregida = { ...info, dataLength: dataReal }
          return { ruta, info: corregida, frames: totalFrames(corregida) }
        } finally {
          await fh.close()
        }
      })()
      p.catch(() => this.infos.delete(clave))
      this.infos.set(clave, p)
    }
    return p
  }

  private async mezclar(proyecto: Proyecto, indice: number, canales: CanalMezcla[]): Promise<SegmentoMezclado | null> {
    // todas las pistas (no solo las que suenan): la frecuencia y el largo de la mezcla no cambian al mutear
    const infos = new Map<string, InfoPista>()
    for (const p of proyecto.pistas) {
      try {
        infos.set(p.id, await this.infoDe(proyecto, p.archivo))
      } catch {
        // pista ilegible o que falta: queda muda (las demas suenan)
      }
    }
    if (infos.size === 0) throw new Error('la cancion no tiene audio legible')
    const sr = frecuenciaMasComun([...infos.values()])
    let framesTotales = 0
    for (const i of infos.values()) framesTotales = Math.max(framesTotales, Math.round((i.frames * sr) / i.info.sampleRate))
    const desde = Math.round(indice * SEGMENTO_SEC * sr)
    if (desde >= framesTotales) return null
    const cantidad = Math.min(Math.round(SEGMENTO_SEC * sr), framesTotales - desde)

    const pistas: Record<string, InfoPista> = {}
    for (const c of canales) {
      const p = infos.get(c.pistaId)
      if (p && c.ganancia > 0) pistas[c.pistaId] = p
    }
    const trabajo: TrabajoMezcla = { pistas, canales, sr, desde, cantidad }
    const { wav, ms } = await new Promise<{ wav: Buffer; ms: number }>((resolve, reject) => {
      this.cola.push({ trabajo, urgencia: () => this.urgencia(proyecto.id, indice), resolve, reject })
      this.despachar()
    })
    this.stats.mezclados++
    this.stats.msTotal += ms
    this.stats.msMax = Math.max(this.stats.msMax, ms)
    return { wav, ultimo: desde + cantidad >= framesTotales, ms }
  }
}

function frecuenciaMasComun(pistas: InfoPista[]): number {
  const cuenta = new Map<number, number>()
  for (const p of pistas) cuenta.set(p.info.sampleRate, (cuenta.get(p.info.sampleRate) ?? 0) + 1)
  let mejor = pistas[0].info.sampleRate
  let max = 0
  for (const [sr, n] of cuenta) {
    if (n > max || (n === max && sr > mejor)) {
      mejor = sr
      max = n
    }
  }
  return mejor
}
