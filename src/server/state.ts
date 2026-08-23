import crypto from 'node:crypto'
import type { Marcador, PlaybackState, Proyecto, TabResumen } from '../shared/types'
import { posicionActualMs } from '../shared/playback'
import { deleteProyecto, saveProyecto } from './projects'

interface Tab {
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

/**
 * Estado en memoria de la aplicacion: pestanas abiertas (setlist en vivo, seccion 5.4),
 * pestana activa, bloqueo de control y el estado de reproduccion de cada pestana.
 *
 * Decision de diseno (ver README): solo la pestana activa puede estar "playing".
 * Al cambiar de pestana, cualquier reproduccion en curso se pausa (se congela su
 * posicion) para evitar reproducir dos canciones a la vez.
 */
export class AppState {
  private tabs = new Map<string, Tab>()
  private orden: string[] = []
  activeTabId: string | null = null
  locked = false

  abrirProyecto(proyecto: Proyecto): string {
    const tabId = crypto.randomUUID()
    this.tabs.set(tabId, { tabId, proyecto, playback: estadoInicial() })
    this.orden.push(tabId)
    this.activeTabId = tabId
    return tabId
  }

  cerrarTab(tabId: string): void {
    this.tabs.delete(tabId)
    this.orden = this.orden.filter((id) => id !== tabId)
    if (this.activeTabId === tabId) {
      this.activeTabId = this.orden[this.orden.length - 1] ?? null
    }
  }

  setActiveTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    const anterior = this.getTab(this.activeTabId)
    if (anterior && anterior.tabId !== tabId && anterior.playback.estado === 'playing') {
      const now = Date.now()
      anterior.playback = {
        estado: 'paused',
        positionMs: posicionActual(anterior.playback, now),
        referenceServerTime: now
      }
    }
    this.activeTabId = tabId
    return true
  }

  listaTabs(): TabResumen[] {
    return this.orden.map((id) => {
      const t = this.tabs.get(id)!
      return { tabId: t.tabId, nombre: t.proyecto.nombre }
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

  actualizarMixer(
    tabId: string,
    pistaId: string,
    patch: Partial<{ volumen: number; pan: number; mute: boolean; solo: boolean; nombre: string }>
  ): boolean {
    const tab = this.tabs.get(tabId)
    const pista = tab?.proyecto.pistas.find((p) => p.id === pistaId)
    if (!tab || !pista) return false
    if (patch.volumen !== undefined) pista.volumen = clamp(patch.volumen, 0, 100)
    if (patch.pan !== undefined) pista.pan = clamp(patch.pan, -100, 100)
    if (patch.mute !== undefined) pista.mute = patch.mute
    if (patch.solo !== undefined) pista.solo = patch.solo
    if (patch.nombre !== undefined && patch.nombre.trim()) pista.nombre = patch.nombre.trim()
    saveProyecto(tab.proyecto)
    return true
  }

  reordenarPistas(tabId: string, orden: string[]): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    const porId = new Map(tab.proyecto.pistas.map((p) => [p.id, p]))
    const nuevas = orden.map((id) => porId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
    // cualquier pista no incluida en `orden` (no deberia pasar) se agrega al final
    for (const p of tab.proyecto.pistas) {
      if (!orden.includes(p.id)) nuevas.push(p)
    }
    tab.proyecto.pistas = nuevas
    saveProyecto(tab.proyecto)
    return true
  }

  crearMarcador(tabId: string, tiempoMs: number, nombre?: string): Marcador | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const nombreFinal = nombre?.trim() || `Marcador ${tab.proyecto.marcadores.length + 1}`
    const marcador: Marcador = {
      id: crypto.randomUUID(),
      nombre: nombreFinal,
      tiempoMs: Math.max(0, Math.round(tiempoMs))
    }
    tab.proyecto.marcadores.push(marcador)
    saveProyecto(tab.proyecto)
    return marcador
  }

  actualizarMarcador(
    tabId: string,
    marcadorId: string,
    patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>
  ): boolean {
    const tab = this.tabs.get(tabId)
    const marcador = tab?.proyecto.marcadores.find((m) => m.id === marcadorId)
    if (!tab || !marcador) return false
    if (patch.nombre !== undefined && patch.nombre.trim()) marcador.nombre = patch.nombre.trim()
    if (patch.tiempoMs !== undefined) marcador.tiempoMs = Math.max(0, Math.round(patch.tiempoMs))
    if (patch.color !== undefined) marcador.color = patch.color
    saveProyecto(tab.proyecto)
    return true
  }

  eliminarMarcador(tabId: string, marcadorId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    const antes = tab.proyecto.marcadores.length
    tab.proyecto.marcadores = tab.proyecto.marcadores.filter((m) => m.id !== marcadorId)
    saveProyecto(tab.proyecto)
    return tab.proyecto.marcadores.length !== antes
  }

  actualizarDuracion(tabId: string, duracionTotalMs: number): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab || duracionTotalMs <= 0) return false
    if (tab.proyecto.duracionTotalMs === Math.round(duracionTotalMs)) return false
    tab.proyecto.duracionTotalMs = Math.round(duracionTotalMs)
    saveProyecto(tab.proyecto)
    return true
  }

  eliminarProyectoGuardado(id: string): void {
    deleteProyecto(id)
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
