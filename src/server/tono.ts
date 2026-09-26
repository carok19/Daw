import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Pista, ProgresoTono, Proyecto } from '../shared/types'
import { esClickOGuia } from '../shared/mezcla'
import { factorDeTono, pareceBateria, pareceVoz, TONO_MAX, TONO_MIN } from '../shared/tonalidad'
import { totalFrames } from '../shared/wav'
import { enParalelo, leerInfoWav, rutaFfmpeg } from './audio'
import { projectDir } from './projects'

/**
 * Cambio de tono de una cancion (−6 a +6 semitonos). La compu prepara ANTES
 * de tocar una copia de cada pista en el tono nuevo (ffmpeg + rubberband, en
 * procesos aparte y con prioridad baja) y recien cuando estan todas pasa la
 * cancion a ese tono: los celulares y la compu la vuelven a cargar (sube la
 * `revision`) y suena igual que siempre, sin trabajo extra mientras se toca.
 *
 * - El click, la guia hablada y la bateria quedan como estan.
 * - Las voces conservan el timbre (formantes): no suenan "chillonas".
 * - Las pistas nuevas duran exactamente lo mismo que las originales, y la
 *   pequena demora propia de rubberband (distinta en cada tono) se mide y se
 *   corrige, asi todo sigue cayendo justo con el click.
 * - Cada cancion guarda solo su ultimo tono (tono/<semitonos>/<archivo>).
 */

/** Subcarpeta de cada cancion con las pistas transpuestas: tono/<semitonos>/<archivo original>. */
export const DIR_TONO = 'tono'

/** Espera despues de tocar − / + antes de empezar a preparar (apretar varias veces seguidas es un solo trabajo). */
const ESPERA_MS = 700
/** Procesos de ffmpeg a la vez (uno solo mientras suena algo: la mezcla de los celulares va primero). */
const HILOS = Math.max(1, Math.min(3, os.cpus().length - 1))

export function esTonoValido(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= TONO_MIN && n <= TONO_MAX
}

/** Las pistas que cambian de tono: todas menos el click, la guia hablada y la bateria. */
export function pistasQueCambianDeTono(p: Proyecto): Pista[] {
  return p.pistas.filter((x) => !esClickOGuia(p, x) && !pareceBateria(x.nombre))
}

/** El archivo que suena de una pista (relativo a la carpeta de la cancion): el transpuesto si la cancion esta en otro tono. */
export function archivoQueSuena(p: Proyecto, pista: Pista): string {
  const n = p.tonoAplicado ?? 0
  return n && p.tonoPistas?.includes(pista.id) && !esClickOGuia(p, pista) ? `${DIR_TONO}/${n}/${pista.archivo}` : pista.archivo
}

// ---- ffmpeg ----

function prioridadBaja(proc: ChildProcess): void {
  try {
    if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // sin permiso para cambiarla: corre con la normal
  }
}

function correr(args: string[], entrada: Buffer | null, alIniciar?: (proc: ChildProcess) => void): Promise<Buffer> {
  const ffmpeg = rutaFfmpeg()
  if (!ffmpeg) return Promise.reject(new Error('No se encontró ffmpeg'))
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...(entrada ? [] : ['-nostdin']), '-y', ...args], {
      stdio: [entrada ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    prioridadBaja(proc)
    alIniciar?.(proc)
    const salida: Buffer[] = []
    let stderr = ''
    proc.stdout!.on('data', (d: Buffer) => salida.push(d))
    proc.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code, senal) => {
      if (code === 0) resolve(Buffer.concat(salida))
      else reject(new Error(senal ? 'cancelado' : stderr.trim().split('\n').pop() || `ffmpeg terminó con código ${code}`))
    })
    if (entrada) {
      proc.stdin!.on('error', () => undefined)
      proc.stdin!.end(entrada)
    }
  })
}

function filtroRubberband(semitonos: number, formantes: boolean): string {
  return `rubberband=pitch=${factorDeTono(semitonos).toFixed(8)}:pitchq=quality${formantes ? ':formant=preserved' : ''}`
}

// ---- demora de rubberband ----

/** Golpes con notas (ataque marcado) a distancias irregulares: para medir cuanto corre el audio rubberband. */
function senalDePrueba(sr: number): Float32Array {
  const x = new Float32Array(Math.round(sr * 4))
  const golpes = [0.3, 0.72, 1.09, 1.61, 2.02, 2.49, 3.03, 3.41]
  const notas = [196, 293.66, 440, 659.26, 987.77]
  golpes.forEach((t0, k) => {
    const i0 = Math.round(t0 * sr)
    for (let i = 0; i < sr * 0.3 && i0 + i < x.length; i++) {
      const t = i / sr
      const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.05)
      let v = 0
      for (const f of notas) v += Math.sin(2 * Math.PI * f * (1 + 0.04 * k) * t)
      x[i0 + i] += 0.12 * env * v
    }
  })
  return x
}

/** Envolvente (bloques de 0,25 ms, suavizada 2 ms sin correrla) para comparar dos senales en el tiempo. */
function envolvente(x: Float32Array, bloque: number): Float64Array {
  const n = Math.floor(x.length / bloque)
  const e = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < bloque; j++) s += Math.abs(x[i * bloque + j])
    e[i] = s
  }
  const r = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = -4; j <= 4; j++) s += e[Math.min(n - 1, Math.max(0, i + j))]
    r[i] = s
  }
  return r
}

/** Cuanto mas tarde (s) viene `b` que `a` (negativo = mas temprano), buscando hasta ±60 ms. */
export function demoraEntre(a: Float32Array, b: Float32Array, sr: number): number {
  const bloque = Math.max(1, Math.round(sr * 0.00025))
  const ea = envolvente(a, bloque)
  const eb = envolvente(b, bloque)
  const max = Math.ceil((0.06 * sr) / bloque)
  const valor = (lag: number): number => {
    let s = 0
    for (let i = 0; i < ea.length; i++) {
      const j = i + lag
      if (j >= 0 && j < eb.length) s += ea[i] * eb[j]
    }
    return s
  }
  let mejor = 0
  let mejorV = -Infinity
  const vals = new Map<number, number>()
  for (let lag = -max; lag <= max; lag++) {
    const v = valor(lag)
    vals.set(lag, v)
    if (v > mejorV) {
      mejorV = v
      mejor = lag
    }
  }
  // entre bloques: parabola por los tres mejores
  const y0 = vals.get(mejor - 1)
  const y2 = vals.get(mejor + 1)
  let fino = mejor
  if (y0 !== undefined && y2 !== undefined) {
    const den = y0 - 2 * mejorV + y2
    if (den < 0) fino = mejor + (0.5 * (y0 - y2)) / den
  }
  return (fino * bloque) / sr
}

const demoras = new Map<string, Promise<number>>()

/** Demora (s) que agrega rubberband con este tono, frecuencia y modo (se mide una vez y se recuerda). */
export function demoraRubberband(semitonos: number, sr: number, formantes: boolean): Promise<number> {
  const clave = `${semitonos}:${sr}:${formantes ? 1 : 0}`
  let p = demoras.get(clave)
  if (!p) {
    const x = senalDePrueba(sr)
    p = correr(
      ['-f', 'f32le', '-ar', String(sr), '-ac', '1', '-i', 'pipe:0', '-af', filtroRubberband(semitonos, formantes), '-f', 'f32le', '-ar', String(sr), '-ac', '1', 'pipe:1'],
      Buffer.from(x.buffer, x.byteOffset, x.byteLength)
    ).then((buf) => {
      const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)))
      return demoraEntre(x, y, sr)
    })
    p.catch(() => demoras.delete(clave))
    demoras.set(clave, p)
  }
  return p
}

/**
 * Escribe `salida`: la pista `entrada` (WAV 16-bit) `semitonos` mas arriba o
 * abajo, con exactamente la misma cantidad de muestras y la demora de
 * rubberband corregida.
 */
export async function transponerPista(
  entrada: string,
  salida: string,
  semitonos: number,
  formantes: boolean,
  alIniciar?: (proc: ChildProcess) => void
): Promise<void> {
  const info = leerInfoWav(entrada)
  const frames = totalFrames(info)
  const demora = await demoraRubberband(semitonos, info.sampleRate, formantes)
  const corrimiento = Math.round(Math.abs(demora) * info.sampleRate)
  const filtros = [filtroRubberband(semitonos, formantes)]
  // llega tarde: se le saca el principio; llega temprano: se lo corre
  if (demora > 0 && corrimiento) filtros.push(`atrim=start_sample=${corrimiento}`, 'asetpts=PTS-STARTPTS')
  else if (demora < 0 && corrimiento) filtros.push(`adelay=delays=${corrimiento}S:all=1`)
  // mismo largo exacto que la original
  filtros.push(`apad=whole_len=${frames}`, `atrim=end_sample=${frames}`)
  const tmp = `${salida}.${process.pid}.tmp.wav`
  fs.mkdirSync(path.dirname(salida), { recursive: true })
  try {
    await correr(['-i', entrada, '-vn', '-map_metadata', '-1', '-fflags', '+bitexact', '-af', filtros.join(','), '-c:a', 'pcm_s16le', '-f', 'wav', tmp], null, alIniciar)
    const hecha = leerInfoWav(tmp)
    if (totalFrames(hecha) !== frames || hecha.sampleRate !== info.sampleRate) throw new Error('la pista transpuesta no quedó del mismo largo')
    fs.renameSync(tmp, salida)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// ---- trabajos por cancion ----

export interface OpcionesTonos {
  /** las canciones abiertas (las del setlist) */
  abiertos(): Proyecto[]
  /** esta cancion esta sonando (no se le cambia el audio hasta que pare) */
  sonando(proyectoId: string): boolean
  algoSuena(): boolean
  /** la cancion ya suena en el tono nuevo (guardar y avisar) */
  aplicado(p: Proyecto): void
  progreso(p: ProgresoTono): void
  /** no se pudo preparar: la cancion queda en el tono que tenia */
  fallo(p: Proyecto, mensaje: string): void
  dirProyecto?(id: string): string
}

interface Trabajo {
  proyecto: Proyecto
  semitonos: number
  revision: number
  total: number
  hechos: string[]
  procesos: Set<ChildProcess>
  cancelado: boolean
  terminado: boolean
}

export class Tonos {
  private trabajos = new Map<string, Trabajo>()
  private esperarHasta = new Map<string, number>()
  private fallidas = new Set<string>()
  private bloqueados = new Map<string, number>()
  private activos = 0
  private reloj: NodeJS.Timeout
  private pronto: NodeJS.Timeout | null = null

  constructor(private o: OpcionesTonos) {
    this.reloj = setInterval(() => this.revisar(), 1000)
    this.reloj.unref()
  }

  private dir(id: string): string {
    return this.o.dirProyecto?.(id) ?? projectDir(id)
  }

  /** El director eligio otro tono: se prepara (o se vuelve al original enseguida). */
  pedir(p: Proyecto, semitonos: number): void {
    p.tono = semitonos
    for (const k of [...this.fallidas]) if (k.startsWith(`${p.id}:`)) this.fallidas.delete(k)
    const t = this.trabajos.get(p.id)
    if (t && t.semitonos !== semitonos) this.cancelar(p.id)
    this.esperarHasta.set(p.id, semitonos === 0 ? 0 : Date.now() + ESPERA_MS)
    this.revisarPronto(semitonos === 0 ? 0 : ESPERA_MS + 20)
  }

  /** Lo que se esta preparando de una cancion (null = nada). */
  preparando(proyectoId: string): ProgresoTono | null {
    const t = this.trabajos.get(proyectoId)
    return t ? { proyectoId, semitonos: t.semitonos, hechos: t.hechos.length, total: t.total } : null
  }

  /** Mientras se reemplaza el audio de una cancion (zip actualizado) no se prepara nada de ella. */
  async durante<T>(proyectoId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (!proyectoId) return fn()
    this.bloqueados.set(proyectoId, (this.bloqueados.get(proyectoId) ?? 0) + 1)
    this.cancelar(proyectoId)
    try {
      return await fn()
    } finally {
      const n = (this.bloqueados.get(proyectoId) ?? 1) - 1
      if (n > 0) this.bloqueados.set(proyectoId, n)
      else this.bloqueados.delete(proyectoId)
      this.revisarPronto(0)
    }
  }

  cancelar(proyectoId: string): void {
    const t = this.trabajos.get(proyectoId)
    if (!t) return
    t.cancelado = true
    for (const proc of t.procesos) proc.kill('SIGKILL')
    this.trabajos.delete(proyectoId)
  }

  cerrar(): void {
    clearInterval(this.reloj)
    if (this.pronto) clearTimeout(this.pronto)
    for (const id of [...this.trabajos.keys()]) this.cancelar(id)
  }

  revisarPronto(ms: number): void {
    if (this.pronto) clearTimeout(this.pronto)
    this.pronto = setTimeout(() => {
      this.pronto = null
      this.revisar()
    }, ms)
    this.pronto.unref()
  }

  /** Pone cada cancion abierta en el tono pedido: prepara lo que falta y aplica lo que ya esta listo. */
  revisar(): void {
    const proyectos = new Map(this.o.abiertos().map((p) => [p.id, p]))
    // lo que se estaba preparando de una cancion que se cerro se termina igual
    for (const [id, t] of this.trabajos) if (!proyectos.has(id)) proyectos.set(id, t.proyecto)
    for (const p of proyectos.values()) {
      try {
        this.revisarUno(p)
      } catch (err) {
        console.error('[tono]', p.id, err)
      }
    }
  }

  private revisarUno(p: Proyecto): void {
    if (this.bloqueados.has(p.id)) return
    const quiere = esTonoValido(p.tono) ? p.tono : 0
    const suena = p.tonoAplicado ?? 0
    let t = this.trabajos.get(p.id)
    if (t && (t.semitonos !== quiere || t.revision !== (p.revision ?? 0))) {
      this.cancelar(p.id)
      t = undefined
    }
    if (t) {
      if (t.terminado && !this.o.sonando(p.id)) {
        this.trabajos.delete(p.id)
        // (si no salio ninguna de las que faltaban del tono que ya suena, no hay nada nuevo que cargar)
        if (suena !== quiere || t.hechos.length) this.aplicar(p, quiere, [...(suena === quiere ? (p.tonoPistas ?? []) : []), ...t.hechos])
      }
      return
    }
    if (quiere === 0) {
      if (suena !== 0 && !this.o.sonando(p.id)) this.aplicar(p, 0, [])
      return
    }
    const faltan = pistasQueCambianDeTono(p).filter(
      (x) => !(suena === quiere && p.tonoPistas?.includes(x.id)) && !this.fallidas.has(`${p.id}:${p.revision ?? 0}:${quiere}:${x.id}`)
    )
    if (suena === quiere && faltan.length === 0) return
    if ((this.esperarHasta.get(p.id) ?? 0) > Date.now()) return
    if (faltan.length === 0) {
      // nada que transponer (solo click, guia o bateria)
      if (!this.o.sonando(p.id)) this.aplicar(p, quiere, [])
      return
    }
    void this.preparar(p, quiere, faltan)
  }

  private aplicar(p: Proyecto, semitonos: number, pistas: string[]): void {
    p.tonoAplicado = semitonos
    p.tonoPistas = semitonos ? [...new Set(pistas)] : []
    p.revision = (p.revision ?? 0) + 1
    this.o.aplicado(p)
    this.limpiar(p)
  }

  /** Borra las pistas de tonos que ya no se usan (solo queda el ultimo de cada cancion). */
  private limpiar(p: Proyecto): void {
    const base = path.join(this.dir(p.id), DIR_TONO)
    let entradas: string[]
    try {
      entradas = fs.readdirSync(base)
    } catch {
      return
    }
    const quedan = new Set([p.tonoAplicado, this.trabajos.get(p.id)?.semitonos].filter((n) => n).map(String))
    for (const e of entradas) {
      if (quedan.has(e)) continue
      try {
        fs.rmSync(path.join(base, e), { recursive: true, force: true })
      } catch {
        // un archivo todavia abierto (Windows): se borra la proxima vez
      }
    }
    try {
      if (fs.readdirSync(base).length === 0) fs.rmdirSync(base)
    } catch {
      // queda la carpeta vacia
    }
  }

  private async lugar(t: Trabajo): Promise<boolean> {
    while (!t.cancelado && this.activos >= (this.o.algoSuena() ? 1 : HILOS)) await new Promise((r) => setTimeout(r, 150))
    if (t.cancelado) return false
    this.activos++
    return true
  }

  private async preparar(p: Proyecto, semitonos: number, pistas: Pista[]): Promise<void> {
    const t: Trabajo = {
      proyecto: p,
      semitonos,
      revision: p.revision ?? 0,
      total: pistas.length,
      hechos: [],
      procesos: new Set(),
      cancelado: false,
      terminado: false
    }
    this.trabajos.set(p.id, t)
    const dir = this.dir(p.id)
    const destino = path.join(dir, DIR_TONO, String(semitonos))
    const fallas: string[] = []
    this.o.progreso({ proyectoId: p.id, semitonos, hechos: 0, total: t.total })
    await enParalelo(pistas, HILOS, async (pista) => {
      if (!(await this.lugar(t))) return
      try {
        await transponerPista(path.join(dir, pista.archivo), path.join(destino, pista.archivo), semitonos, pareceVoz(pista.nombre), (proc) => {
          t.procesos.add(proc)
          proc.on('close', () => t.procesos.delete(proc))
        })
        if (t.cancelado) return
        t.hechos.push(pista.id)
        this.o.progreso({ proyectoId: p.id, semitonos, hechos: t.hechos.length, total: t.total })
      } catch (err) {
        if (t.cancelado) return
        fallas.push(`${pista.nombre}: ${(err as Error).message}`)
        this.fallidas.add(`${p.id}:${t.revision}:${semitonos}:${pista.id}`)
      } finally {
        this.activos--
      }
    })
    if (t.cancelado || this.trabajos.get(p.id) !== t) return
    if (fallas.length) {
      console.error('[tono]', p.nombre, fallas)
      if (semitonos !== (p.tonoAplicado ?? 0)) {
        // queda en el tono que tenia (nunca a medias)
        this.trabajos.delete(p.id)
        p.tono = p.tonoAplicado ?? 0
        this.o.fallo(p, fallas[0])
        return
      }
      // faltaban algunas pistas del tono que ya suena: se usan las que salieron (las otras quedan como estaban)
    }
    t.terminado = true
    this.revisarPronto(0)
  }
}
