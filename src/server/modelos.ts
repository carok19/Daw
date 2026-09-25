import fs from 'node:fs'
import path from 'node:path'
import type { InfoModeloVoz } from '../shared/types'
import { appBaseDir } from './projects'

/**
 * Modelo de reconocimiento de voz (Whisper "base", multilingüe, cuantizado:
 * ~80 MB) que usa la compu para entender la voz guia. Funciona sin internet:
 * o viene incluido en el instalador (`npm run modelos` antes de `dist`), o
 * se descarga una sola vez desde la app. Se sirve por HTTP desde este mismo
 * servidor en /modelos/<nombre>/..., que es donde lo busca transformers.js.
 */

export const MODELO_VOZ = {
  nombre: 'whisper-base',
  repo: 'Xenova/whisper-base',
  obligatorios: [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx'
  ],
  opcionales: ['special_tokens_map.json', 'added_tokens.json', 'normalizer.json', 'vocab.json', 'merges.txt']
}

export function dirModelosUsuario(): string {
  return path.join(appBaseDir(), 'modelos')
}

export class ModelosVoz {
  private info: InfoModeloVoz
  private oyentes = new Set<(i: InfoModeloVoz) => void>()

  /** `dirIncluido`: carpeta de modelos que viene dentro del instalador (resources/modelos), si hay. */
  constructor(private readonly dirIncluido: string | null) {
    this.info = { estado: this.dirDisponible() ? 'listo' : 'falta', url: '/modelos/' }
  }

  /** Carpeta (incluida o descargada) que tiene todos los archivos del modelo, o null. */
  dirDisponible(): string | null {
    for (const base of [this.dirIncluido, dirModelosUsuario()]) {
      if (!base) continue
      const dir = path.join(base, MODELO_VOZ.nombre)
      if (MODELO_VOZ.obligatorios.every((f) => fs.existsSync(path.join(dir, f)))) return base
    }
    return null
  }

  estado(): InfoModeloVoz {
    return { ...this.info }
  }

  onCambio(cb: (i: InfoModeloVoz) => void): () => void {
    this.oyentes.add(cb)
    return () => this.oyentes.delete(cb)
  }

  private set(info: InfoModeloVoz): void {
    this.info = { url: '/modelos/', ...info }
    for (const o of this.oyentes) o(this.estado())
  }

  /** Descarga el modelo desde Hugging Face (una sola vez) a ~/MultitrackApp/modelos. */
  async descargar(host = HOST_MODELOS): Promise<void> {
    if (this.info.estado === 'descargando') return
    if (this.dirDisponible()) {
      this.set({ estado: 'listo' })
      return
    }
    try {
      this.set({ estado: 'descargando', progreso: 0 })
      await descargarModeloVoz(dirModelosUsuario(), (progreso) => this.set({ estado: 'descargando', progreso }), host)
      this.set({ estado: this.dirDisponible() ? 'listo' : 'error', mensaje: this.dirDisponible() ? undefined : 'Faltan archivos del modelo' })
    } catch (err) {
      this.set({ estado: 'error', mensaje: `No se pudo descargar el reconocedor de voz: ${(err as Error).message}. Revisá la conexión a internet.` })
    }
  }
}

export const HOST_MODELOS = 'https://huggingface.co'

/**
 * Baja los archivos del modelo a `<base>/whisper-base/` (lo que ya esta se
 * saltea; cada archivo se escribe como `.parte` y se renombra al terminar,
 * asi un corte nunca deja un archivo a medias que parezca completo).
 */
export async function descargarModeloVoz(base: string, onProgreso: (fraccion: number) => void, host = HOST_MODELOS): Promise<void> {
  const destino = path.join(base, MODELO_VOZ.nombre)
  fs.mkdirSync(path.join(destino, 'onnx'), { recursive: true })
  const archivos = [...MODELO_VOZ.obligatorios.map((f) => ({ f, obligatorio: true })), ...MODELO_VOZ.opcionales.map((f) => ({ f, obligatorio: false }))]
  // tamaños aproximados para una barra de progreso pareja (los .onnx son casi todo)
  const pesos = archivos.map(({ f }) => (f.includes('encoder') ? 25 : f.includes('decoder') ? 55 : f === 'tokenizer.json' ? 2 : 0.1))
  const total = pesos.reduce((a, b) => a + b, 0)
  let hecho = 0
  for (let i = 0; i < archivos.length; i++) {
    const { f, obligatorio } = archivos[i]
    const final = path.join(destino, f)
    if (fs.existsSync(final)) {
      hecho += pesos[i]
      continue
    }
    const resp = await fetch(`${host}/${MODELO_VOZ.repo}/resolve/main/${f}`)
    if (!resp.ok || !resp.body) {
      if (!obligatorio && resp.status === 404) continue
      throw new Error(`No se pudo bajar ${f} (HTTP ${resp.status})`)
    }
    const largo = Number(resp.headers.get('content-length')) || 0
    const parcial = `${final}.parte`
    const salida = fs.createWriteStream(parcial)
    let recibidos = 0
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      recibidos += value.byteLength
      if (!salida.write(value)) await new Promise<void>((r) => salida.once('drain', () => r()))
      if (largo) onProgreso(Math.min(0.999, (hecho + pesos[i] * (recibidos / largo)) / total))
    }
    await new Promise<void>((r, rej) => salida.end((err?: Error | null) => (err ? rej(err) : r())))
    fs.renameSync(parcial, final)
    hecho += pesos[i]
    onProgreso(hecho / total)
  }
}
