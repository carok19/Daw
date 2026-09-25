/// <reference lib="webworker" />
/**
 * Reconocedor de voz (Whisper "base", en WebAssembly) para la pista de guia.
 * Corre en un Worker: el hilo de la interfaz de la compu nunca se traba.
 *
 * Todo es local: el modelo lo sirve el propio servidor de la app en
 * /modelos/whisper-base/ (incluido en el instalador o descargado una vez) y
 * el runtime de ONNX en /ort/. No se conecta a internet.
 */
import { env, pipeline } from '@huggingface/transformers'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = '/modelos/'
env.useBrowserCache = false
const onnx = env.backends.onnx
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm' }
  // sin SharedArrayBuffer (la pagina se sirve por http sin aislamiento): un solo hilo
  onnx.wasm.numThreads = 1
}

type Reconocer = (audio: Float32Array, opciones: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>
let cargando: Promise<Reconocer> | null = null

function modelo(): Promise<Reconocer> {
  if (!cargando) {
    cargando = pipeline('automatic-speech-recognition', 'whisper-base', { dtype: 'q8', device: 'wasm' }).then(
      (p) => p as unknown as Reconocer
    )
    cargando.catch(() => {
      cargando = null
    })
  }
  return cargando
}

export interface PedidoWorker {
  id: number
  audio: Float32Array
}

export type RespuestaWorker = { id: number; texto: string } | { id: number; error: string }

self.onmessage = async (e: MessageEvent<PedidoWorker>) => {
  const { id, audio } = e.data
  try {
    const reconocer = await modelo()
    const r = await reconocer(audio, { language: 'spanish', task: 'transcribe' })
    const texto = (Array.isArray(r) ? r[0]?.text : r.text) ?? ''
    ;(self as unknown as Worker).postMessage({ id, texto: texto.trim() } satisfies RespuestaWorker)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies RespuestaWorker)
  }
}
