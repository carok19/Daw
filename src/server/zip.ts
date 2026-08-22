import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import type { Proyecto, Pista } from '../shared/types'
import { projectAudioDir, saveProyecto } from './projects'

const EXTENSIONES_AUDIO = new Set(['.mp3', '.wav', '.m4a'])

export class ZipSinPistasError extends Error {
  constructor() {
    super('No se encontraron pistas de audio en este archivo')
    this.name = 'ZipSinPistasError'
  }
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

/**
 * Descomprime el zip, filtra archivos de audio (.mp3/.wav/.m4a), crea un proyecto
 * nuevo con una pista por archivo (orden alfabetico) y persiste todo en disco.
 * Si no hay ningun archivo de audio reconocible, lanza ZipSinPistasError y no
 * crea nada en disco.
 */
export function crearProyectoDesdeZip(zipPath: string): Proyecto {
  const zip = new AdmZip(zipPath)
  const entradasAudio = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const baseName = path.basename(e.entryName)
      if (esArchivoBasura(baseName)) return false
      if (e.entryName.split('/').includes('__MACOSX')) return false
      return EXTENSIONES_AUDIO.has(path.extname(baseName).toLowerCase())
    })
    .sort((a, b) => a.entryName.localeCompare(b.entryName))

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

    return {
      id: crypto.randomUUID(),
      nombre: nombrePistaDesdeArchivo(path.basename(destino, ext)),
      archivo: `audio/${destino}`,
      volumen: 80,
      pan: 0,
      mute: false,
      solo: false
    }
  })

  const proyecto: Proyecto = {
    id,
    nombre: nombreCancionDesdeZip(zipPath),
    creadoEn: new Date().toISOString(),
    pistas,
    marcadores: [],
    // Se completa cuando el cliente decodifica los buffers (ver AudioEngine) y
    // reporta la duracion real; ver README "Decisiones de diseno".
    duracionTotalMs: 0
  }

  saveProyecto(proyecto)
  return proyecto
}
