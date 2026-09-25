import type { DispositivoInfo, EstadoBuffer, OrigenCliente, SyncReportPayload } from '../shared/types'

interface DispositivoInterno extends DispositivoInfo {
  sockets: Set<string>
  /** nombre elegido en el propio dispositivo (reemplaza la etiqueta automatica) */
  nombre: string | null
  numero: number
}

const ID_DISPOSITIVO_RE = /^[A-Za-z0-9_-]{8,64}$/
const BUFFERS_VALIDOS: EstadoBuffer[] = ['normal', 'rellenando', 'critico']

export function limpiarNombreDispositivo(nombre: unknown): string | null {
  if (typeof nombre !== 'string') return null
  const limpio = nombre.replace(/\s+/g, ' ').trim().slice(0, 24)
  return limpio || null
}

/**
 * Roster de dispositivos: quien esta conectado, su sincronizacion y su buffer.
 * Se identifica por un `deviceId` estable que cada dispositivo guarda en su
 * localStorage: al reconectar (pantalla bloqueada, WiFi que se corta, recargar
 * la pagina) vuelve a la MISMA fila con la misma etiqueta, en vez de sumar un
 * "Celular N" nuevo y dejar el anterior en rojo para siempre. Un dispositivo
 * desconectado queda visible (marcado) hasta que el operador lo olvide.
 */
export class DeviceRegistry {
  private dispositivos = new Map<string, DispositivoInterno>()
  private porSocket = new Map<string, string>()
  private siguienteNumeroCelular = 1

  conectar(socketId: string, origen: OrigenCliente, deviceId: unknown, nombre: unknown): DispositivoInfo {
    // la compu es una sola (la que tiene el token): siempre la misma fila
    const id =
      origen === 'compu' ? 'compu' : typeof deviceId === 'string' && ID_DISPOSITIVO_RE.test(deviceId) ? `celular:${deviceId}` : socketId
    let info = this.dispositivos.get(id)
    if (!info) {
      info = {
        id,
        origen,
        etiqueta: '',
        nombre: null,
        numero: origen === 'celular' ? this.siguienteNumeroCelular++ : 0,
        conectado: true,
        driftMs: null,
        buffer: null,
        error: null,
        audio: origen === 'compu',
        desconectadoDesde: null,
        sockets: new Set()
      }
      this.dispositivos.set(id, info)
    }
    const nombreLimpio = limpiarNombreDispositivo(nombre)
    if (nombreLimpio) info.nombre = nombreLimpio
    info.sockets.add(socketId)
    info.conectado = true
    info.desconectadoDesde = null
    this.porSocket.set(socketId, id)
    this.actualizarEtiqueta(info)
    return this.aPublico(info)
  }

  desconectar(socketId: string): void {
    const info = this.infoDeSocket(socketId)
    this.porSocket.delete(socketId)
    if (!info) return
    info.sockets.delete(socketId)
    if (info.sockets.size === 0) {
      info.conectado = false
      info.desconectadoDesde = Date.now()
      info.driftMs = null
      info.buffer = null
      if (info.origen === 'celular') info.audio = false
    }
  }

  reportar(socketId: string, payload: SyncReportPayload): void {
    const info = this.infoDeSocket(socketId)
    if (!info || !payload) return
    info.driftMs = typeof payload.driftMs === 'number' && Number.isFinite(payload.driftMs) ? payload.driftMs : null
    if (payload.buffer !== undefined) info.buffer = BUFFERS_VALIDOS.includes(payload.buffer as EstadoBuffer) ? payload.buffer! : null
    if (payload.error !== undefined) info.error = typeof payload.error === 'string' ? payload.error.slice(0, 200) : null
    if (typeof payload.audio === 'boolean') info.audio = payload.audio
  }

  renombrar(socketId: string, nombre: unknown): boolean {
    const info = this.infoDeSocket(socketId)
    if (!info) return false
    info.nombre = limpiarNombreDispositivo(nombre)
    this.actualizarEtiqueta(info)
    return true
  }

  /** Quita de la lista un dispositivo desconectado (el operador lo "olvida"). */
  olvidar(id: string): boolean {
    const info = this.dispositivos.get(id)
    if (!info || info.conectado) return false
    this.dispositivos.delete(id)
    return true
  }

  olvidarDesconectados(): void {
    for (const [id, info] of this.dispositivos) if (!info.conectado) this.dispositivos.delete(id)
  }

  listar(): DispositivoInfo[] {
    return [...this.dispositivos.values()]
      .sort((a, b) => (a.origen === b.origen ? a.numero - b.numero : a.origen === 'compu' ? -1 : 1))
      .map((info) => this.aPublico(info))
  }

  private infoDeSocket(socketId: string): DispositivoInterno | undefined {
    const id = this.porSocket.get(socketId)
    return id ? this.dispositivos.get(id) : undefined
  }

  private actualizarEtiqueta(info: DispositivoInterno): void {
    info.etiqueta = info.nombre ?? (info.origen === 'compu' ? 'Computadora' : `Celular ${info.numero}`)
  }

  private aPublico(info: DispositivoInterno): DispositivoInfo {
    return {
      id: info.id,
      origen: info.origen,
      etiqueta: info.etiqueta,
      conectado: info.conectado,
      driftMs: info.driftMs,
      buffer: info.buffer,
      error: info.error,
      audio: info.audio,
      desconectadoDesde: info.desconectadoDesde
    }
  }
}
