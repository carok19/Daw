import * as esbuild from 'esbuild'
import { existsSync } from 'node:fs'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info'
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
