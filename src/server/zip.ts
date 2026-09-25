import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import AdmZip from 'adm-zip'
import type { ImportProgreso, Proyecto, Pista } from '../shared/types'
import { FORMATO_PROYECTO_ACTUAL } from '../shared/types'
import { colorPorIndice, deleteProyecto, projectAudioDir, saveProyecto } from './projects'
import { EXTENSIONES_AUDIO, enParalelo, normalizarAWav } from './audio'

export class ZipSinPistasError extends Error {
  constructor() {
    super('No se encontraron pistas de audio en este archivo')
    this.name = 'ZipSinPistasError'
  }
}

export class ImportError extends Error {}

/** Limites contra zips malformados o maliciosos ("zip bombs"). */
const MAX_BYTES_POR_PISTA = 2 * 1024 ** 3
const MAX_BYTES_TOTAL = 12 * 1024 ** 3
const MAX_PISTAS = 64

function esArchivoBasura(baseName: string): boolean {
  // Recursos de macOS dentro del zip (AppleDouble / __MACOSX): no son audio real
  // aunque su nombre termine en una extension de audio.
  return baseName.startsWith('._') || baseName.startsWith('.DS_Store')
}

/**
 * "01_Click" -> "Click", "02 - Guia" -> "Guia", "Bajo_DI" -> "Bajo DI". El
 * prefijo numerico (1-2 digitos + separador) es solo para ordenar en el DAW.
 */
export function nombrePistaDesdeArchivo(baseNameSinExt: string): string {
  const limpio = baseNameSinExt
    .replace(/_/g, ' ')
    .replace(/^\s*\d{1,2}\s*[-.)\s]\s*(?=\S)/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return limpio || baseNameSinExt
}

function nombreCancionDesdeZip(zipPath: string): string {
  const base = path.basename(zipPath, path.extname(zipPath))
  return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || base
}

/** Nombre de archivo seguro (sin separadores de ruta ni caracteres raros) para guardar en disco. */
function nombreArchivoSeguro(base: string): string {
  return base.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 80) || 'pista'
}

/**
 * Descomprime el zip, filtra archivos de audio, los normaliza a WAV (ver
 * audio.ts) y crea un proyecto nuevo con una pista por archivo (orden
 * alfabetico). Si no hay audio reconocible, lanza ZipSinPistasError. Si algo
 * falla a mitad de camino, no deja nada a medias en disco.
 */
export async function crearProyectoDesdeZip(
  zipPath: string,
  onProgreso?: (p: ImportProgreso) => void
): Promise<Proyecto> {
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch {
    throw new ImportError('No se pudo abrir el archivo .zip (esta dañado o no es un zip)')
  }
  const entradasAudio = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const baseName = path.basename(e.entryName)
      if (esArchivoBasura(baseName)) return false
      if (e.entryName.split('/').includes('__MACOSX')) return false
      return EXTENSIONES_AUDIO.has(path.extname(baseName).toLowerCase())
    })
    .sort((a, b) => a.entryName.localeCompare(b.entryName, 'es', { numeric: true }))

  if (entradasAudio.length === 0) throw new ZipSinPistasError()
  if (entradasAudio.length > MAX_PISTAS) throw new ImportError(`Demasiadas pistas en el zip (maximo ${MAX_PISTAS})`)
  const totalDeclarado = entradasAudio.reduce((acc, e) => acc + e.header.size, 0)
  if (totalDeclarado > MAX_BYTES_TOTAL || entradasAudio.some((e) => e.header.size > MAX_BYTES_POR_PISTA)) {
    throw new ImportError('El zip es demasiado grande')
  }

  const id = crypto.randomUUID()
  const audioDir = projectAudioDir(id)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-import-'))
  fs.mkdirSync(audioDir, { recursive: true })

  try {
    onProgreso?.({ etapa: 'extrayendo', actual: 0, total: entradasAudio.length })
    const nombresUsados = new Set<string>()
    const tareas = entradasAudio.map((entry, i) => {
      const baseName = path.basename(entry.entryName)
      const ext = path.extname(baseName)
      const base = nombreArchivoSeguro(path.basename(baseName, ext))
      let destino = `${base}.wav`
      let n = 1
      while (nombresUsados.has(destino.toLowerCase())) destino = `${base}_${n++}.wav`
      nombresUsados.add(destino.toLowerCase())
      const origenTmp = path.join(tmpDir, `${i}${ext.toLowerCase()}`)
      fs.writeFileSync(origenTmp, entry.getData())
      return { origenTmp, destino, nombre: nombrePistaDesdeArchivo(path.basename(baseName, ext)) }
    })

    let hechas = 0
    const duraciones = await enParalelo(tareas, 3, async (t) => {
      try {
        const r = await normalizarAWav(t.origenTmp, path.join(audioDir, t.destino))
        onProgreso?.({ etapa: 'convirtiendo', actual: ++hechas, total: tareas.length, pista: t.nombre })
        return r.duracionMs
      } catch (err) {
        throw new ImportError(`No se pudo leer la pista "${t.nombre}": ${(err as Error).message}`)
      } finally {
        fs.rmSync(t.origenTmp, { force: true })
      }
    })

    const pistas: Pista[] = tareas.map((t, i) => ({
      id: crypto.randomUUID(),
      nombre: t.nombre,
      archivo: `audio/${t.destino}`,
      volumen: 80,
      pan: 0,
      mute: false,
      solo: false,
      color: colorPorIndice(i)
    }))

    const proyecto: Proyecto = {
      id,
      nombre: nombreCancionDesdeZip(zipPath),
      creadoEn: new Date().toISOString(),
      pistas,
      marcadores: [],
      duracionTotalMs: Math.max(0, ...duraciones),
      formato: FORMATO_PROYECTO_ACTUAL
    }
    saveProyecto(proyecto)
    onProgreso?.({ etapa: 'listo', actual: tareas.length, total: tareas.length })
    return proyecto
  } catch (err) {
    deleteProyecto(id)
    throw err
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
