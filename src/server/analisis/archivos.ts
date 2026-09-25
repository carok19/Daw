import path from 'node:path'
import { nombreDeMarcadorArchivo } from './secciones'

/**
 * Marcadores que ya vienen en los archivos del zip: los DAWs los guardan en
 * los WAV (chunks "cue " + "LIST/adtl/labl": Ableton, Logic, Reaper, Pro
 * Tools, Audition), en un MIDI de la sesion (meta eventos Marker/Cue) o en un
 * archivo de texto (etiquetas de Audacity, CSV de Reaper, "1:23 Coro").
 * Cuando existen son exactos: tienen prioridad sobre la deteccion por voz.
 */

export interface MarcadorArchivo {
  nombre: string
  tiempoMs: number
}

// ---------------- WAV ----------------

export function marcadoresDeWav(buf: Buffer): MarcadorArchivo[] {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return []
  let sampleRate = 0
  const cues = new Map<number, number>() // id -> sample offset
  const etiquetas = new Map<number, string>()
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const tam = buf.readUInt32LE(off + 4)
    const ini = off + 8
    if (ini + tam > buf.length + 1) break
    if (id === 'fmt ' && tam >= 8) sampleRate = buf.readUInt32LE(ini + 4)
    else if (id === 'cue ' && tam >= 4) {
      const n = buf.readUInt32LE(ini)
      for (let i = 0; i < n && ini + 4 + (i + 1) * 24 <= buf.length; i++) {
        const p = ini + 4 + i * 24
        const cueId = buf.readUInt32LE(p)
        const sampleOffset = buf.readUInt32LE(p + 20)
        cues.set(cueId, sampleOffset)
      }
    } else if (id === 'LIST' && tam >= 4 && buf.toString('ascii', ini, ini + 4) === 'adtl') {
      let q = ini + 4
      while (q + 8 <= ini + tam) {
        const sub = buf.toString('ascii', q, q + 4)
        const subTam = buf.readUInt32LE(q + 4)
        if ((sub === 'labl' || sub === 'note') && subTam >= 4) {
          const cueId = buf.readUInt32LE(q + 8)
          const texto = buf
            .toString('utf8', q + 12, q + 8 + subTam)
            .replace(/\0+$/g, '')
            .trim()
          if (texto && (sub === 'labl' || !etiquetas.has(cueId))) etiquetas.set(cueId, texto)
        }
        q += 8 + subTam + (subTam % 2)
      }
    }
    off = ini + tam + (tam % 2)
  }
  if (!sampleRate || cues.size === 0) return []
  return [...cues.entries()]
    .map(([cueId, muestra], i) => ({
      nombre: etiquetas.get(cueId) ?? `Marcador ${i + 1}`,
      tiempoMs: Math.round((muestra / sampleRate) * 1000)
    }))
    .sort((a, b) => a.tiempoMs - b.tiempoMs)
}

// ---------------- MIDI ----------------

function leerVarLen(buf: Buffer, p: number): [number, number] {
  let v = 0
  let b = 0
  do {
    b = buf[p++]
    v = (v << 7) | (b & 0x7f)
  } while (b & 0x80 && p < buf.length)
  return [v, p]
}

export function marcadoresDeMidi(buf: Buffer): MarcadorArchivo[] {
  if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') return []
  const division = buf.readUInt16BE(12)
  if (division & 0x8000) return [] // SMPTE: poco comun en sesiones de musica
  const tpq = division
  const tempos: { tick: number; usPorNegra: number }[] = [{ tick: 0, usPorNegra: 500000 }]
  const eventos: { tick: number; texto: string }[] = []
  let off = 8 + buf.readUInt32BE(4)
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const tam = buf.readUInt32BE(off + 4)
    let p = off + 8
    const fin = Math.min(buf.length, p + tam)
    if (id === 'MTrk') {
      let tick = 0
      let estado = 0
      while (p < fin) {
        const [delta, p2] = leerVarLen(buf, p)
        p = p2
        tick += delta
        let st = buf[p]
        if (st & 0x80) p++
        else st = estado
        if (st === 0xff) {
          const tipo = buf[p++]
          const [largo, p3] = leerVarLen(buf, p)
          p = p3
          if (tipo === 0x51 && largo === 3) tempos.push({ tick, usPorNegra: (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2] })
          if (tipo === 0x06 || tipo === 0x07) eventos.push({ tick, texto: buf.toString('utf8', p, p + largo).trim() })
          p += largo
        } else if (st === 0xf0 || st === 0xf7) {
          const [largo, p3] = leerVarLen(buf, p)
          p = p3 + largo
        } else {
          estado = st
          const tipo = st & 0xf0
          p += tipo === 0xc0 || tipo === 0xd0 ? 1 : 2
        }
      }
    }
    off += 8 + tam
  }
  tempos.sort((a, b) => a.tick - b.tick)
  const aMs = (tick: number): number => {
    let ms = 0
    for (let i = 0; i < tempos.length; i++) {
      const desde = tempos[i].tick
      if (desde >= tick) break
      const hasta = i + 1 < tempos.length ? Math.min(tempos[i + 1].tick, tick) : tick
      // (dos cambios de tempo en el mismo tick: el tramo intermedio mide 0 y se saltea)
      if (hasta > desde) ms += ((hasta - desde) / tpq) * (tempos[i].usPorNegra / 1000)
    }
    return Math.round(ms)
  }
  return eventos.filter((e) => e.texto).map((e) => ({ nombre: e.texto, tiempoMs: aMs(e.tick) }))
}

// ---------------- Texto ----------------

/** "83.5", "1:23", "1:23.456", "01:02:03" -> ms */
function tiempoATexto(t: string): number | null {
  const s = t.trim().replace(',', '.')
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  return Math.round(((m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3])) * 1000)
}

export function marcadoresDeTexto(texto: string): MarcadorArchivo[] {
  const res: MarcadorArchivo[] = []
  for (const linea of texto.split(/\r?\n/)) {
    const l = linea.trim()
    if (!l || l.startsWith('#')) continue
    // Audacity: "inicio<TAB>fin<TAB>etiqueta"
    const tabs = l.split('\t')
    if (tabs.length >= 3 && tiempoATexto(tabs[0]) !== null) {
      res.push({ nombre: tabs.slice(2).join(' ').trim(), tiempoMs: tiempoATexto(tabs[0])! })
      continue
    }
    // CSV (Reaper: "#,Nombre,Inicio,..." / "M1,Coro,1:23.000,...") o "Nombre;1:23"
    const campos = l.split(/[,;]/).map((c) => c.trim().replace(/^"|"$/g, ''))
    if (campos.length >= 2) {
      const idxTiempo = campos.findIndex((c) => /\d/.test(c) && tiempoATexto(c) !== null && /[:.]/.test(c))
      if (idxTiempo >= 0) {
        const nombre = campos.find((c, i) => i !== idxTiempo && /[a-zñáéíóú]/i.test(c) && !/^[mr]\d+$/i.test(c))
        if (nombre) {
          res.push({ nombre, tiempoMs: tiempoATexto(campos[idxTiempo])! })
          continue
        }
      }
    }
    // "1:23 Coro" / "Coro 1:23" / "1:23 - Coro"
    const inicio = /^(\d+(?::\d{1,2}){1,2}(?:\.\d+)?)\s*[-–:]?\s+(.+)$/.exec(l)
    if (inicio) {
      res.push({ nombre: inicio[2].trim(), tiempoMs: tiempoATexto(inicio[1])! })
      continue
    }
    const fin = /^(.+?)\s*[-–:]?\s+(\d+(?::\d{1,2}){1,2}(?:\.\d+)?)$/.exec(l)
    if (fin) res.push({ nombre: fin[1].trim(), tiempoMs: tiempoATexto(fin[2])! })
  }
  return res.filter((m) => m.nombre && m.tiempoMs >= 0)
}

const EXT_TEXTO = new Set(['.txt', '.csv', '.tsv', '.labels', '.markers'])
/** Archivos (no de audio) de los que se pueden sacar marcadores: se extraen del comprimido si son chicos. */
export const EXTENSIONES_MARCADORES = new Set([...EXT_TEXTO, '.mid', '.midi'])

/**
 * Busca marcadores en las entradas del zip. Se queda con la primera fuente
 * que tenga al menos 2 marcadores (en este orden: texto, MIDI, WAV), traduce
 * nombres conocidos ("Chorus" -> "Coro") y descarta duplicados.
 */
export function marcadoresDelZip(entradas: { nombre: string; datos: () => Buffer }[], duracionMs: number): MarcadorArchivo[] {
  const fuentes: MarcadorArchivo[][] = []
  const porTipo = (pred: (ext: string) => boolean): typeof entradas => entradas.filter((e) => pred(path.extname(e.nombre).toLowerCase()))
  for (const e of porTipo((x) => EXT_TEXTO.has(x))) fuentes.push(marcadoresDeTexto(e.datos().toString('utf8')))
  for (const e of porTipo((x) => x === '.mid' || x === '.midi')) fuentes.push(marcadoresDeMidi(e.datos()))
  for (const e of porTipo((x) => x === '.wav')) {
    const m = marcadoresDeWav(e.datos())
    if (m.length) {
      fuentes.push(m)
      break // todos los stems suelen traer los mismos marcadores
    }
  }
  const elegida = fuentes.find((f) => f.length >= 2) ?? []
  const vistos = new Set<number>()
  return elegida
    .filter((m) => m.tiempoMs < duracionMs || duracionMs <= 0)
    .sort((a, b) => a.tiempoMs - b.tiempoMs)
    .filter((m) => {
      const clave = Math.round(m.tiempoMs / 50)
      if (vistos.has(clave)) return false
      vistos.add(clave)
      return true
    })
    .map((m) => ({ nombre: nombreDeMarcadorArchivo(m.nombre), tiempoMs: m.tiempoMs }))
}
