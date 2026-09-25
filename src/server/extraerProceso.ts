/**
 * Proceso aparte que descomprime una cancion (.zip o .rar) en una carpeta:
 * solo las pistas de audio y los archivos chicos con marcadores, con nombres
 * propios ("0.wav", "1.mp3"...) para que nada del comprimido pueda escribir
 * fuera de la carpeta. Ver comprimidos.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { createExtractorFromFile, UnrarError } from 'node-unrar-js'
import { esArchivoBasura, type ArchivoExtraido, type MensajeExtraccion, type PedidoExtraccion } from './comprimidos'

const MAX_BYTES_EXTRA = 5 * 1024 ** 2

class Fallo extends Error {
  constructor(
    readonly codigo: 'sin-pistas' | 'invalido',
    mensaje: string
  ) {
    super(mensaje)
  }
}

interface Candidato {
  nombre: string
  tam: number
  audio: boolean
}

function enviar(m: MensajeExtraccion): Promise<void> {
  return new Promise((r) => process.send!(m, () => r()))
}

/** Elige que archivos sacar y controla los limites (con los tamaños que declara el comprimido). */
function elegir(p: PedidoExtraccion, entradas: { nombre: string; tam: number; carpeta: boolean }[]): Candidato[] {
  const audio = new Set(p.extensionesAudio)
  const extra = new Set(p.extensionesExtra)
  const elegidos = entradas
    .filter((e) => !e.carpeta && !esArchivoBasura(e.nombre))
    .map((e) => {
      const ext = path.extname(e.nombre).toLowerCase()
      return { nombre: e.nombre, tam: e.tam, audio: audio.has(ext), extra: extra.has(ext) && e.tam <= MAX_BYTES_EXTRA }
    })
    .filter((e) => e.audio || e.extra)
  const pistas = elegidos.filter((e) => e.audio)
  if (pistas.length === 0) throw new Fallo('sin-pistas', 'No se encontraron pistas de audio en este archivo')
  if (pistas.length > p.maxPistas) throw new Fallo('invalido', `Demasiadas pistas en el archivo (máximo ${p.maxPistas})`)
  const total = pistas.reduce((a, e) => a + e.tam, 0)
  if (total > p.maxBytesTotal || pistas.some((e) => e.tam > p.maxBytesPorPista)) throw new Fallo('invalido', 'El archivo es demasiado grande')
  return elegidos.map(({ nombre, tam, audio: a }) => ({ nombre, tam, audio: a }))
}

function nombreDestino(i: number, nombre: string): string {
  return `${i}${path.extname(nombre).toLowerCase()}`
}

async function extraerZip(p: PedidoExtraccion): Promise<ArchivoExtraido[]> {
  let zip: AdmZip
  try {
    zip = new AdmZip(p.ruta)
  } catch {
    throw new Fallo('invalido', 'No se pudo abrir el .zip (está dañado o no es un zip)')
  }
  const entradas = zip.getEntries()
  const elegidos = elegir(
    p,
    entradas.map((e) => ({ nombre: e.entryName, tam: e.header.size, carpeta: e.isDirectory }))
  )
  const porNombre = new Map(entradas.map((e) => [e.entryName, e]))
  const res: ArchivoExtraido[] = []
  for (const [i, c] of elegidos.entries()) {
    const ruta = path.join(p.destino, nombreDestino(i, c.nombre))
    const datos = porNombre.get(c.nombre)!.getData()
    fs.writeFileSync(ruta, datos)
    res.push({ nombre: c.nombre, ruta, tam: datos.length })
    await enviar({ tipo: 'progreso', hechos: i + 1, total: elegidos.length })
  }
  return res
}

function mensajeUnrar(err: UnrarError): Fallo {
  switch (err.reason) {
    case 'ERAR_MISSING_PASSWORD':
    case 'ERAR_BAD_PASSWORD':
      return new Fallo('invalido', 'El .rar tiene contraseña: descomprimilo y volvé a comprimirlo sin contraseña (en .zip o .rar)')
    case 'ERAR_EOPEN':
      return new Fallo('invalido', 'Falta una parte del .rar: copiá todas las partes (.part1.rar, .part2.rar…) en la misma carpeta')
    case 'ERAR_ECREATE':
    case 'ERAR_EWRITE':
      return new Fallo('invalido', 'No se pudo escribir en el disco mientras se descomprimía (¿falta espacio?)')
    case 'ERAR_NO_MEMORY':
      return new Fallo('invalido', 'No alcanzó la memoria para descomprimir el .rar')
    default:
      return new Fallo('invalido', 'El .rar está dañado o incompleto')
  }
}

async function extraerRar(p: PedidoExtraccion): Promise<ArchivoExtraido[]> {
  const wasmBinary = fs.readFileSync(require.resolve('node-unrar-js/dist/js/unrar.wasm'))
  const normal = (n: string): string => n.replace(/\\/g, '/')
  const salida = new Map<string, string>()
  try {
    const extractor = await createExtractorFromFile({
      wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer,
      filepath: p.ruta,
      targetPath: p.destino,
      // cada archivo se escribe con un nombre propio, nunca con la ruta que trae el .rar
      filenameTransform: (n) => salida.get(normal(n)) ?? `descartado-${salida.size}`
    })
    const lista = extractor.getFileList()
    const cabeceras = [...lista.fileHeaders]
    if (cabeceras.length === 0) throw new Fallo('invalido', 'El .rar está dañado o incompleto (no se pudo leer ningún archivo)')
    const elegidos = elegir(
      p,
      cabeceras.map((h) => ({ nombre: normal(h.name), tam: h.unpSize, carpeta: h.flags.directory }))
    )
    if (cabeceras.some((h) => h.flags.encrypted && elegidos.some((e) => e.nombre === normal(h.name)))) {
      throw mensajeUnrar(new UnrarError('ERAR_MISSING_PASSWORD', ''))
    }
    elegidos.forEach((c, i) => salida.set(c.nombre, nombreDestino(i, c.nombre)))
    const { files } = extractor.extract({ files: (h) => salida.has(normal(h.name)) })
    let hechos = 0
    for (const _ of files) await enviar({ tipo: 'progreso', hechos: ++hechos, total: elegidos.length })
    return elegidos.map((c) => {
      const ruta = path.join(p.destino, salida.get(c.nombre)!)
      return { nombre: c.nombre, ruta, tam: fs.statSync(ruta).size }
    })
  } catch (err) {
    if (err instanceof UnrarError) throw mensajeUnrar(err)
    // unrar abre la parte siguiente cuando la necesita: si no esta, falla al abrirla
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT' && e.path) {
      throw new Fallo('invalido', `Falta una parte del .rar (${path.basename(e.path)}): copiá todas las partes en la misma carpeta`)
    }
    throw err
  }
}

process.once('message', async (p: PedidoExtraccion) => {
  try {
    const archivos = p.ruta.toLowerCase().endsWith('.rar') ? await extraerRar(p) : await extraerZip(p)
    await enviar({ tipo: 'ok', archivos })
    process.exit(0)
  } catch (err) {
    const f = err instanceof Fallo ? err : new Fallo('invalido', `No se pudo descomprimir: ${(err as Error)?.message ?? err}`)
    await enviar({ tipo: 'error', codigo: f.codigo, mensaje: f.message })
    process.exit(0)
  }
})
