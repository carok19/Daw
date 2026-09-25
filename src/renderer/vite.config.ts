import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Copia el runtime de ONNX (WebAssembly) que usa el reconocedor de voz a
 * out/renderer/ort/: se sirve desde la propia app, sin depender de un CDN
 * (tiene que funcionar sin internet).
 */
function copiarOnnxRuntime(): Plugin {
  const archivos = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']
  return {
    name: 'copiar-onnx-runtime',
    apply: 'build',
    writeBundle(opciones) {
      const origen = path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist')
      const destino = path.join(opciones.dir!, 'ort')
      fs.mkdirSync(destino, { recursive: true })
      for (const a of archivos) fs.copyFileSync(path.join(origen, a), path.join(destino, a))
    }
  }
}

// El renderer se sirve a la ventana de Electron y a los celulares (desde el
// servidor embebido): build con rutas relativas.
export default defineConfig({
  root: path.resolve(__dirname),
  base: './',
  plugins: [react(), copiarOnnxRuntime()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  worker: {
    format: 'es'
  },
  build: {
    outDir: path.resolve(__dirname, '../../out/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000
  },
  server: {
    host: true,
    port: 5173
  }
})
