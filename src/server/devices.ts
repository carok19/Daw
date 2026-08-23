import type { DispositivoInfo, OrigenCliente } from '../shared/types'

/**
 * Roster de dispositivos conectados (secciones 26/27/21 del spec): un panel
 * en la compu para ver quien esta conectado y su calidad de sincronizacion.
 * Un dispositivo desconectado se marca `conectado: false` en vez de
 * eliminarse, para que el operador note si alguien se cayo a mitad de un
 * culto en vez de que la fila simplemente desaparezca.
 */
export class DeviceRegistry {
  private dispositivos = new Map<string, DispositivoInfo>()
  private siguienteNumeroCelular = 1

  conectar(socketId: string, origen: OrigenCliente): DispositivoInfo {
    const etiqueta = origen === 'compu' ? 'Computadora' : `Celular ${this.siguienteNumeroCelular++}`
    const info: DispositivoInfo = { id: socketId, origen, etiqueta, conectado: true, driftMs: null }
    this.dispositivos.set(socketId, info)
    return info
  }

  desconectar(socketId: string): void {
    const info = this.dispositivos.get(socketId)
    if (info) info.conectado = false
  }

  actualizarDrift(socketId: string, driftMs: number | null): void {
    const info = this.dispositivos.get(socketId)
    if (info) info.driftMs = driftMs
  }

  listar(): DispositivoInfo[] {
    return [...this.dispositivos.values()]
  }
}
