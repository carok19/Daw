import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { createServer, type AppServer } from '../server'
import { direccionesLan, esAdaptadorVirtual, getLanIp } from '../server/network'
import { evaluarFirewall, leerFirewall, permitirEnFirewall } from '../server/firewall'
import type { EstadoFirewall } from '../shared/types'
import { EXTENSIONES_COMPRIMIDO } from '../server/comprimidos'

const PUERTO_PREFERIDO = 4848

let mainWindow: BrowserWindow | null = null
let server: AppServer | null = null
let puertoActivo = PUERTO_PREFERIDO

// La app antes se llamaba "Multitrack Alabanza": si ya estaba instalada, se siguen usando sus carpetas
// (preferencias de la compu y canciones), asi al actualizar no se pierde nada.
const NOMBRE_ANTERIOR = 'Multitrack Alabanza'
const datosAnteriores = path.join(app.getPath('appData'), NOMBRE_ANTERIOR)
if (fs.existsSync(datosAnteriores)) app.setPath('userData', datosAnteriores)

// una sola instancia: dos copias de la app pelearian por el puerto y por el setlist
const tieneLock = app.requestSingleInstanceLock()
if (!tieneLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// ---- firewall de Windows (ver server/firewall.ts) ----

let firewall: EstadoFirewall | null = null
let revisandoFirewall: Promise<EstadoFirewall | null> | null = null

/** Lee si Windows deja entrar a los celulares en las redes de ahora y, si cambio, avisa a la ventana. */
function revisarFirewall(): Promise<EstadoFirewall | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  revisandoFirewall ??= (async () => {
    const datos = await leerFirewall(process.execPath)
    const nuevo: EstadoFirewall = datos ? evaluarFirewall(datos, esAdaptadorVirtual) : { estado: 'desconocido', redes: [], bloqueadas: [] }
    if (JSON.stringify(nuevo) !== JSON.stringify(firewall)) mainWindow?.webContents.send('firewall:estado', nuevo)
    firewall = nuevo
    return nuevo
  })().finally(() => {
    revisandoFirewall = null
  })
  return revisandoFirewall
}

/** Al cambiar de red (otro WiFi, otro lugar) se vuelve a revisar: Windows tarda unos segundos en clasificarla. */
function vigilarRed(): void {
  if (process.platform !== 'win32') return
  let redes = direccionesLan().join(',')
  setTimeout(() => void revisarFirewall(), 3000)
  setInterval(() => {
    const ahora = direccionesLan().join(',')
    if (ahora === redes) return
    redes = ahora
    setTimeout(() => void revisarFirewall(), 4000)
    setTimeout(() => void revisarFirewall(), 20000)
  }, 4000).unref()
}

async function crearVentana(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e1016',
    title: 'AirTracks Wireless Monitor',
    icon: path.join(__dirname, '../renderer/apple-touch-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // en vivo la ventana puede quedar detras de otra (letras, OBS...): que no se frenen los timers ni el audio
      backgroundThrottling: false
    }
  })
  // links externos (si los hubiera) en el navegador, nunca dentro de la app
  mainWindow.webContents.setWindowOpenHandler(({ url: destino }) => {
    void shell.openExternal(destino)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, destino) => {
    if (!destino.startsWith(url)) e.preventDefault()
  })
  // si el renderer se cae (memoria, GPU...), se recarga solo: el estado vive en el servidor
  mainWindow.webContents.on('render-process-gone', () => {
    setTimeout(() => mainWindow?.loadURL(url), 500)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  await mainWindow.loadURL(url)
}

app.whenReady().then(async () => {
  if (!tieneLock) return
  const rendererDir = path.join(__dirname, '../renderer')
  // modelo de voz incluido en el instalador (resources/modelos) o, en desarrollo, <repo>/modelos
  const dirModelos = app.isPackaged ? path.join(process.resourcesPath, 'modelos') : path.join(__dirname, '../../modelos')
  // app Android incluida en el instalador (la baja cada celular desde la compu)
  const dirExtras = app.isPackaged ? path.join(process.resourcesPath, 'extras') : path.join(__dirname, '../../extras')
  // voces en español que avisan los saltos (resources/voces-es o, en desarrollo, <repo>/recursos/voces-es)
  const dirVocesDeFabrica = app.isPackaged ? path.join(process.resourcesPath, 'voces-es') : path.join(__dirname, '../../recursos/voces-es')
  server = createServer(rendererDir, { dirModelos, dirExtras, version: app.getVersion(), precalentarPads: true, dirVocesDeFabrica })
  await server.restaurarSesion()
  puertoActivo = await server.start(PUERTO_PREFERIDO)
  const bibliotecaAnterior = path.join(app.getPath('documents'), NOMBRE_ANTERIOR)
  server.iniciarServicios(fs.existsSync(bibliotecaAnterior) ? bibliotecaAnterior : path.join(app.getPath('documents'), 'AirTracks'))

  // la pantalla de la compu no se apaga ni entra en reposo mientras la app esta abierta
  powerSaveBlocker.start('prevent-display-sleep')

  // el token viaja por IPC sincronico al preload: nunca pasa por la red
  const token = server.compuToken
  ipcMain.on('app:compu-token', (e) => {
    e.returnValue = token
  })

  ipcMain.handle('dialog:pick-zip', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Seleccionar canción (.zip o .rar)',
      properties: ['openFile'],
      filters: [{ name: 'Canción comprimida (.zip, .rar)', extensions: EXTENSIONES_COMPRIMIDO }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:pick-pads', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Pads del colchón: un .zip o .rar con un audio por tono, o un solo audio',
      properties: ['openFile'],
      filters: [{ name: 'Pads (.zip, .rar, WAV, MP3, M4A, AIFF, FLAC)', extensions: [...EXTENSIONES_COMPRIMIDO, 'wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('biblioteca:elegir', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Carpeta de la biblioteca de canciones',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('biblioteca:abrir', async (_e, ruta: unknown) => {
    // solo la carpeta de la biblioteca actual (no cualquier ruta que pida la pagina)
    if (typeof ruta === 'string' && ruta === server?.biblioteca.ruta) await shell.openPath(ruta)
  })

  ipcMain.handle('firewall:estado', () => {
    if (!firewall) void revisarFirewall()
    return firewall
  })
  ipcMain.handle('firewall:revisar', () => revisarFirewall())
  ipcMain.handle('firewall:permitir', async () => {
    const resultado = await permitirEnFirewall(process.execPath)
    const estado = await revisarFirewall()
    return { resultado, estado }
  })
  vigilarRed()

  ipcMain.handle('app:connection-info', () => {
    const ip = getLanIp()
    const host = ip ?? 'localhost'
    return { url: `http://${host}:${puertoActivo}`, ip, port: puertoActivo }
  })

  await crearVentana(`http://localhost:${puertoActivo}/`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void crearVentana(`http://localhost:${puertoActivo}/`)
    }
  })
})

app.on('before-quit', () => {
  server?.state.guardarPendientes()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
