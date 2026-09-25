import fs from 'node:fs'
import path from 'node:path'
import type { Proyecto } from '../shared/types'
import { coeficientesPaneo, SEGMENTO_SEC, type CanalMezcla } from '../shared/mezcla'
import { bytesPorFrame, decodePcmSegment, parseWavHeader, totalFrames, WAV_HEADER_FETCH_BYTES, type WavInfo } from '../shared/wav'

/**
 * Mezcla, en la compu, el segmento `indice` (2 s) de una cancion con la mezcla
 * que pide cada celular, y lo devuelve como un WAV estereo de 16 bits.
 *
 * - No bloquea el servidor: se cede el turno entre pista y pista (los
 *   mensajes de sincronizacion siguen saliendo a tiempo).
 * - Cache chica en memoria: los celulares con la misma mezcla (lo mas comun)
 *   comparten los segmentos, y dos pedidos iguales al mismo tiempo se
 *   calculan una sola vez.
 * - Si la suma pasa de 0 dB, un limitador suave en el ultimo 10% evita el
 *   recorte duro (hasta ahi es identico a lo que hacia el celular).
 */

interface InfoPista {
  ruta: string
  info: WavInfo
  frames: number
}

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
/** Mezclas calculandose a la vez: mas no es mas rapido (es CPU) y harian esperar a los mensajes de sync. */
const MEZCLAS_A_LA_VEZ = 2
const cederTurno = (): Promise<void> => new Promise((r) => setImmediate(r))

export class Mezclador {
  private infos = new Map<string, Promise<InfoPista>>()
  private cache = new Map<string, SegmentoMezclado>()
  private bytesEnCache = 0
  private enCurso = new Map<string, Promise<SegmentoMezclado | null>>()
  private stats = { pedidos: 0, aciertosCache: 0, mezclados: 0, msTotal: 0, msMax: 0, bytes: 0 }
  private activas = 0
  private enEspera: (() => void)[] = []

  constructor(private readonly dirProyecto: (id: string) => string) {}

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
    if (this.activas >= MEZCLAS_A_LA_VEZ) await new Promise<void>((r) => this.enEspera.push(r))
    this.activas++
    try {
      return await this.mezclarYa(proyecto, indice, canales)
    } finally {
      this.activas--
      this.enEspera.shift()?.()
    }
  }

  private async mezclarYa(proyecto: Proyecto, indice: number, canales: CanalMezcla[]): Promise<SegmentoMezclado | null> {
    const t0 = performance.now()
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

    const L = new Float32Array(cantidad)
    const R = new Float32Array(cantidad)
    for (const canal of canales) {
      const pista = infos.get(canal.pistaId)
      if (!pista || canal.ganancia <= 0) continue
      await sumarPista(pista, canal, sr, desde, cantidad, L, R)
      await cederTurno()
    }

    const wav = aWav16(L, R, sr)
    const ms = performance.now() - t0
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

/** Lee `frames` frames desde `desdeFrame` (lo que exista: al final de la pista, menos). */
async function leerFrames(pista: InfoPista, desdeFrame: number, frames: number): Promise<Buffer> {
  const bpf = bytesPorFrame(pista.info)
  const hasta = Math.min(pista.frames, desdeFrame + frames)
  if (hasta <= desdeFrame) return Buffer.alloc(0)
  const largo = (hasta - desdeFrame) * bpf
  // memoria propia (offset 0): se puede ver como Int16Array sin copiar
  const buf = Buffer.from(new ArrayBuffer(largo))
  const fh = await fs.promises.open(pista.ruta, 'r')
  try {
    let leidos = 0
    while (leidos < largo) {
      const { bytesRead } = await fh.read(buf, leidos, largo - leidos, pista.info.dataOffset + desdeFrame * bpf + leidos)
      if (bytesRead <= 0) break
      leidos += bytesRead
    }
    return leidos === largo ? buf : buf.subarray(0, leidos - (leidos % bpf))
  } finally {
    await fh.close()
  }
}

/** Canales de la pista como Float32 (-1..1). Camino rapido para PCM 16 bits (el formato de las canciones importadas). */
function aFloat(pista: InfoPista, bytes: Buffer): Float32Array[] {
  const ch = pista.info.numChannels
  const frames = Math.floor(bytes.length / bytesPorFrame(pista.info))
  if (pista.info.audioFormat === 1 && pista.info.bitsPerSample === 16 && bytes.byteOffset % 2 === 0) {
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, frames * ch)
    const res = Array.from({ length: ch }, () => new Float32Array(frames))
    for (let c = 0; c < ch; c++) {
      const out = res[c]
      for (let i = 0, j = c; i < frames; i++, j += ch) out[i] = s[j] / 32768
    }
    return res
  }
  const copia = new Uint8Array(frames * bytesPorFrame(pista.info))
  copia.set(bytes.subarray(0, copia.length))
  return decodePcmSegment(pista.info, copia.buffer)
}

async function sumarPista(pista: InfoPista, canal: CanalMezcla, sr: number, desde: number, cantidad: number, L: Float32Array, R: Float32Array): Promise<void> {
  const ch = Math.min(2, pista.info.numChannels)
  const { aLL, aLR, aRL, aRR } = coeficientesPaneo(canal.pan, ch)
  const g = canal.ganancia
  const srPista = pista.info.sampleRate

  // camino rapido (las canciones importadas: PCM 16 bits): se suma directo desde los enteros, sin copias
  if (srPista === sr && pista.info.audioFormat === 1 && pista.info.bitsPerSample === 16 && pista.info.numChannels <= 2) {
    const bytes = await leerFrames(pista, desde, cantidad)
    const n = Math.min(cantidad, Math.floor(bytes.length / (2 * ch)))
    const s = new Int16Array(bytes.buffer, bytes.byteOffset, n * ch)
    const k = g / 32768
    if (ch === 1) {
      const gl = k * aLL
      const gr = k * aRR
      for (let i = 0; i < n; i++) {
        const x = s[i]
        L[i] += x * gl
        R[i] += x * gr
      }
    } else {
      const a = k * aLL
      const b = k * aLR
      const c = k * aRL
      const d = k * aRR
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const l = s[j]
        const r = s[j + 1]
        L[i] += a * l + b * r
        R[i] += c * l + d * r
      }
    }
    return
  }

  // otros formatos u otra frecuencia de muestreo (raro): a float e interpolacion lineal
  const factor = srPista / sr
  const base = Math.floor(desde * factor) // primer frame (de la pista) leido
  const necesarios = Math.ceil((desde + cantidad) * factor) - base + 2
  const canalesF = aFloat(pista, await leerFrames(pista, base, necesarios))
  const entradaL = canalesF[0] ?? new Float32Array(0)
  const entradaR = canalesF[ch === 2 ? 1 : 0] ?? entradaL
  const disponibles = entradaL.length
  for (let i = 0; i < cantidad; i++) {
    const pos = (desde + i) * factor - base
    const i0 = Math.floor(pos)
    if (i0 >= disponibles) break
    const f = pos - i0
    const i1 = Math.min(i0 + 1, disponibles - 1)
    const l = entradaL[i0] + (entradaL[i1] - entradaL[i0]) * f
    if (ch === 1) {
      L[i] += l * g * aLL
      R[i] += l * g * aRR
    } else {
      const r = entradaR[i0] + (entradaR[i1] - entradaR[i0]) * f
      L[i] += g * (aLL * l + aLR * r)
      R[i] += g * (aRL * l + aRR * r)
    }
  }
}

/** Limitador suave: lineal hasta 0,9 y despues se acerca a 1 sin pasarse (sin recorte duro). */
function limitar(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.9) return x
  const y = 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1)
  return x < 0 ? -y : y
}

function aWav16(L: Float32Array, R: Float32Array, sr: number): Buffer {
  const frames = L.length
  const datos = frames * 4
  const buf = Buffer.alloc(44 + datos)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + datos, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sr, 24)
  buf.writeUInt32LE(sr * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(datos, 40)
  const s = new Int16Array(buf.buffer, buf.byteOffset + 44, frames * 2)
  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    s[j] = Math.round(limitar(L[i]) * 32767)
    s[j + 1] = Math.round(limitar(R[i]) * 32767)
  }
  return buf
}
