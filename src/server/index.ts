import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import express from 'express'
import { Server as SocketIOServer } from 'socket.io'
import { AppState } from './state'
import { DeviceRegistry } from './devices'
import { registerSocketHandlers, restaurarSesion } from './socketHandlers'
import { ensureBaseDir, leerSesion, projectsBaseDir } from './projects'
import type { Transporte } from './transport'

export interface AppServer {
  app: express.Express
  httpServer: http.Server
  io: SocketIOServer
  state: AppState
  devices: DeviceRegistry
  transporte: Transporte
  /** secreto que identifica a la ventana de Electron como "la compu" (ver socketHandlers.origenDe) */
  compuToken: string
  start(preferredPort: number): Promise<number>
  /** reabre las canciones de la ultima sesion (pestanas abiertas al cerrar la app) */
  restaurarSesion(): Promise<void>
  close(): Promise<void>
}

export interface OpcionesServidor {
  compuToken?: string
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
  // index.html nunca se cachea (asi un celular siempre toma la version nueva de la app); los assets tienen hash
  app.use(express.static(rendererDir, { index: false, maxAge: '7d' }))
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(rendererDir, 'index.html'))
  })

  const transporte = registerSocketHandlers(io, state, devices, compuToken)

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

  async function start(preferredPort: number): Promise<number> {
    try {
      return await listenOn(preferredPort)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        // el puerto preferido esta ocupado: se pide uno libre al sistema operativo
        return listenOn(0)
      }
      throw err
    }
  }

  async function close(): Promise<void> {
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
    compuToken,
    start,
    restaurarSesion: () => restaurarSesion(state, leerSesion()),
    close
  }
}
