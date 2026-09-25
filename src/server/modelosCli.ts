/**
 * `npm run modelos`: baja el reconocedor de voz a ./modelos para incluirlo en
 * el instalador (`npm run dist` lo empaqueta en resources/modelos). Asi la
 * app detecta secciones por la voz guia sin descargar nada en la iglesia.
 */
import path from 'node:path'
import { descargarModeloVoz, MODELO_VOZ } from './modelos'

async function main(): Promise<void> {
  const base = path.resolve(process.argv[2] ?? 'modelos')
  console.log(`Bajando ${MODELO_VOZ.repo} a ${path.join(base, MODELO_VOZ.nombre)} …`)
  let ultimo = -1
  await descargarModeloVoz(base, (f) => {
    const pct = Math.floor(f * 100)
    if (pct !== ultimo && pct % 5 === 0) {
      ultimo = pct
      process.stdout.write(`  ${pct}%\n`)
    }
  })
  console.log('Listo: el modelo se incluye en el próximo "npm run dist".')
}

main().catch((err: unknown) => {
  console.error(`No se pudo bajar el modelo: ${(err as Error).message}`)
  process.exit(1)
})
