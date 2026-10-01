import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOTAS_PAD, type NotaPad } from '../shared/colchon'
import type { InfoPads } from '../shared/types'
import { EXTENSIONES_AUDIO, rutaFfmpeg } from './audio'
import { ErrorComprimido, esComprimido, extraerComprimido, primerVolumen } from './comprimidos'
import { SR_PAD, wavDePad } from './pads'
import { appBaseDir } from './projects'
import { prioridadBaja } from './tono'

/**
 * Pads propios para el colchón: en vez de los que sintetiza la app, los de la
 * banda. Se importa un .zip/.rar con un audio por tono (el nombre dice el
 * tono: "Pad C.wav", "Warm Pad - F#.mp3", "Pad Bb.wav", "Fondo Re.wav") o un
 * solo audio; los tonos que faltan se hacen con rubberband desde el más
 * cercano (a lo sumo 6 semitonos). De cada uno se arma un loop que empalma
 * sin corte (un tramo del medio, con un cruce largo entre el final y el
 * principio), mono a SR_PAD como los de la app, y se guarda en
 * ~/MultitrackApp/pads-propios. Se pueden apagar sin borrarlos.
 */

/** largo del loop y del cruce entre el final y el principio */
const LOOP_SEG = 40
const CRUCE_SEG = 4
/** de un archivo largo se lee esto (los pads suelen durar minutos) */
const LEER_SEG = 75

export class ErrorPads extends Error {}

interface IndicePads {
  nombre: string
  activo: boolean
  revision: string
  originales: NotaPad[]
}

const LETRAS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SOLFEO: Record<string, number> = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 }
const SOSTENIDO = /^(#|sharp|sostenido)$/i
const BEMOL = /^(b|flat|bemol)$/i

/**
 * El tono que dice el nombre de un pad ("Warm Pad - C#.wav" -> C#, "Pad_Bb" ->
 * A#, "Fondo Re.mp3" -> D, "C Sharp Pad" -> C#). Si dice varios, el último.
 * null = no dice.
 */
export function notaDeNombreDePad(nombre: string): NotaPad | null {
  const base = (nombre.split(/[\\/]/).pop() ?? nombre).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/♯/g, '#').replace(/♭/g, 'b')
  const t = base.split(/[\s_\-.,()[\]]+/).filter(Boolean)
  let ingles: number | null = null
  let espanol: number | null = null
  for (let i = 0; i < t.length; i++) {
    const sig = t[i + 1] ?? ''
    const alteracion = (a: string | undefined): number => (a === '#' || SOSTENIDO.test(sig) ? 1 : a === 'b' || BEMOL.test(sig) ? -1 : 0)
    // ingles: "C", "C#", "Db", "F#m", "Bbmaj" (mayuscula; en minuscula solo con alteracion: "c#", "eb")
    const m = /^([A-G])(#|b)?(m|min|maj|major|minor)?$/.exec(t[i]) ?? /^([a-g])(#|b)$/.exec(t[i])
    if (m) {
      ingles = LETRAS[m[1].toUpperCase()] + alteracion(m[2])
      continue
    }
    // espanol: "Do", "Re#", "Sib", "Sol menor" (con mayuscula: "la" suelto es un articulo). Al principio
    // del nombre solo si es lo unico o trae alteracion: "Mi pad.wav" es "mi pad", "Pad Mi.wav" es Mi
    const s = /^(Do|Re|Mi|Fa|Sol|La|Si|DO|RE|MI|FA|SOL|LA|SI)(#|b)?(m)?$/.exec(t[i])
    if (s && (i > 0 || t.length === 1 || s[2] || SOSTENIDO.test(sig) || BEMOL.test(sig))) espanol = SOLFEO[s[1].toLowerCase()] + alteracion(s[2])
  }
  const n = ingles ?? espanol
  return n === null ? null : NOTAS_PAD[((n % 12) + 12) % 12]
}

/** De que tono propio sale cada uno (el mas cercano; a igual distancia, bajando). */
export function fuenteDe(nota: NotaPad, originales: NotaPad[]): { desde: NotaPad; semitonos: number } {
  const i = NOTAS_PAD.indexOf(nota)
  let mejor: { desde: NotaPad; semitonos: number } | null = null
  for (const o of originales) {
    let d = (i - NOTAS_PAD.indexOf(o) + 12) % 12
    if (d > 6) d -= 12
    if (d === 6) d = -6
    if (!mejor || Math.abs(d) < Math.abs(mejor.semitonos) || (Math.abs(d) === Math.abs(mejor.semitonos) && d < mejor.semitonos)) mejor = { desde: o, semitonos: d }
  }
  return mejor!
}

/**
 * Un loop sin corte de un pad: un tramo del medio (lejos del fade in y del
 * final del archivo) y, al principio, un cruce de igual potencia con lo que
 * seguia despues del tramo: el ultimo punto del loop sigue en el primero.
 */
export function hacerLoop(x: Float32Array, sr: number): Float32Array {
  const n = x.length
  const borde = Math.min(2 * sr, Math.floor(n / 10))
  const util = n - 2 * borde
  const cruce = Math.min(CRUCE_SEG * sr, Math.floor(util / 5))
  const largo = Math.min(LOOP_SEG * sr, util - cruce)
  if (largo < 3 * sr) throw new ErrorPads('Ese pad es muy corto: tiene que durar al menos unos 5 segundos')
  const s = borde + Math.floor((util - largo - cruce) / 2)
  const y = x.slice(s, s + largo)
  for (let i = 0; i < cruce; i++) {
    const a = ((i + 0.5) / cruce) * (Math.PI / 2)
    y[i] = x[s + i] * Math.sin(a) + x[s + largo + i] * Math.cos(a)
  }
  let pico = 0
  for (const v of y) pico = Math.max(pico, Math.abs(v))
  if (pico < 1e-4) throw new ErrorPads('Ese pad está en silencio')
  // como los de la app: pico en -3 dB
  const g = 0.7 / pico
  for (let i = 0; i < y.length; i++) y[i] *= g
  return y
}

/** El audio de un pad (lo primero), mono a SR_PAD y `semitonos` mas arriba o abajo (rubberband). */
function decodificarPad(ruta: string, semitonos: number): Promise<Float32Array> {
  const ffmpeg = rutaFfmpeg()
  if (!ffmpeg) return Promise.reject(new Error('No se encontró ffmpeg'))
  const filtros = [`aresample=${SR_PAD}`, 'aformat=channel_layouts=mono']
  if (semitonos) filtros.push(`rubberband=pitch=${(2 ** (semitonos / 12)).toFixed(8)}:pitchq=quality:transients=smooth`)
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-t', String(LEER_SEG), '-i', ruta, '-vn', '-af', filtros.join(','), '-ac', '1', '-ar', String(SR_PAD), '-f', 'f32le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    prioridadBaja(proc)
    const partes: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => partes.push(d))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new ErrorPads(`No se pudo leer ${path.basename(ruta)}: ${stderr.trim().split('\n').pop() ?? code}`))
      const todo = Buffer.concat(partes)
      const m = new Float32Array(Math.floor(todo.length / 4))
      for (let i = 0; i < m.length; i++) m[i] = todo.readFloatLE(i * 4)
      resolve(m)
    })
  })
}

export class PadsPropios {
  private indice: IndicePads | null = null

  constructor(readonly dir = path.join(appBaseDir(), 'pads-propios')) {
    try {
      const i = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf-8')) as IndicePads
      if (i && Array.isArray(i.originales) && typeof i.revision === 'string') this.indice = i
    } catch {
      this.indice = null
    }
  }

  info(): InfoPads | null {
    const i = this.indice
    return i ? { nombre: i.nombre, activo: i.activo, originales: [...i.originales], revision: i.revision } : null
  }

  /** Cambia cada vez que cambian los pads que suenan (va en la direccion: nadie usa los de antes guardados). */
  revision(): string {
    return this.indice?.activo ? this.indice.revision : 'app'
  }

  /** El pad propio de esa nota (null = se usa el de la app). */
  ruta(nota: NotaPad): string | null {
    if (!this.indice?.activo) return null
    const r = path.join(this.dir, `${NOTAS_PAD.indexOf(nota)}.wav`)
    return fs.existsSync(r) ? r : null
  }

  activar(activo: boolean): void {
    if (!this.indice) return
    this.indice.activo = activo
    fs.writeFileSync(path.join(this.dir, 'indice.json'), JSON.stringify(this.indice, null, 1))
  }

  borrar(): void {
    fs.rmSync(this.dir, { recursive: true, force: true })
    this.indice = null
  }

  /**
   * Importa un pack (.zip/.rar) o un audio. Un audio cuyo nombre no dice el
   * tono: { pedirNota } (se vuelve a llamar con la nota que elige el usuario).
   */
  async importar(ruta: string, notaElegida: NotaPad | null, progreso?: (hechos: number, total: number) => void): Promise<InfoPads | { pedirNota: string }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-pads-'))
    const nuevo = `${this.dir}.nuevo-${Date.now()}`
    try {
      const fuentes = new Map<NotaPad, string>()
      if (esComprimido(ruta)) {
        let extraidos
        try {
          extraidos = await extraerComprimido({
            ruta: primerVolumen(ruta),
            destino: tmp,
            extensionesAudio: [...EXTENSIONES_AUDIO],
            extensionesExtra: [],
            maxPistas: 100,
            maxBytesPorPista: 400 * 1024 ** 2,
            maxBytesTotal: 4 * 1024 ** 3
          })
        } catch (err) {
          if (err instanceof ErrorComprimido && err.codigo === 'sin-pistas') throw new ErrorPads('No hay audios en ese archivo')
          throw new ErrorPads((err as Error).message)
        }
        const orden = [...extraidos].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }))
        for (const e of orden) {
          const nota = notaDeNombreDePad(e.nombre)
          if (nota && !fuentes.has(nota)) fuentes.set(nota, e.ruta)
        }
        if (!fuentes.size && orden.length === 1) {
          if (!notaElegida) return { pedirNota: path.basename(orden[0].nombre) }
          fuentes.set(notaElegida, orden[0].ruta)
        }
        if (!fuentes.size)
          throw new ErrorPads('No se reconoció el tono de los pads: el nombre de cada archivo tiene que decir su tono (por ejemplo “Pad C.wav”, “Pad F#.wav”, “Pad Bb.wav”)')
      } else if (EXTENSIONES_AUDIO.has(path.extname(ruta).toLowerCase())) {
        const nota = notaDeNombreDePad(path.basename(ruta)) ?? notaElegida
        if (!nota) return { pedirNota: path.basename(ruta) }
        fuentes.set(nota, ruta)
      } else throw new ErrorPads('Elegí un .zip o .rar con los pads, o un audio (WAV, MP3, M4A…)')

      const originales = NOTAS_PAD.filter((n) => fuentes.has(n))
      fs.mkdirSync(nuevo, { recursive: true })
      for (const [k, nota] of NOTAS_PAD.entries()) {
        const { desde, semitonos } = fuenteDe(nota, originales)
        const loop = hacerLoop(await decodificarPad(fuentes.get(desde)!, semitonos), SR_PAD)
        fs.writeFileSync(path.join(nuevo, `${k}.wav`), wavDePad(loop))
        progreso?.(k + 1, NOTAS_PAD.length)
      }
      const indice: IndicePads = {
        nombre: path.basename(ruta).replace(/\.[a-z0-9]{2,4}$/i, ''),
        activo: true,
        revision: crypto.randomBytes(6).toString('hex'),
        originales
      }
      fs.writeFileSync(path.join(nuevo, 'indice.json'), JSON.stringify(indice, null, 1))
      fs.rmSync(this.dir, { recursive: true, force: true })
      fs.renameSync(nuevo, this.dir)
      this.indice = indice
      return this.info()!
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(nuevo, { recursive: true, force: true })
    }
  }
}
