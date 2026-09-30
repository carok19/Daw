import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AnuncioSalto, InfoVoces, Proyecto } from '../shared/types'
import { clavesDeArchivoDeVoz, type PlanAnuncio } from '../shared/anuncio'
import { esClickOGuia, pareceNombreDeClick, pareceNombreDeGuia } from '../shared/mezcla'
import { decodePcmSegment } from '../shared/wav'
import { appBaseDir } from './projects'
import { convertirVoz, encabezadoWav16, enParalelo, EXTENSIONES_AUDIO, leerInfoWav } from './audio'
import { ErrorComprimido, extraerComprimido, primerVolumen, type ArchivoExtraido } from './comprimidos'

/**
 * Voces que avisan a que seccion se salta ("Coro… 3, 4"), ver shared/anuncio.ts.
 *
 * La app trae voces en espanol ("de fabrica": las secciones y los numeros de
 * los recursos gratuitos "Click and Guide Samples" de Secuencias.com, en
 * recursos/voces-es). Se puede importar otro pack (un .zip o .rar con un
 * archivo por seccion: "Coro.wav", "Spanish - Coro 2 (Chorus 2).wav",
 * "Spanish - 3.wav"...; si trae varios idiomas se usa el espanol, si no hay,
 * el ingles): queda en ~/MultitrackApp/voces y se usa en lugar de las de
 * fabrica; si se borra, vuelven las de fabrica. Cada voz es un WAV mono, con
 * un indice de que nombre es cada una y donde empieza y termina lo hablado.
 */

export const SR_VOCES = 48000

interface Voz {
  claves: string[]
  archivo: string
  /** donde empieza a hablar dentro del archivo (ms) y cuanto dura lo hablado */
  inicioMs: number
  vozMs: number
}

interface Indice {
  idioma: InfoVoces['idioma']
  activo: boolean
  voces: Voz[]
}

const IDIOMAS: { idioma: InfoVoces['idioma']; filtro?: string }[] = [
  { idioma: 'es', filtro: 'spanish|espa[nñ]ol' },
  { idioma: 'en', filtro: 'english|ingl[eé]s' },
  { idioma: 'otro' }
]

/** Con al menos una de estas es un pack de voces (y no, por ejemplo, las pistas de una cancion). */
const SECCIONES_CONOCIDAS = ['coro', 'verso', 'puente', 'intro', 'final', 'outro', 'instrumental', 'pre coro', 'chorus', 'verse', 'bridge']

const EN_ESPANOL = ['coro', 'verso', 'puente', 'pre coro', 'intro', 'final', 'outro', 'instrumental']

export class ErrorVoces extends Error {}

/** Muestras (float) de un WAV. */
function leerMuestras(ruta: string): Float32Array {
  const info = leerInfoWav(ruta)
  const buf = fs.readFileSync(ruta)
  const datos = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength)
  const copia = new Uint8Array(datos.length)
  copia.set(datos)
  return decodePcmSegment(info, copia.buffer)[0] ?? new Float32Array(0)
}

/** Donde empieza y termina lo hablado (lo que pasa de 30 dB por debajo del pico). */
function medirVoz(m: Float32Array, sr: number): { inicioMs: number; vozMs: number } {
  let pico = 0
  for (const v of m) pico = Math.max(pico, Math.abs(v))
  if (pico < 0.003) return { inicioMs: 0, vozMs: 0 }
  const umbral = pico * 0.03
  let primero = 0
  while (primero < m.length && Math.abs(m[primero]) < umbral) primero++
  let ultimo = m.length - 1
  while (ultimo > primero && Math.abs(m[ultimo]) < umbral) ultimo--
  return { inicioMs: (primero / sr) * 1000, vozMs: ((ultimo - primero + 1) / sr) * 1000 }
}

export class Voces {
  private indice: Indice | null
  /** las voces en uso son las de fabrica (no se importo ningun pack) */
  private deFabrica = false
  private muestras = new Map<string, Float32Array>()

  constructor(
    private readonly dir = path.join(appBaseDir(), 'voces'),
    /** las voces que trae la app (null = ninguna) */
    private readonly dirFabrica: string | null = null,
    /** si se apagaron las de fabrica (no se pueden tocar: estan dentro del programa) */
    private readonly archivoFabrica = path.join(appBaseDir(), 'voces-fabrica.json')
  ) {
    this.indice = this.cargar()
  }

  /** El pack importado; si no hay, las voces de fabrica. */
  private cargar(): Indice | null {
    this.muestras.clear()
    const importado = this.leerIndice(this.dir)
    this.deFabrica = !importado
    if (importado) return importado
    const fabrica = this.dirFabrica ? this.leerIndice(this.dirFabrica) : null
    if (!fabrica) return null
    let activo = true
    try {
      activo = (JSON.parse(fs.readFileSync(this.archivoFabrica, 'utf-8')) as { activo?: unknown }).activo !== false
    } catch {
      // sin eleccion: encendidas
    }
    return { ...fabrica, activo }
  }

  /** Donde estan los WAV de las voces en uso. */
  private dirEnUso(): string {
    return this.deFabrica && this.dirFabrica ? this.dirFabrica : this.dir
  }

  private leerIndice(dir: string): Indice | null {
    try {
      const i = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf-8')) as Indice
      return Array.isArray(i.voces) && i.voces.length ? { idioma: i.idioma ?? 'otro', activo: i.activo !== false, voces: i.voces } : null
    } catch {
      return null
    }
  }

  private guardarIndice(dir: string, i: Indice): void {
    const tmp = path.join(dir, `indice.json.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(i, null, 1))
    fs.renameSync(tmp, path.join(dir, 'indice.json'))
  }

  info(): InfoVoces | null {
    const i = this.indice
    if (!i) return null
    const todas = i.voces.flatMap((v) => v.claves)
    return {
      idioma: i.idioma,
      activo: i.activo,
      deFabrica: this.deFabrica,
      cantidad: i.voces.length,
      numeros: todas.includes('3') && todas.includes('4'),
      // para mostrar: los nombres en español (si el pack no los tiene, los que tenga)
      ejemplos: (EN_ESPANOL.some((c) => todas.includes(c)) ? EN_ESPANOL : SECCIONES_CONOCIDAS).filter((c) => todas.includes(c)).slice(0, 6)
    }
  }

  activar(activo: boolean): void {
    if (!this.indice) return
    this.indice = { ...this.indice, activo }
    if (!this.deFabrica) return this.guardarIndice(this.dir, this.indice)
    fs.mkdirSync(path.dirname(this.archivoFabrica), { recursive: true })
    fs.writeFileSync(this.archivoFabrica, JSON.stringify({ activo }))
  }

  /** Borra el pack importado (vuelven las voces de fabrica, si la app las trae). */
  borrar(): void {
    fs.rmSync(this.dir, { recursive: true, force: true })
    this.indice = this.cargar()
  }

  private voz(clave: string): Voz | null {
    if (!this.indice?.activo) return null
    return this.indice.voces.find((v) => v.claves.includes(clave)) ?? null
  }

  /** Cuanto dura lo hablado de esa voz (ms); null = no esta (o las voces estan apagadas). */
  duracion(clave: string): number | null {
    return this.voz(clave)?.vozMs ?? null
  }

  /** Importa un pack de voces (.zip o .rar). Reemplaza al anterior solo si sale bien. */
  async importar(ruta: string): Promise<InfoVoces> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-voces-'))
    const nuevo = `${this.dir}.nuevo-${Date.now()}`
    try {
      let extraidos: ArchivoExtraido[] | null = null
      let idioma: InfoVoces['idioma'] = 'otro'
      for (const intento of IDIOMAS) {
        try {
          extraidos = await extraerComprimido({
            ruta: primerVolumen(ruta),
            destino: tmp,
            extensionesAudio: [...EXTENSIONES_AUDIO],
            extensionesExtra: [],
            maxPistas: 600,
            maxBytesPorPista: 50 * 1024 ** 2,
            maxBytesTotal: 2 * 1024 ** 3,
            filtro: intento.filtro
          })
          idioma = intento.idioma
          break
        } catch (err) {
          if (err instanceof ErrorComprimido && err.codigo === 'sin-pistas') continue
          throw new ErrorVoces((err as Error).message)
        }
      }
      if (!extraidos) throw new ErrorVoces('No se encontraron voces (archivos de audio) en ese archivo')

      fs.mkdirSync(nuevo, { recursive: true })
      const candidatos = extraidos
        .map((e) => ({ e, claves: clavesDeArchivoDeVoz(e.nombre) }))
        .filter((x) => x.claves.length > 0)
        .sort((a, b) => a.e.nombre.localeCompare(b.e.nombre, 'es', { numeric: true }))
      const usadas = new Set<string>()
      const voces: (Voz & { orden: number })[] = []
      await enParalelo(candidatos, 3, async ({ e, claves }, orden) => {
        // si dos archivos dicen lo mismo, queda el primero
        const libres = claves.filter((c) => !usadas.has(c))
        if (libres.length === 0) return
        for (const c of libres) usadas.add(c)
        const archivo = `${orden}.wav`
        try {
          await convertirVoz(e.ruta, path.join(nuevo, archivo), SR_VOCES)
        } catch {
          return // un archivo que no se puede leer no frena al resto
        }
        const medida = medirVoz(leerMuestras(path.join(nuevo, archivo)), SR_VOCES)
        if (medida.vozMs <= 0) return
        voces.push({ claves: libres, archivo, ...medida, orden })
      })
      if (!voces.some((v) => v.claves.some((c) => SECCIONES_CONOCIDAS.includes(c)))) {
        throw new ErrorVoces('Ese archivo no parece un pack de voces: no tiene nombres de secciones (Coro, Verso, Puente…)')
      }
      voces.sort((a, b) => a.orden - b.orden)
      const indice: Indice = { idioma, activo: true, voces: voces.map(({ orden: _, ...v }) => v) }
      this.guardarIndice(nuevo, indice)
      fs.rmSync(this.dir, { recursive: true, force: true })
      fs.renameSync(nuevo, this.dir)
      this.indice = indice
      this.deFabrica = false
      this.muestras.clear()
      return this.info()!
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(nuevo, { recursive: true, force: true })
    }
  }

  private muestrasDe(v: Voz): Float32Array {
    let m = this.muestras.get(v.archivo)
    if (!m) {
      m = leerMuestras(path.join(this.dirEnUso(), v.archivo))
      this.muestras.set(v.archivo, m)
    }
    return m
  }

  /** El audio del anuncio (mono, SR_VOCES): de `plan.desdeMs` a `plan.hastaMs`, cada voz hablando justo en su momento. */
  renderizar(plan: PlanAnuncio): Float32Array {
    const sr = SR_VOCES
    const salida = new Float32Array(Math.max(0, Math.round(((plan.hastaMs - plan.desdeMs) / 1000) * sr)))
    const fundido = Math.round(0.005 * sr)
    for (const parte of plan.partes) {
      const v = this.voz(parte.clave)
      if (!v) continue
      const m = this.muestrasDe(v)
      // desde donde empieza a hablar hasta un poco despues de que termina (sin la cola de silencio)
      const desde = Math.round((v.inicioMs / 1000) * sr)
      const hasta = Math.min(m.length, Math.round(((v.inicioMs + v.vozMs + 60) / 1000) * sr))
      const destino = Math.round(((parte.enMs - plan.desdeMs) / 1000) * sr)
      const n = Math.min(hasta - desde, salida.length - destino)
      for (let i = 0; i < n; i++) {
        const fin = n - i
        salida[destino + i] += m[desde + i] * (fin < fundido ? fin / fundido : 1)
      }
    }
    return salida
  }
}

/**
 * Arma las voces de fabrica (recursos/voces-es) desde un pack: lo importa como
 * cualquiera y deja cada voz recortada a lo hablado (con un respiro antes y
 * despues), asi pesan poco dentro del instalador.
 */
export async function armarVocesDeFabrica(pack: string, destino: string): Promise<InfoVoces> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-voces-fabrica-'))
  try {
    const voces = new Voces(path.join(tmp, 'voces'), null, path.join(tmp, 'x.json'))
    await voces.importar(pack)
    const indice = JSON.parse(fs.readFileSync(path.join(tmp, 'voces', 'indice.json'), 'utf-8')) as Indice
    fs.rmSync(destino, { recursive: true, force: true })
    fs.mkdirSync(destino, { recursive: true })
    const antes = 40
    const despues = 200
    indice.voces = indice.voces.map((v) => {
      const m = leerMuestras(path.join(tmp, 'voces', v.archivo))
      const desde = Math.max(0, Math.round(((v.inicioMs - antes) / 1000) * SR_VOCES))
      const hasta = Math.min(m.length, Math.round(((v.inicioMs + v.vozMs + despues) / 1000) * SR_VOCES))
      const recorte = m.subarray(desde, hasta)
      const datos = Buffer.alloc(recorte.length * 2)
      for (let i = 0; i < recorte.length; i++) datos.writeInt16LE(Math.round(Math.max(-1, Math.min(1, recorte[i])) * 32767), i * 2)
      fs.writeFileSync(path.join(destino, v.archivo), Buffer.concat([encabezadoWav16(1, SR_VOCES, datos.length), datos]))
      return { ...v, inicioMs: Math.round(((v.inicioMs - (desde / SR_VOCES) * 1000) * 10)) / 10 }
    })
    indice.activo = true
    fs.writeFileSync(path.join(destino, 'indice.json'), JSON.stringify(indice, null, 1))
    return voces.info()!
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * La pista con cuyo volumen y paneo suena la voz (la guia; sin guia, el click)
 * y la guia que se calla mientras tanto.
 */
export function pistasDeAnuncio(p: Proyecto): { pistaId: string | null; guiaPistaId: string | null } {
  const guia =
    p.pistas.find((x) => x.id === p.analisis?.guiaPistaId && x.rol !== 'normal') ??
    p.pistas.find((x) => x.rol === 'guia') ??
    p.pistas.find((x) => x.rol !== 'normal' && x.rol !== 'click' && pareceNombreDeGuia(x.nombre))
  const click =
    p.pistas.find((x) => x.id === p.tempo?.clickPistaId) ??
    p.pistas.find((x) => x.rol === 'click') ??
    p.pistas.find((x) => x.rol !== 'normal' && pareceNombreDeClick(x.nombre)) ??
    p.pistas.find((x) => esClickOGuia(p, x))
  return { pistaId: guia?.id ?? click?.id ?? null, guiaPistaId: guia?.id ?? null }
}

export interface AnuncioRegistrado extends AnuncioSalto {
  proyectoId: string
  /** audio del anuncio (mono, SR_VOCES) */
  muestras: Float32Array
}

/** Los ultimos anuncios armados (los celulares los piden por id al mezclar; la compu, como WAV). */
export class Anuncios {
  private lista: AnuncioRegistrado[] = []
  private remuestreados = new Map<string, Float32Array>()

  registrar(a: Omit<AnuncioRegistrado, 'id'>): AnuncioRegistrado {
    const r: AnuncioRegistrado = { ...a, id: crypto.randomUUID().slice(0, 8) }
    this.lista.push(r)
    if (this.lista.length > 8) {
      const viejo = this.lista.shift()!
      for (const k of [...this.remuestreados.keys()]) if (k.startsWith(`${viejo.id}:`)) this.remuestreados.delete(k)
    }
    return r
  }

  get(id: unknown): AnuncioRegistrado | null {
    return typeof id === 'string' ? (this.lista.find((a) => a.id === id) ?? null) : null
  }

  /** El audio a la frecuencia de la cancion (interpolacion lineal; es voz). */
  muestrasA(a: AnuncioRegistrado, sr: number): Float32Array {
    if (sr === SR_VOCES) return a.muestras
    const clave = `${a.id}:${sr}`
    let m = this.remuestreados.get(clave)
    if (!m) {
      const factor = SR_VOCES / sr
      m = new Float32Array(Math.floor(a.muestras.length / factor))
      for (let i = 0; i < m.length; i++) {
        const pos = i * factor
        const i0 = Math.floor(pos)
        const i1 = Math.min(i0 + 1, a.muestras.length - 1)
        m[i] = a.muestras[i0] + (a.muestras[i1] - a.muestras[i0]) * (pos - i0)
      }
      this.remuestreados.set(clave, m)
    }
    return m
  }

  /** WAV mono de 16 bits (la compu lo suma en su propio audio). */
  wav(a: AnuncioRegistrado): Buffer {
    const datos = Buffer.alloc(a.muestras.length * 2)
    for (let i = 0; i < a.muestras.length; i++) datos.writeInt16LE(Math.round(Math.max(-1, Math.min(1, a.muestras[i])) * 32767), i * 2)
    return Buffer.concat([encabezadoWav16(1, SR_VOCES, datos.length), datos])
  }
}
