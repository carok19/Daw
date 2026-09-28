import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import type { Proyecto, Pista, Marcador } from '../shared/types'
import { projectAudioDir, saveProyecto } from './projects'

const EXTENSIONES_AUDIO = new Set(['.mp3', '.wav', '.m4a'])

/** Nombres del manifiesto opcional dentro del zip (lo genera MoiMoi, el separador de pistas). */
const NOMBRES_MANIFIESTO = new Set(['moimoi.json', 'multitrack.json'])

export class ZipSinPistasError extends Error {
  constructor() {
    super('No se encontraron pistas de audio en este archivo')
    this.name = 'ZipSinPistasError'
  }
}

/**
 * Manifiesto opcional del zip (ver README, "Canciones desde MoiMoi"). Todos los campos
 * son opcionales: un zip sin manifiesto se importa exactamente igual que siempre.
 */
export interface Manifiesto {
  cancion?: { titulo?: unknown; artista?: unknown; duracionMs?: unknown }
  pistas?: Array<{ archivo?: unknown; nombre?: unknown; volumen?: unknown; pan?: unknown; mute?: unknown; solo?: unknown }>
  marcadores?: Array<{ nombre?: unknown; tiempoMs?: unknown; color?: unknown }>
}

function esArchivoBasura(baseName: string): boolean {
  // Recursos de macOS dentro del zip (AppleDouble / __MACOSX): no son audio real
  // aunque su nombre termine en una extension de audio.
  return baseName.startsWith('._') || baseName.startsWith('.DS_Store')
}

function nombrePistaDesdeArchivo(baseNameSinExt: string): string {
  return baseNameSinExt.replace(/_/g, ' ').trim() || baseNameSinExt
}

function nombreCancionDesdeZip(zipPath: string): string {
  const base = path.basename(zipPath, path.extname(zipPath))
  return base.replace(/_/g, ' ').trim() || base
}

function texto(valor: unknown, max: number): string | null {
  if (typeof valor !== 'string') return null
  const limpio = valor.trim().slice(0, max)
  return limpio || null
}

function numero(valor: unknown, min: number, max: number): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null
  return Math.min(max, Math.max(min, Math.round(valor)))
}

function colorValido(valor: unknown): string | undefined {
  return typeof valor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(valor) ? valor : undefined
}

/** Lee `moimoi.json` si viene en el zip. Si falta o esta mal formado, devuelve null. */
export function leerManifiesto(zip: AdmZip): Manifiesto | null {
  const entrada = zip
    .getEntries()
    .find((e) => !e.isDirectory && !e.entryName.split('/').includes('__MACOSX')
      && NOMBRES_MANIFIESTO.has(path.basename(e.entryName).toLowerCase()))
  if (!entrada) return null
  try {
    const data = JSON.parse(entrada.getData().toString('utf-8'))
    return data && typeof data === 'object' ? (data as Manifiesto) : null
  } catch {
    return null
  }
}

function marcadoresDesdeManifiesto(manifiesto: Manifiesto | null): Marcador[] {
  if (!manifiesto || !Array.isArray(manifiesto.marcadores)) return []
  const marcadores: Marcador[] = []
  for (const m of manifiesto.marcadores) {
    const nombre = texto(m?.nombre, 80)
    const tiempoMs = numero(m?.tiempoMs, 0, 24 * 60 * 60 * 1000)
    if (!nombre || tiempoMs === null) continue
    const marcador: Marcador = { id: crypto.randomUUID(), nombre, tiempoMs }
    const color = colorValido(m?.color)
    if (color) marcador.color = color
    marcadores.push(marcador)
  }
  return marcadores.sort((a, b) => a.tiempoMs - b.tiempoMs)
}

/**
 * Descomprime el zip, filtra archivos de audio (.mp3/.wav/.m4a), crea un proyecto
 * nuevo con una pista por archivo (orden alfabetico) y persiste todo en disco.
 * Si el zip trae un manifiesto (`moimoi.json`), usa su orden y nombres de pistas,
 * sus volumenes/paneos y sus marcadores (las partes de la cancion: intro, verso,
 * coro...). Si no hay ningun archivo de audio reconocible, lanza ZipSinPistasError
 * y no crea nada en disco.
 */
export function crearProyectoDesdeZip(zipPath: string): Proyecto {
  const zip = new AdmZip(zipPath)
  const manifiesto = leerManifiesto(zip)
  const pistasManifiesto = manifiesto && Array.isArray(manifiesto.pistas) ? manifiesto.pistas : []
  const indiceManifiesto = new Map<string, number>()
  pistasManifiesto.forEach((p, i) => {
    const archivo = texto(p?.archivo, 260)
    if (archivo && !indiceManifiesto.has(path.basename(archivo).toLowerCase())) {
      indiceManifiesto.set(path.basename(archivo).toLowerCase(), i)
    }
  })
  const posicion = (entryName: string) =>
    indiceManifiesto.get(path.basename(entryName).toLowerCase()) ?? Number.MAX_SAFE_INTEGER

  const entradasAudio = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const baseName = path.basename(e.entryName)
      if (esArchivoBasura(baseName)) return false
      if (e.entryName.split('/').includes('__MACOSX')) return false
      return EXTENSIONES_AUDIO.has(path.extname(baseName).toLowerCase())
    })
    .sort((a, b) => posicion(a.entryName) - posicion(b.entryName) || a.entryName.localeCompare(b.entryName))

  if (entradasAudio.length === 0) {
    throw new ZipSinPistasError()
  }

  const id = crypto.randomUUID()
  const audioDir = projectAudioDir(id)
  fs.mkdirSync(audioDir, { recursive: true })

  const nombresUsados = new Set<string>()
  const pistas: Pista[] = entradasAudio.map((entry) => {
    const baseName = path.basename(entry.entryName)
    const ext = path.extname(baseName)
    let destino = baseName
    let i = 1
    while (nombresUsados.has(destino.toLowerCase())) {
      destino = `${path.basename(baseName, ext)}_${i}${ext}`
      i += 1
    }
    nombresUsados.add(destino.toLowerCase())

    fs.writeFileSync(path.join(audioDir, destino), entry.getData())

    const info = pistasManifiesto[indiceManifiesto.get(baseName.toLowerCase()) ?? -1]
    return {
      id: crypto.randomUUID(),
      nombre: texto(info?.nombre, 80) ?? nombrePistaDesdeArchivo(path.basename(destino, ext)),
      archivo: `audio/${destino}`,
      volumen: numero(info?.volumen, 0, 100) ?? 80,
      pan: numero(info?.pan, -100, 100) ?? 0,
      mute: info?.mute === true,
      solo: info?.solo === true
    }
  })

  const proyecto: Proyecto = {
    id,
    nombre: nombreCancionDesdeZip(zipPath),
    creadoEn: new Date().toISOString(),
    pistas,
    marcadores: marcadoresDesdeManifiesto(manifiesto),
    // Si el manifiesto no la trae, se completa cuando el cliente decodifica los
    // buffers (ver AudioEngine) y reporta la duracion real; ver README "Decisiones de diseno".
    duracionTotalMs: numero(manifiesto?.cancion?.duracionMs, 0, 24 * 60 * 60 * 1000) ?? 0
  }

  saveProyecto(proyecto)
  return proyecto
}
