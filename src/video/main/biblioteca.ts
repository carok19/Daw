import fs from 'node:fs'
import path from 'node:path'
import type { VideoGuardado } from '../tipos'

const EXTENSIONES = ['.mp4', '.m4v', '.mov', '.webm', '.mkv']

export function esVideo(ruta: string): boolean {
  return EXTENSIONES.includes(path.extname(ruta).toLowerCase())
}

/**
 * Los videos de esta compu: cada uno copiado en la carpeta del programa (asi
 * no se pierde si se mueve el original) y vinculado a una cancion de
 * AirTracks, con su desfase. Se guarda en videos.json.
 */
export class BibliotecaVideos {
  videos: VideoGuardado[] = []
  readonly dir: string
  private readonly archivoLista: string

  constructor(base: string) {
    this.dir = path.join(base, 'videos')
    this.archivoLista = path.join(base, 'videos.json')
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      const datos = JSON.parse(fs.readFileSync(this.archivoLista, 'utf-8')) as VideoGuardado[]
      this.videos = Array.isArray(datos) ? datos.filter((v) => v && typeof v.proyectoId === 'string' && typeof v.archivo === 'string') : []
    } catch {
      this.videos = []
    }
    // un video que quedo a mitad de alinear (se cerro el programa): se vuelve a intentar
    for (const v of this.videos) if (v.estado === 'alineando') v.estado = 'sin-conexion'
  }

  private guardar(): void {
    fs.writeFileSync(this.archivoLista, JSON.stringify(this.videos, null, 2))
  }

  ruta(v: Pick<VideoGuardado, 'archivo'>): string {
    return path.join(this.dir, path.basename(v.archivo))
  }

  de(proyectoId: string): VideoGuardado | null {
    return this.videos.find((v) => v.proyectoId === proyectoId) ?? null
  }

  /** Copia el video y lo vincula a la cancion (si ya tenia uno, lo reemplaza). */
  async agregar(origen: string, proyectoId: string, cancion: string): Promise<VideoGuardado> {
    if (!esVideo(origen)) throw new Error('No es un video (mp4, mov, webm o mkv)')
    const archivo = `${proyectoId}-${Date.now().toString(36)}${path.extname(origen).toLowerCase()}`
    await fs.promises.copyFile(origen, path.join(this.dir, archivo))
    const anterior = this.de(proyectoId)
    if (anterior) this.borrarArchivos(anterior)
    const v: VideoGuardado = {
      proyectoId,
      cancion,
      archivo,
      nombreArchivo: path.basename(origen),
      duracionSeg: 0,
      desfaseMs: null,
      alineacion: null,
      estado: 'alineando',
      agregado: new Date().toISOString()
    }
    this.videos = [...this.videos.filter((x) => x.proyectoId !== proyectoId), v].sort((a, b) => a.cancion.localeCompare(b.cancion))
    this.guardar()
    return v
  }

  quitar(proyectoId: string): void {
    const v = this.de(proyectoId)
    if (!v) return
    this.borrarArchivos(v)
    this.videos = this.videos.filter((x) => x.proyectoId !== proyectoId)
    this.guardar()
  }

  actualizar(proyectoId: string, cambio: Partial<VideoGuardado>): void {
    const v = this.de(proyectoId)
    if (!v) return
    Object.assign(v, cambio)
    this.guardar()
  }

  /** Huella del audio del video (calculada una vez). */
  rutaHuella(proyectoId: string): string {
    return path.join(this.dir, `${proyectoId}.huella`)
  }

  private borrarArchivos(v: VideoGuardado): void {
    for (const r of [this.ruta(v), this.rutaHuella(v.proyectoId)]) fs.rmSync(r, { force: true })
  }
}
