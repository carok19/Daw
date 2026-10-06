import fs from 'node:fs'
import path from 'node:path'
import { ROLES, type DiagnosticoDispositivo, type DispositivoInfo, type EstadoBuffer, type MedicionTalkback, type OrigenCliente, type RolDispositivo, type SalidaSonido, type SyncReportPayload } from '../shared/types'

interface DispositivoInterno extends DispositivoInfo {
  sockets: Set<string>
  /** nombre elegido en el propio dispositivo (reemplaza la etiqueta automatica) */
  nombre: string | null
  numero: number
}

const ID_DISPOSITIVO_RE = /^[A-Za-z0-9_-]{8,64}$/
/** en la lista: la compu, la pantalla de video y los celulares */
const ORDEN: Record<OrigenCliente, number> = { compu: 0, video: 1, celular: 2 }
const BUFFERS_VALIDOS: EstadoBuffer[] = ['normal', 'rellenando', 'critico']

const num = (v: unknown, min = 0, max = 1e6): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null

/** Valida lo que manda un celular (viene de la red: nada se toma sin revisar). */
export function limpiarDiagnostico(d: unknown): DiagnosticoDispositivo | null {
  if (!d || typeof d !== 'object') return null
  const x = d as Record<string, unknown>
  return {
    modo: x.modo === 'mezcla' ? 'mezcla' : 'pistas',
    mbpsNecesarios: num(x.mbpsNecesarios, 0, 10000) ?? 0,
    mbpsRecibidos: num(x.mbpsRecibidos, 0, 10000) ?? 0,
    mbpsCapacidad: num(x.mbpsCapacidad, 0, 100000),
    colchonSeg: num(x.colchonSeg, 0, 3600) ?? 0,
    cortes: Math.round(num(x.cortes) ?? 0),
    correcciones: Math.round(num(x.correcciones) ?? 0),
    errores: Math.round(num(x.errores) ?? 0),
    latenciaMs: num(x.latenciaMs, 0, 600000),
    memoriaMB: num(x.memoriaMB, 0, 100000) ?? 0,
    salidaMs: Math.round(num(x.salidaMs, 0, 10000) ?? 0),
    resyncs: Math.round(num(x.resyncs) ?? 0),
    plataforma: typeof x.plataforma === 'string' ? x.plataforma.slice(0, 40) : '',
    talkback: limpiarTalkback(x.talkback)
  }
}

function limpiarTalkback(t: unknown): MedicionTalkback | null {
  if (!t || typeof t !== 'object') return null
  const x = t as Record<string, unknown>
  const objetivo = num(x.objetivoMs, 0, 5000)
  if (objetivo === null) return null
  return { objetivoMs: Math.round(objetivo), redMs: x.redMs === null ? null : Math.round(num(x.redMs, 0, 60000) ?? 0), tardes: Math.round(num(x.tardes, 0, 1000) ?? 0) }
}

export function esRol(r: unknown): r is RolDispositivo {
  return typeof r === 'string' && (ROLES as string[]).includes(r)
}

export function limpiarSalida(s: unknown): SalidaSonido {
  const x = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  return { click: x.click === true, guia: x.guia === true }
}

/** Solo lo que viene (`{ guia: true }` cambia la guia y deja el click como estaba). */
function limpiarSalidaParcial(s: unknown): Partial<SalidaSonido> {
  const x = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  const r: Partial<SalidaSonido> = {}
  if (typeof x.click === 'boolean') r.click = x.click
  if (typeof x.guia === 'boolean') r.guia = x.guia
  return r
}

/** Lo que se recuerda de cada celular entre una vez y otra (aunque se cierre la compu). */
interface Recordado {
  rol: RolDispositivo
  salida?: SalidaSonido
}

/** Cuantos celulares se recuerdan como mucho (los ultimos que cambiaron). */
const MAX_RECORDADOS = 300

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
  /** rol de cada celular, recordado en la compu (`archivo`): el de la consola sigue siendo el de la consola */
  private recordados = new Map<string, Recordado>()

  /** `archivo`: donde se recuerdan los roles (null = solo en memoria) */
  constructor(private readonly archivo: string | null = null) {
    if (!archivo) return
    try {
      const datos = JSON.parse(fs.readFileSync(archivo, 'utf-8')) as Record<string, { rol?: unknown; salida?: unknown }>
      for (const [id, r] of Object.entries(datos ?? {})) {
        if (!esRol(r?.rol)) continue
        this.recordados.set(id, r.rol === 'sonido' ? { rol: r.rol, salida: limpiarSalida(r.salida) } : { rol: r.rol })
      }
    } catch {
      // primera vez (o archivo roto: se empieza de cero)
    }
  }

  /**
   * `rol`/`salida`: lo que tenia guardado el celular. Manda lo que recuerda la
   * compu (se pudo cambiar desde aca mientras el celular no estaba), salvo
   * que el celular lo haya cambiado sin conexion (`rolPendiente`).
   */
  conectar(socketId: string, origen: OrigenCliente, deviceId: unknown, nombre: unknown, rol?: unknown, salida?: unknown, rolPendiente?: unknown): DispositivoInfo {
    // la compu es una sola (la que tiene el token): siempre la misma fila
    const id =
      origen === 'compu'
        ? 'compu'
        : typeof deviceId === 'string' && ID_DISPOSITIVO_RE.test(deviceId)
          ? `${origen === 'video' ? 'video' : 'celular'}:${deviceId}`
          : socketId
    let info = this.dispositivos.get(id)
    if (!info) {
      info = {
        id,
        origen,
        etiqueta: '',
        nombre: null,
        numero: origen === 'celular' ? this.siguienteNumeroCelular++ : 0,
        rol: null,
        salida: null,
        ajusteMs: 0,
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
    if (origen === 'celular') {
      const recordado = this.recordados.get(id)
      if (esRol(rol) && (rolPendiente === true || !recordado)) this.ponerRol(info, rol, rol === 'sonido' ? limpiarSalida(salida) : null)
      else if (recordado) {
        info.rol = recordado.rol
        info.salida = recordado.rol === 'sonido' ? (recordado.salida ?? { click: false, guia: false }) : null
      }
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
    if (payload.driftMs !== undefined) info.driftMs = typeof payload.driftMs === 'number' && Number.isFinite(payload.driftMs) ? payload.driftMs : null
    if (payload.buffer !== undefined) info.buffer = BUFFERS_VALIDOS.includes(payload.buffer as EstadoBuffer) ? payload.buffer! : null
    if (payload.error !== undefined) info.error = typeof payload.error === 'string' ? payload.error.slice(0, 200) : null
    if (typeof payload.audio === 'boolean') info.audio = payload.audio
    if (payload.diag !== undefined) info.diag = limpiarDiagnostico(payload.diag)
    if (payload.ajusteMs !== undefined) info.ajusteMs = Math.round(num(payload.ajusteMs, -500, 500) ?? 0)
  }

  renombrar(socketId: string, nombre: unknown): boolean {
    const info = this.infoDeSocket(socketId)
    if (!info) return false
    info.nombre = limpiarNombreDispositivo(nombre)
    this.actualizarEtiqueta(info)
    return true
  }

  /** Cambia el rol de un celular (desde el propio celular o desde la compu). false = no existe o no es un celular. */
  setRol(id: string, rol: unknown): boolean {
    const info = this.dispositivos.get(id)
    if (!info || info.origen !== 'celular' || !esRol(rol)) return false
    this.ponerRol(info, rol, rol === 'sonido' ? (info.salida ?? this.recordados.get(id)?.salida ?? { click: false, guia: false }) : null)
    return true
  }

  /** Que mas va a la consola (solo el celular de Sonido). */
  setSalida(id: string, salida: unknown): boolean {
    const info = this.dispositivos.get(id)
    if (!info || info.rol !== 'sonido') return false
    this.ponerRol(info, 'sonido', { ...(info.salida ?? { click: false, guia: false }), ...limpiarSalidaParcial(salida) })
    return true
  }

  idDeSocket(socketId: string): string | null {
    return this.porSocket.get(socketId) ?? null
  }

  rolDeSocket(socketId: string): RolDispositivo | null {
    return this.infoDeSocket(socketId)?.rol ?? null
  }

  /** Los sockets conectados de un dispositivo (para avisarle algo solo a el). */
  socketsDe(id: string): string[] {
    return [...(this.dispositivos.get(id)?.sockets ?? [])]
  }

  private ponerRol(info: DispositivoInterno, rol: RolDispositivo, salida: SalidaSonido | null): void {
    info.rol = rol
    info.salida = rol === 'sonido' ? salida : null
    this.recordados.delete(info.id)
    this.recordados.set(info.id, rol === 'sonido' ? { rol, salida: info.salida! } : { rol })
    while (this.recordados.size > MAX_RECORDADOS) this.recordados.delete(this.recordados.keys().next().value!)
    this.guardar()
  }

  private guardar(): void {
    if (!this.archivo) return
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true })
      const tmp = `${this.archivo}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.recordados), null, 1))
      fs.renameSync(tmp, this.archivo)
    } catch {
      // no es critico: se recuerda mientras la compu siga abierta
    }
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
      .sort((a, b) => (a.origen === b.origen ? a.numero - b.numero : ORDEN[a.origen] - ORDEN[b.origen]))
      .map((info) => this.aPublico(info))
  }

  private infoDeSocket(socketId: string): DispositivoInterno | undefined {
    const id = this.porSocket.get(socketId)
    return id ? this.dispositivos.get(id) : undefined
  }

  private actualizarEtiqueta(info: DispositivoInterno): void {
    info.etiqueta = info.nombre ?? (info.origen === 'compu' ? 'Computadora' : info.origen === 'video' ? 'Pantalla de video' : `Celular ${info.numero}`)
  }

  private aPublico(info: DispositivoInterno): DispositivoInfo {
    return {
      id: info.id,
      origen: info.origen,
      etiqueta: info.etiqueta,
      rol: info.rol,
      salida: info.salida ? { ...info.salida } : null,
      ajusteMs: info.ajusteMs,
      conectado: info.conectado,
      driftMs: info.driftMs,
      buffer: info.buffer,
      error: info.error,
      audio: info.audio,
      desconectadoDesde: info.desconectadoDesde,
      diag: info.diag ?? null
    }
  }
}
