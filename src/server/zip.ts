import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import type { ImportProgreso, Marcador, Proyecto, Pista } from '../shared/types'
import { FORMATO_PROYECTO_ACTUAL } from '../shared/types'
import { colorPorIndice, deleteProyecto, esIdValido, loadProyecto, projectAudioDir, projectDir, proyectoExiste, saveProyecto } from './projects'
import { EXTENSIONES_AUDIO, enParalelo, normalizarAWav } from './audio'
import { EXTENSIONES_MARCADORES, marcadoresDelZip } from './analisis/archivos'
import { clavePista } from './clavePista'
import { baseDeComprimido, ErrorComprimido, extraerComprimido, primerVolumen } from './comprimidos'
import { esNombreDeFicha, interpretarFicha, leerFicha, rutaFicha, type FichaCancion } from './ficha'

export class ZipSinPistasError extends Error {
  constructor() {
    super('No se encontraron pistas de audio en este archivo')
    this.name = 'ZipSinPistasError'
  }
}

export class ImportError extends Error {}

/** Limites contra comprimidos malformados o maliciosos ("zip bombs"). */
const MAX_BYTES_POR_PISTA = 2 * 1024 ** 3
const MAX_BYTES_TOTAL = 12 * 1024 ** 3
const MAX_PISTAS = 64

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

/** "Santo_Santo.zip" / "Santo Santo.part1.rar" -> "Santo Santo" */
export function nombreCancionDesdeZip(zipPath: string): string {
  const base = baseDeComprimido(zipPath)
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
 * Descomprime la cancion (.zip o .rar, en otro proceso: ver comprimidos.ts),
 * normaliza las pistas a WAV (ver audio.ts), lee los marcadores que traiga
 * (WAV/MIDI/texto, ver analisis/archivos.ts) y crea (o actualiza) la cancion.
 * Si algo falla a mitad de camino, no deja nada a medias en disco.
 */
export async function crearProyectoDesdeZip(rutaArchivo: string, opciones: OpcionesImport = {}): Promise<Proyecto> {
  const { onProgreso } = opciones
  const zipPath = primerVolumen(rutaArchivo)
  // ficha al lado del comprimido ("Santo.multitrack.json"): la cancion vuelve con todo lo que tenia
  const fichaAlLado = leerFicha(rutaFicha(zipPath))
  let reemplazarId = opciones.reemplazarId
  // esa misma cancion ya esta en esta compu: se actualiza en vez de duplicarse
  if (!reemplazarId && fichaAlLado && proyectoExiste(fichaAlLado.id)) reemplazarId = fichaAlLado.id
  const anterior = reemplazarId && proyectoExiste(reemplazarId) ? loadProyecto(reemplazarId) : null
  // se conserva el id de la ficha: los setlists que la nombran siguen andando
  const id = anterior?.id ?? (fichaAlLado && esIdValido(fichaAlLado.id) ? fichaAlLado.id : crypto.randomUUID())
  const audioFinal = projectAudioDir(id)
  // al reimportar, el audio nuevo se arma aparte y recien al final reemplaza al viejo
  const audioDir = anterior ? path.join(projectDir(id), `audio.nuevo-${Date.now()}`) : audioFinal
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-import-'))
  fs.mkdirSync(audioDir, { recursive: true })

  try {
    onProgreso?.({ etapa: 'extrayendo', actual: 0, total: 0 })
    let extraidos
    try {
      extraidos = await extraerComprimido(
        {
          ruta: zipPath,
          destino: tmpDir,
          extensionesAudio: [...EXTENSIONES_AUDIO],
          extensionesExtra: [...EXTENSIONES_MARCADORES, '.json'],
          maxPistas: MAX_PISTAS,
          maxBytesPorPista: MAX_BYTES_POR_PISTA,
          maxBytesTotal: MAX_BYTES_TOTAL
        },
        (actual, total) => onProgreso?.({ etapa: 'extrayendo', actual, total })
      )
    } catch (err) {
      if (err instanceof ErrorComprimido) throw err.codigo === 'sin-pistas' ? new ZipSinPistasError() : new ImportError(err.message)
      throw err
    }
    const esAudio = (nombre: string): boolean => EXTENSIONES_AUDIO.has(path.extname(nombre).toLowerCase())
    const audio = extraidos.filter((e) => esAudio(e.nombre)).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }))
    const nombresUsados = new Set<string>()
    const tareas = audio.map((e) => {
      const baseName = path.basename(e.nombre)
      const ext = path.extname(baseName)
      const base = nombreArchivoSeguro(path.basename(baseName, ext))
      let destino = `${base}.wav`
      let n = 1
      while (nombresUsados.has(destino.toLowerCase())) destino = `${base}_${n++}.wav`
      nombresUsados.add(destino.toLowerCase())
      return { origenTmp: e.ruta, destino, nombre: nombrePistaDesdeArchivo(path.basename(baseName, ext)) }
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

    // la ficha (al lado, o adentro como "multitrack.json") solo vale para una cancion nueva en esta compu
    let ficha: FichaCancion | null = null
    if (!anterior) {
      const adentro = extraidos.find((e) => esNombreDeFicha(e.nombre))
      ficha = fichaAlLado ?? (adentro ? interpretarFicha(fs.readFileSync(adentro.ruta, 'utf-8')) : null)
    }
    // con el mismo audio vale todo; si el audio cambio, solo la mezcla y las secciones puestas a mano
    const fichaVigente = !!ficha && Math.abs(ficha.duracionTotalMs - duracionTotalMs) <= 100

    // marcadores que ya traen los archivos (se leen de los originales, antes de convertir)
    const marcadoresArchivo = marcadoresDelZip(
      [
        ...extraidos.filter((e) => !esAudio(e.nombre)).map((e) => ({ nombre: e.nombre, datos: () => fs.readFileSync(e.ruta) })),
        ...tareas.slice(0, 2).map((t) => ({ nombre: t.origenTmp, datos: () => fs.readFileSync(t.origenTmp) }))
      ],
      duracionTotalMs
    )
    const desdeArchivo: Marcador[] = marcadoresArchivo.map((m) => ({ id: crypto.randomUUID(), nombre: m.nombre, tiempoMs: m.tiempoMs, origen: 'archivo' }))

    const mezclaAnterior = new Map<string, Partial<Pista> & Pick<Pista, 'nombre'>>(
      (anterior?.pistas ?? ficha?.pistas ?? []).map((p) => [clavePista(p.nombre), p])
    )
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
        color: previa?.color ?? colorPorIndice(i),
        ...(previa?.rol === 'click' || previa?.rol === 'guia' || previa?.rol === 'normal' ? { rol: previa.rol } : {})
      }
    })

    let marcadores: Marcador[]
    if (anterior) {
      // si el usuario ya las acomodo, quedan todas como estan; si no, se conservan
      // las puestas a mano y las automaticas se recalculan con el audio nuevo
      const manuales = anterior.seccionesEditadas ? anterior.marcadores : anterior.marcadores.filter((m) => !m.origen || m.origen === 'manual')
      marcadores = manuales.length ? manuales : desdeArchivo
    } else if (ficha) {
      const usables = fichaVigente ? ficha.marcadores : ficha.marcadores.filter((m) => m.origen === 'manual')
      marcadores = usables.length ? usables.map((m) => ({ id: crypto.randomUUID(), ...m })) : desdeArchivo
    } else marcadores = desdeArchivo

    const proyecto: Proyecto = {
      ...(anterior ?? {}),
      id,
      nombre: anterior?.nombre ?? (ficha?.nombre || nombreCancionDesdeZip(zipPath)),
      creadoEn: anterior?.creadoEn ?? new Date().toISOString(),
      pistas,
      marcadores: marcadores.filter((m) => m.tiempoMs < duracionTotalMs).sort((a, b) => a.tiempoMs - b.tiempoMs),
      duracionTotalMs,
      formato: FORMATO_PROYECTO_ACTUAL,
      categoria: opciones.categoria ?? anterior?.categoria ?? '',
      revision: (anterior?.revision ?? 0) + (anterior ? 1 : 0),
      tempo: fichaVigente ? ficha!.tempo : null,
      seccionesEditadas: anterior?.seccionesEditadas ?? (fichaVigente ? ficha!.seccionesEditadas : false),
      // con la ficha vigente ya esta todo: no hace falta volver a analizar
      analisis: fichaVigente
        ? { estado: 'listo', fuente: ficha!.fuenteSecciones, guiaPistaId: null }
        : desdeArchivo.length
          ? { estado: 'analizando', fuente: 'archivo', guiaPistaId: null }
          : { estado: 'analizando', fuente: null, guiaPistaId: null }
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
