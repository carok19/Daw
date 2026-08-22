import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Proyecto, ProyectoResumen } from '../shared/types'

/**
 * ~/MultitrackApp/proyectos/<id>/
 * Se puede sobreescribir con MULTITRACK_APP_DIR (usado por los tests del servidor).
 */
export function projectsBaseDir(): string {
  const base = process.env.MULTITRACK_APP_DIR || path.join(os.homedir(), 'MultitrackApp')
  return path.join(base, 'proyectos')
}

export function projectDir(id: string): string {
  return path.join(projectsBaseDir(), id)
}

export function projectAudioDir(id: string): string {
  return path.join(projectDir(id), 'audio')
}

export function projectJsonPath(id: string): string {
  return path.join(projectDir(id), 'proyecto.json')
}

export function ensureBaseDir(): void {
  fs.mkdirSync(projectsBaseDir(), { recursive: true })
}

export function saveProyecto(proyecto: Proyecto): void {
  fs.mkdirSync(projectDir(proyecto.id), { recursive: true })
  fs.writeFileSync(projectJsonPath(proyecto.id), JSON.stringify(proyecto, null, 2), 'utf-8')
}

export function loadProyecto(id: string): Proyecto {
  const raw = fs.readFileSync(projectJsonPath(id), 'utf-8')
  return JSON.parse(raw) as Proyecto
}

export function proyectoExiste(id: string): boolean {
  return fs.existsSync(projectJsonPath(id))
}

export function listProyectos(): ProyectoResumen[] {
  ensureBaseDir()
  const entries = fs.readdirSync(projectsBaseDir(), { withFileTypes: true })
  const resumenes: ProyectoResumen[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const proyecto = loadProyecto(entry.name)
      resumenes.push({
        id: proyecto.id,
        nombre: proyecto.nombre,
        creadoEn: proyecto.creadoEn,
        duracionTotalMs: proyecto.duracionTotalMs,
        cantidadPistas: proyecto.pistas.length,
        cantidadMarcadores: proyecto.marcadores.length
      })
    } catch {
      // carpeta corrupta o incompleta: se ignora
    }
  }
  resumenes.sort((a, b) => a.nombre.localeCompare(b.nombre))
  return resumenes
}

export function deleteProyecto(id: string): void {
  const dir = projectDir(id)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Ruta URL (servida por Express estatico) para el audio de una pista. */
export function audioUrlPath(proyectoId: string, archivoRelativo: string): string {
  return `/media/${proyectoId}/${archivoRelativo.split(path.sep).join('/')}`
}
