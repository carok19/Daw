import type { DispositivoInfo, OrigenCliente, PreparacionProyecto } from '../shared/types'

interface DispositivoInterno {
  id: string
  origen: OrigenCliente
  etiqueta: string
  conectado: boolean
  driftMs: number | null
  /** proyectoId -> estado de preparacion. Mapa interno; se serializa a array en `listar()`. */
  preparaciones: Map<string, PreparacionProyecto>
}

/**
 * Roster de dispositivos conectados (secciones 26/27/21 del spec): un panel
 * en la compu para ver quien esta conectado, su calidad de sincronizacion y
 * (seccion "precarga") si ya tiene lista la proxima cancion del setlist. Un
 * dispositivo desconectado se marca `conectado: false` en vez de eliminarse,
 * para que el operador note si alguien se cayo a mitad de un culto en vez
 * de que la fila simplemente desaparezca.
 */
export class DeviceRegistry {
  private dispositivos = new Map<string, DispositivoInterno>()
  private siguienteNumeroCelular = 1

  conectar(socketId: string, origen: OrigenCliente): DispositivoInfo {
    const etiqueta = origen === 'compu' ? 'Computadora' : `Celular ${this.siguienteNumeroCelular++}`
    const info: DispositivoInterno = {
      id: socketId,
      origen,
      etiqueta,
      conectado: true,
      driftMs: null,
      preparaciones: new Map()
    }
    this.dispositivos.set(socketId, info)
    return this.aPublico(info)
  }

  desconectar(socketId: string): void {
    const info = this.dispositivos.get(socketId)
    if (info) info.conectado = false
  }

  actualizarDrift(socketId: string, driftMs: number | null): void {
    const info = this.dispositivos.get(socketId)
    if (info) info.driftMs = driftMs
  }

  actualizarPreparacion(socketId: string, preparacion: PreparacionProyecto): void {
    const info = this.dispositivos.get(socketId)
    if (info) info.preparaciones.set(preparacion.proyectoId, preparacion)
  }

  listar(): DispositivoInfo[] {
    return [...this.dispositivos.values()].map((info) => this.aPublico(info))
  }

  private aPublico(info: DispositivoInterno): DispositivoInfo {
    return {
      id: info.id,
      origen: info.origen,
      etiqueta: info.etiqueta,
      conectado: info.conectado,
      driftMs: info.driftMs,
      preparaciones: [...info.preparaciones.values()]
    }
  }
}
