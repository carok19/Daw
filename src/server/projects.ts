import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { Proyecto, ProyectoResumen, SetlistResumen } from '../shared/types'
import { FORMATO_PROYECTO_ACTUAL } from '../shared/types'
import { enParalelo, normalizarAWav } from './audio'

/**
 * ~/MultitrackApp/
 *   proyectos/<id>/proyecto.json + audio/
 *   setlists/<id>.json
 *   sesion.json          (pestanas abiertas, para recuperarlas si la app se cierra a mitad de un culto)
 * Se puede sobreescribir con MULTITRACK_APP_DIR (usado por los tests del servidor).
 */
export function appBaseDir(): string {
  return process.env.MULTITRACK_APP_DIR || path.join(os.homedir(), 'MultitrackApp')
}

export function projectsBaseDir(): string {
  return path.join(appBaseDir(), 'proyectos')
}

function setlistsDir(): string {
  return path.join(appBaseDir(), 'setlists')
}

function sesionPath(): string {
  return path.join(appBaseDir(), 'sesion.json')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Los ids llegan desde la red (Socket.IO): se validan como UUID antes de
 * armar cualquier ruta en disco, para que nadie pueda pedir `../../algo`.
 */
export function esIdValido(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id)
}

export function projectDir(id: string): string {
  if (!esIdValido(id)) throw new Error('id de proyecto invalido')
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
  fs.mkdirSync(setlistsDir(), { recursive: true })
}

/** Escritura atomica (archivo temporal + rename): un corte de luz a mitad de guardado no deja un JSON roto. */
function escribirJson(ruta: string, datos: unknown): void {
  const tmp = `${ruta}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), 'utf-8')
  fs.renameSync(tmp, ruta)
}

export function saveProyecto(proyecto: Proyecto): void {
  fs.mkdirSync(projectDir(proyecto.id), { recursive: true })
  escribirJson(projectJsonPath(proyecto.id), proyecto)
}

export function loadProyecto(id: string): Proyecto {
  const raw = fs.readFileSync(projectJsonPath(id), 'utf-8')
  return JSON.parse(raw) as Proyecto
}

export function proyectoExiste(id: string): boolean {
  return esIdValido(id) && fs.existsSync(projectJsonPath(id))
}

export function listProyectos(): ProyectoResumen[] {
  ensureBaseDir()
  const entries = fs.readdirSync(projectsBaseDir(), { withFileTypes: true })
  const resumenes: ProyectoResumen[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !esIdValido(entry.name)) continue
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
  resumenes.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  return resumenes
}

export function deleteProyecto(id: string): void {
  const dir = projectDir(id)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---- Colores de pista ----

/** Paleta de colores bien distinguibles entre si sobre fondo oscuro; se asignan por orden de pista. */
export const PALETA_PISTAS = [
  '#ff8a3d', // naranja
  '#3dbcff', // celeste
  '#a6e05a', // verde lima
  '#ff5c8a', // rosa
  '#b18cff', // violeta
  '#ffd23d', // amarillo
  '#3de0c0', // turquesa
  '#ff6b5c', // rojo coral
  '#6b8cff', // azul
  '#e07cff', // magenta
  '#8fd6a0', // verde agua
  '#d9a066' // ocre
]

export function colorPorIndice(i: number): string {
  return PALETA_PISTAS[i % PALETA_PISTAS.length]
}

// ---- Migracion de proyectos viejos ----

export function necesitaMigracion(proyecto: Proyecto): boolean {
  return (
    proyecto.formato !== FORMATO_PROYECTO_ACTUAL ||
    proyecto.pistas.some((p) => !p.archivo.toLowerCase().endsWith('.wav') || !p.color)
  )
}

/**
 * Lleva un proyecto guardado con una version anterior al formato actual:
 * convierte a WAV normalizado las pistas que no lo sean (p.ej. .mp3 que antes
 * no sonaban en los celulares), recalcula la duracion en el servidor y asigna
 * colores. Idempotente.
 */
export async function migrarProyecto(proyecto: Proyecto): Promise<Proyecto> {
  if (!necesitaMigracion(proyecto)) return proyecto
  const dir = projectDir(proyecto.id)
  const duraciones = await enParalelo(proyecto.pistas, 2, async (pista) => {
    const origen = path.join(dir, pista.archivo)
    const ext = path.extname(pista.archivo)
    const destinoRel = pista.archivo.slice(0, pista.archivo.length - ext.length) + '.wav'
    const destinoTmp = path.join(dir, destinoRel + '.norm')
    const { duracionMs } = await normalizarAWav(origen, destinoTmp)
    if (destinoRel !== pista.archivo) fs.rmSync(origen, { force: true })
    fs.renameSync(destinoTmp, path.join(dir, destinoRel))
    pista.archivo = destinoRel
    return duracionMs
  })
  proyecto.pistas.forEach((p, i) => {
    if (!p.color) p.color = colorPorIndice(i)
  })
  proyecto.duracionTotalMs = Math.max(0, ...duraciones)
  proyecto.formato = FORMATO_PROYECTO_ACTUAL
  saveProyecto(proyecto)
  return proyecto
}

// ---- Setlists ----

interface SetlistArchivo {
  id: string
  nombre: string
  creadoEn: string
  proyectos: string[]
}

function setlistPath(id: string): string {
  if (!esIdValido(id)) throw new Error('id de setlist invalido')
  return path.join(setlistsDir(), `${id}.json`)
}

export function guardarSetlist(nombre: string, proyectos: string[]): SetlistResumen {
  ensureBaseDir()
  const setlist: SetlistArchivo = {
    id: crypto.randomUUID(),
    nombre,
    creadoEn: new Date().toISOString(),
    proyectos: proyectos.filter(esIdValido)
  }
  escribirJson(setlistPath(setlist.id), setlist)
  return aResumen(setlist)
}

function aResumen(s: SetlistArchivo): SetlistResumen {
  const canciones: string[] = []
  for (const id of s.proyectos) {
    try {
      canciones.push(loadProyecto(id).nombre)
    } catch {
      // cancion borrada despues de guardar el setlist
    }
  }
  return { id: s.id, nombre: s.nombre, creadoEn: s.creadoEn, canciones }
}

export function cargarSetlist(id: string): SetlistArchivo {
  return JSON.parse(fs.readFileSync(setlistPath(id), 'utf-8')) as SetlistArchivo
}

export function listarSetlists(): SetlistResumen[] {
  ensureBaseDir()
  const lista: SetlistResumen[] = []
  for (const archivo of fs.readdirSync(setlistsDir())) {
    const id = archivo.replace(/\.json$/, '')
    if (!esIdValido(id)) continue
    try {
      lista.push(aResumen(cargarSetlist(id)))
    } catch {
      // archivo roto: se ignora
    }
  }
  lista.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn))
  return lista
}

export function borrarSetlist(id: string): void {
  fs.rmSync(setlistPath(id), { force: true })
}

// ---- Sesion (pestanas abiertas) ----

export interface SesionGuardada {
  proyectos: string[]
  activo: number
}

export function guardarSesion(sesion: SesionGuardada): void {
  try {
    fs.mkdirSync(appBaseDir(), { recursive: true })
    escribirJson(sesionPath(), sesion)
  } catch {
    // no es critico: solo sirve para recuperar las pestanas al reabrir
  }
}

export function leerSesion(): SesionGuardada | null {
  try {
    const s = JSON.parse(fs.readFileSync(sesionPath(), 'utf-8')) as SesionGuardada
    if (!Array.isArray(s.proyectos)) return null
    return { proyectos: s.proyectos.filter(esIdValido), activo: Number(s.activo) || 0 }
  } catch {
    return null
  }
}
