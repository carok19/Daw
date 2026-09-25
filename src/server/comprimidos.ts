import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'

/**
 * Canciones comprimidas: .zip o .rar (tambien .rar en partes: "Cancion.part1.rar",
 * "Cancion.part2.rar"... o "Cancion.rar", "Cancion.r00"...).
 *
 * La descompresion corre en OTRO proceso (extraerProceso.ts): descomprimir un
 * multitrack de 1 GB lleva segundos de CPU y no puede frenar al servidor, que
 * mientras tanto le sigue mandando audio a los celulares. Ademas asi la
 * memoria del zip entero y la libreria de RAR (WebAssembly) quedan aisladas.
 */

export const EXTENSIONES_COMPRIMIDO = ['zip', 'rar']

const PARTE_RAR = /\.part(\d+)\.rar$/i
const PARTE_VIEJA = /\.r\d\d$/i

/** Archivos de sistema que se cuelan en los comprimidos (macOS, Windows): no son pistas. */
export function esArchivoBasura(nombreEnComprimido: string): boolean {
  const partes = nombreEnComprimido.split(/[\\/]/)
  const base = partes[partes.length - 1]
  return base.startsWith('._') || base === '.DS_Store' || base.toLowerCase() === 'thumbs.db' || partes.includes('__MACOSX')
}

/** ¿Se puede importar como cancion? (.zip o .rar; de un .rar en partes, solo la primera parte) */
export function esComprimido(nombre: string): boolean {
  const n = nombre.toLowerCase()
  if (n.endsWith('.zip')) return true
  if (!n.endsWith('.rar')) return false
  const parte = PARTE_RAR.exec(nombre)
  return !parte || Number(parte[1]) === 1
}

/** "Cancion.part3.rar" -> "Cancion.part1.rar" si esta en la misma carpeta (unrar arranca siempre por la primera). */
export function primerVolumen(ruta: string): string {
  const parte = PARTE_RAR.exec(ruta)
  if (!parte || Number(parte[1]) === 1) return ruta
  const primera = `${ruta.slice(0, parte.index)}.part${'1'.padStart(parte[1].length, '0')}.rar`
  return fs.existsSync(primera) ? primera : ruta
}

/** Todos los archivos que forman el comprimido (varios si es un .rar en partes), en orden. */
export function volumenesDe(ruta: string): string[] {
  const dir = path.dirname(ruta)
  const base = path.basename(ruta)
  let hermanos: string[]
  try {
    hermanos = fs.readdirSync(dir)
  } catch {
    return [ruta]
  }
  const parte = PARTE_RAR.exec(base)
  if (parte) {
    const prefijo = base.slice(0, parte.index).toLowerCase()
    return hermanos
      .map((h) => ({ h, p: PARTE_RAR.exec(h) }))
      .filter(({ h, p }) => p && h.slice(0, p.index).toLowerCase() === prefijo)
      .sort((a, b) => Number(a.p![1]) - Number(b.p![1]))
      .map(({ h }) => path.join(dir, h))
  }
  if (base.toLowerCase().endsWith('.rar')) {
    const prefijo = base.slice(0, -4).toLowerCase()
    const viejas = hermanos.filter((h) => PARTE_VIEJA.test(h) && h.slice(0, -4).toLowerCase() === prefijo).sort()
    return [ruta, ...viejas.map((h) => path.join(dir, h))]
  }
  return [ruta]
}

/** Nombre del archivo sin extension ni ".partN": "Santo_Santo.part1.rar" -> "Santo_Santo". */
export function baseDeComprimido(ruta: string): string {
  return path.basename(ruta).replace(PARTE_RAR, '').replace(/\.(zip|rar)$/i, '')
}

// ---------- extraccion (en otro proceso) ----------

export interface ArchivoExtraido {
  /** ruta dentro del comprimido ("Cancion/01 Click.wav") */
  nombre: string
  /** donde quedo en disco */
  ruta: string
  tam: number
}

export interface PedidoExtraccion {
  ruta: string
  destino: string
  /** extensiones de las pistas (".wav"...): las que cuentan para los limites */
  extensionesAudio: string[]
  /** otros archivos chicos que interesan (marcadores: .txt, .mid...) */
  extensionesExtra: string[]
  maxPistas: number
  maxBytesPorPista: number
  maxBytesTotal: number
}

export type MensajeExtraccion =
  | { tipo: 'progreso'; hechos: number; total: number }
  | { tipo: 'ok'; archivos: ArchivoExtraido[] }
  | { tipo: 'error'; codigo: 'sin-pistas' | 'invalido'; mensaje: string }

export class ErrorComprimido extends Error {
  constructor(
    readonly codigo: 'sin-pistas' | 'invalido',
    mensaje: string
  ) {
    super(mensaje)
    this.name = 'ErrorComprimido'
  }
}

/** Compilado junto al servidor (scripts/build-main.mjs). */
const PROCESO = path.join(__dirname, 'extraer.cjs')

export function extraerComprimido(pedido: PedidoExtraccion, onProgreso?: (hechos: number, total: number) => void): Promise<ArchivoExtraido[]> {
  return new Promise((resolve, reject) => {
    // en Electron, fork usa el mismo ejecutable como Node (ELECTRON_RUN_AS_NODE)
    const hijo = fork(PROCESO, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    let terminado = false
    let stderr = ''
    hijo.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString()
    })
    hijo.on('message', (m: MensajeExtraccion) => {
      if (m.tipo === 'progreso') onProgreso?.(m.hechos, m.total)
      else if (!terminado) {
        terminado = true
        if (m.tipo === 'ok') resolve(m.archivos)
        else reject(new ErrorComprimido(m.codigo, m.mensaje))
      }
    })
    hijo.on('error', (err) => {
      if (terminado) return
      terminado = true
      reject(new ErrorComprimido('invalido', `No se pudo descomprimir: ${err.message}`))
    })
    hijo.on('exit', (code) => {
      if (terminado) return
      terminado = true
      if (stderr) console.error('[extraer]', stderr.trim())
      reject(new ErrorComprimido('invalido', `No se pudo abrir el archivo (¿está dañado?)${code ? ` [código ${code}]` : ''}`))
    })
    hijo.send(pedido)
  })
}
