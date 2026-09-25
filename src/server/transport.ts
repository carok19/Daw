import type { Server } from 'socket.io'
import type { AccionProgramada, ComandoProgramado, TramoReproduccion } from '../shared/types'
import { calcularSecciones, nuevoPlayback, posicionActualMs, seccionEn } from '../shared/playback'
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
    private readonly hayCelulares: () => boolean
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
    this.seek(marcador.tiempoMs)
    return true
  }

  /** Posicion desde la que reanuda un play sin posicion explicita. */
  private posicionDeReanudacion(tab: Tab, now: number): number {
    const pos = posicionActualMs(tab.playback, now)
    const dur = tab.proyecto.duracionTotalMs
    // si quedo parado al final, "play" arranca de nuevo desde el principio
    return dur > 0 && pos >= dur - 50 ? 0 : clampPos(pos, dur)
  }

  private emitir(tab: Tab, accion: AccionProgramada, tramo: TramoReproduccion): void {
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
