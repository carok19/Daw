import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { esVideo } from '../nombres'
import type { VideoGuardado } from '../tipos'

/** "Santo.mp4" -> "Santo.airtracks-video.json": a que cancion va y su alineacion */
export const EXT_FICHA_VIDEO = '.airtracks-video.json'
const FORMATO = 'airtracks-video/1'

/** Lo que se guarda al lado de cada video (todo lo de VideoGuardado). */
interface FichaVideo extends VideoGuardado {
  formato: typeof FORMATO
}

/** Un nombre de archivo valido en Windows para la cancion ("Santo: en vivo" -> "Santo en vivo"). */
export function nombreDeArchivo(cancion: string): string {
  const limpio = cancion
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100)
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(limpio) || !limpio ? `Video ${limpio}`.trim() : limpio
}

const mismaCarpeta = (a: string, b: string): boolean =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)

/** Mueve un archivo (renombrando; entre discos, copiando y borrando). */
async function mover(de: string, a: string): Promise<void> {
  try {
    await fs.promises.rename(de, a)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.promises.copyFile(de, a)
    await fs.promises.rm(de, { force: true })
  }
}

function escribirSeguro(ruta: string, datos: string): void {
  const tmp = `${ruta}.${process.pid}.tmp`
  fs.writeFileSync(tmp, datos)
  fs.renameSync(tmp, ruta)
}

/**
 * Los videos de esta compu, en una carpeta comun (la elige el usuario; por
 * defecto Documentos\AirTracks Video): cada video con el nombre de su cancion
 * y, al lado, una fichita con la cancion y la alineacion. La carpeta es lo
 * unico que importa: se copia a otra compu y los videos aparecen ya
 * alineados, y un video que se deja ahi a mano se vincula solo con la cancion
 * del mismo nombre (ver vincularSueltos en index.ts).
 */
export class BibliotecaVideos {
  videos: VideoGuardado[] = []
  /** videos de la carpeta que no son de ninguna cancion (todavia) */
  sueltos: string[] = []
  dir: string
  private readonly dirHuellas: string
  private vigia: fs.FSWatcher | null = null
  private escaneoProgramado: ReturnType<typeof setTimeout> | null = null
  /** tamano de cada suelto en el escaneo anterior (uno que se esta copiando todavia crece) */
  private tamanos = new Map<string, { tamano: number; desde: number }>()
  /** sueltos que ya terminaron de copiarse */
  private estables = new Set<string>()

  constructor(
    base: string,
    carpeta: string,
    private readonly alCambiar: () => void
  ) {
    this.dir = carpeta
    this.dirHuellas = path.join(base, 'huellas')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.dirHuellas, { recursive: true })
    this.migrar(base)
    this.escanear()
    this.vigilar()
  }

  /** Los videos que la version anterior guardaba adentro del programa pasan a la carpeta. */
  private migrar(base: string): void {
    const lista = path.join(base, 'videos.json')
    if (!fs.existsSync(lista)) return
    try {
      const viejos = JSON.parse(fs.readFileSync(lista, 'utf-8')) as VideoGuardado[]
      for (const v of Array.isArray(viejos) ? viejos : []) {
        if (!v || typeof v.proyectoId !== 'string' || typeof v.archivo !== 'string') continue
        const origen = path.join(base, 'videos', path.basename(v.archivo))
        if (!fs.existsSync(origen)) continue
        const archivo = this.nombreLibre(nombreDeArchivo(v.cancion), path.extname(origen))
        try {
          fs.renameSync(origen, path.join(this.dir, archivo))
        } catch {
          fs.copyFileSync(origen, path.join(this.dir, archivo))
          fs.rmSync(origen, { force: true })
        }
        this.escribirFicha({ ...v, archivo, estado: v.estado === 'alineando' ? 'sin-conexion' : v.estado })
      }
      fs.renameSync(lista, `${lista}.antes`)
      fs.rmSync(path.join(base, 'videos'), { recursive: true, force: true })
    } catch {
      // si algo fallo, queda como estaba (se intenta de nuevo al abrir)
    }
  }

  private rutaFicha(archivo: string): string {
    return path.join(this.dir, `${path.basename(archivo, path.extname(archivo))}${EXT_FICHA_VIDEO}`)
  }

  private escribirFicha(v: VideoGuardado): void {
    const ficha: FichaVideo = { formato: FORMATO, ...v }
    escribirSeguro(this.rutaFicha(v.archivo), JSON.stringify(ficha, null, 2))
  }

  /** Un nombre que no esta usado en la carpeta ("Santo.mp4", "Santo (2).mp4"...). */
  private nombreLibre(base: string, ext: string, salvo?: string): string {
    const ocupado = (n: string): boolean =>
      n !== salvo && (fs.existsSync(path.join(this.dir, n)) || fs.existsSync(this.rutaFicha(n)))
    let n = `${base}${ext.toLowerCase()}`
    for (let i = 2; ocupado(n); i++) n = `${base} (${i})${ext.toLowerCase()}`
    return n
  }

  /** Lee la carpeta: las fichas dicen que video es de que cancion; el resto son sueltos. */
  escanear(): void {
    let nombres: string[]
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      nombres = fs.readdirSync(this.dir)
    } catch {
      nombres = []
    }
    const archivos = new Set(nombres.filter((n) => !n.startsWith('.') && esVideo(n)))
    const videos: VideoGuardado[] = []
    const usados = new Set<string>()
    for (const n of nombres) {
      if (!n.toLowerCase().endsWith(EXT_FICHA_VIDEO)) continue
      try {
        const f = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf-8')) as Partial<FichaVideo>
        if (typeof f.proyectoId !== 'string' || typeof f.archivo !== 'string' || !archivos.has(f.archivo)) continue
        if (usados.has(f.archivo) || videos.some((v) => v.proyectoId === f.proyectoId)) continue
        const enMemoria = this.videos.find((v) => v.archivo === f.archivo && v.proyectoId === f.proyectoId)
        videos.push({
          proyectoId: f.proyectoId,
          cancion: typeof f.cancion === 'string' ? f.cancion : f.archivo,
          archivo: f.archivo,
          nombreArchivo: typeof f.nombreArchivo === 'string' ? f.nombreArchivo : f.archivo,
          duracionSeg: typeof f.duracionSeg === 'number' ? f.duracionSeg : 0,
          desfaseMs: typeof f.desfaseMs === 'number' ? f.desfaseMs : null,
          alineacion: f.alineacion ?? null,
          // a mitad de alinear (se cerro el programa, o se copio asi): se vuelve a intentar
          estado: enMemoria?.estado ?? (f.estado === 'alineando' || !f.estado ? 'sin-conexion' : f.estado),
          mensaje: enMemoria?.mensaje ?? f.mensaje,
          agregado: typeof f.agregado === 'string' ? f.agregado : new Date().toISOString()
        })
        usados.add(f.archivo)
      } catch {
        // ficha rota: el video queda suelto
      }
    }
    this.videos = videos.sort((a, b) => a.cancion.localeCompare(b.cancion))
    const sueltos = [...archivos].filter((a) => !usados.has(a)).sort((a, b) => a.localeCompare(b))
    // los que se estan copiando (todavia crecen o estan abiertos) se miran de nuevo en un rato
    const ahora = Date.now()
    let falta = false
    for (const a of sueltos) {
      if (this.estables.has(a)) continue
      let tamano = -1
      try {
        tamano = fs.statSync(path.join(this.dir, a)).size
        // Windows no deja abrirlo para escribir mientras el Explorador lo copia
        fs.closeSync(fs.openSync(path.join(this.dir, a), 'r+'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EBUSY') tamano = -1
      }
      const antes = this.tamanos.get(a)
      if (tamano >= 0 && antes && antes.tamano === tamano && ahora - antes.desde >= 2000) this.estables.add(a)
      else {
        if (!antes || antes.tamano !== tamano) this.tamanos.set(a, { tamano, desde: ahora })
        falta = true
      }
    }
    for (const a of [...this.estables]) if (!sueltos.includes(a)) this.estables.delete(a)
    for (const a of [...this.tamanos.keys()]) if (!sueltos.includes(a)) this.tamanos.delete(a)
    this.sueltos = sueltos.filter((a) => this.estables.has(a))
    if (falta) this.programarEscaneo(2500)
    this.alCambiar()
  }

  /** Los sueltos que todavia se estan copiando a la carpeta. */
  get copiandose(): number {
    return this.tamanos.size - [...this.tamanos.keys()].filter((a) => this.estables.has(a)).length
  }

  private programarEscaneo(ms = 800): void {
    if (this.escaneoProgramado) clearTimeout(this.escaneoProgramado)
    this.escaneoProgramado = setTimeout(() => {
      this.escaneoProgramado = null
      this.escanear()
    }, ms)
  }

  /** Mira la carpeta: lo que se agrega o se borra a mano (o con otra compu) se ve solo. */
  private vigilar(): void {
    this.vigia?.close()
    this.vigia = null
    try {
      this.vigia = fs.watch(this.dir, () => this.programarEscaneo())
      this.vigia.on('error', () => {
        this.vigia?.close()
        this.vigia = null
        setTimeout(() => this.vigilar(), 5000)
      })
    } catch {
      setTimeout(() => this.vigilar(), 5000)
    }
  }

  detener(): void {
    this.vigia?.close()
    this.vigia = null
    if (this.escaneoProgramado) clearTimeout(this.escaneoProgramado)
  }

  ruta(v: Pick<VideoGuardado, 'archivo'>): string {
    return path.join(this.dir, path.basename(v.archivo))
  }

  de(proyectoId: string): VideoGuardado | null {
    return this.videos.find((v) => v.proyectoId === proyectoId) ?? null
  }

  /**
   * Vincula un video a la cancion (si ya tenia otro, lo reemplaza). Si viene
   * de afuera se copia a la carpeta con el nombre de la cancion; si ya esta en
   * la carpeta (un suelto, o el de otra cancion) se usa ahi mismo.
   */
  async agregar(origen: string, proyectoId: string, cancion: string): Promise<VideoGuardado> {
    if (!esVideo(origen)) throw new Error('No es un video (mp4, mov, webm o mkv)')
    if (!fs.existsSync(origen)) throw new Error('No se encontró el archivo del video')
    const yaEsta = mismaCarpeta(path.dirname(origen), this.dir)
    const otro = yaEsta ? this.videos.find((v) => v.archivo === path.basename(origen)) : undefined
    const anterior = this.de(proyectoId)
    // el que tenia la cancion se borra (salvo que sea este mismo)
    if (anterior && !(yaEsta && anterior.archivo === path.basename(origen))) this.borrar(anterior)
    // un video de la carpeta que era de otra cancion: deja de serlo
    if (otro && otro.proyectoId !== proyectoId) fs.rmSync(this.rutaFicha(otro.archivo), { force: true })
    let archivo: string
    if (yaEsta) archivo = path.basename(origen)
    else {
      archivo = this.nombreLibre(nombreDeArchivo(cancion), path.extname(origen))
      // se copia con un nombre que no es de video (el escaneo no lo toma como suelto a mitad de copiar)
      const tmp = path.join(this.dir, `.${archivo}.copiando`)
      await fs.promises.copyFile(origen, tmp)
      this.escribirFicha(this.nuevo(proyectoId, cancion, archivo, path.basename(origen)))
      await fs.promises.rename(tmp, path.join(this.dir, archivo))
    }
    const v = this.nuevo(proyectoId, cancion, archivo, yaEsta ? (otro?.nombreArchivo ?? archivo) : path.basename(origen))
    this.escribirFicha(v)
    this.videos = [...this.videos.filter((x) => x.proyectoId !== proyectoId && x.archivo !== archivo), v].sort((a, b) => a.cancion.localeCompare(b.cancion))
    this.sueltos = this.sueltos.filter((a) => a !== archivo)
    this.alCambiar()
    return v
  }

  private nuevo(proyectoId: string, cancion: string, archivo: string, nombreArchivo: string): VideoGuardado {
    return {
      proyectoId,
      cancion,
      archivo,
      nombreArchivo,
      duracionSeg: 0,
      desfaseMs: null,
      alineacion: null,
      estado: 'alineando',
      agregado: new Date().toISOString()
    }
  }

  /** Copia un video a la carpeta tal cual (sin conexion: se vincula solo al conectar). */
  async copiarSuelto(origen: string): Promise<string> {
    if (!esVideo(origen)) throw new Error('No es un video (mp4, mov, webm o mkv)')
    if (mismaCarpeta(path.dirname(origen), this.dir)) return path.basename(origen)
    const ext = path.extname(origen)
    const archivo = this.nombreLibre(nombreDeArchivo(path.basename(origen, ext)), ext)
    const tmp = path.join(this.dir, `.${archivo}.copiando`)
    await fs.promises.copyFile(origen, tmp)
    await fs.promises.rename(tmp, path.join(this.dir, archivo))
    this.estables.add(archivo)
    this.escanear()
    return archivo
  }

  /** Cuando la cancion de AirTracks es otra (otra compu, se volvio a importar): el video pasa a la nueva. */
  revincular(proyectoId: string, nuevoId: string, cancion: string): void {
    const v = this.de(proyectoId)
    if (!v || this.de(nuevoId)) return
    v.proyectoId = nuevoId
    v.cancion = cancion
    this.escribirFicha(v)
    this.alCambiar()
  }

  /** Quita el video (lo borra de la carpeta, con su ficha). */
  quitar(proyectoId: string): void {
    const v = this.de(proyectoId)
    if (!v) return
    this.borrar(v)
    this.alCambiar()
  }

  /** Borra un video suelto de la carpeta. */
  borrarSuelto(archivo: string): void {
    const a = path.basename(archivo)
    if (!this.sueltos.includes(a)) return
    fs.rmSync(path.join(this.dir, a), { force: true })
    this.sueltos = this.sueltos.filter((x) => x !== a)
    this.alCambiar()
  }

  actualizar(proyectoId: string, cambio: Partial<VideoGuardado>): void {
    const v = this.de(proyectoId)
    if (!v) return
    Object.assign(v, cambio)
    this.escribirFicha(v)
    this.alCambiar()
  }

  /** Huella del audio del video (calculada una vez; si el archivo cambia, es otra). */
  rutaHuella(proyectoId: string): string | null {
    const v = this.de(proyectoId)
    if (!v) return null
    try {
      const st = fs.statSync(this.ruta(v))
      const clave = crypto.createHash('sha1').update(`${v.archivo}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20)
      return path.join(this.dirHuellas, `${clave}.huella`)
    } catch {
      return null
    }
  }

  private borrar(v: VideoGuardado): void {
    const huella = this.rutaHuella(v.proyectoId)
    for (const r of [this.ruta(v), this.rutaFicha(v.archivo), huella]) if (r) fs.rmSync(r, { force: true })
    this.videos = this.videos.filter((x) => x !== v)
  }

  /**
   * Pasa a otra carpeta: los videos (con sus fichas) se mueven alla, salvo que
   * ya haya uno con el mismo nombre (una carpeta copiada de otra compu: queda
   * la de alla). Despues se lee la nueva.
   */
  async cambiarCarpeta(nueva: string): Promise<void> {
    if (mismaCarpeta(nueva, this.dir)) return
    await fs.promises.mkdir(nueva, { recursive: true })
    const vieja = this.dir
    for (const v of this.videos) {
      for (const n of [v.archivo, path.basename(this.rutaFicha(v.archivo))]) {
        const de = path.join(vieja, n)
        const a = path.join(nueva, n)
        if (fs.existsSync(de) && !fs.existsSync(a)) await mover(de, a)
      }
    }
    for (const n of this.sueltos) {
      const a = path.join(nueva, n)
      if (!fs.existsSync(a)) await mover(path.join(vieja, n), a)
    }
    this.dir = nueva
    this.videos = []
    this.tamanos.clear()
    this.estables.clear()
    this.escanear()
    this.vigilar()
  }
}
