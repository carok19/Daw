import { contextBridge, ipcRenderer } from 'electron'

/**
 * API expuesta a la ventana de Electron ("Modo Computadora"). Su sola presencia
 * (`window.electronAPI`) es lo que el renderer usa para distinguirse de un
 * navegador de celular conectado por WiFi (ver App.tsx). `compuToken` es el
 * secreto con el que el servidor reconoce a la compu (los celulares no lo
 * conocen, asi que no pueden hacerse pasar por ella).
 */
const electronAPI = {
  isElectron: true as const,
  compuToken: ipcRenderer.sendSync('app:compu-token') as string,
  pickZipFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-zip'),
  getConnectionInfo: (): Promise<{ url: string; ip: string | null; port: number }> =>
    ipcRenderer.invoke('app:connection-info')
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
