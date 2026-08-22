import { contextBridge, ipcRenderer } from 'electron'

/**
 * API expuesta a la ventana de Electron ("Modo Computadora"). Su sola presencia
 * (`window.electronAPI`) es lo que el renderer usa para distinguirse de un
 * navegador de celular conectado por WiFi (ver App.tsx).
 */
const electronAPI = {
  isElectron: true as const,
  pickZipFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-zip'),
  getConnectionInfo: (): Promise<{ url: string; ip: string | null; port: number }> =>
    ipcRenderer.invoke('app:connection-info')
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
