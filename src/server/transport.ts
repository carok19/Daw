import type { Server } from 'socket.io'
import type { AccionProgramada, ComandoProgramado, SeccionSaltarPayload, TramoReproduccion } from '../shared/types'
import { calcularSecciones, nuevoPlayback, posicionActualMs, seccionEn, type Seccion } from '../shared/playback'
import type { AppState, Tab } from './state'

/**
 * Margen (ms) para programar una accion de audio a futuro, usado cuando hay al
 * menos un celular conectado: tiempo de sobra para que el comando llegue por
 * WiFi a todos y cada uno programe su audio para el mismo instante.
 */
export const MARGIN_MS = 1500

/** Margen minimo sin celulares conectados: la compu no tiene con quien sincronizarse. */
export const MARGIN_SIN_CELULARES_MS = 30

/** Anticipacion minima con la que se emite el salto de "repetir seccion" (aunque no haya celulares). */
const ANTICIPO_MIN_LOOP_MS = 250

/** Una seccion mas corta que esto no se repite (no da el tiempo para programarla en todos). */
const MIN_SECCION_LOOP_MS = 1000

/**
 * Anticipacion minima de un salto de seccion en el limite (fin de seccion o
 * compas) con celulares: si el limite esta mas cerca, se usa el siguiente.
 * Menor que MARGIN_MS a proposito: el comando se manda igual con todo el
 * margen posible, y en una WiFi local llega en milisegundos.
 */
const ANTICIPO_MIN_SALTO_MS = 700

function clampPos(ms: number, duracionTotalMs: number): number {
  const max = duracionTotalMs > 0 ? duracionTotalMs : Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(0, Math.round(ms)))
}

/**
 * Transporte del lado del servidor: unica fuente de verdad de play/pausa/stop/
 * saltos, y de los eventos que dependen del tiempo — fin de cancion y
 * "repetir seccion" — que se programan aca (y no en la UI de la compu) para
 * que funcionen igual aunque la ventana de la compu este ocupada o cerrada.
 */
export class Transporte {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly io: Server,
    private readonly state: AppState,
    private readonly hayCelulares: () => boolean,
    /** cambio el salto pendiente (se eligio, se cambio, se cancelo o se hizo): avisar a todos */
    private readonly alCambiarSalto: () => void = () => {}
  ) {}

  margen(): number {
    return this.hayCelulares() ? MARGIN_MS : MARGIN_SIN_CELULARES_MS
  }

  play(positionMs?: number): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    const now = Date.now()
    if (positionMs === undefined && tab.playback.estado === 'playing') return // ya esta sonando
    const pos =
      positionMs !== undefined && Number.isFinite(positionMs)
        ? clampPos(positionMs, tab.proyecto.duracionTotalMs)
        : this.posicionDeReanudacion(tab, now)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: pos, referenceServerTime: now + this.margen() })
  }

  pause(): void {
    const tab = this.state.getActiveTab()
    if (!tab || tab.playback.estado !== 'playing') return
    const executeAt = Date.now() + this.margen()
    const pos = clampPos(posicionActualMs(tab.playback, executeAt), tab.proyecto.duracionTotalMs)
    this.emitir(tab, 'pause', { estado: 'paused', positionMs: pos, referenceServerTime: executeAt })
  }

  stop(): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    if (tab.playback.estado === 'stopped' && tab.playback.positionMs === 0) return
    const executeAt = Date.now() + (tab.playback.estado === 'playing' ? this.margen() : 0)
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: executeAt })
  }

  /** Corta YA (sin margen): se usa al cerrar la pestana que esta sonando o borrar su proyecto. */
  detenerInmediato(tab: Tab): void {
    if (tab.playback.estado !== 'playing') return
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: Date.now() })
  }

  seek(positionMs: number): void {
    const tab = this.state.getActiveTab()
    if (!tab || !Number.isFinite(positionMs)) return
    const pos = clampPos(positionMs, tab.proyecto.duracionTotalMs)
    if (tab.playback.estado === 'playing') {
      this.emitir(tab, 'play', { estado: 'playing', positionMs: pos, referenceServerTime: Date.now() + this.margen() })
    } else {
      const estado = pos === 0 ? tab.playback.estado : 'paused'
      this.emitir(tab, 'seek', { estado, positionMs: pos, referenceServerTime: Date.now() })
    }
  }

  saltarAMarcador(marcadorId: string): boolean {
    const tab = this.state.getActiveTab()
    const marcador = tab?.proyecto.marcadores.find((m) => m.id === marcadorId)
    if (!tab || !marcador) return false
    this.saltarASeccion({ posicionMs: marcador.tiempoMs })
    return true
  }

  /**
   * Ir a una seccion. Parado o en pausa, va enseguida. Sonando, segun el modo:
   * al terminar la seccion actual (o en el proximo compas) la musica sigue
   * directo en la seccion elegida, sin cortes; mientras tanto el salto queda
   * pendiente y se puede cambiar (elegir otra) o cancelar.
   */
  saltarASeccion(p: SeccionSaltarPayload): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    const dur = tab.proyecto.duracionTotalMs
    const secciones = calcularSecciones(tab.proyecto.marcadores, dur)
    if (secciones.length === 0) return
    const now = Date.now()
    const pendiente = this.state.saltoPendiente?.tabId === tab.tabId ? this.state.saltoPendiente : null

    let destino: Seccion | null = null
    let relativoNatural = false
    if (typeof p.relativo === 'number' && p.relativo !== 0) {
      const pos = posicionActualMs(tab.playback, now)
      // relativo a lo que ya se eligio (dos veces "siguiente" = saltear una seccion) o a la actual
      const base = seccionEn(secciones, pendiente ? pendiente.destinoMs : pos) ?? secciones[0]
      let i = base.indice + Math.sign(p.relativo)
      // "anterior" pasados 2 s de la seccion = repetir esta desde su comienzo
      if (!pendiente && p.relativo < 0 && pos - base.inicioMs > 2000) i = base.indice
      destino = secciones[Math.max(0, Math.min(secciones.length - 1, i))]
      relativoNatural = p.relativo > 0 && !pendiente
    } else if (typeof p.posicionMs === 'number' && Number.isFinite(p.posicionMs)) {
      destino = seccionEn(secciones, p.posicionMs)
    }
    if (!destino) return

    if (tab.playback.estado !== 'playing' || p.inmediato || this.state.modoSalto === 'inmediato') {
      this.cancelarSalto()
      this.seek(destino.inicioMs)
      return
    }

    let limite = this.limiteDeSalto(tab, secciones, this.state.modoSalto, now)
    // "siguiente" en modo seccion: la siguiente ya viene sola al terminar esta;
    // lo que se quiere es pasar ya, a tiempo: en el proximo compas (o enseguida si no hay tempo)
    if (relativoNatural && limite && limite.limiteMs === destino.inicioMs) {
      limite = this.state.modoSalto === 'seccion' ? this.limiteDeSalto(tab, secciones, 'compas', now) : null
      if (!limite || limite.limiteMs === destino.inicioMs) {
        this.cancelarSalto()
        this.seek(destino.inicioMs)
        return
      }
    }
    if (!limite) {
      this.cancelarSalto()
      this.seek(destino.inicioMs)
      return
    }
    this.state.saltoPendiente = { tabId: tab.tabId, destinoMs: destino.inicioMs, nombre: destino.nombre, ...limite }
    this.reprogramarTimers()
    this.alCambiarSalto()
  }

  /** Cancela el salto elegido que todavia no se hizo. */
  cancelarSalto(): void {
    if (!this.state.saltoPendiente) return
    this.state.saltoPendiente = null
    this.reprogramarTimers()
    this.alCambiarSalto()
  }

  /**
   * Proximo limite donde puede caer un salto: el fin de la seccion que va a
   * estar sonando (o el proximo compas), al menos ANTICIPO_MIN_SALTO_MS a futuro
   * y nunca antes de que se ejecute un comando ya programado.
   */
  private limiteDeSalto(
    tab: Tab,
    secciones: Seccion[],
    modo: 'seccion' | 'compas' | 'inmediato',
    now: number
  ): { limiteMs: number; tSalto: number } | null {
    const dur = tab.proyecto.duracionTotalMs
    const anticipo = this.hayCelulares() ? ANTICIPO_MIN_SALTO_MS : MARGIN_SIN_CELULARES_MS
    const desde = Math.max(now + anticipo, tab.playback.referenceServerTime)
    const posDesde = posicionActualMs(tab.playback, desde)
    const compases = tab.proyecto.tempo?.compasesMs
    let limiteMs: number | undefined
    if (modo === 'compas' && compases && compases.length > 1) limiteMs = compases.find((c) => c >= posDesde)
    else limiteMs = seccionEn(secciones, posDesde)?.finMs
    if (limiteMs === undefined || limiteMs > dur || limiteMs < posDesde) return null
    return { limiteMs, tSalto: desde + (limiteMs - posDesde) }
  }

  private ejecutarSalto(tabId: string, tSalto: number): void {
    const tab = this.state.getActiveTab()
    const pendiente = this.state.saltoPendiente
    if (!tab || tab.tabId !== tabId || !pendiente || pendiente.tabId !== tabId || pendiente.tSalto !== tSalto) return
    if (tab.playback.estado !== 'playing') {
      this.cancelarSalto()
      return
    }
    if (pendiente.destinoMs === pendiente.limiteMs) {
      // la seccion elegida es justo la que sigue: la musica ya continua ahi sola
      this.cancelarSalto()
      return
    }
    const executeAt = Math.max(tSalto, Date.now() + 20)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: pendiente.destinoMs, referenceServerTime: executeAt })
  }

  /** Posicion desde la que reanuda un play sin posicion explicita. */
  private posicionDeReanudacion(tab: Tab, now: number): number {
    const pos = posicionActualMs(tab.playback, now)
    const dur = tab.proyecto.duracionTotalMs
    // si quedo parado al final, "play" arranca de nuevo desde el principio
    return dur > 0 && pos >= dur - 50 ? 0 : clampPos(pos, dur)
  }

  private emitir(tab: Tab, accion: AccionProgramada, tramo: TramoReproduccion): void {
    // cualquier comando (pausa, otro salto, el salto mismo) reemplaza al salto que estaba esperando
    const habiaSalto = this.state.saltoPendiente !== null
    this.state.saltoPendiente = null
    const now = Date.now()
    const playback = nuevoPlayback(tab.playback, tramo, now)
    this.state.setPlayback(tab.tabId, playback)
    const cmd: ComandoProgramado = {
      tabId: tab.tabId,
      accion,
      positionMs: tramo.positionMs,
      executeAtServerTime: tramo.referenceServerTime,
      playback
    }
    this.io.emit('playback:scheduled', cmd)
    this.reprogramarTimers()
    if (habiaSalto) this.alCambiarSalto()
  }

  /**
   * (Re)calcula el proximo evento temporal de la pestana activa: el salto de
   * "repetir seccion" (si esta activo) o el fin de la cancion. Llamar ante
   * cualquier cambio de reproduccion, marcadores, loop o pestana activa.
   */
  reprogramarTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tab = this.state.getActiveTab()
    if (!tab || tab.playback.estado !== 'playing') return
    const dur = tab.proyecto.duracionTotalMs
    if (dur <= 0) return

    const now = Date.now()
    const tRef = Math.max(now, tab.playback.referenceServerTime)
    const pos = posicionActualMs(tab.playback, tRef)
    const tabId = tab.tabId

    // un salto elegido tiene prioridad sobre "repetir seccion" y el fin de la cancion
    const salto = this.state.saltoPendiente
    if (salto && salto.tabId === tabId) {
      const emitirEn = salto.tSalto - this.margen()
      this.timer = setTimeout(() => this.ejecutarSalto(tabId, salto.tSalto), Math.max(0, emitirEn - now))
      return
    }

    if (this.state.loop) {
      const seccion = seccionEn(calcularSecciones(tab.proyecto.marcadores, dur), pos)
      if (seccion && seccion.finMs - seccion.inicioMs >= MIN_SECCION_LOOP_MS && seccion.finMs > pos) {
        const tSalto = tRef + (seccion.finMs - pos)
        // se emite con anticipacion (al menos ANTICIPO_MIN_LOOP_MS) para que cada cliente programe el salto exacto
        const emitirEn = tSalto - Math.max(this.margen(), ANTICIPO_MIN_LOOP_MS)
        this.timer = setTimeout(() => this.saltoDeLoop(tabId, seccion.inicioMs, tSalto), Math.max(0, emitirEn - now))
        return
      }
    }

    const tFin = tRef + Math.max(0, dur - pos)
    this.timer = setTimeout(() => this.finDeCancion(tabId), Math.max(0, tFin - now))
  }

  private saltoDeLoop(tabId: string, inicioMs: number, tSalto: number): void {
    const tab = this.state.getActiveTab()
    if (!tab || tab.tabId !== tabId || tab.playback.estado !== 'playing' || !this.state.loop) return
    const now = Date.now()
    // si el timer se atraso (proceso ocupado), el salto no puede quedar en el pasado
    const executeAt = Math.max(tSalto, now + 20)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: inicioMs, referenceServerTime: executeAt })
  }

  private finDeCancion(tabId: string): void {
    const tab = this.state.getActiveTab()
    if (!tab || tab.tabId !== tabId || tab.playback.estado !== 'playing') return
    const now = Date.now()
    if (posicionActualMs(tab.playback, now) < tab.proyecto.duracionTotalMs - 20) {
      this.reprogramarTimers() // algo cambio en el medio (p.ej. un salto): recalcular
      return
    }
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: now })
  }

  cancelarTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
