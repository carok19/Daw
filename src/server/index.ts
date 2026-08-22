import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { Server as SocketIOServer } from 'socket.io'
import { AppState } from './state'
import { registerSocketHandlers } from './socketHandlers'
import { ensureBaseDir, projectsBaseDir } from './projects'

export interface AppServer {
  app: express.Express
  httpServer: http.Server
  io: SocketIOServer
  state: AppState
  start(preferredPort: number): Promise<number>
}

/**
 * Arma el servidor Express + Socket.IO embebido. No arranca a escuchar todavia
 * (ver `start`) para poder registrarlo antes de crear la ventana de Electron.
 */
export function createServer(rendererDir: string): AppServer {
  ensureBaseDir()

  const app = express()
  const httpServer = http.createServer(app)
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } })
  const state = new AppState()

  app.use(express.json())
  app.use('/media', express.static(projectsBaseDir()))
  app.use(express.static(rendererDir))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(rendererDir, 'index.html'))
  })

  registerSocketHandlers(io, state)

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

  return { app, httpServer, io, state, start }
}
