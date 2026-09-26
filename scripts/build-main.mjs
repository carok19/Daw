import * as esbuild from 'esbuild'
import { existsSync } from 'node:fs'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  // licencias/clave-publica.txt va adentro del programa (no es un archivo aparte que se pueda cambiar)
  loader: { '.txt': 'text' }
}

await esbuild.build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'out/main/index.cjs'
})

await esbuild.build({
  ...common,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'out/main/preload.cjs'
})

if (existsSync('src/server/server.test.ts')) {
  await esbuild.build({
    ...common,
    entryPoints: ['src/server/server.test.ts'],
    outfile: 'out/main/server.test.cjs'
  })
}

if (existsSync('src/e2e/e2e.test.ts')) {
  await esbuild.build({
    ...common,
    entryPoints: ['src/e2e/e2e.test.ts'],
    outfile: 'out/main/e2e.test.cjs'
  })
}

if (existsSync('src/server/analisis/analisis.test.ts')) {
  await esbuild.build({
    ...common,
    entryPoints: ['src/server/analisis/analisis.test.ts'],
    outfile: 'out/main/analisis.test.cjs'
  })
}

if (existsSync('src/server/automatico.test.ts')) {
  await esbuild.build({
    ...common,
    entryPoints: ['src/server/automatico.test.ts'],
    outfile: 'out/main/automatico.test.cjs'
  })
}

await esbuild.build({
  ...common,
  entryPoints: ['src/server/modelosCli.ts'],
  outfile: 'out/main/modelos-cli.cjs',
  logLevel: 'warning'
})

// proceso aparte que descomprime .zip/.rar (ver src/server/comprimidos.ts)
await esbuild.build({
  ...common,
  entryPoints: ['src/server/extraerProceso.ts'],
  outfile: 'out/main/extraer.cjs',
  logLevel: 'warning'
})
