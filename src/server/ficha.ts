import fs from 'node:fs'
import path from 'node:path'
import type { Marcador, Pista, Proyecto, TempoProyecto } from '../shared/types'
import { baseDeComprimido } from './comprimidos'
import { normalizarTonalidad, TONO_MAX, TONO_MIN } from '../shared/tonalidad'

/**
 * "Ficha" de una cancion: un archivito JSON al lado de su .zip/.rar en la
 * carpeta de canciones ("Santo.zip" -> "Santo.multitrack.json") con todo lo
 * que no es audio: secciones, mezcla, colores y tempo. La app la mantiene al
 * dia sola. Si se copia la carpeta a otra compu (o se reinstala), la cancion
 * se importa ya con sus secciones y su mezcla, sin volver a analizar nada.
 * Tambien sirve adentro del zip, con el nombre "multitrack.json".
 */

export const EXT_FICHA = '.multitrack.json'
const FORMATO = 'multitrack-alabanza/1'

export interface FichaCancion {
  formato: typeof FORMATO
  id: string
  nombre: string
  /** duracion del audio con el que se hizo: si el audio cambio, las secciones automaticas no sirven */
  duracionTotalMs: number
  marcadores: Pick<Marcador, 'nombre' | 'tiempoMs' | 'origen' | 'color'>[]
  seccionesEditadas: boolean
  /** mezcla por nombre de pista (los ids de pista se regeneran al importar) */
  pistas: Pick<Pista, 'nombre' | 'volumen' | 'pan' | 'mute' | 'solo' | 'color' | 'rol' | 'panAutomatico'>[]
  tempo: TempoProyecto | null
  fuenteSecciones: 'archivo' | 'guia' | null
  /** tono elegido (semitonos) y tonalidad original puesta a mano */
  tono?: number
  tonalidad?: string
}

export function rutaFicha(rutaComprimido: string): string {
  return path.join(path.dirname(rutaComprimido), `${baseDeComprimido(rutaComprimido)}${EXT_FICHA}`)
}

export function esNombreDeFicha(nombre: string): boolean {
  const base = path.basename(nombre).toLowerCase()
  return base === 'multitrack.json' || base.endsWith(EXT_FICHA)
}

export function fichaDesdeProyecto(p: Proyecto): FichaCancion {
  return {
    formato: FORMATO,
    id: p.id,
    nombre: p.nombre,
    duracionTotalMs: p.duracionTotalMs,
    marcadores: p.marcadores.map(({ nombre, tiempoMs, origen, color }) => ({ nombre, tiempoMs, origen, ...(color ? { color } : {}) })),
    seccionesEditadas: !!p.seccionesEditadas,
    pistas: p.pistas.map(({ nombre, volumen, pan, mute, solo, color, rol, panAutomatico }) => ({
      nombre,
      volumen,
      pan,
      mute,
      solo,
      color,
      ...(rol ? { rol } : {}),
      ...(typeof panAutomatico === 'boolean' ? { panAutomatico } : {})
    })),
    tempo: p.tempo ?? null,
    fuenteSecciones: p.analisis?.fuente ?? null,
    ...(p.tono ? { tono: p.tono } : {}),
    ...(p.tonalidad ? { tonalidad: p.tonalidad } : {})
  }
}

/** Lee y valida una ficha (null si no es una ficha de esta app o esta rota). */
export function interpretarFicha(texto: string): FichaCancion | null {
  try {
    const f = JSON.parse(texto) as Partial<FichaCancion>
    if (f?.formato !== FORMATO || typeof f.duracionTotalMs !== 'number' || !Array.isArray(f.marcadores) || !Array.isArray(f.pistas)) return null
    const marcadores = f.marcadores.filter(
      (m) => m && typeof m.nombre === 'string' && typeof m.tiempoMs === 'number' && Number.isFinite(m.tiempoMs) && m.tiempoMs >= 0
    )
    const pistas = f.pistas
      .filter((p) => p && typeof p.nombre === 'string')
      .map((p) => {
        const { rol, panAutomatico, ...resto } = p
        return {
          ...resto,
          ...(rol === 'click' || rol === 'guia' || rol === 'normal' ? { rol } : {}),
          ...(typeof panAutomatico === 'boolean' ? { panAutomatico } : {})
        }
      })
    const tempo =
      f.tempo && typeof f.tempo.bpm === 'number' && Array.isArray(f.tempo.compasesMs) && f.tempo.compasesMs.every((c) => typeof c === 'number')
        ? f.tempo
        : null
    return {
      formato: FORMATO,
      id: typeof f.id === 'string' ? f.id : '',
      nombre: typeof f.nombre === 'string' ? f.nombre.slice(0, 80) : '',
      duracionTotalMs: f.duracionTotalMs,
      marcadores: marcadores.map((m) => ({
        nombre: m.nombre.slice(0, 60),
        tiempoMs: Math.round(m.tiempoMs),
        origen: m.origen === 'guia' || m.origen === 'archivo' ? m.origen : 'manual',
        ...(typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? { color: m.color } : {})
      })),
      seccionesEditadas: !!f.seccionesEditadas,
      pistas,
      tempo,
      fuenteSecciones: f.fuenteSecciones === 'guia' || f.fuenteSecciones === 'archivo' ? f.fuenteSecciones : null,
      ...(typeof f.tono === 'number' && Number.isInteger(f.tono) && f.tono >= TONO_MIN && f.tono <= TONO_MAX && f.tono !== 0 ? { tono: f.tono } : {}),
      ...(normalizarTonalidad(f.tonalidad) ? { tonalidad: normalizarTonalidad(f.tonalidad)! } : {})
    }
  } catch {
    return null
  }
}

export function leerFicha(ruta: string): FichaCancion | null {
  try {
    return interpretarFicha(fs.readFileSync(ruta, 'utf-8'))
  } catch {
    return null
  }
}

/** Escribe la ficha (atomico). Devuelve false si no se pudo (carpeta de solo lectura, etc.). */
export function escribirFicha(ruta: string, ficha: FichaCancion): boolean {
  try {
    const tmp = `${ruta}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(ficha, null, 2), 'utf-8')
    fs.renameSync(tmp, ruta)
    return true
  } catch {
    return false
  }
}
