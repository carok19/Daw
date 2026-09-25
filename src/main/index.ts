import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { createServer, type AppServer } from '../server'
import { getLanIp } from '../server/network'
import { EXTENSIONES_COMPRIMIDO } from '../server/comprimidos'

const PUERTO_PREFERIDO = 4848

let mainWindow: BrowserWindow | null = null
let server: AppServer | null = null
let puertoActivo = PUERTO_PREFERIDO

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

async function crearVentana(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e1016',
    title: 'Multitrack Alabanza',
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
  server = createServer(rendererDir, { dirModelos, dirExtras, version: app.getVersion() })
  await server.restaurarSesion()
  puertoActivo = await server.start(PUERTO_PREFERIDO)
  server.iniciarServicios(path.join(app.getPath('documents'), 'Multitrack Alabanza'))

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
