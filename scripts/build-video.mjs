// Arma AirTracks Video (el programa del proyector) en video/out: Electron 22 (Windows 7 en adelante),
// asi que el proceso principal es Node 16 y las ventanas Chromium 108.
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const out = 'video/out'
fs.mkdirSync(out, { recursive: true })

const comun = { bundle: true, logLevel: 'warning' }
const nodo = { ...comun, platform: 'node', target: 'node16', format: 'cjs', external: ['electron', 'bufferutil', 'utf-8-validate'] }
const ventana = { ...comun, platform: 'browser', target: 'chrome108', format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' } }

await esbuild.build({ ...nodo, entryPoints: ['src/video/main/index.ts'], outfile: `${out}/main.cjs` })
await esbuild.build({ ...nodo, entryPoints: ['src/video/preload.ts'], outfile: `${out}/preload.cjs` })
await esbuild.build({ ...ventana, entryPoints: ['src/video/control/index.tsx'], outfile: `${out}/control.js`, jsx: 'automatic' })
await esbuild.build({ ...ventana, entryPoints: ['src/video/control/calculo.worker.ts'], outfile: `${out}/calculo.js` })
await esbuild.build({ ...ventana, entryPoints: ['src/video/pantalla/index.ts'], outfile: `${out}/pantalla.js` })
for (const f of ['src/video/control/control.html', 'src/video/control/control.css', 'src/video/pantalla/pantalla.html']) {
  fs.copyFileSync(f, path.join(out, path.basename(f)))
}
console.log('AirTracks Video armado en', out)
