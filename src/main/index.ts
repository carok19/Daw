import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createServer } from '../server'
import { getLanIp } from '../server/network'

const PUERTO_PREFERIDO = 4848

let mainWindow: BrowserWindow | null = null
let puertoActivo = PUERTO_PREFERIDO

async function crearVentana(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await mainWindow.loadURL(url)
}

app.whenReady().then(async () => {
  const rendererDir = path.join(__dirname, '../renderer')
  const server = createServer(rendererDir)
  puertoActivo = await server.start(PUERTO_PREFERIDO)

  ipcMain.handle('dialog:pick-zip', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Seleccionar cancion (.zip)',
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
      crearVentana(`http://localhost:${puertoActivo}/`)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
