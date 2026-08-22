import type { Server, Socket } from 'socket.io'
import type {
  AccionProgramada,
  ComandoProgramado,
  ErrorPayload,
  LockSetPayload,
  MarcadorActualizarPayload,
  MarcadorCrearPayload,
  MarcadorEliminarPayload,
  MarcadorSaltarPayload,
  MixerActualizarPayload,
  OrigenCliente,
  PistasReordenarPayload,
  TabsClosePayload,
  TabsSwitchPayload,
  TransportPlayPayload,
  TransportSeekPayload
} from '../shared/types'
import { AppState, posicionActual } from './state'
import { buildEstadoCompleto } from './estado'
import { crearProyectoDesdeZip, ZipSinPistasError } from './zip'
import { deleteProyecto, listProyectos, loadProyecto } from './projects'

/**
 * Margen (ms) para programar una accion de audio a futuro (seccion 7.3), usado
 * SOLO cuando hay al menos un celular conectado (necesitan tiempo de sobra para
 * recibir el comando por WiFi y arrancar el audio programado).
 */
export const MARGIN_MS = 1500

/**
 * Margen minimo cuando no hay ningun celular conectado: la compu no tiene con
 * quien sincronizarse, asi que responde practicamente al instante en vez de
 * esperar el margen completo.
 */
export const MARGIN_SIN_CELULARES_MS = 30

interface SocketData {
  origen: OrigenCliente
}

function origenDe(socket: Socket): OrigenCliente {
  const declarado = socket.handshake.auth?.origen
  return declarado === 'compu' ? 'compu' : 'celular'
}

function rechazar(socket: Socket, mensaje: string): void {
  const payload: ErrorPayload = { mensaje }
  socket.emit('accion:rechazada', payload)
}

export function registerSocketHandlers(io: Server, state: AppState): void {
  io.on('connection', (socket: Socket) => {
    ;(socket.data as SocketData).origen = origenDe(socket)

    socket.on('clock:sync', (_payload: unknown, ack?: (r: { tServer: number }) => void) => {
      ack?.({ tServer: Date.now() })
    })

    socket.on('state:request', (_payload: unknown, ack?: (r: ReturnType<typeof buildEstadoCompleto>) => void) => {
      ack?.(buildEstadoCompleto(state))
    })

    // ---- Transporte ----

    socket.on('transport:play', (payload: TransportPlayPayload = {}) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!permitido(socket, state)) return rechazar(socket, 'Control bloqueado por la computadora')
      const posicionBase =
        payload.positionMs !== undefined
          ? clampPos(payload.positionMs, tab.proyecto.duracionTotalMs)
          : posicionActual(tab.playback)
      programarAccion(io, state, tab.tabId, 'play', posicionBase, margenActual(io))
    })

    socket.on('transport:pause', () => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!permitido(socket, state)) return rechazar(socket, 'Control bloqueado por la computadora')
      if (tab.playback.estado !== 'playing') return
      const executeAt = Date.now() + margenActual(io)
      const posicionCongelada = posicionActual(tab.playback, executeAt)
      state.setPlayback(tab.tabId, { estado: 'paused', positionMs: posicionCongelada, referenceServerTime: executeAt })
      io.emit('playback:scheduled', {
        tabId: tab.tabId,
        accion: 'pause',
        positionMs: posicionCongelada,
        executeAtServerTime: executeAt
      } satisfies ComandoProgramado)
    })

    socket.on('transport:stop', () => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!permitido(socket, state)) return rechazar(socket, 'Control bloqueado por la computadora')
      if (tab.playback.estado === 'stopped') return
      const executeAt = Date.now() + margenActual(io)
      state.setPlayback(tab.tabId, { estado: 'stopped', positionMs: 0, referenceServerTime: executeAt })
      io.emit('playback:scheduled', {
        tabId: tab.tabId,
        accion: 'stop',
        positionMs: 0,
        executeAtServerTime: executeAt
      } satisfies ComandoProgramado)
    })

    socket.on('transport:seek', (payload: TransportSeekPayload) => {
      const tab = state.getActiveTab()
      if (!tab || payload?.positionMs === undefined) return
      if (!permitido(socket, state)) return rechazar(socket, 'Control bloqueado por la computadora')
      const pos = clampPos(payload.positionMs, tab.proyecto.duracionTotalMs)
      if (tab.playback.estado === 'playing') {
        programarAccion(io, state, tab.tabId, 'play', pos, margenActual(io))
      } else {
        const executeAt = Date.now()
        state.setPlayback(tab.tabId, { estado: tab.playback.estado, positionMs: pos, referenceServerTime: executeAt })
        io.emit('playback:scheduled', {
          tabId: tab.tabId,
          accion: 'seek',
          positionMs: pos,
          executeAtServerTime: executeAt
        } satisfies ComandoProgramado)
      }
    })

    // ---- Marcadores ----

    socket.on('marker:jump', (payload: MarcadorSaltarPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!permitido(socket, state)) return rechazar(socket, 'Control bloqueado por la computadora')
      const marcador = tab.proyecto.marcadores.find((m) => m.id === payload?.marcadorId)
      if (!marcador) return
      if (tab.playback.estado === 'playing') {
        programarAccion(io, state, tab.tabId, 'play', marcador.tiempoMs, margenActual(io))
      } else {
        const executeAt = Date.now()
        state.setPlayback(tab.tabId, {
          estado: tab.playback.estado,
          positionMs: marcador.tiempoMs,
          referenceServerTime: executeAt
        })
        io.emit('playback:scheduled', {
          tabId: tab.tabId,
          accion: 'seek',
          positionMs: marcador.tiempoMs,
          executeAtServerTime: executeAt
        } satisfies ComandoProgramado)
      }
    })

    socket.on('marker:create', (payload: MarcadorCrearPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede crear marcadores')
      state.crearMarcador(tab.tabId, payload.tiempoMs, payload.nombre)
      io.emit('estado:actualizado', buildEstadoCompleto(state))
    })

    socket.on('marker:update', (payload: MarcadorActualizarPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede editar marcadores')
      if (state.actualizarMarcador(tab.tabId, payload.marcadorId, payload.patch)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    socket.on('marker:delete', (payload: MarcadorEliminarPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede eliminar marcadores')
      if (state.eliminarMarcador(tab.tabId, payload.marcadorId)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    // ---- Mixer ----

    socket.on('mixer:update', (payload: MixerActualizarPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede editar la mezcla')
      if (state.actualizarMixer(tab.tabId, payload.pistaId, payload.patch)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    socket.on('pistas:reorder', (payload: PistasReordenarPayload) => {
      const tab = state.getActiveTab()
      if (!tab) return
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede reordenar pistas')
      if (state.reordenarPistas(tab.tabId, payload.orden)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    socket.on('project:duration', (payload: { duracionTotalMs: number }) => {
      const tab = state.getActiveTab()
      if (!tab || !soloCompu(socket)) return
      if (state.actualizarDuracion(tab.tabId, payload?.duracionTotalMs)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    // ---- Pestanas / proyectos ----

    socket.on('tabs:switch', (payload: TabsSwitchPayload) => {
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede cambiar de pestana')
      if (state.setActiveTab(payload.tabId)) {
        io.emit('estado:actualizado', buildEstadoCompleto(state))
      }
    })

    socket.on('tabs:close', (payload: TabsClosePayload) => {
      if (!soloCompu(socket)) return rechazar(socket, 'Solo la computadora puede cerrar pestanas')
      state.cerrarTab(payload.tabId)
      io.emit('estado:actualizado', buildEstadoCompleto(state))
    })

    socket.on('lock:set', (payload: LockSetPayload) => {
      if (!soloCompu(socket)) return
      state.setLocked(!!payload.locked)
      io.emit('estado:actualizado', buildEstadoCompleto(state))
    })

    socket.on(
      'project:load-from-zip',
      (payload: { filePath: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
        if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede cargar canciones' })
        try {
          const proyecto = crearProyectoDesdeZip(payload.filePath)
          state.abrirProyecto(proyecto)
          io.emit('estado:actualizado', buildEstadoCompleto(state))
          ack?.({ ok: true })
        } catch (err) {
          const mensaje = err instanceof ZipSinPistasError ? err.message : 'No se pudo cargar el archivo .zip'
          ack?.({ ok: false, error: mensaje })
        }
      }
    )

    socket.on('projects:list', (_payload: unknown, ack?: (r: ReturnType<typeof listProyectos>) => void) => {
      ack?.(listProyectos())
    })

    socket.on('projects:open', (payload: { id: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede abrir proyectos' })
      const existente = state.listaTabs().find((t) => state.getTab(t.tabId)?.proyecto.id === payload.id)
      try {
        if (existente) {
          state.setActiveTab(existente.tabId)
        } else {
          const proyecto = loadProyecto(payload.id)
          state.abrirProyecto(proyecto)
        }
        io.emit('estado:actualizado', buildEstadoCompleto(state))
        ack?.({ ok: true })
      } catch {
        ack?.({ ok: false, error: 'No se pudo abrir el proyecto guardado' })
      }
    })

    socket.on('projects:delete', (payload: { id: string }, ack?: (r: { ok: boolean }) => void) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      for (const t of state.listaTabs()) {
        if (state.getTab(t.tabId)?.proyecto.id === payload.id) state.cerrarTab(t.tabId)
      }
      deleteProyecto(payload.id)
      io.emit('estado:actualizado', buildEstadoCompleto(state))
      ack?.({ ok: true })
    })
  })
}

function soloCompu(socket: Socket): boolean {
  return (socket.data as SocketData).origen === 'compu'
}

function permitido(socket: Socket, state: AppState): boolean {
  return soloCompu(socket) || !state.locked
}

function hayCelularesConectados(io: Server): boolean {
  for (const socket of io.sockets.sockets.values()) {
    if ((socket.data as SocketData).origen === 'celular') return true
  }
  return false
}

/** Margen a usar para la proxima accion programada, segun si hay celulares conectados. */
function margenActual(io: Server): number {
  return hayCelularesConectados(io) ? MARGIN_MS : MARGIN_SIN_CELULARES_MS
}

function clampPos(ms: number, duracionTotalMs: number): number {
  const max = duracionTotalMs > 0 ? duracionTotalMs : Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(0, Math.round(ms)))
}

function programarAccion(
  io: Server,
  state: AppState,
  tabId: string,
  accion: AccionProgramada,
  positionMs: number,
  marginMs: number
): void {
  const executeAt = Date.now() + marginMs
  state.setPlayback(tabId, { estado: 'playing', positionMs, referenceServerTime: executeAt })
  io.emit('playback:scheduled', {
    tabId,
    accion,
    positionMs,
    executeAtServerTime: executeAt
  } satisfies ComandoProgramado)
}
