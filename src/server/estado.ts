import type { EstadoCompleto } from '../shared/types'
import type { AppState } from './state'

export function buildEstadoCompleto(state: AppState): EstadoCompleto {
  const tab = state.getActiveTab()
  return {
    tabs: state.listaTabs(),
    activeTabId: state.activeTabId,
    locked: state.locked,
    loop: state.loop,
    proyectoActivo: tab?.proyecto ?? null,
    proyectos: state.listaProyectos(),
    playbackActivo: tab?.playback ?? null,
    modoSalto: state.modoSalto,
    saltoPendiente:
      state.saltoPendiente && state.saltoPendiente.tabId === tab?.tabId
        ? {
            destinoMs: state.saltoPendiente.destinoMs,
            nombre: state.saltoPendiente.nombre,
            limiteMs: state.saltoPendiente.limiteMs,
            tSalto: state.saltoPendiente.tSalto
          }
        : null,
    lista: state.listaActiva,
    serverTime: Date.now()
  }
}
