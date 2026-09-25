import crypto from 'node:crypto'
import type { Marcador, ModoSalto, PatchPista, PlaybackState, Proyecto, SaltoPendiente, TabResumen } from '../shared/types'
import { posicionActualMs } from '../shared/playback'
import { guardarSesion, saveProyecto } from './projects'

export interface Tab {
  tabId: string
  proyecto: Proyecto
  playback: PlaybackState
}

function estadoInicial(): PlaybackState {
  return { estado: 'stopped', positionMs: 0, referenceServerTime: Date.now() }
}

/** Posicion real (ms) de una pestana en el instante `now`. */
export function posicionActual(playback: PlaybackState, now: number = Date.now()): number {
  return posicionActualMs(playback, now)
}

const DEBOUNCE_GUARDADO_MS = 400

function limpiarNombre(nombre: unknown, max = 60): string {
  return typeof nombre === 'string' ? nombre.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function numeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Estado en memoria: pestanas abiertas (el setlist en vivo), pestana activa,
 * bloqueo de control, repetir seccion y el estado de reproduccion de cada
 * pestana. Solo la pestana activa puede estar "playing".
 *
 * Los cambios del mixer se guardan a disco con debounce (mover un fader genera
 * decenas de cambios por segundo); todo lo demas se guarda al instante.
 */
export class AppState {
  private tabs = new Map<string, Tab>()
  private orden: string[] = []
  activeTabId: string | null = null
  locked = false
  loop = false
  modoSalto: ModoSalto = 'seccion'
  /** salto elegido que espera su limite (lo maneja Transporte); se cancela al cambiar de cancion */
  saltoPendiente: (SaltoPendiente & { tabId: string }) | null = null
  private guardadosPendientes = new Map<string, NodeJS.Timeout>()

  abrirProyecto(proyecto: Proyecto, activar = true): string {
    const tabId = crypto.randomUUID()
    this.tabs.set(tabId, { tabId, proyecto, playback: estadoInicial() })
    this.orden.push(tabId)
    if (activar || !this.activeTabId) this.cambiarActiva(tabId)
    this.persistirSesion()
    return tabId
  }

  /** Pestana que ya tiene abierto este proyecto, si hay. */
  tabDeProyecto(proyectoId: string): Tab | null {
    for (const t of this.tabs.values()) if (t.proyecto.id === proyectoId) return t
    return null
  }

  cerrarTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.guardarYa(tab.proyecto)
    const indice = this.orden.indexOf(tabId)
    this.tabs.delete(tabId)
    this.orden = this.orden.filter((id) => id !== tabId)
    if (this.activeTabId === tabId) {
      // la que queda en el mismo lugar (la siguiente del setlist), o la anterior si era la ultima
      this.activeTabId = this.orden[Math.min(indice, this.orden.length - 1)] ?? null
      this.loop = false
      this.saltoPendiente = null
    }
    this.persistirSesion()
  }

  cerrarTodo(): void {
    for (const id of [...this.orden]) this.cerrarTab(id)
  }

  setActiveTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false
    if (tabId === this.activeTabId) return true
    this.cambiarActiva(tabId)
    this.persistirSesion()
    return true
  }

  private cambiarActiva(tabId: string): void {
    const anterior = this.getTab(this.activeTabId)
    if (anterior && anterior.tabId !== tabId) {
      // la cancion que se deja queda pausada donde estaba (solo una suena a la vez)
      const now = Date.now()
      const pos = posicionActual(anterior.playback, now)
      if (anterior.playback.estado !== 'stopped') {
        anterior.playback = { estado: 'paused', positionMs: pos, referenceServerTime: now }
      }
    }
    this.activeTabId = tabId
    this.loop = false
    this.saltoPendiente = null
    const nueva = this.tabs.get(tabId)
    if (nueva) {
      nueva.proyecto.usadoEn = new Date().toISOString()
      this.guardarConDebounce(nueva.proyecto)
    }
  }

  reordenarTabs(orden: string[]): boolean {
    if (!Array.isArray(orden)) return false
    const validos = orden.filter((id) => this.tabs.has(id))
    const faltantes = this.orden.filter((id) => !validos.includes(id))
    const nuevo = [...new Set([...validos, ...faltantes])]
    if (nuevo.join() === this.orden.join()) return false
    this.orden = nuevo
    this.persistirSesion()
    return true
  }

  listaTabs(): TabResumen[] {
    return this.orden.map((id) => {
      const t = this.tabs.get(id)!
      return { tabId: t.tabId, nombre: t.proyecto.nombre, proyectoId: t.proyecto.id, posicionMs: Math.round(posicionActual(t.playback)) }
    })
  }

  /** Proyectos completos de todas las pestanas abiertas, mismo orden/indice que `listaTabs()`. */
  listaProyectos(): Proyecto[] {
    return this.orden.map((id) => this.tabs.get(id)!.proyecto)
  }

  getTab(tabId: string | null): Tab | null {
    if (!tabId) return null
    return this.tabs.get(tabId) ?? null
  }

  getActiveTab(): Tab | null {
    return this.getTab(this.activeTabId)
  }

  setLocked(locked: boolean): void {
    this.locked = locked
  }

  setPlayback(tabId: string, playback: PlaybackState): void {
    const tab = this.tabs.get(tabId)
    if (tab) tab.playback = playback
  }

  /** Aplica un cambio de mezcla. Devuelve la pista actualizada (o null si no existe). */
  actualizarMixer(tabId: string, pistaId: string, patch: PatchPista): Tab['proyecto']['pistas'][number] | null {
    const tab = this.tabs.get(tabId)
    const pista = tab?.proyecto.pistas.find((p) => p.id === pistaId)
    if (!tab || !pista || !patch) return null
    if (numeroFinito(patch.volumen)) pista.volumen = clamp(Math.round(patch.volumen), 0, 100)
    if (numeroFinito(patch.pan)) pista.pan = clamp(Math.round(patch.pan), -100, 100)
    if (typeof patch.mute === 'boolean') pista.mute = patch.mute
    if (typeof patch.solo === 'boolean') pista.solo = patch.solo
    const nombre = limpiarNombre(patch.nombre, 40)
    if (nombre) pista.nombre = nombre
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) pista.color = patch.color
    this.guardarConDebounce(tab.proyecto)
    return pista
  }

  reordenarPistas(tabId: string, orden: string[]): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab || !Array.isArray(orden)) return false
    const porId = new Map(tab.proyecto.pistas.map((p) => [p.id, p]))
    const nuevas = orden.map((id) => porId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
    for (const p of tab.proyecto.pistas) {
      if (!nuevas.includes(p)) nuevas.push(p)
    }
    tab.proyecto.pistas = [...new Set(nuevas)]
    this.guardarYa(tab.proyecto)
    return true
  }

  renombrarProyecto(proyectoId: string, nombre: unknown): Proyecto | null {
    const tab = this.tabDeProyecto(proyectoId)
    const limpio = limpiarNombre(nombre, 80)
    if (!tab || !limpio) return null
    tab.proyecto.nombre = limpio
    this.guardarYa(tab.proyecto)
    return tab.proyecto
  }

  crearMarcador(tabId: string, tiempoMs: number, nombre?: string): Marcador | null {
    const tab = this.tabs.get(tabId)
    if (!tab || !numeroFinito(tiempoMs)) return null
    const nombreFinal = limpiarNombre(nombre) || `Sección ${tab.proyecto.marcadores.length + 1}`
    const marcador: Marcador = {
      id: crypto.randomUUID(),
      nombre: nombreFinal,
      tiempoMs: this.limitarTiempo(tab, tiempoMs),
      origen: 'manual'
    }
    tab.proyecto.marcadores.push(marcador)
    this.ordenarMarcadores(tab)
    this.guardarYa(tab.proyecto)
    return marcador
  }

  /** Vuelve a agregar un marcador borrado (deshacer), con su mismo id. */
  restaurarMarcador(tabId: string, marcador: Marcador): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab || !marcador || typeof marcador.id !== 'string' || !numeroFinito(marcador.tiempoMs)) return false
    if (tab.proyecto.marcadores.some((m) => m.id === marcador.id)) return false
    tab.proyecto.marcadores.push({
      id: marcador.id.slice(0, 64),
      nombre: limpiarNombre(marcador.nombre) || 'Sección',
      tiempoMs: this.limitarTiempo(tab, marcador.tiempoMs),
      origen: marcador.origen === 'guia' || marcador.origen === 'archivo' ? marcador.origen : 'manual'
    })
    this.ordenarMarcadores(tab)
    this.guardarYa(tab.proyecto)
    return true
  }

  actualizarMarcador(
    tabId: string,
    marcadorId: string,
    patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>
  ): boolean {
    const tab = this.tabs.get(tabId)
    const marcador = tab?.proyecto.marcadores.find((m) => m.id === marcadorId)
    if (!tab || !marcador || !patch) return false
    const nombre = limpiarNombre(patch.nombre)
    if (nombre) marcador.nombre = nombre
    if (numeroFinito(patch.tiempoMs)) marcador.tiempoMs = this.limitarTiempo(tab, patch.tiempoMs)
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) marcador.color = patch.color
    this.ordenarMarcadores(tab)
    this.guardarYa(tab.proyecto)
    return true
  }

  eliminarMarcador(tabId: string, marcadorId: string): Marcador | null {
    const tab = this.tabs.get(tabId)
    const marcador = tab?.proyecto.marcadores.find((m) => m.id === marcadorId)
    if (!tab || !marcador) return null
    tab.proyecto.marcadores = tab.proyecto.marcadores.filter((m) => m.id !== marcadorId)
    this.guardarYa(tab.proyecto)
    return marcador
  }

  private limitarTiempo(tab: Tab, tiempoMs: number): number {
    const max = tab.proyecto.duracionTotalMs > 0 ? tab.proyecto.duracionTotalMs - 1 : Number.MAX_SAFE_INTEGER
    return clamp(Math.round(tiempoMs), 0, max)
  }

  private ordenarMarcadores(tab: Tab): void {
    tab.proyecto.marcadores.sort((a, b) => a.tiempoMs - b.tiempoMs)
  }

  private guardarConDebounce(proyecto: Proyecto): void {
    const previo = this.guardadosPendientes.get(proyecto.id)
    if (previo) clearTimeout(previo)
    this.guardadosPendientes.set(
      proyecto.id,
      setTimeout(() => {
        this.guardadosPendientes.delete(proyecto.id)
        saveProyecto(proyecto)
      }, DEBOUNCE_GUARDADO_MS)
    )
  }

  private guardarYa(proyecto: Proyecto): void {
    const previo = this.guardadosPendientes.get(proyecto.id)
    if (previo) clearTimeout(previo)
    this.guardadosPendientes.delete(proyecto.id)
    saveProyecto(proyecto)
  }

  /** Guarda a disco cualquier cambio del mixer pendiente (al cerrar la app). */
  guardarPendientes(): void {
    for (const t of this.tabs.values()) {
      if (this.guardadosPendientes.has(t.proyecto.id)) this.guardarYa(t.proyecto)
    }
  }

  private persistirSesion(): void {
    const proyectos = this.listaProyectos().map((p) => p.id)
    guardarSesion({ proyectos, activo: Math.max(0, this.orden.indexOf(this.activeTabId ?? '')) })
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
