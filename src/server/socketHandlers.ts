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
  ModoSalto,
  SeccionSaltarPayload,
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
import { primerVolumen } from './comprimidos'
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
  proyectoExiste,
  saveProyecto
} from './projects'
import type { DeviceRegistry } from './devices'
import { Transporte } from './transport'
import { Analizador } from './analisis'
import { Biblioteca } from './biblioteca'
import type { ModelosVoz } from './modelos'

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

export interface Servicios {
  transporte: Transporte
  analizador: Analizador
  biblioteca: Biblioteca
}

export function registerSocketHandlers(
  io: Server,
  state: AppState,
  devices: DeviceRegistry,
  compuToken: string,
  modelos: ModelosVoz,
  analisisAutomatico = true
): Servicios {
  function hayCelularesConectados(): boolean {
    for (const socket of io.sockets.sockets.values()) {
      if ((socket.data as SocketData).origen === 'celular') return true
    }
    return false
  }

  const transporte = new Transporte(io, state, hayCelularesConectados, () => emitirEstadoPronto())

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

  function aCompus(evento: string, payload: unknown): void {
    for (const s of io.sockets.sockets.values()) if ((s.data as SocketData).origen === 'compu') s.emit(evento, payload)
  }

  // varios cambios seguidos (analisis, biblioteca) -> un solo estado completo
  let estadoProgramado: NodeJS.Timeout | null = null
  function emitirEstadoPronto(): void {
    if (estadoProgramado) return
    estadoProgramado = setTimeout(() => {
      estadoProgramado = null
      emitirEstado()
    }, 80)
  }

  const analizador = new Analizador({
    obtener(id) {
      if (!proyectoExiste(id)) return null
      const p = state.tabDeProyecto(id)?.proyecto ?? loadProyecto(id)
      // si la cancion se borro mientras se analizaba, no se la "resucita" al guardar
      return { proyecto: p, guardar: () => proyectoExiste(id) && saveProyecto(p) }
    },
    cambio(id, aviso) {
      if (state.tabDeProyecto(id)) {
        transporte.reprogramarTimers()
        emitirEstadoPronto()
      }
      aCompus('proyectos:cambio', { proyectoId: id })
      if (aviso) aCompus('aviso', { tipo: 'info', texto: aviso, grupo: 'secciones' })
    },
    pedidosVoz: (pedidos) => aCompus('analisis:pedidos', pedidos),
    puedeTrabajar: () => !algoSuena()
  }, analisisAutomatico)

  modelos.onCambio((info) => {
    aCompus('modelo:estado', info)
    if (info.estado === 'listo') aCompus('analisis:pedidos', analizador.pedidos())
  })

  async function importarZip(zip: string, categoria: string | undefined, reemplazarId: string | null, onProgreso?: (p: ImportProgreso) => void): Promise<Proyecto> {
    const p = await crearProyectoDesdeZip(zip, { categoria, reemplazarId: reemplazarId ?? undefined, onProgreso })
    analizador.encolar(p.id)
    if (state.tabDeProyecto(p.id)) emitirEstadoPronto()
    aCompus('proyectos:cambio', { proyectoId: p.id })
    return p
  }

  // lo que importo la biblioteca se avisa de una sola vez cuando termina la tanda (copiar 50 zips no son 50 avisos)
  const tanda = { nuevas: [] as string[], actualizadas: [] as string[] }
  function avisarTanda(): void {
    const { nuevas, actualizadas } = tanda
    if (nuevas.length + actualizadas.length === 0) return
    let texto: string
    if (nuevas.length + actualizadas.length === 1)
      texto = nuevas.length ? `Nueva canción en la biblioteca: “${nuevas[0]}”` : `Se actualizó “${actualizadas[0]}” desde la biblioteca`
    else
      texto = `Biblioteca: ${[
        nuevas.length ? `${nuevas.length} ${nuevas.length === 1 ? 'canción nueva' : 'canciones nuevas'}` : '',
        actualizadas.length ? `${actualizadas.length} ${actualizadas.length === 1 ? 'actualizada' : 'actualizadas'}` : ''
      ]
        .filter(Boolean)
        .join(' y ')}`
    tanda.nuevas = []
    tanda.actualizadas = []
    aCompus('aviso', { tipo: 'info', texto })
  }

  const biblioteca = new Biblioteca({
    async importar(zip, categoria, reemplazarId) {
      const p = await importarZip(zip, categoria, reemplazarId)
      ;(reemplazarId ? tanda.actualizadas : tanda.nuevas).push(p.nombre)
      return p
    },
    moverCategoria(id, categoria) {
      const p = loadProyecto(id)
      p.categoria = categoria
      saveProyecto(p)
      aCompus('proyectos:cambio', { proyectoId: id })
    },
    puedeTrabajar: () => !algoSuena(),
    estado: (e) => {
      aCompus('biblioteca:estado', e)
      if (e.pendientes === 0 && !e.importando) avisarTanda()
    },
    error: (mensaje) => aCompus('aviso', { tipo: 'error', texto: `Biblioteca: ${mensaje}` })
  })

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
    // canciones de versiones anteriores (sin analisis): se analizan en segundo plano
    if (!proyecto.analisis) analizador.encolar(proyecto.id)
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
    if (origen === 'compu') {
      socket.emit('modelo:estado', modelos.estado())
      socket.emit('biblioteca:estado', biblioteca.estado())
      socket.emit('analisis:pedidos', analizador.pedidos())
    }

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
      // sonando, a tiempo (proximo compas, al "1"); con `inmediato` (Shift) o sin tempo, ya
      transporte.saltarAPosicion(payload.positionMs, payload.inmediato === true)
    })

    socket.on('marker:jump', (payload: MarcadorSaltarPayload) => {
      if (!permitido()) return
      transporte.saltarAMarcador(payload?.marcadorId)
    })

    socket.on('seccion:saltar', (payload: SeccionSaltarPayload) => {
      if (!permitido() || !payload) return
      transporte.saltarASeccion({
        posicionMs: typeof payload.posicionMs === 'number' ? payload.posicionMs : undefined,
        relativo: typeof payload.relativo === 'number' ? Math.sign(payload.relativo) : undefined,
        inmediato: payload.inmediato === true
      })
    })

    socket.on('salto:cancelar', () => {
      if (!permitido()) return
      transporte.cancelarSalto()
    })

    socket.on('salto:modo', (payload: { modo?: ModoSalto }) => {
      if (!soloCompu(socket) || !payload || !['seccion', 'compas', 'inmediato'].includes(payload.modo ?? '')) return
      state.modoSalto = payload.modo!
      if (state.modoSalto === 'inmediato') transporte.cancelarSalto()
      emitirEstado()
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

    // cambiar de cancion es control de transporte: los celulares pueden, salvo que la compu los bloquee
    socket.on('tabs:switch', (payload: TabsSwitchPayload) => {
      if (!permitido()) return
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
        !['.zip', '.rar'].includes(path.extname(filePath).toLowerCase()) ||
        !fs.existsSync(filePath)
      ) {
        return ack?.({ ok: false, error: 'Elegí un archivo .zip o .rar válido' })
      }
      try {
        const primero = primerVolumen(filePath)
        const proyecto = await importarZip(primero, '', null, (p: ImportProgreso) => socket.emit('import:progreso', p))
        biblioteca.registrarImportada(primero, proyecto.id)
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
            : 'No se pudo cargar el archivo'
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
      analizador.olvidar(payload.id)
      biblioteca.olvidarProyecto(payload.id)
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

    // ---- Analisis automatico (tempo, secciones por la voz guia) ----

    socket.on('analisis:detectar', (payload: { proyectoId?: string }) => {
      if (!soloCompu(socket) || !esIdValido(payload?.proyectoId) || !proyectoExiste(payload.proyectoId)) return
      analizador.encolar(payload.proyectoId, true)
    })

    socket.on('analisis:progreso', (payload: { proyectoId?: string; hechos?: number; total?: number }) => {
      if (!soloCompu(socket) || !esIdValido(payload?.proyectoId)) return
      analizador.estadoVoz(payload.proyectoId, 'reconociendo')
      aCompus('analisis:progreso', { proyectoId: payload.proyectoId, hechos: Number(payload.hechos) || 0, total: Number(payload.total) || 0 })
    })

    socket.on('analisis:textos', (payload: { proyectoId?: string; textos?: unknown }) => {
      if (!soloCompu(socket) || !esIdValido(payload?.proyectoId) || !Array.isArray(payload.textos)) return
      const textos = payload.textos
        .filter((t): t is { n: number; texto: string } => !!t && typeof (t as { n: unknown }).n === 'number' && typeof (t as { texto: unknown }).texto === 'string')
        .map((t) => ({ n: t.n, texto: t.texto.slice(0, 200) }))
      analizador.aplicarTextos(payload.proyectoId, textos)
    })

    socket.on('analisis:fallo', (payload: { proyectoId?: string; motivo?: string; mensaje?: string }) => {
      if (!soloCompu(socket) || !esIdValido(payload?.proyectoId)) return
      analizador.estadoVoz(payload.proyectoId, payload.motivo === 'falta-modelo' ? 'falta-modelo' : 'error', typeof payload.mensaje === 'string' ? payload.mensaje.slice(0, 300) : undefined)
    })

    socket.on('modelo:descargar', () => {
      if (!soloCompu(socket)) return
      void modelos.descargar()
    })

    // ---- Biblioteca (carpeta vigilada) ----

    socket.on('biblioteca:ruta', (payload: { ruta?: string }, ack?: Ack<{ ok: boolean; error?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      try {
        if (typeof payload?.ruta !== 'string') throw new Error('Ruta inválida')
        biblioteca.setRuta(payload.ruta)
        ack?.({ ok: true })
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message })
      }
    })

    socket.on('biblioteca:escanear', () => {
      if (soloCompu(socket)) biblioteca.escanear()
    })

    socket.on('setlists:delete', (payload: { id?: string }, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket) || !esIdValido(payload?.id)) return ack?.({ ok: false })
      borrarSetlist(payload.id)
      ack?.({ ok: true })
    })
  })

  return { transporte, analizador, biblioteca }
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
