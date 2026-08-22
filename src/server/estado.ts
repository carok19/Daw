import type { EstadoCompleto } from '../shared/types'
import type { AppState } from './state'

export function buildEstadoCompleto(state: AppState): EstadoCompleto {
  const tab = state.getActiveTab()
  return {
    tabs: state.listaTabs(),
    activeTabId: state.activeTabId,
    locked: state.locked,
    proyectoActivo: tab?.proyecto ?? null,
    playbackActivo: tab?.playback ?? null,
    serverTime: Date.now()
  }
}
