import fs from 'node:fs'
import path from 'node:path'
import type { CueVoz } from '../../shared/types'
import { ceder } from './decodificar'

/**
 * Voz guia: la pista donde una voz anuncia "Intro", "Verso uno", "Coro"...
 * justo antes de cada parte. Aca se encuentra la pista y se recortan sus
 * frases (entre anuncio y anuncio hay silencio); el reconocimiento de lo que
 * dice cada frase lo hace despues la compu con Whisper (ver renderer
 * analisis/), y `seccionesDesdeFrases` las ubica en el compas.
 */

export const SR_VOZ = 16000

export { pareceNombreDeGuia } from '../../shared/mezcla'

export interface Frase {
  inicioMs: number
  finMs: number
}

const FRAME = 320 // 20 ms a 16 kHz

/**
 * Detecta frases habladas en una pista mayormente silenciosa. Une las
 * palabras separadas por pausas cortas ("verso ... uno"), descarta ruidos
 * muy cortos y tramos largos (si es una voz cantada, no son anuncios).
 */
export async function detectarFrases(x: Float32Array, sr = SR_VOZ): Promise<Frase[]> {
  const frames = Math.floor(x.length / FRAME)
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += x[i] * x[i]
    rms[f] = Math.sqrt(s / FRAME)
    if (f % 50000 === 0) await ceder()
  }
  const ordenado = Float32Array.from(rms).sort()
  const piso = ordenado[Math.floor(frames * 0.2)] ?? 0
  const pico = ordenado[Math.floor(frames * 0.995)] ?? 0
  if (pico < 0.003) return []
  const umbral = Math.max(piso * 5, pico * 0.08, 0.003)

  const msPorFrame = (FRAME / sr) * 1000
  const crudas: Frase[] = []
  let inicio = -1
  for (let f = 0; f <= frames; f++) {
    const activo = f < frames && rms[f] > umbral
    if (activo && inicio < 0) inicio = f
    if (!activo && inicio >= 0) {
      crudas.push({ inicioMs: inicio * msPorFrame, finMs: f * msPorFrame })
      inicio = -1
    }
  }
  // unir pausas cortas dentro de una misma frase
  const unidas: Frase[] = []
  for (const fr of crudas) {
    const previa = unidas[unidas.length - 1]
    if (previa && fr.inicioMs - previa.finMs < 280) previa.finMs = fr.finMs
    else unidas.push({ ...fr })
  }
  return unidas
    .filter((fr) => fr.finMs - fr.inicioMs >= 120 && fr.finMs - fr.inicioMs <= 4500)
    .map((fr) => ({ inicioMs: Math.round(fr.inicioMs), finMs: Math.round(fr.finMs) }))
}

const PADDING_MS = 150
const MAX_FRASES = 80

/**
 * Guarda el audio (16 kHz mono float32) de cada frase en
 * <proyecto>/analisis/cue-<n>.f32, para que la compu lo baje y lo reconozca.
 */
export function guardarFrases(dirProyecto: string, x: Float32Array, frases: Frase[], sr = SR_VOZ): CueVoz[] {
  const dir = path.join(dirProyecto, 'analisis')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return frases.slice(0, MAX_FRASES).map((fr, n) => {
    const i0 = Math.max(0, Math.floor(((fr.inicioMs - PADDING_MS) / 1000) * sr))
    const i1 = Math.min(x.length, Math.ceil(((fr.finMs + PADDING_MS) / 1000) * sr))
    const trozo = x.subarray(i0, i1)
    const archivo = `analisis/cue-${n}.f32`
    fs.writeFileSync(path.join(dirProyecto, archivo), Buffer.from(trozo.buffer, trozo.byteOffset, trozo.byteLength))
    return { n, inicioMs: fr.inicioMs, finMs: fr.finMs, archivo }
  })
}
