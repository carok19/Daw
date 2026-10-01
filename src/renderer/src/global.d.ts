import type { EstadoFirewall } from '@shared/types'

export interface ElectronAPI {
  isElectron: true
  /** secreto con el que el servidor reconoce a la ventana de Electron como "la compu" */
  compuToken: string
  pickZipFile(): Promise<string | null>
  /** pads propios: un .zip/.rar con un audio por tono, o un solo audio */
  pickPadsFile?(): Promise<string | null>
  getConnectionInfo(): Promise<{ url: string; ip: string | null; port: number }>
  elegirCarpeta?(): Promise<string | null>
  abrirCarpeta?(ruta: string): Promise<void>
  /** firewall de Windows (solo la app de Windows) */
  firewall?: {
    estado(): Promise<EstadoFirewall | null>
    revisar(): Promise<EstadoFirewall | null>
    permitir(): Promise<{ resultado: 'ok' | 'cancelado' | 'error'; estado: EstadoFirewall | null }>
    alCambiar(cb: (e: EstadoFirewall) => void): () => void
  }
}

declare global {
  interface Window {
    /** Solo existe cuando la pagina corre dentro de la ventana de Electron ("Modo Computadora"). */
    electronAPI?: ElectronAPI
  }
}
