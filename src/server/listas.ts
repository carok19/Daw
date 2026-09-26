import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ListaResumen } from '../shared/types'
import { ensureBaseDir, escribirJson, esIdValido, loadProyecto, proyectoExiste, setlistsDir } from './projects'

/**
 * Listas por dia ("Sabado 17/10 · 19 hs"), cada una en una carpeta opcional
 * ("Congreso Juvenil 2026"). Una lista es solo el orden de las canciones: las
 * canciones viven en la biblioteca, y sacar una de la lista (o borrar la
 * lista) no las borra.
 *
 *   setlists/<id>.json   una lista (antes "setlist": los viejos se leen igual, sin carpeta)
 *   setlists/carpetas.json   las carpetas, aunque esten vacias
 */

interface ListaArchivo {
  id: string
  nombre: string
  creadoEn: string
  actualizadoEn?: string
  proyectos: string[]
  carpeta?: string
  fecha?: string | null
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/

export function limpiarNombre(nombre: unknown, max = 60): string {
  return typeof nombre === 'string' ? nombre.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** AAAA-MM-DD valida, '' / null = sin fecha; undefined = no vino (no cambia). */
export function limpiarFecha(fecha: unknown): string | null | undefined {
  if (fecha === undefined) return undefined
  if (fecha === null || fecha === '') return null
  if (typeof fecha !== 'string' || !FECHA_RE.test(fecha)) return undefined
  const d = new Date(`${fecha}T12:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha ? undefined : fecha
}

function rutaLista(id: string): string {
  if (!esIdValido(id)) throw new Error('id de lista invalido')
  return path.join(setlistsDir(), `${id}.json`)
}

function rutaCarpetas(): string {
  return path.join(setlistsDir(), 'carpetas.json')
}

export function leerLista(id: unknown): ListaArchivo | null {
  if (!esIdValido(id)) return null
  try {
    const l = JSON.parse(fs.readFileSync(rutaLista(id), 'utf-8')) as ListaArchivo
    if (!l || typeof l.nombre !== 'string' || !Array.isArray(l.proyectos)) return null
    return { ...l, id, proyectos: l.proyectos.filter(esIdValido), carpeta: typeof l.carpeta === 'string' ? l.carpeta : '', fecha: l.fecha ?? null }
  } catch {
    return null
  }
}

export function guardarLista(l: ListaArchivo): void {
  ensureBaseDir()
  escribirJson(rutaLista(l.id), { ...l, actualizadoEn: new Date().toISOString() })
}

export function crearLista(datos: { nombre: string; carpeta?: string; fecha?: string | null; proyectos?: string[] }): ListaArchivo {
  const ahora = new Date().toISOString()
  const lista: ListaArchivo = {
    id: crypto.randomUUID(),
    nombre: datos.nombre,
    creadoEn: ahora,
    actualizadoEn: ahora,
    proyectos: [...new Set((datos.proyectos ?? []).filter(esIdValido))],
    carpeta: datos.carpeta ?? '',
    fecha: datos.fecha ?? null
  }
  guardarLista(lista)
  if (lista.carpeta) agregarCarpeta(lista.carpeta)
  return lista
}

export function borrarLista(id: string): void {
  fs.rmSync(rutaLista(id), { force: true })
}

export function resumenLista(l: ListaArchivo): ListaResumen {
  const canciones: ListaResumen['canciones'] = []
  let faltantes = 0
  for (const id of l.proyectos) {
    if (!proyectoExiste(id)) {
      faltantes++
      continue
    }
    try {
      const p = loadProyecto(id)
      canciones.push({ id, nombre: p.nombre, duracionMs: p.duracionTotalMs, bpm: p.tempo?.bpm ?? null, categoria: p.categoria ?? '' })
    } catch {
      faltantes++
    }
  }
  return {
    id: l.id,
    nombre: l.nombre,
    carpeta: l.carpeta ?? '',
    fecha: l.fecha ?? null,
    creadoEn: l.creadoEn,
    actualizadoEn: l.actualizadoEn ?? l.creadoEn,
    canciones,
    faltantes
  }
}

function leerTodas(): ListaArchivo[] {
  ensureBaseDir()
  const res: ListaArchivo[] = []
  for (const archivo of fs.readdirSync(setlistsDir())) {
    const id = archivo.replace(/\.json$/, '')
    if (!archivo.endsWith('.json') || !esIdValido(id)) continue
    const l = leerLista(id)
    if (l) res.push(l)
  }
  return res
}

export function listarListas(): ListaResumen[] {
  return leerTodas()
    .map(resumenLista)
    .sort((a, b) => b.actualizadoEn.localeCompare(a.actualizadoEn))
}

// ---- carpetas ----

function leerCarpetasGuardadas(): string[] {
  try {
    const c = JSON.parse(fs.readFileSync(rutaCarpetas(), 'utf-8')) as { carpetas?: unknown }
    return Array.isArray(c.carpetas) ? c.carpetas.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  } catch {
    return []
  }
}

function guardarCarpetas(carpetas: string[]): void {
  ensureBaseDir()
  escribirJson(rutaCarpetas(), { carpetas: [...new Set(carpetas)] })
}

const mismaCarpeta = (a: string, b: string): boolean => a.localeCompare(b, 'es', { sensitivity: 'base' }) === 0

/** Todas las carpetas (las guardadas, aunque esten vacias, y las que usan las listas), en orden alfabetico. */
export function listarCarpetas(): string[] {
  const todas: string[] = []
  for (const c of [...leerCarpetasGuardadas(), ...leerTodas().map((l) => l.carpeta ?? '')]) {
    if (c && !todas.some((x) => mismaCarpeta(x, c))) todas.push(c)
  }
  return todas.sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true }))
}

/** Nombre de carpeta tal como ya existe (sin duplicar por mayusculas), o el nuevo limpio. */
export function nombreCarpeta(nombre: unknown): string {
  const limpio = limpiarNombre(nombre)
  return listarCarpetas().find((c) => mismaCarpeta(c, limpio)) ?? limpio
}

export function agregarCarpeta(nombre: string): string {
  const final = nombreCarpeta(nombre)
  if (!final) return ''
  const guardadas = leerCarpetasGuardadas()
  if (!guardadas.some((c) => mismaCarpeta(c, final))) guardarCarpetas([...guardadas, final])
  return final
}

/** Cambia el nombre de una carpeta (y de las listas que tiene). Si ya existe otra con ese nombre, se juntan. */
export function renombrarCarpeta(de: string, a: string): boolean {
  const nuevo = limpiarNombre(a)
  if (!de || !nuevo) return false
  const destino = listarCarpetas().find((c) => mismaCarpeta(c, nuevo) && !mismaCarpeta(c, de)) ?? nuevo
  for (const l of leerTodas()) {
    if (l.carpeta && mismaCarpeta(l.carpeta, de)) guardarLista({ ...l, carpeta: destino })
  }
  guardarCarpetas([...leerCarpetasGuardadas().filter((c) => !mismaCarpeta(c, de) && !mismaCarpeta(c, destino)), destino])
  return true
}

/** Borra una carpeta: sus listas quedan "sin carpeta" (no se borra ninguna lista). */
export function borrarCarpeta(nombre: string): void {
  for (const l of leerTodas()) {
    if (l.carpeta && mismaCarpeta(l.carpeta, nombre)) guardarLista({ ...l, carpeta: '' })
  }
  guardarCarpetas(leerCarpetasGuardadas().filter((c) => !mismaCarpeta(c, nombre)))
}
