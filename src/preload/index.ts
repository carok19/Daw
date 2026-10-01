import { contextBridge, ipcRenderer } from 'electron'
import type { EstadoFirewall } from '../shared/types'

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
  pickPadsFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-pads'),
  getConnectionInfo: (): Promise<{ url: string; ip: string | null; port: number }> =>
    ipcRenderer.invoke('app:connection-info'),
  /** dialogo nativo para elegir la carpeta de la biblioteca */
  elegirCarpeta: (): Promise<string | null> => ipcRenderer.invoke('biblioteca:elegir'),
  /** abre la carpeta de la biblioteca en el explorador de archivos */
  abrirCarpeta: (ruta: string): Promise<void> => ipcRenderer.invoke('biblioteca:abrir', ruta),
  /** firewall de Windows: si deja entrar a los celulares en esta red, y arreglarlo (Windows pide permiso) */
  firewall: {
    estado: (): Promise<EstadoFirewall | null> => ipcRenderer.invoke('firewall:estado'),
    revisar: (): Promise<EstadoFirewall | null> => ipcRenderer.invoke('firewall:revisar'),
    permitir: (): Promise<{ resultado: 'ok' | 'cancelado' | 'error'; estado: EstadoFirewall | null }> => ipcRenderer.invoke('firewall:permitir'),
    alCambiar: (cb: (e: EstadoFirewall) => void): (() => void) => {
      const f = (_e: unknown, estado: EstadoFirewall): void => cb(estado)
      ipcRenderer.on('firewall:estado', f)
      return () => ipcRenderer.removeListener('firewall:estado', f)
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
