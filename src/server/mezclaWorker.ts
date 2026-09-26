import { parentPort } from 'node:worker_threads'
import { calcularMezcla, type TrabajoMezcla } from './mezclaCalculo'

/**
 * Hilo de trabajo del mezclador (ver mezclador.ts): recibe un segmento para
 * mezclar y devuelve el WAV. Va incrustado en el programa como texto
 * (scripts/build-main.mjs), asi no depende de un archivo suelto en el instalador.
 */
parentPort?.on('message', async (m: { id: number; trabajo: TrabajoMezcla }) => {
  const t0 = performance.now()
  try {
    const wav = await calcularMezcla(m.trabajo)
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
    parentPort!.postMessage({ id: m.id, wav: ab, ms: performance.now() - t0 }, [ab])
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: String((err as Error)?.message ?? err) })
  }
})
