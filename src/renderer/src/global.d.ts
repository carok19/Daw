export interface ElectronAPI {
  isElectron: true
  /** secreto con el que el servidor reconoce a la ventana de Electron como "la compu" */
  compuToken: string
  pickZipFile(): Promise<string | null>
  getConnectionInfo(): Promise<{ url: string; ip: string | null; port: number }>
}

declare global {
  interface Window {
    /** Solo existe cuando la pagina corre dentro de la ventana de Electron ("Modo Computadora"). */
    electronAPI?: ElectronAPI
  }
}
