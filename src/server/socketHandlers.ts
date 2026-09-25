import fs from 'node:fs'
import path from 'node:path'
import type { Server, Socket } from 'socket.io'
import type {
  AuthHandshake,
  ErrorPayload,
  ImportProgreso,
  LockSetPayload,
  LoopSetPayload,
  MarcadorActualizarPayload,
  MarcadorCrearPayload,
  MarcadorEliminarPayload,
  MarcadorRestaurarPayload,
  MarcadorSaltarPayload,
  MixerActualizadoPayload,
  MixerActualizarPayload,
  OrigenCliente,
  PistasReordenarPayload,
  Proyecto,
  SyncReportPayload,
  TabsClosePayload,
  TabsReordenarPayload,
  TabsSwitchPayload,
  TransportPlayPayload,
  TransportSeekPayload
} from '../shared/types'
import type { AppState } from './state'
import { buildEstadoCompleto } from './estado'
import { crearProyectoDesdeZip, ImportError, ZipSinPistasError } from './zip'
import {
  borrarSetlist,
  cargarSetlist,
  deleteProyecto,
  esIdValido,
  guardarSetlist,
  listarSetlists,
  listProyectos,
  loadProyecto,
  migrarProyecto,
  proyectoExiste
} from './projects'
import type { DeviceRegistry } from './devices'
import { Transporte } from './transport'

export { MARGIN_MS, MARGIN_SIN_CELULARES_MS } from './transport'

interface SocketData {
  origen: OrigenCliente
}

type Ack<T> = ((r: T) => void) | undefined

/**
 * Solo la ventana de Electron conoce `compuToken` (lo genera el proceso
 * principal al arrancar y lo pasa por el preload, nunca viaja a los
 * celulares). Cualquier otro cliente — aunque diga "soy la compu" — es un
 * celular: no puede cargar/borrar canciones, tocar la mezcla ni saltarse el
 * bloqueo.
 */
function origenDe(socket: Socket, compuToken: string): OrigenCliente {
  const auth = (socket.handshake.auth ?? {}) as AuthHandshake
  return auth.origen === 'compu' && typeof auth.token === 'string' && auth.token === compuToken ? 'compu' : 'celular'
}

function rechazar(socket: Socket, mensaje: string): void {
  const payload: ErrorPayload = { mensaje }
  socket.emit('accion:rechazada', payload)
}

function soloCompu(socket: Socket): boolean {
  return (socket.data as SocketData).origen === 'compu'
}

export function registerSocketHandlers(io: Server, state: AppState, devices: DeviceRegistry, compuToken: string): Transporte {
  function hayCelularesConectados(): boolean {
    for (const socket of io.sockets.sockets.values()) {
      if ((socket.data as SocketData).origen === 'celular') return true
    }
    return false
  }

  const transporte = new Transporte(io, state, hayCelularesConectados)

  function emitirEstado(): void {
    io.emit('estado:actualizado', buildEstadoCompleto(state))
  }

  function emitirDispositivos(): void {
    io.emit('dispositivos:actualizado', devices.listar())
  }

  /** true si hay una cancion sonando (o por sonar) en la pestana activa. */
  function algoSuena(): boolean {
    return state.getActiveTab()?.playback.estado === 'playing'
  }

  /**
   * Abre (o activa si ya esta abierto) un proyecto guardado, migrandolo al
   * formato actual si hace falta. Una cancion NUEVA en el setlist nunca
   * interrumpe la que esta sonando: se agrega al final sin activarla.
   * Devuelve si quedo activa.
   */
  async function abrirProyectoGuardado(id: string, activar: boolean): Promise<boolean> {
    const existente = state.tabDeProyecto(id)
    if (existente) {
      if (activar) cambiarPestana(existente.tabId)
      return activar
    }
    const proyecto = await migrarProyecto(loadProyecto(id))
    const activarla = activar && !algoSuena()
    state.abrirProyecto(proyecto, activarla)
    return activarla
  }

  function cambiarPestana(tabId: string): void {
    const activa = state.getActiveTab()
    if (activa && activa.tabId !== tabId) transporte.detenerInmediato(activa)
    if (state.setActiveTab(tabId)) transporte.reprogramarTimers()
  }

  io.on('connection', (socket: Socket) => {
    const origen = origenDe(socket, compuToken)
    ;(socket.data as SocketData).origen = origen
    const auth = (socket.handshake.auth ?? {}) as AuthHandshake

    devices.conectar(socket.id, origen, auth.deviceId, auth.nombre)
    emitirDispositivos()

    socket.on('disconnect', () => {
      devices.desconectar(socket.id)
      emitirDispositivos()
    })

    socket.on('sync:report', (payload: SyncReportPayload) => {
      devices.reportar(socket.id, payload)
      emitirDispositivos()
    })

    socket.on('device:rename', (payload: { nombre?: string }) => {
      if (devices.renombrar(socket.id, payload?.nombre)) emitirDispositivos()
    })

    socket.on('devices:forget', (payload: { id?: string }) => {
      if (!soloCompu(socket)) return
      if (payload?.id === '*') devices.olvidarDesconectados()
      else if (typeof payload?.id === 'string') devices.olvidar(payload.id)
      emitirDispositivos()
    })

    socket.on('clock:sync', (_payload: unknown, ack?: Ack<{ tServer: number }>) => {
      ack?.({ tServer: Date.now() })
    })

    socket.on('state:request', (_payload: unknown, ack?: Ack<ReturnType<typeof buildEstadoCompleto>>) => {
      ack?.(buildEstadoCompleto(state))
    })

    // ---- Transporte (celulares tambien, salvo con el control bloqueado) ----

    function permitido(): boolean {
      if (soloCompu(socket) || !state.locked) return true
      rechazar(socket, 'Control bloqueado por la computadora')
      return false
    }

    socket.on('transport:play', (payload: TransportPlayPayload = {}) => {
      if (!permitido()) return
      transporte.play(typeof payload?.positionMs === 'number' ? payload.positionMs : undefined)
    })

    socket.on('transport:pause', () => {
      if (!permitido()) return
      transporte.pause()
    })

    socket.on('transport:stop', () => {
      if (!permitido()) return
      transporte.stop()
    })

    socket.on('transport:seek', (payload: TransportSeekPayload) => {
      if (typeof payload?.positionMs !== 'number' || !permitido()) return
      transporte.seek(payload.positionMs)
    })

    socket.on('marker:jump', (payload: MarcadorSaltarPayload) => {
      if (!permitido()) return
      transporte.saltarAMarcador(payload?.marcadorId)
    })

    socket.on('loop:set', (payload: LoopSetPayload) => {
      if (!permitido()) return
      state.loop = !!payload?.activo && !!state.getActiveTab()
      transporte.reprogramarTimers()
      emitirEstado()
    })

    // ---- Edicion (solo la compu) ----

    function edicion(mensaje: string): boolean {
      if (soloCompu(socket)) return true
      rechazar(socket, mensaje)
      return false
    }

    socket.on('marker:create', (payload: MarcadorCrearPayload) => {
      if (!edicion('Solo la computadora puede crear marcadores')) return
      const tab = state.getActiveTab()
      if (!tab) return
      if (state.crearMarcador(tab.tabId, payload?.tiempoMs, payload?.nombre)) {
        transporte.reprogramarTimers()
        emitirEstado()
      }
    })

    socket.on('marker:update', (payload: MarcadorActualizarPayload) => {
      if (!edicion('Solo la computadora puede editar marcadores')) return
      const tab = state.getActiveTab()
      if (!tab) return
      if (state.actualizarMarcador(tab.tabId, payload?.marcadorId, payload?.patch)) {
        transporte.reprogramarTimers()
        emitirEstado()
      }
    })

    socket.on('marker:delete', (payload: MarcadorEliminarPayload) => {
      if (!edicion('Solo la computadora puede eliminar marcadores')) return
      const tab = state.getActiveTab()
      if (!tab) return
      if (state.eliminarMarcador(tab.tabId, payload?.marcadorId)) {
        transporte.reprogramarTimers()
        emitirEstado()
      }
    })

    socket.on('marker:restore', (payload: MarcadorRestaurarPayload) => {
      if (!edicion('Solo la computadora puede editar marcadores')) return
      const tab = state.getActiveTab()
      if (!tab) return
      if (state.restaurarMarcador(tab.tabId, payload?.marcador)) {
        transporte.reprogramarTimers()
        emitirEstado()
      }
    })

    socket.on('mixer:update', (payload: MixerActualizarPayload) => {
      if (!edicion('Solo la computadora puede editar la mezcla')) return
      const tab = state.getActiveTab()
      if (!tab) return
      const pista = state.actualizarMixer(tab.tabId, payload?.pistaId, payload?.patch)
      if (pista) {
        // broadcast liviano: solo la pista que cambio, no el estado completo
        const msg: MixerActualizadoPayload = { proyectoId: tab.proyecto.id, pista }
        io.emit('mixer:actualizado', msg)
      }
    })

    socket.on('pistas:reorder', (payload: PistasReordenarPayload) => {
      if (!edicion('Solo la computadora puede reordenar pistas')) return
      const tab = state.getActiveTab()
      if (!tab) return
      if (state.reordenarPistas(tab.tabId, payload?.orden)) emitirEstado()
    })

    socket.on('project:rename', (payload: { proyectoId?: string; nombre?: string }) => {
      if (!edicion('Solo la computadora puede renombrar canciones')) return
      if (typeof payload?.proyectoId === 'string' && state.renombrarProyecto(payload.proyectoId, payload.nombre)) emitirEstado()
    })

    // ---- Pestanas / setlist ----

    socket.on('tabs:switch', (payload: TabsSwitchPayload) => {
      if (!edicion('Solo la computadora puede cambiar de canción')) return
      if (typeof payload?.tabId !== 'string' || !state.getTab(payload.tabId)) return
      cambiarPestana(payload.tabId)
      emitirEstado()
    })

    socket.on('tabs:close', (payload: TabsClosePayload) => {
      if (!edicion('Solo la computadora puede cerrar canciones')) return
      const tab = state.getTab(payload?.tabId ?? null)
      if (!tab) return
      const eraActiva = tab.tabId === state.activeTabId
      if (eraActiva) transporte.detenerInmediato(tab)
      state.cerrarTab(tab.tabId)
      transporte.reprogramarTimers()
      emitirEstado()
    })

    socket.on('tabs:reorder', (payload: TabsReordenarPayload) => {
      if (!edicion('Solo la computadora puede ordenar el setlist')) return
      if (state.reordenarTabs(payload?.orden)) emitirEstado()
    })

    socket.on('lock:set', (payload: LockSetPayload) => {
      if (!soloCompu(socket)) return
      state.setLocked(!!payload?.locked)
      emitirEstado()
    })

    // ---- Canciones guardadas ----

    socket.on('project:load-from-zip', async (payload: { filePath?: string }, ack?: Ack<{ ok: boolean; error?: string; activada?: boolean }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede cargar canciones' })
      const filePath = payload?.filePath
      if (
        typeof filePath !== 'string' ||
        !path.isAbsolute(filePath) ||
        path.extname(filePath).toLowerCase() !== '.zip' ||
        !fs.existsSync(filePath)
      ) {
        return ack?.({ ok: false, error: 'Elegí un archivo .zip válido' })
      }
      try {
        const proyecto = await crearProyectoDesdeZip(filePath, (p: ImportProgreso) => socket.emit('import:progreso', p))
        // importar mientras suena una cancion no la corta: la nueva queda al final del setlist
        const activar = !algoSuena()
        state.abrirProyecto(proyecto, activar)
        transporte.reprogramarTimers()
        emitirEstado()
        ack?.({ ok: true, activada: activar })
      } catch (err) {
        const mensaje =
          err instanceof ZipSinPistasError || err instanceof ImportError
            ? err.message
            : 'No se pudo cargar el archivo .zip'
        if (!(err instanceof ZipSinPistasError)) console.error('[import]', err)
        ack?.({ ok: false, error: mensaje })
      }
    })

    socket.on('projects:list', (_payload: unknown, ack?: Ack<ReturnType<typeof listProyectos>>) => {
      ack?.(listProyectos())
    })

    socket.on('projects:open', async (payload: { id?: string; activar?: boolean }, ack?: Ack<{ ok: boolean; error?: string; activada?: boolean }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede abrir canciones' })
      if (!esIdValido(payload?.id) || !proyectoExiste(payload.id)) return ack?.({ ok: false, error: 'La canción ya no existe' })
      try {
        const activada = await abrirProyectoGuardado(payload.id, payload.activar !== false)
        transporte.reprogramarTimers()
        emitirEstado()
        ack?.({ ok: true, activada })
      } catch (err) {
        console.error('[projects:open]', err)
        ack?.({ ok: false, error: 'No se pudo abrir la canción guardada' })
      }
    })

    socket.on('projects:delete', (payload: { id?: string }, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket) || !esIdValido(payload?.id)) return ack?.({ ok: false })
      const tab = state.tabDeProyecto(payload.id)
      if (tab) {
        if (tab.tabId === state.activeTabId) transporte.detenerInmediato(tab)
        state.cerrarTab(tab.tabId)
      }
      deleteProyecto(payload.id)
      transporte.reprogramarTimers()
      emitirEstado()
      ack?.({ ok: true })
    })

    // ---- Setlists ----

    socket.on('setlists:list', (_payload: unknown, ack?: Ack<ReturnType<typeof listarSetlists>>) => {
      ack?.(listarSetlists())
    })

    socket.on('setlists:save', (payload: { nombre?: string }, ack?: Ack<{ ok: boolean; error?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede guardar setlists' })
      const nombre = typeof payload?.nombre === 'string' ? payload.nombre.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
      const proyectos = state.listaProyectos().map((p: Proyecto) => p.id)
      if (!nombre) return ack?.({ ok: false, error: 'Poné un nombre para el setlist' })
      if (proyectos.length === 0) return ack?.({ ok: false, error: 'No hay canciones abiertas para guardar' })
      guardarSetlist(nombre, proyectos)
      ack?.({ ok: true })
    })

    socket.on('setlists:open', async (payload: { id?: string }, ack?: Ack<{ ok: boolean; error?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede abrir setlists' })
      if (!esIdValido(payload?.id)) return ack?.({ ok: false, error: 'Setlist inválido' })
      try {
        const setlist = cargarSetlist(payload.id)
        const activa = state.getActiveTab()
        if (activa) transporte.detenerInmediato(activa)
        state.cerrarTodo()
        let faltantes = 0
        for (const id of setlist.proyectos) {
          if (!proyectoExiste(id)) {
            faltantes++
            continue
          }
          await abrirProyectoGuardado(id, false)
        }
        const primera = state.listaTabs()[0]
        if (primera) state.setActiveTab(primera.tabId)
        transporte.reprogramarTimers()
        emitirEstado()
        ack?.({ ok: true, error: faltantes ? `${faltantes} canción(es) del setlist ya no existen` : undefined })
      } catch (err) {
        console.error('[setlists:open]', err)
        ack?.({ ok: false, error: 'No se pudo abrir el setlist' })
      }
    })

    socket.on('setlists:delete', (payload: { id?: string }, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket) || !esIdValido(payload?.id)) return ack?.({ ok: false })
      borrarSetlist(payload.id)
      ack?.({ ok: true })
    })
  })

  return transporte
}

/** Reabre las canciones que estaban abiertas la ultima vez (si la app se cerro a mitad de un culto). */
export async function restaurarSesion(
  state: AppState,
  sesion: { proyectos: string[]; activo: number } | null
): Promise<void> {
  if (!sesion) return
  for (const id of sesion.proyectos) {
    if (!proyectoExiste(id) || state.tabDeProyecto(id)) continue
    try {
      state.abrirProyecto(await migrarProyecto(loadProyecto(id)), false)
    } catch (err) {
      console.error('[sesion] no se pudo reabrir', id, err)
    }
  }
  const tabs = state.listaTabs()
  const activa = tabs[Math.min(Math.max(0, sesion.activo), tabs.length - 1)]
  if (activa) state.setActiveTab(activa.tabId)
}
