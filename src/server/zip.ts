import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import AdmZip from 'adm-zip'
import type { ImportProgreso, Marcador, Proyecto, Pista } from '../shared/types'
import { FORMATO_PROYECTO_ACTUAL } from '../shared/types'
import { colorPorIndice, deleteProyecto, loadProyecto, projectAudioDir, projectDir, proyectoExiste, saveProyecto } from './projects'
import { EXTENSIONES_AUDIO, enParalelo, normalizarAWav } from './audio'
import { marcadoresDelZip } from './analisis/archivos'
import { clavePista } from './clavePista'

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

function esArchivoBasura(entryName: string): boolean {
  // Recursos de macOS dentro del zip (AppleDouble / __MACOSX): no son archivos reales
  const base = path.basename(entryName)
  return base.startsWith('._') || base.startsWith('.DS_Store') || entryName.split('/').includes('__MACOSX')
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

export function nombreCancionDesdeZip(zipPath: string): string {
  const base = path.basename(zipPath, path.extname(zipPath))
  return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || base
}

/** Nombre de archivo seguro (sin separadores de ruta ni caracteres raros) para guardar en disco. */
function nombreArchivoSeguro(base: string): string {
  return base.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 80) || 'pista'
}

export interface OpcionesImport {
  onProgreso?: (p: ImportProgreso) => void
  /** subcarpeta de la biblioteca donde esta el zip */
  categoria?: string
  /**
   * Reimportar sobre una cancion existente (el zip de la biblioteca cambio):
   * se reemplaza el audio y se conservan la mezcla (por nombre de pista), las
   * secciones puestas a mano y el lugar en los setlists.
   */
  reemplazarId?: string
}

/**
 * Descomprime el zip, filtra archivos de audio, los normaliza a WAV (ver
 * audio.ts), lee los marcadores que traiga (WAV/MIDI/texto, ver
 * analisis/archivos.ts) y crea (o actualiza) la cancion. Si algo falla a mitad
 * de camino, no deja nada a medias en disco.
 */
export async function crearProyectoDesdeZip(zipPath: string, opciones: OpcionesImport = {}): Promise<Proyecto> {
  const { onProgreso } = opciones
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch {
    throw new ImportError('No se pudo abrir el archivo .zip (está dañado o no es un zip)')
  }
  const entradas = zip.getEntries().filter((e) => !e.isDirectory && !esArchivoBasura(e.entryName))
  const entradasAudio = entradas
    .filter((e) => EXTENSIONES_AUDIO.has(path.extname(e.entryName).toLowerCase()))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, 'es', { numeric: true }))

  if (entradasAudio.length === 0) throw new ZipSinPistasError()
  if (entradasAudio.length > MAX_PISTAS) throw new ImportError(`Demasiadas pistas en el zip (máximo ${MAX_PISTAS})`)
  const totalDeclarado = entradasAudio.reduce((acc, e) => acc + e.header.size, 0)
  if (totalDeclarado > MAX_BYTES_TOTAL || entradasAudio.some((e) => e.header.size > MAX_BYTES_POR_PISTA)) {
    throw new ImportError('El zip es demasiado grande')
  }

  const anterior = opciones.reemplazarId && proyectoExiste(opciones.reemplazarId) ? loadProyecto(opciones.reemplazarId) : null
  const id = anterior?.id ?? crypto.randomUUID()
  const audioFinal = projectAudioDir(id)
  // al reimportar, el audio nuevo se arma aparte y recien al final reemplaza al viejo
  const audioDir = anterior ? path.join(projectDir(id), `audio.nuevo-${Date.now()}`) : audioFinal
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
      }
    })
    const duracionTotalMs = Math.max(0, ...duraciones)

    // marcadores que ya traen los archivos (se leen de los originales, antes de convertir)
    const marcadoresArchivo = marcadoresDelZip(
      [
        ...entradas.filter((e) => !EXTENSIONES_AUDIO.has(path.extname(e.entryName).toLowerCase())).map((e) => ({ nombre: e.entryName, datos: () => e.getData() })),
        ...tareas.slice(0, 2).map((t) => ({ nombre: t.origenTmp, datos: () => fs.readFileSync(t.origenTmp) }))
      ],
      duracionTotalMs
    )
    const desdeArchivo: Marcador[] = marcadoresArchivo.map((m) => ({ id: crypto.randomUUID(), nombre: m.nombre, tiempoMs: m.tiempoMs, origen: 'archivo' }))

    const mezclaAnterior = new Map((anterior?.pistas ?? []).map((p) => [clavePista(p.nombre), p]))
    const pistas: Pista[] = tareas.map((t, i) => {
      const previa = mezclaAnterior.get(clavePista(t.nombre))
      return {
        id: previa?.id ?? crypto.randomUUID(),
        nombre: previa?.nombre ?? t.nombre,
        archivo: `audio/${t.destino}`,
        volumen: previa?.volumen ?? 80,
        pan: previa?.pan ?? 0,
        mute: previa?.mute ?? false,
        solo: previa?.solo ?? false,
        color: previa?.color ?? colorPorIndice(i)
      }
    })

    let marcadores: Marcador[]
    if (anterior) {
      // se conservan las secciones puestas a mano; las automaticas se recalculan
      const manuales = anterior.marcadores.filter((m) => !m.origen || m.origen === 'manual')
      marcadores = manuales.length ? manuales : desdeArchivo
    } else marcadores = desdeArchivo

    const proyecto: Proyecto = {
      ...(anterior ?? {}),
      id,
      nombre: anterior?.nombre ?? nombreCancionDesdeZip(zipPath),
      creadoEn: anterior?.creadoEn ?? new Date().toISOString(),
      pistas,
      marcadores: marcadores.filter((m) => m.tiempoMs < duracionTotalMs).sort((a, b) => a.tiempoMs - b.tiempoMs),
      duracionTotalMs,
      formato: FORMATO_PROYECTO_ACTUAL,
      categoria: opciones.categoria ?? anterior?.categoria ?? '',
      revision: (anterior?.revision ?? 0) + (anterior ? 1 : 0),
      tempo: null,
      analisis: desdeArchivo.length ? { estado: 'analizando', fuente: 'archivo', guiaPistaId: null } : { estado: 'analizando', fuente: null, guiaPistaId: null }
    }

    if (anterior) {
      const viejo = `${audioFinal}.viejo-${Date.now()}`
      if (fs.existsSync(audioFinal)) fs.renameSync(audioFinal, viejo)
      fs.renameSync(audioDir, audioFinal)
      fs.rmSync(viejo, { recursive: true, force: true })
      // el mismo objeto en memoria (puede estar abierto en el setlist): se actualiza en el lugar
      Object.assign(anterior, proyecto)
      saveProyecto(anterior)
      onProgreso?.({ etapa: 'listo', actual: tareas.length, total: tareas.length })
      return anterior
    }
    saveProyecto(proyecto)
    onProgreso?.({ etapa: 'listo', actual: tareas.length, total: tareas.length })
    return proyecto
  } catch (err) {
    if (anterior) fs.rmSync(audioDir, { recursive: true, force: true })
    else deleteProyecto(id)
    throw err
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
