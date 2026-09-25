import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import express from 'express'
import { Server as SocketIOServer } from 'socket.io'
import { AppState } from './state'
import { DeviceRegistry } from './devices'
import { registerSocketHandlers, restaurarSesion } from './socketHandlers'
import { ensureBaseDir, leerSesion, listProyectos, loadProyecto, projectsBaseDir } from './projects'
import type { Transporte } from './transport'
import type { Analizador } from './analisis'
import type { Biblioteca } from './biblioteca'
import { ModelosVoz } from './modelos'

export interface AppServer {
  app: express.Express
  httpServer: http.Server
  io: SocketIOServer
  state: AppState
  devices: DeviceRegistry
  transporte: Transporte
  analizador: Analizador
  biblioteca: Biblioteca
  modelos: ModelosVoz
  /** secreto que identifica a la ventana de Electron como "la compu" (ver socketHandlers.origenDe) */
  compuToken: string
  start(preferredPort: number): Promise<number>
  /** reabre las canciones de la ultima sesion (pestanas abiertas al cerrar la app) */
  restaurarSesion(): Promise<void>
  /**
   * Arranca la biblioteca (carpeta vigilada) y retoma los analisis que
   * quedaron a medias o pendientes (canciones viejas sin analizar incluidas).
   */
  iniciarServicios(bibliotecaPorDefecto: string | null): void
  close(): Promise<void>
}

export interface OpcionesServidor {
  compuToken?: string
  /** carpeta de modelos incluida en el instalador (resources/modelos) */
  dirModelos?: string | null
  /** analizar tempo/secciones al importar (por defecto si; los tests que no lo prueban lo apagan) */
  analisisAutomatico?: boolean
}

/**
 * Arma el servidor Express + Socket.IO embebido. No arranca a escuchar todavia
 * (ver `start`) para poder registrarlo antes de crear la ventana de Electron.
 */
export function createServer(rendererDir: string, opciones: OpcionesServidor = {}): AppServer {
  ensureBaseDir()
  const compuToken = opciones.compuToken ?? crypto.randomBytes(24).toString('hex')

  const app = express()
  app.disable('x-powered-by')
  const httpServer = http.createServer(app)
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 8000 })
  const state = new AppState()
  const devices = new DeviceRegistry()

  // audio de las pistas: express.static responde "206 Partial Content" a los pedidos Range del streaming
  app.use('/media', express.static(projectsBaseDir(), { fallthrough: false, maxAge: '1h' }))

  // modelo de reconocimiento de voz (incluido en el instalador o descargado): lo carga la compu
  const modelos = new ModelosVoz(opciones.dirModelos ?? null)
  const estaticos = new Map<string, express.Handler>()
  app.use('/modelos', (req, res, next) => {
    const base = modelos.dirDisponible()
    if (!base) return res.status(404).end()
    if (!estaticos.has(base)) estaticos.set(base, express.static(base, { fallthrough: false, maxAge: '30d' }))
    estaticos.get(base)!(req, res, next)
  })
  // index.html nunca se cachea (asi un celular siempre toma la version nueva de la app); los assets tienen hash
  app.use(express.static(rendererDir, { index: false, maxAge: '7d' }))
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(rendererDir, 'index.html'))
  })

  const { transporte, analizador, biblioteca } = registerSocketHandlers(io, state, devices, compuToken, modelos, opciones.analisisAutomatico ?? true)

  async function listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, () => {
        httpServer.removeListener('error', reject)
        const address = httpServer.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  /**
   * Escucha en el puerto preferido o, si esta ocupado, en los siguientes
   * (4849, 4850...): asi la direccion (y el QR que ya tienen los celulares, y
   * las preferencias guardadas por origen) es la misma de un dia al otro. Solo
   * si estan todos ocupados se pide uno cualquiera al sistema operativo.
   */
  async function start(preferredPort: number): Promise<number> {
    const candidatos = preferredPort === 0 ? [0] : [...Array.from({ length: 10 }, (_, i) => preferredPort + i), 0]
    for (const puerto of candidatos) {
      try {
        return await listenOn(puerto)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || puerto === 0) throw err
      }
    }
    throw new Error('sin puerto disponible')
  }

  function iniciarServicios(bibliotecaPorDefecto: string | null): void {
    for (const r of listProyectos()) {
      const p = loadProyecto(r.id)
      if (!p.analisis || p.analisis.estado === 'analizando') analizador.encolar(p.id)
      else analizador.registrarPendiente(p)
    }
    biblioteca.iniciar(bibliotecaPorDefecto)
  }

  async function close(): Promise<void> {
    biblioteca.detener()
    analizador.detener()
    transporte.cancelarTimers()
    state.guardarPendientes()
    io.close()
    await new Promise<void>((r) => httpServer.close(() => r()))
  }

  return {
    app,
    httpServer,
    io,
    state,
    devices,
    transporte,
    analizador,
    biblioteca,
    modelos,
    compuToken,
    start,
    restaurarSesion: () => restaurarSesion(state, leerSesion()),
    iniciarServicios,
    close
  }
}
