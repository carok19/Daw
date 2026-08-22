export interface ElectronAPI {
  isElectron: true
  pickZipFile(): Promise<string | null>
  getConnectionInfo(): Promise<{ url: string; ip: string | null; port: number }>
}

declare global {
  interface Window {
    /** Solo existe cuando la pagina corre dentro de la ventana de Electron ("Modo Computadora"). */
    electronAPI?: ElectronAPI
  }
}
