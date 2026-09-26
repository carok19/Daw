import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import express from 'express'
import { Server as SocketIOServer } from 'socket.io'
import { AppState } from './state'
import { DeviceRegistry } from './devices'
import { registerSocketHandlers, restaurarSesion } from './socketHandlers'
import { ensureBaseDir, esIdValido, leerSesion, listProyectos, loadProyecto, projectDir, projectsBaseDir } from './projects'
import type { Transporte } from './transport'
import type { Analizador } from './analisis'
import type { Biblioteca } from './biblioteca'
import { ModelosVoz } from './modelos'
import { leerAjustes, type Ajustes } from './ajustes'
import { Descubrimiento } from './descubrimiento'
import { Mezclador } from './mezclador'
import { archivoQueSuena, type Tonos } from './tono'
import { Licencias } from './licencia'
import { decodificarMezcla, SEGMENTO_SEC } from '../shared/mezcla'
import { posicionActualMs } from '../shared/playback'

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
  /** mezcla de cada celular (una pista estereo en vez de todas las pistas) */
  mezclador: Mezclador
  /** cambio de tono de las canciones (prepara las pistas transpuestas) */
  tonos: Tonos
  licencias: Licencias
  /** secreto que identifica a la ventana de Electron como "la compu" (ver socketHandlers.origenDe) */
  compuToken: string
  start(preferredPort: number): Promise<number>
  /** reabre las canciones de la ultima sesion (pestanas abiertas al cerrar la app) */
  restaurarSesion(): Promise<void>
  /**
   * Arranca la biblioteca (carpeta vigilada), retoma los analisis que
   * quedaron a medias y deja a la compu "encontrable" por los celulares
   * (airtracks.local, la app Android y la direccion corta en el puerto 80).
   */
  iniciarServicios(bibliotecaPorDefecto: string | null, opciones?: OpcionesServicios): void
  /** ajustes de conexion (codigo de la banda, WiFi) */
  ajustes: Ajustes
  /** puerto de la direccion corta (80) si se pudo usar */
  puertoCorto(): number | null
  close(): Promise<void>
}

export interface OpcionesServicios {
  /** anunciarse por mDNS (airtracks.local) y responder a la busqueda de la app Android (por defecto si) */
  descubrimiento?: boolean
  /** puertos del descubrimiento (los tests usan otros) */
  puertoMdns?: number
  puertoUdp?: number
  /** puerto de la direccion corta que redirige al principal (por defecto 80; null = no) */
  puertoCorto?: number | null
}

export interface OpcionesServidor {
  compuToken?: string
  /** carpeta de modelos incluida en el instalador (resources/modelos) */
  dirModelos?: string | null
  /** analizar tempo/secciones al importar (por defecto si; los tests que no lo prueban lo apagan) */
  analisisAutomatico?: boolean
  /** carpeta con la app Android (airtracks.apk) incluida en el instalador (resources/extras) */
  dirExtras?: string | null
  /** version de la app (se informa a la app Android) */
  version?: string
  /** clave publica de las licencias (undefined = la que trae la app; null = sin licencias) */
  clavePublicaLicencias?: string | null
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
  // cada minuto se anota que la app sigue abierta: al reabrirla se sabe si se corto recien (vuelve todo) o no (pantalla de listas)
  const latido = setInterval(() => {
    if (state.listaTabs().length) state.guardarSesionAhora()
  }, 60_000)
  latido.unref()
  const devices = new DeviceRegistry()
  const ajustes = leerAjustes()
  const licencias = new Licencias(opciones.clavePublicaLicencias)
  const version = opciones.version ?? '0.0.0'
  const rutaApk = opciones.dirExtras ? path.join(opciones.dirExtras, 'airtracks.apk') : null
  const hayApk = (): boolean => !!rutaApk && fs.existsSync(rutaApk)
  let puertoCortoActivo: number | null = null
  const nombreVisible = `AirTracks · ${os.hostname()}`.slice(0, 60)

  // para la app Android (y la pagina, que prueba si anda airtracks.local): que app es y si pide codigo.
  // `app` es un id interno (de cuando se llamaba Multitrack Alabanza): no cambiarlo, lo buscan las apps ya instaladas.
  app.get('/api/info', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.json({ app: 'multitrack-alabanza', nombre: nombreVisible, version, id: ajustes.idInstalacion, requiereCodigo: !!ajustes.codigoBanda, apk: hayApk() })
  })
  // la app Android se baja de la misma compu (sin Play Store ni internet)
  app.get('/app/airtracks.apk', (_req, res) => {
    if (!rutaApk || !hayApk()) return res.status(404).end()
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    res.setHeader('Content-Disposition', 'attachment; filename="AirTracks.apk"')
    res.sendFile(rutaApk)
  })
  // el enlace de antes del cambio de nombre (hojas impresas, mensajes viejos)
  app.get('/app/alabanza.apk', (_req, res) => res.redirect(302, '/app/airtracks.apk'))

  // mezcla de cada celular: el segmento <n> (2 s) de la cancion como UN WAV estereo, con la mezcla que pide
  // (?m=... = ganancia y paneo por pista, ver shared/mezcla.ts). Asi cada celular baja ~1,4 Mbps y no 20+.
  // lo mas urgente primero: el segmento que va a sonar antes (de la cancion que esta arriba; las demas, al final)
  const mezclador = new Mezclador(projectDir, (proyectoId, indice) => {
    const tab = state.getActiveTab()
    if (!tab || tab.proyecto.id !== proyectoId) return 1e9 + indice
    return indice * SEGMENTO_SEC * 1000 - posicionActualMs(tab.playback, Date.now())
  })
  app.get('/mezcla/:proyectoId/:segmento', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const { proyectoId, segmento } = req.params
    const m = /^(\d{1,6})\.wav$/.exec(segmento)
    if (!esIdValido(proyectoId) || !m) return res.status(400).end()
    const proyecto = state.tabDeProyecto(proyectoId)?.proyecto
    if (!proyecto) return res.status(404).end()
    // audio reemplazado (zip actualizado): el celular tiene que volver a pedir con la revision nueva
    if (String(proyecto.revision ?? 0) !== String(req.query.v ?? '0')) return res.status(409).end()
    const texto = typeof req.query.m === 'string' ? req.query.m : ''
    const canales = decodificarMezcla(texto)
    if (!canales) return res.status(400).end()
    try {
      const seg = await mezclador.segmento(proyecto, Number(m[1]), canales, texto)
      if (!seg) return res.status(416).end() // despues del final de la cancion
      res.setHeader('Content-Type', 'audio/wav')
      res.setHeader('X-Ultimo', seg.ultimo ? '1' : '0')
      res.end(seg.wav)
    } catch {
      if (!res.headersSent) res.status(500).end()
    }
  })

  // cancion en otro tono: las pistas transpuestas se sirven en la misma direccion que las originales
  // (la `revision` cambia al cambiar el tono, asi nadie se queda con lo que tenia en cache)
  app.use('/media', (req, _res, next) => {
    const m = /^\/([^/]+)\/(.+)$/.exec(req.path)
    const proyecto = m && esIdValido(m[1]) ? state.tabDeProyecto(m[1])?.proyecto : null
    if (m && proyecto?.tonoAplicado) {
      let rel: string | null = null
      try {
        rel = decodeURIComponent(m[2])
      } catch {
        // direccion mal escrita: la atiende express.static (404)
      }
      const pista = rel ? proyecto.pistas.find((x) => x.archivo === rel) : undefined
      const archivo = pista ? archivoQueSuena(proyecto, pista) : null
      if (pista && archivo !== pista.archivo) req.url = `/${m[1]}/${archivo!.split('/').map(encodeURIComponent).join('/')}${req.url.slice(req.path.length)}`
    }
    next()
  })
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

  const { transporte, analizador, biblioteca, tonos } = registerSocketHandlers(io, state, devices, compuToken, modelos, opciones.analisisAutomatico ?? true, {
    ajustes,
    puerto: () => {
      const a = httpServer.address()
      return typeof a === 'object' && a ? a.port : 0
    },
    puertoCorto: () => puertoCortoActivo,
    hayApk,
    estadisticasMezcla: () => mezclador.estadisticas(),
    version,
    licencias
  })

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

  let descubrimiento: Descubrimiento | null = null
  let servidorCorto: http.Server | null = null

  function iniciarServicios(bibliotecaPorDefecto: string | null, op: OpcionesServicios = {}): void {
    for (const r of listProyectos()) {
      const p = loadProyecto(r.id)
      if (!p.analisis || p.analisis.estado === 'analizando') analizador.encolar(p.id)
      else analizador.registrarPendiente(p)
    }
    biblioteca.iniciar(bibliotecaPorDefecto)

    if (op.descubrimiento ?? true) {
      descubrimiento = new Descubrimiento(
        () => {
          const a = httpServer.address()
          return {
            nombre: nombreVisible,
            puerto: typeof a === 'object' && a ? a.port : 0,
            id: ajustes.idInstalacion,
            version,
            requiereCodigo: !!ajustes.codigoBanda
          }
        },
        { puertoMdns: op.puertoMdns, puertoUdp: op.puertoUdp }
      )
      descubrimiento.iniciar()
    }

    // direccion corta: http://192.168.1.35 (o http://airtracks.local) sin ":4848", que redirige al puerto real.
    // Si el puerto 80 esta ocupado o no se puede usar, no pasa nada: queda la direccion con puerto.
    const puertoCorto = op.puertoCorto === undefined ? 80 : op.puertoCorto
    if (puertoCorto !== null) {
      const s = http.createServer((req, res) => {
        const a = httpServer.address()
        const puerto = typeof a === 'object' && a ? a.port : 0
        const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '').replace(/[^a-zA-Z0-9.\-[\]:]/g, '')
        res.writeHead(302, { Location: `http://${host}:${puerto}${req.url?.startsWith('/') ? req.url : '/'}`, 'Cache-Control': 'no-store' })
        res.end()
      })
      s.on('error', () => {
        puertoCortoActivo = null
      })
      s.listen(puertoCorto, () => {
        const a = s.address()
        puertoCortoActivo = typeof a === 'object' && a ? a.port : puertoCorto
        servidorCorto = s
      })
    }
  }

  async function close(): Promise<void> {
    clearInterval(latido)
    mezclador.cerrar()
    tonos.cerrar()
    descubrimiento?.detener()
    servidorCorto?.close()
    biblioteca.apagar()
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
    mezclador,
    tonos,
    licencias,
    compuToken,
    ajustes,
    puertoCorto: () => puertoCortoActivo,
    start,
    restaurarSesion: () => restaurarSesion(state, leerSesion()),
    iniciarServicios,
    close
  }
}
