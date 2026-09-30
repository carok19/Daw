import fs from 'node:fs'
import path from 'node:path'
import { NOTAS_PAD, type NotaPad } from '../shared/colchon'
import { encabezadoWav16 } from './audio'
import { appBaseDir } from './projects'

/**
 * Pads de ambiente para el colchón (ver shared/colchon.ts), sintetizados por
 * la app: sin samples ni licencias, sin internet, en los 12 tonos.
 *
 * Raíz + quinta + octava (y un poco de brillo arriba), sin tercera: sirve
 * igual con los acordes mayores y menores de la tonalidad. Cada nota son tres
 * osciladores apenas desafinados (coro), con un filtro que "respira" despacio
 * y una reverb larga.
 *
 * Es un loop de LARGO_SEG que se repite sin corte: todas las frecuencias (las
 * notas, el vibrato y el filtro) dan vueltas enteras en ese tiempo, y se
 * guarda la segunda vuelta (la reverb y el filtro ya en régimen), así el final
 * empalma con el principio. Mono (va del lado de la banda) a 22 kHz: un pad no
 * necesita más, y cada celular baja 1,4 MB por tono.
 *
 * Se sintetiza una vez por nota (unos segundos, cediendo el turno para no
 * frenar al servidor) y queda en ~/MultitrackApp/pads.
 */

export const LARGO_SEG = 32
export const SR_PAD = 22050
/** Cambia si cambia el sonido (los de antes se vuelven a sintetizar). */
const VERSION = 1

/** Raíz en la octava de 65 a 123 Hz (C2..B2). */
function raizDe(nota: NotaPad): number {
  const i = NOTAS_PAD.indexOf(nota)
  return 65.40639 * 2 ** (i / 12)
}

const TABLA = 4096
/** Forma de onda (seno con dos armónicos suaves), en una tabla. */
const ONDA = (() => {
  const t = new Float32Array(TABLA + 1)
  for (let i = 0; i <= TABLA; i++) {
    const f = (2 * Math.PI * i) / TABLA
    t[i] = Math.sin(f) + 0.18 * Math.sin(2 * f) + 0.06 * Math.sin(3 * f)
  }
  return t
})()

const cederTurno = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Una frecuencia que da vueltas enteras en el loop (a lo sumo 1/LARGO_SEG Hz de diferencia). */
const enLoop = (f: number): number => Math.max(1, Math.round(f * LARGO_SEG)) / LARGO_SEG

/** El loop del pad (mono, SR_PAD), con el pico en −3 dB. */
export async function sintetizarPad(nota: NotaPad): Promise<Float32Array> {
  const sr = SR_PAD
  const n = LARGO_SEG * sr
  const total = 2 * n
  const raiz = raizDe(nota)
  // raiz, quinta, octava, quinta arriba, dos octavas, brillo
  const voces: [number, number][] = [
    [1, 0.5],
    [1.5, 0.32],
    [2, 0.34],
    [3, 0.14],
    [4, 0.1],
    [6, 0.05]
  ]
  const osc = voces.flatMap(([mult, amp], v) =>
    [-1, 0, 1].map((d) => ({
      f: enLoop(raiz * mult * (1 + d * 0.0035)),
      amp: amp * 0.11,
      fase: ((v * 3 + d + 1) * 0.618) % 1,
      vibrato: enLoop(0.13 + (d + 1) * 0.05),
      faseVibrato: ((v + d) * 0.37) % 1
    }))
  )
  const respiro = enLoop(0.05)
  const x = new Float32Array(total)
  const bloque = 4096
  // osciladores (con tabla de onda) y un filtro pasabajos que abre y cierra despacio
  let y = 0
  for (let a = 0; a < total; a += bloque) {
    const b = Math.min(total, a + bloque)
    for (const o of osc) {
      let fase = o.fase
      for (let i = a; i < b; i++) {
        const t = i / sr
        const vib = 1 + 0.0012 * Math.sin(2 * Math.PI * (o.vibrato * t + o.faseVibrato))
        fase += (o.f * vib) / sr
        fase -= Math.floor(fase)
        const p = fase * TABLA
        const k = p | 0
        x[i] += (ONDA[k] + (ONDA[k + 1] - ONDA[k]) * (p - k)) * o.amp
      }
      o.fase = fase
    }
    for (let i = a; i < b; i++) {
      const corte = 900 + 500 * Math.sin(2 * Math.PI * respiro * (i / sr))
      y += (1 - Math.exp((-2 * Math.PI * corte) / sr)) * (x[i] - y)
      x[i] = y
    }
    await cederTurno()
  }
  // reverb larga: cuatro lineas de retardo realimentadas y cruzadas
  const lineas = [1553, 2089, 2663, 3347].map((d) => ({ b: new Float32Array(Math.round((d * sr) / 44100)), i: 0 }))
  const salida = new Float32Array(n)
  for (let a = 0; a < total; a += bloque) {
    const b = Math.min(total, a + bloque)
    for (let i = a; i < b; i++) {
      let suma = 0
      for (const l of lineas) suma += l.b[l.i]
      suma *= 0.5
      let humedo = 0
      for (let k = 0; k < lineas.length; k++) {
        const l = lineas[k]
        const s = l.b[l.i]
        humedo += s
        l.b[l.i] = x[i] * 0.35 + (suma - s) * 0.62
        l.i = (l.i + 1) % l.b.length
      }
      if (i >= n) salida[i - n] = x[i] * 0.7 + humedo * 0.22
    }
    await cederTurno()
  }
  let pico = 0
  for (const v of salida) pico = Math.max(pico, Math.abs(v))
  const g = pico > 0 ? 0.7 / pico : 0
  for (let i = 0; i < n; i++) salida[i] *= g
  return salida
}

export function wavDePad(muestras: Float32Array): Buffer {
  const datos = Buffer.alloc(muestras.length * 2)
  for (let i = 0; i < muestras.length; i++) datos.writeInt16LE(Math.round(Math.max(-1, Math.min(1, muestras[i])) * 32767), i * 2)
  return Buffer.concat([encabezadoWav16(1, SR_PAD, datos.length), datos])
}

/** Los pads ya hechos (en disco) y los que se están haciendo. */
export class Pads {
  private enCurso = new Map<NotaPad, Promise<string>>()

  constructor(private readonly dir = path.join(appBaseDir(), 'pads')) {}

  /** Ruta del WAV del pad de esa nota (lo sintetiza la primera vez). */
  ruta(nota: NotaPad): Promise<string> {
    const archivo = path.join(this.dir, `v${VERSION}-${NOTAS_PAD.indexOf(nota)}.wav`)
    if (fs.existsSync(archivo)) return Promise.resolve(archivo)
    let p = this.enCurso.get(nota)
    if (!p) {
      p = sintetizarPad(nota).then((m) => {
        fs.mkdirSync(this.dir, { recursive: true })
        const tmp = `${archivo}.${process.pid}.tmp`
        fs.writeFileSync(tmp, wavDePad(m))
        fs.renameSync(tmp, archivo)
        return archivo
      })
      p.finally(() => this.enCurso.delete(nota)).catch(() => undefined)
      this.enCurso.set(nota, p)
    }
    return p
  }
}
