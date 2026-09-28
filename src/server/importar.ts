import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type express from 'express'
import type { Server as SocketIOServer } from 'socket.io'
import type { AppState } from './state'
import { buildEstadoCompleto } from './estado'
import { crearProyectoDesdeZip, ZipSinPistasError } from './zip'

/** Tamano maximo de un .zip recibido por la red. */
export const LIMITE_IMPORTAR_BYTES = 4 * 1024 * 1024 * 1024

function esLocal(req: express.Request): boolean {
  const ip = req.socket.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** Nombre del archivo tal como lo manda el cliente (el nombre del zip es el de la cancion). */
function nombreArchivo(crudo: string | undefined): string {
  let nombre = ''
  if (crudo) {
    try {
      nombre = decodeURIComponent(crudo)
    } catch {
      nombre = crudo
    }
  }
  nombre = path
    .basename(nombre.replace(/\\/g, '/'))
    .replace(/[:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!nombre.toLowerCase().endsWith('.zip')) nombre = `${nombre || 'Cancion importada'}.zip`
  if (nombre === '.zip') nombre = 'Cancion importada.zip'
  return nombre.length > 160 ? `${nombre.slice(0, 156).trim()}.zip` : nombre
}

/**
 * Rutas HTTP para recibir canciones desde otras apps (p. ej. MoiMoi, el separador de
 * pistas) sin pasar por el dialogo de "Cargar .zip":
 *
 * - `GET /api/info`: para que la otra app detecte que Multitrack Alabanza esta abierto.
 * - `POST /api/importar`: el cuerpo es el .zip (Content-Type: application/zip) y el
 *   encabezado `X-Nombre-Archivo` (URL-encoded) el nombre del archivo. Crea el proyecto
 *   igual que "Cargar .zip" y lo abre en una pestana nueva; si hay una cancion sonando,
 *   la pestana se agrega sin cambiar la cancion activa.
 *
 * Con el control bloqueado (candado) solo se aceptan envios desde esta misma computadora.
 */
export function registrarRutasImportar(app: express.Express, io: SocketIOServer, state: AppState): void {
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nombre-Archivo')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  app.get('/api/info', (_req, res) => {
    res.json({ app: 'multitrack-alabanza', importar: true, bloqueado: state.locked })
  })

  app.post('/api/importar', (req, res) => {
    if (state.locked && !esLocal(req)) {
      res.status(423).json({ ok: false, error: 'El control esta bloqueado en la computadora (candado)' })
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-importar-'))
    const destino = path.join(dir, nombreArchivo(req.header('X-Nombre-Archivo')))
    const limpiar = () => fs.rmSync(dir, { recursive: true, force: true })
    const out = fs.createWriteStream(destino)
    let bytes = 0
    let terminado = false
    const responder = (status: number, body: object) => {
      if (terminado) return
      terminado = true
      res.status(status).json(body)
    }

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > LIMITE_IMPORTAR_BYTES && !terminado) {
        req.unpipe(out)
        out.destroy()
        limpiar()
        responder(413, { ok: false, error: 'El archivo es demasiado grande' })
        req.resume()
      }
    })
    req.on('aborted', () => {
      out.destroy()
      limpiar()
      terminado = true
    })
    out.on('error', () => {
      limpiar()
      responder(500, { ok: false, error: 'No se pudo guardar el archivo recibido' })
    })
    out.on('finish', () => {
      if (terminado) return
      try {
        if (bytes === 0) {
          responder(400, { ok: false, error: 'No llego ningun archivo' })
          return
        }
        const proyecto = crearProyectoDesdeZip(destino)
        const sonando = state.getActiveTab()?.playback.estado === 'playing'
        state.abrirProyecto(proyecto, !sonando)
        io.emit('estado:actualizado', buildEstadoCompleto(state))
        responder(200, {
          ok: true,
          proyectoId: proyecto.id,
          nombre: proyecto.nombre,
          pistas: proyecto.pistas.length,
          marcadores: proyecto.marcadores.length,
          activada: !sonando
        })
      } catch (err) {
        const mensaje = err instanceof ZipSinPistasError ? err.message : 'No se pudo importar el archivo .zip'
        responder(400, { ok: false, error: mensaje })
      } finally {
        limpiar()
      }
    })
    req.pipe(out)
  })
}
