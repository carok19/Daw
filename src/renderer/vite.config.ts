import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Renderer is served both to the Electron window and to phones on the LAN
// (by the embedded Express server), so it must be a plain relative-path build.
export default defineConfig({
  root: path.resolve(__dirname),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  build: {
    outDir: path.resolve(__dirname, '../../out/renderer'),
    emptyOutDir: true
  },
  server: {
    host: true,
    port: 5173
  }
})
