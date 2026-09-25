import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { createServer, type AppServer } from '../server'
import { getLanIp } from '../server/network'

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
  server = createServer(rendererDir)
  await server.restaurarSesion()
  puertoActivo = await server.start(PUERTO_PREFERIDO)

  // la pantalla de la compu no se apaga ni entra en reposo mientras la app esta abierta
  powerSaveBlocker.start('prevent-display-sleep')

  // el token viaja por IPC sincronico al preload: nunca pasa por la red
  const token = server.compuToken
  ipcMain.on('app:compu-token', (e) => {
    e.returnValue = token
  })

  ipcMain.handle('dialog:pick-zip', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Seleccionar canción (.zip)',
      properties: ['openFile'],
      filters: [{ name: 'Archivo ZIP', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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
