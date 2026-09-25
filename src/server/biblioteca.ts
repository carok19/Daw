import fs from 'node:fs'
import path from 'node:path'
import type { EstadoBiblioteca, Proyecto } from '../shared/types'
import { alGuardarProyecto, appBaseDir, loadProyecto, proyectoExiste } from './projects'
import { baseDeComprimido, esComprimido, volumenesDe } from './comprimidos'
import { escribirFicha, fichaDesdeProyecto, rutaFicha } from './ficha'

/** Tamaño y fecha de un comprimido; si es un .rar en partes, de todas juntas (asi se nota si falta copiar alguna). */
function firmaDe(abs: string): { size: number; mtimeMs: number } {
  let size = 0
  let mtimeMs = 0
  for (const v of volumenesDe(abs)) {
    const st = fs.statSync(v)
    size += st.size
    mtimeMs = Math.max(mtimeMs, st.mtimeMs)
  }
  return { size, mtimeMs }
}

/**
 * Biblioteca en carpetas: una carpeta (por defecto Documentos/Multitrack
 * Alabanza) donde cada .zip es una cancion. Se vigila sola: un zip nuevo se
 * importa, uno reemplazado se reimporta (conservando mezcla y secciones
 * puestas a mano), uno movido de subcarpeta cambia de categoria. Las
 * subcarpetas ("Adoración", "Navidad/2024") son las categorias de la lista.
 *
 * Nunca importa mientras suena una cancion (la conversion usa CPU y disco):
 * espera a que se pause o termine.
 */

interface EntradaIndice {
  proyectoId: string | null // null = la cancion se borro a proposito: no reimportar este zip
  tam: number
  mtimeMs: number
}

interface ArchivoBiblioteca {
  ruta: string | null
  archivos: Record<string, EntradaIndice>
}

export interface HooksBiblioteca {
  importar(zip: string, categoria: string, reemplazarId: string | null): Promise<Proyecto>
  moverCategoria(proyectoId: string, categoria: string): void
  /** false mientras suena una cancion */
  puedeTrabajar(): boolean
  estado(e: EstadoBiblioteca): void
  error(mensaje: string): void
}

const ESTABLE_MS = 1500
const ESCANEO_MS = 20000
const PROFUNDIDAD_MAX = 5

function archivoIndice(): string {
  return path.join(appBaseDir(), 'biblioteca.json')
}

function categoriaDe(rel: string): string {
  const dir = path.dirname(rel)
  return dir === '.' ? '' : dir.split(path.sep).join('/')
}

export class Biblioteca {
  private datos: ArchivoBiblioteca = { ruta: null, archivos: {} }
  private watcher: fs.FSWatcher | null = null
  private intervalo: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private vistos = new Map<string, { tam: number; desde: number }>()
  private cola: { rel: string; reemplazarId: string | null }[] = []
  private trabajando = false
  private importando: string | null = null
  private esperandoSilencio = false
  private ultimoError: string | null = null
  private ignorar = new Set<string>()
  private detenida = false
  /** ficha escrita por ultima vez de cada cancion (para no reescribir lo mismo) */
  private fichasEscritas = new Map<string, string>()
  private fichasPendientes = new Map<string, NodeJS.Timeout>()
  private quitarOyente: () => void

  constructor(private readonly hooks: HooksBiblioteca) {
    try {
      this.datos = JSON.parse(fs.readFileSync(archivoIndice(), 'utf-8')) as ArchivoBiblioteca
      this.datos.archivos ??= {}
    } catch {
      // primera vez
    }
    // cada vez que se guarda una cancion, su ficha en la carpeta se pone al dia
    this.quitarOyente = alGuardarProyecto((p) => this.guardarFicha(p.id))
  }

  /** Al cerrar la app: deja de vigilar y escribe las fichas que estaban por escribirse. */
  apagar(): void {
    this.detener()
    this.quitarOyente()
    for (const [id, t] of this.fichasPendientes) {
      clearTimeout(t)
      this.escribirFichaYa(id)
    }
    this.fichasPendientes.clear()
  }

  /**
   * Pone al dia la ficha (secciones, mezcla, tempo) al lado del comprimido de
   * la cancion en la carpeta. Con `ya`, enseguida; si no, con un segundo de
   * espera (mover un fader guarda muchas veces seguidas).
   */
  guardarFicha(proyectoId: string, ya = false): void {
    if (!this.datos.ruta) return
    const previo = this.fichasPendientes.get(proyectoId)
    if (previo) clearTimeout(previo)
    this.fichasPendientes.delete(proyectoId)
    if (ya) return this.escribirFichaYa(proyectoId)
    this.fichasPendientes.set(
      proyectoId,
      setTimeout(() => {
        this.fichasPendientes.delete(proyectoId)
        this.escribirFichaYa(proyectoId)
      }, 1000)
    )
  }

  private escribirFichaYa(proyectoId: string): void {
    const raiz = this.datos.ruta
    if (!raiz || !proyectoExiste(proyectoId)) return
    const rel = Object.entries(this.datos.archivos).find(([, e]) => e.proyectoId === proyectoId)?.[0]
    if (!rel || !fs.existsSync(path.join(raiz, rel))) return
    const ficha = fichaDesdeProyecto(loadProyecto(proyectoId))
    const texto = JSON.stringify(ficha)
    if (this.fichasEscritas.get(proyectoId) === texto) return
    if (escribirFicha(rutaFicha(path.join(raiz, rel)), ficha)) this.fichasEscritas.set(proyectoId, texto)
  }

  get ruta(): string | null {
    return this.datos.ruta
  }

  estado(): EstadoBiblioteca {
    return {
      ruta: this.datos.ruta,
      pendientes: this.cola.length + (this.importando ? 1 : 0),
      importando: this.importando,
      esperandoSilencio: this.esperandoSilencio,
      ultimoError: this.ultimoError
    }
  }

  /** Arranca con la carpeta guardada o, la primera vez, con `porDefecto`. */
  iniciar(porDefecto: string | null): void {
    const ruta = this.datos.ruta ?? porDefecto
    if (ruta) this.usar(ruta)
  }

  /** Cambia la carpeta de la biblioteca (las canciones ya importadas se conservan). */
  setRuta(ruta: string): void {
    if (!path.isAbsolute(ruta)) throw new Error('Ruta inválida')
    this.usar(ruta)
  }

  private usar(ruta: string): void {
    this.detener()
    this.detenida = false
    try {
      fs.mkdirSync(ruta, { recursive: true })
    } catch {
      this.ultimoError = `No se pudo usar la carpeta ${ruta}`
      this.avisar()
      return
    }
    if (this.datos.ruta !== ruta) {
      this.datos = { ruta, archivos: {} }
      this.vistos.clear()
      this.guardar()
    }
    try {
      this.watcher = fs.watch(ruta, { recursive: true }, () => this.programarEscaneo())
      this.watcher.on('error', () => undefined)
    } catch {
      // sin watch recursivo: alcanza con el escaneo periodico
    }
    this.intervalo = setInterval(() => this.escanear(), ESCANEO_MS)
    this.escanear()
    this.avisar()
  }

  detener(): void {
    this.detenida = true
    this.watcher?.close()
    this.watcher = null
    if (this.intervalo) clearInterval(this.intervalo)
    if (this.debounce) clearTimeout(this.debounce)
    this.intervalo = null
  }

  private programarEscaneo(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.escanear(), 600)
  }

  private guardar(): void {
    try {
      fs.mkdirSync(appBaseDir(), { recursive: true })
      const tmp = `${archivoIndice()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.datos, null, 2))
      fs.renameSync(tmp, archivoIndice())
    } catch {
      // no es critico
    }
  }

  private avisar(): void {
    this.hooks.estado(this.estado())
  }

  /** Canciones de la carpeta: .zip y .rar (de un .rar en partes, la primera). */
  private listarZips(): Map<string, { size: number; mtimeMs: number }> {
    const res = new Map<string, { size: number; mtimeMs: number }>()
    const raiz = this.datos.ruta
    if (!raiz) return res
    const recorrer = (dir: string, prof: number): void => {
      let entradas: fs.Dirent[]
      try {
        entradas = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entradas) {
        if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory() && prof < PROFUNDIDAD_MAX) recorrer(abs, prof + 1)
        else if (e.isFile() && esComprimido(e.name)) {
          try {
            res.set(path.relative(raiz, abs), firmaDe(abs))
          } catch {
            // se borro en el medio
          }
        }
      }
    }
    recorrer(raiz, 0)
    return res
  }

  /** Revisa la carpeta y encola lo nuevo o cambiado (solo cuando el archivo termino de copiarse). */
  escanear(): void {
    if (!this.datos.ruta) return
    const ahora = Date.now()
    const zips = this.listarZips()
    const faltantes = Object.entries(this.datos.archivos).filter(([rel]) => !zips.has(rel))
    let cambioIndice = false

    for (const [rel, st] of zips) {
      if (this.ignorar.has(rel) || this.cola.some((c) => c.rel === rel) || this.importando === rel) continue
      const ent = this.datos.archivos[rel]
      if (ent && ent.tam === st.size && ent.mtimeMs === Math.round(st.mtimeMs)) {
        this.vistos.delete(rel)
        continue
      }
      // ¿es un zip que se movio de carpeta? (mismo nombre, tamaño y fecha que uno que ya no esta)
      if (!ent) {
        const movido = faltantes.find(
          ([r, e]) => path.basename(r) === path.basename(rel) && e.tam === st.size && e.mtimeMs === Math.round(st.mtimeMs)
        )
        if (movido) {
          delete this.datos.archivos[movido[0]]
          this.datos.archivos[rel] = movido[1]
          // la ficha acompaña a su cancion
          try {
            const vieja = rutaFicha(path.join(this.datos.ruta, movido[0]))
            if (fs.existsSync(vieja)) fs.renameSync(vieja, rutaFicha(path.join(this.datos.ruta, rel)))
          } catch {
            // se reescribe en el proximo guardado
          }
          if (movido[1].proyectoId && proyectoExiste(movido[1].proyectoId)) this.hooks.moverCategoria(movido[1].proyectoId, categoriaDe(rel))
          cambioIndice = true
          continue
        }
      }
      // esperar a que termine de copiarse (tamaño estable)
      const visto = this.vistos.get(rel)
      if (!visto || visto.tam !== st.size) {
        this.vistos.set(rel, { tam: st.size, desde: ahora })
        this.programarEscaneo()
        continue
      }
      if (ahora - visto.desde < ESTABLE_MS) {
        this.programarEscaneo()
        continue
      }
      this.vistos.delete(rel)
      const reemplazarId = ent?.proyectoId && proyectoExiste(ent.proyectoId) ? ent.proyectoId : null
      this.cola.push({ rel, reemplazarId })
    }
    if (cambioIndice) this.guardar()
    this.avisar()
    void this.procesar()
  }

  private async procesar(): Promise<void> {
    if (this.trabajando) return
    this.trabajando = true
    try {
      while (this.cola.length && !this.detenida) {
        if (!this.hooks.puedeTrabajar()) {
          if (!this.esperandoSilencio) {
            this.esperandoSilencio = true
            this.avisar()
          }
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        this.esperandoSilencio = false
        const { rel, reemplazarId } = this.cola.shift()!
        const abs = path.join(this.datos.ruta!, rel)
        this.importando = rel
        this.avisar()
        try {
          const st = firmaDe(abs)
          const p = await this.hooks.importar(abs, categoriaDe(rel), reemplazarId)
          this.datos.archivos[rel] = { proyectoId: p.id, tam: st.size, mtimeMs: Math.round(st.mtimeMs) }
          this.guardar()
          this.guardarFicha(p.id, true)
          this.ultimoError = null
        } catch (err) {
          const mensaje = `${path.basename(rel)}: ${(err as Error).message}`
          this.ultimoError = mensaje
          this.hooks.error(mensaje)
          // no reintentar en cada escaneo un zip roto: queda registrado hasta que cambie
          try {
            const st = firmaDe(abs)
            this.datos.archivos[rel] = { proyectoId: null, tam: st.size, mtimeMs: Math.round(st.mtimeMs) }
            this.guardar()
          } catch {
            // se borro
          }
        } finally {
          this.importando = null
          this.avisar()
        }
      }
    } finally {
      this.trabajando = false
      this.esperandoSilencio = false
      this.avisar()
    }
  }

  /**
   * Una cancion importada con el dialogo: se guarda una copia del comprimido
   * (todas sus partes, si es un .rar en partes) en la biblioteca, ya registrada.
   */
  registrarImportada(origen: string, proyectoId: string): void {
    const raiz = this.datos.ruta
    if (!raiz) return
    const relOrigen = path.relative(raiz, origen)
    if (!relOrigen.startsWith('..') && !path.isAbsolute(relOrigen)) {
      // ya estaba dentro de la biblioteca
      const st = firmaDe(origen)
      this.datos.archivos[relOrigen] = { proyectoId, tam: st.size, mtimeMs: Math.round(st.mtimeMs) }
      this.guardar()
      this.guardarFicha(proyectoId, true)
      return
    }
    const base = baseDeComprimido(origen)
    const volumenes = volumenesDe(origen)
    // ".zip", ".part1.rar", ".r00"...: lo que sigue al nombre en cada parte
    const sufijos = volumenes.map((v) => path.basename(v).slice(base.length))
    let nuevoBase = base
    for (let n = 2; fs.existsSync(path.join(raiz, `${nuevoBase}${sufijos[0]}`)); n++) nuevoBase = `${base} (${n})`
    const rel = `${nuevoBase}${sufijos[0]}`
    this.ignorar.add(rel)
    try {
      volumenes.forEach((v, i) => fs.copyFileSync(v, path.join(raiz, `${nuevoBase}${sufijos[i]}`)))
      const st = firmaDe(path.join(raiz, rel))
      this.datos.archivos[rel] = { proyectoId, tam: st.size, mtimeMs: Math.round(st.mtimeMs) }
      this.guardar()
      this.guardarFicha(proyectoId, true)
    } catch {
      // sin copia en la biblioteca: la cancion igual quedo importada
    } finally {
      setTimeout(() => this.ignorar.delete(rel), 5000)
    }
  }

  /** Se borro una cancion: su zip queda en la carpeta, pero no se vuelve a importar solo. */
  olvidarProyecto(proyectoId: string): void {
    let cambio = false
    for (const e of Object.values(this.datos.archivos)) {
      if (e.proyectoId === proyectoId) {
        e.proyectoId = null
        cambio = true
      }
    }
    if (cambio) this.guardar()
  }
}
