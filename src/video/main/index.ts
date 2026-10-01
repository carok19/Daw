import { app, BrowserWindow, dialog, ipcMain, protocol, screen, type Display } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { velocidadAplicada } from '../../shared/velocidad'
import type { EstadoApp, Reproduccion, VideoGuardado } from '../tipos'
import { BibliotecaVideos } from './biblioteca'
import { ConexionAirTracks } from './conexion'

/**
 * AirTracks Video (proceso principal): la ventana de control (videos,
 * conexion, que pantalla es el proyector) y la del proyector, que aparece
 * encima de todo (de Holyrics tambien) solo mientras suena una cancion con
 * video y nunca le saca el foco a nadie.
 */

interface Ajustes {
  deviceId: string
  servidor: string | null
  codigo: string | null
  /** pantalla del proyector elegida (null = la que no es la principal, si hay) */
  pantallaId: number | null
  inicioConWindows: boolean
}

// carpeta de datos (los tests usan otra)
if (process.env.AIRTRACKS_VIDEO_DIR) app.setPath('userData', process.env.AIRTRACKS_VIDEO_DIR)
app.setAppUserModelId('com.airtracks.video')
// el video arranca sin que nadie toque la pantalla del proyector
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

protocol.registerSchemesAsPrivileged([{ scheme: 'atv', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])

if (!app.requestSingleInstanceLock()) app.quit()

const base = app.getPath('userData')
fs.mkdirSync(base, { recursive: true })
const archivoAjustes = path.join(base, 'ajustes.json')

function leerAjustes(): Ajustes {
  try {
    const a = JSON.parse(fs.readFileSync(archivoAjustes, 'utf-8')) as Partial<Ajustes>
    return {
      deviceId: typeof a.deviceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(a.deviceId) ? a.deviceId : nuevoId(),
      servidor: typeof a.servidor === 'string' ? a.servidor : null,
      codigo: typeof a.codigo === 'string' ? a.codigo : null,
      pantallaId: typeof a.pantallaId === 'number' ? a.pantallaId : null,
      inicioConWindows: !!a.inicioConWindows
    }
  } catch {
    return { deviceId: nuevoId(), servidor: null, codigo: null, pantallaId: null, inicioConWindows: false }
  }
}
function nuevoId(): string {
  return crypto.randomBytes(12).toString('hex')
}
const ajustes = leerAjustes()
const guardarAjustes = (): void => fs.writeFileSync(archivoAjustes, JSON.stringify(ajustes, null, 2))
guardarAjustes()

const biblioteca = new BibliotecaVideos(base)
let control: BrowserWindow | null = null
let pantalla: BrowserWindow | null = null

const conexion = new ConexionAirTracks({
  deviceId: ajustes.deviceId,
  nombre: os.hostname().slice(0, 24),
  codigo: () => ajustes.codigo,
  servidorGuardado: () => process.env.AIRTRACKS_SERVIDOR ?? ajustes.servidor,
  guardarServidor: (url) => {
    if (ajustes.servidor === url) return
    ajustes.servidor = url
    guardarAjustes()
  },
  alCambiar: () => avisarControl(),
  alReproduccion: () => {
    avisarPantalla()
    avisarControl()
  },
  alConectar: () => informarVideos(),
  puertoBusqueda: process.env.AIRTRACKS_PUERTO_BUSQUEDA ? Number(process.env.AIRTRACKS_PUERTO_BUSQUEDA) : undefined
})

/** El proyector: el elegido, o la pantalla que no es la principal. null = no hay (no se muestra nada). */
function pantallaDelProyector(): Display | null {
  const todas = screen.getAllDisplays()
  const elegida = todas.find((d) => d.id === ajustes.pantallaId)
  if (elegida) return elegida
  const principal = screen.getPrimaryDisplay().id
  return todas.find((d) => d.id !== principal) ?? null
}

function ubicarPantalla(): void {
  const d = pantallaDelProyector()
  if (pantalla && d) pantalla.setBounds(d.bounds)
}

function estadoApp(): EstadoApp {
  const principal = screen.getPrimaryDisplay().id
  const e = conexion.estado
  return {
    conexion: conexion.info,
    videos: biblioteca.videos,
    pantallas: screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      nombre: `Pantalla ${i + 1} (${d.size.width}×${d.size.height})${d.id === principal ? ' · la principal' : ''}`,
      principal: d.id === principal
    })),
    pantallaId: pantallaDelProyector()?.id ?? null,
    inicioConWindows: ajustes.inicioConWindows,
    cancionActiva: e?.proyectoActivo ? { id: e.proyectoActivo.id, nombre: e.proyectoActivo.nombre } : null,
    version: app.getVersion()
  }
}

let controlProgramado: ReturnType<typeof setTimeout> | null = null
function avisarControl(): void {
  if (controlProgramado) return
  controlProgramado = setTimeout(() => {
    controlProgramado = null
    control?.webContents.send('estado', estadoApp())
  }, 150)
}

function reproduccion(): Reproduccion {
  const e = conexion.estado
  const p = e?.proyectoActivo ?? null
  return {
    conectado: conexion.conectado,
    proyectoId: p?.id ?? null,
    velocidad: p ? velocidadAplicada(p) : 1,
    playback: e?.playbackActivo ?? null,
    relojMs: conexion.relojMs,
    videos: biblioteca.videos
  }
}

function avisarPantalla(): void {
  pantalla?.webContents.send('reproduccion', reproduccion())
}

/** A la compu de AirTracks: que canciones tienen video (se ve en su transporte). */
function informarVideos(): void {
  conexion.emitir('video:estado', {
    nombre: os.hostname().slice(0, 24),
    canciones: biblioteca.videos.filter((v) => v.desfaseMs !== null).map((v) => v.proyectoId)
  })
}

function videosCambiaron(): void {
  avisarControl()
  avisarPantalla()
  informarVideos()
}

function crearVentanas(): void {
  const preload = path.join(__dirname, 'preload.cjs')
  control = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    title: 'AirTracks Video',
    backgroundColor: '#101216',
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false }
  })
  control.removeMenu()
  void control.loadURL('atv://app/control.html')
  control.on('closed', () => {
    control = null
    app.quit()
  })

  pantalla = new BrowserWindow({
    show: false,
    frame: false,
    // nunca le saca el foco a Holyrics (ni a nada): el teclado sigue donde estaba
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    title: 'AirTracks Video · proyector',
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false }
  })
  pantalla.setAlwaysOnTop(true, 'screen-saver')
  pantalla.setIgnoreMouseEvents(true)
  ubicarPantalla()
  void pantalla.loadURL('atv://app/pantalla.html')
  pantalla.webContents.on('did-finish-load', avisarPantalla)
}

app.whenReady().then(() => {
  // sin internet: que Chromium no salga a preguntar DNS "seguro" afuera
  app.configureHostResolver({ secureDnsMode: 'off' })
  // atv://app/...: las paginas del programa y, en /videos/, los videos (mismo origen: se pueden leer para alinear)
  protocol.registerFileProtocol('atv', (req, cb) => {
    const partes = decodeURIComponent(new URL(req.url).pathname).split('/').filter(Boolean)
    if (partes[0] === 'videos') return cb({ path: path.join(biblioteca.dir, path.basename(partes[1] ?? '')) })
    cb({ path: path.join(__dirname, path.basename(partes[partes.length - 1] ?? 'control.html')) })
  })
  crearVentanas()
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
    screen.on(ev as 'display-added', () => {
      ubicarPantalla()
      avisarControl()
    })
  }
  conexion.iniciar()
})

app.on('second-instance', () => {
  if (control?.isMinimized()) control.restore()
  control?.focus()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => conexion.detener())

// ---- IPC ----

ipcMain.handle('estado', () => estadoApp())
ipcMain.handle('canciones', () => conexion.canciones())
ipcMain.handle('elegir-archivo', async () => {
  const r = await dialog.showOpenDialog(control!, {
    title: 'Elegí el video con la letra',
    filters: [{ name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }],
    properties: ['openFile']
  })
  return r.canceled ? null : (r.filePaths[0] ?? null)
})
ipcMain.handle('agregar-video', async (_e, ruta: string, proyectoId: string, cancion: string) => {
  try {
    const v = await biblioteca.agregar(String(ruta), String(proyectoId), String(cancion).slice(0, 80))
    videosCambiaron()
    return v
  } catch (err) {
    return { error: String((err as Error).message ?? err) }
  }
})
ipcMain.handle('quitar-video', (_e, proyectoId: string) => {
  biblioteca.quitar(String(proyectoId))
  videosCambiaron()
})
ipcMain.handle('actualizar-video', (_e, proyectoId: string, cambio: Partial<VideoGuardado>) => {
  const permitido: Partial<VideoGuardado> = {}
  for (const k of ['desfaseMs', 'alineacion', 'estado', 'mensaje', 'duracionSeg'] as const) if (k in cambio) (permitido as Record<string, unknown>)[k] = cambio[k]
  biblioteca.actualizar(String(proyectoId), permitido)
  videosCambiaron()
})
ipcMain.handle('huella-cancion', (_e, proyectoId: string) => conexion.huella(String(proyectoId)))
ipcMain.handle('leer-huella-video', (_e, proyectoId: string) => {
  try {
    return new Uint8Array(fs.readFileSync(biblioteca.rutaHuella(String(proyectoId))))
  } catch {
    return null
  }
})
ipcMain.handle('guardar-huella-video', (_e, proyectoId: string, huella: Uint8Array) => {
  if (biblioteca.de(String(proyectoId))) fs.writeFileSync(biblioteca.rutaHuella(String(proyectoId)), Buffer.from(huella))
})
ipcMain.on('usar-codigo', (_e, codigo: string) => {
  ajustes.codigo = String(codigo).replace(/\D/g, '').slice(0, 8) || null
  guardarAjustes()
  conexion.reintentar()
})
ipcMain.on('usar-direccion', (_e, direccion: string | null) => {
  let url: string | null = null
  if (direccion && direccion.trim()) {
    const d = direccion.trim()
    url = /^https?:\/\//i.test(d) ? d : `http://${d}`
  }
  ajustes.servidor = url
  guardarAjustes()
  conexion.usarDireccion(url)
})
ipcMain.on('elegir-pantalla', (_e, id: number) => {
  ajustes.pantallaId = typeof id === 'number' ? id : null
  guardarAjustes()
  ubicarPantalla()
  avisarControl()
})
ipcMain.on('probar-pantalla', () => {
  ubicarPantalla()
  pantalla?.webContents.send('prueba')
})
ipcMain.on('inicio-windows', (_e, activo: boolean) => {
  ajustes.inicioConWindows = !!activo
  guardarAjustes()
  app.setLoginItemSettings({ openAtLogin: ajustes.inicioConWindows })
  avisarControl()
})
ipcMain.on('mostrar-pantalla', (_e, visible: boolean) => {
  if (!pantalla) return
  if (visible && pantallaDelProyector()) {
    if (!pantalla.isVisible()) {
      ubicarPantalla()
      pantalla.showInactive()
      pantalla.setAlwaysOnTop(true, 'screen-saver')
    }
  } else if (pantalla.isVisible()) pantalla.hide()
})
