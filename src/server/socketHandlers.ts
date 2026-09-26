import os from 'node:os'
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
  TransportSeekPayload,
  AjustesConexion,
  DatosInvitacion,
  DiagnosticoServidor,
  EstadoLicencia,
  DatosListas,
  MotivoCodigo,
  SesionAnterior
} from '../shared/types'
import type { AppState } from './state'
import { buildEstadoCompleto } from './estado'
import { crearProyectoDesdeZip, ImportError, ZipSinPistasError } from './zip'
import { primerVolumen } from './comprimidos'
import { deleteProyecto, esIdValido, listProyectos, loadProyecto, migrarProyecto, proyectoExiste, saveProyecto, type SesionGuardada } from './projects'
import {
  agregarCarpeta,
  borrarCarpeta,
  borrarLista,
  crearLista,
  guardarLista,
  leerLista,
  limpiarFecha,
  limpiarNombre,
  listarCarpetas,
  listarListas,
  renombrarCarpeta
} from './listas'
import type { DeviceRegistry } from './devices'
import { Transporte } from './transport'
import { Analizador } from './analisis'
import { Biblioteca } from './biblioteca'
import type { ModelosVoz } from './modelos'
import { guardarAjustes, normalizarCodigo, type Ajustes } from './ajustes'
import type { EstadisticasMezcla } from './mezclador'
import type { Licencias } from './licencia'
import { direccionesLan, ipParaCliente } from './network'
import { NOMBRE_FIJO } from './descubrimiento'

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

/** Lo que la conexion de los celulares necesita del servidor (puertos, ajustes, app Android). */
export interface Conexion {
  ajustes: Ajustes
  puerto(): number
  puertoCorto(): number | null
  hayApk(): boolean
  /** como viene la mezcla por celular (para el diagnostico) */
  estadisticasMezcla?(): EstadisticasMezcla
  /** version de la app (para el diagnostico) */
  version?: string
  /** licencia de la compu: cuantos celulares a la vez */
  licencias?: Licencias
}

/** Version de prueba (o licencia con menos celulares): ya hay el maximo conectado. */
function resumenLicencia(e: EstadoLicencia | undefined): string {
  if (!e || !e.configuradas) return 'sin licencias (versión libre)'
  if (e.activa) return `licencia de ${e.nombre} · ${e.celulares ? `${e.celulares} celulares` : 'celulares sin límite'}${e.vence ? ` · vence ${e.vence}` : ''}`
  return `versión de prueba (hasta ${e.celularesPrueba} celulares)${e.error ? ` · ${e.error}` : ''}`
}

function errorLicencia(limite: number, prueba: boolean): Error {
  const e = new Error('licencia') as Error & { data?: unknown }
  e.data = { motivo: 'limite', limite, prueba }
  return e
}

function errorCodigo(motivo: MotivoCodigo): Error {
  const e = new Error('codigo') as Error & { data?: unknown }
  e.data = { motivo }
  return e
}

export function registerSocketHandlers(
  io: Server,
  state: AppState,
  devices: DeviceRegistry,
  compuToken: string,
  modelos: ModelosVoz,
  analisisAutomatico = true,
  conexion: Conexion = { ajustes: { codigoBanda: null, wifi: null, idInstalacion: 'local' }, puerto: () => 0, puertoCorto: () => null, hayApk: () => false }
): Servicios {
  // codigo de la banda: un celular sin el codigo no entra (la compu siempre). Contra adivinarlo
  // probando: 5 intentos fallidos desde un mismo celular lo frenan un minuto.
  const intentos = new Map<string, { fallos: number; hasta: number }>()
  io.use((socket, next) => {
    const codigo = conexion.ajustes.codigoBanda
    if (!codigo || origenDe(socket, compuToken) === 'compu') return next()
    const ip = socket.handshake.address
    const reg = intentos.get(ip)
    if (reg && reg.hasta > Date.now()) return next(errorCodigo('codigo-bloqueado'))
    if (reg && reg.hasta && reg.hasta <= Date.now()) intentos.delete(ip)
    const dado = normalizarCodigo((socket.handshake.auth as AuthHandshake | undefined)?.codigo)
    if (dado === codigo) {
      intentos.delete(ip)
      return next()
    }
    if (dado) {
      const fallos = (intentos.get(ip)?.fallos ?? 0) + 1
      intentos.set(ip, { fallos, hasta: fallos >= 5 ? Date.now() + 60_000 : 0 })
      return next(errorCodigo(fallos >= 5 ? 'codigo-bloqueado' : 'codigo-incorrecto'))
    }
    next(errorCodigo('codigo-requerido'))
  })

  // licencia: cuantos celulares a la vez (el que reconecta no cuenta dos veces)
  io.use((socket, next) => {
    const limite = conexion.licencias?.limiteCelulares() ?? null
    if (limite === null || origenDe(socket, compuToken) === 'compu') return next()
    const deviceId = (socket.handshake.auth as AuthHandshake | undefined)?.deviceId
    const propio = typeof deviceId === 'string' ? `celular:${deviceId}` : null
    const conectados = devices.listar().filter((d) => d.origen === 'celular' && d.conectado && d.id !== propio).length
    if (conectados >= limite) {
      // aviso en la compu (uno cada tanto: el celular reintenta solo)
      const prueba = conexion.licencias?.estado().prueba ?? false
      if (Date.now() - ultimoAvisoLimite > 60_000) {
        ultimoAvisoLimite = Date.now()
        aCompus('aviso', {
          tipo: 'error',
          texto: prueba
            ? `Un celular no pudo entrar: la versión de prueba permite ${limite} celulares a la vez. Activá una licencia para más.`
            : `Un celular no pudo entrar: la licencia permite ${limite} celulares a la vez.`
        })
      }
      return next(errorLicencia(limite, prueba))
    }
    next()
  })
  let ultimoAvisoLimite = 0

  function emitirLicencia(): void {
    const estado = conexion.licencias?.estado()
    if (!estado) return
    for (const s of io.sockets.sockets.values()) if ((s.data as SocketData).origen === 'compu') s.emit('licencia:estado', estado)
  }

  function datosInvitacion(ipCliente: string | undefined): DatosInvitacion {
    const ip = ipParaCliente(ipCliente) ?? 'localhost'
    const puerto = conexion.puerto()
    const corto = conexion.puertoCorto()
    return {
      url: `http://${ip}:${puerto}`,
      urlCorta: corto === 80 ? `http://${ip}` : null,
      urlFija: corto === 80 ? `http://${NOMBRE_FIJO}` : `http://${NOMBRE_FIJO}:${puerto}`,
      codigo: conexion.ajustes.codigoBanda,
      wifi: conexion.ajustes.wifi,
      apk: conexion.hayApk()
    }
  }

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
    if (p.analisis?.estado !== 'listo') analizador.encolar(p.id)
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

  // ---- listas por dia ----

  /** Las operaciones de listas van de a una (cargar una lista abre canciones y puede tardar). */
  let colaListas: Promise<unknown> = Promise.resolve()
  function enCola<T>(fn: () => Promise<T>): Promise<T> {
    const p = colaListas.then(fn, fn)
    colaListas = p.catch(() => undefined)
    return p
  }

  function listasCambiaron(): void {
    aCompus('listas:cambio', {})
  }
  // lo que se cambia en las pestanas se guarda solo en la lista del dia: las pantallas de listas se actualizan
  state.onListaGuardada = listasCambiaron

  function datosListas(): DatosListas {
    const s = state.sesionAnterior
    let sesionAnterior: SesionAnterior | null = null
    const existentes = s ? s.proyectos.filter((id) => proyectoExiste(id)) : []
    if (s && existentes.length) {
      const actualId = s.proyectos[Math.min(Math.max(0, s.activo), s.proyectos.length - 1)]
      sesionAnterior = {
        lista: s.listaId ? (leerLista(s.listaId)?.nombre ?? null) : null,
        canciones: existentes.length,
        actual: Math.max(1, existentes.indexOf(actualId) + 1),
        nombreActual: proyectoExiste(actualId) ? loadProyecto(actualId).nombre : null
      }
    }
    return { listas: listarListas(), carpetas: listarCarpetas(), activa: state.listaActiva?.id ?? null, sesionAnterior }
  }

  function actualizarListaActiva(): void {
    if (!state.listaActiva) return
    const l = leerLista(state.listaActiva.id)
    state.listaActiva = l ? { id: l.id, nombre: l.nombre, carpeta: l.carpeta ?? '' } : null
    emitirEstado()
  }

  /** Carga una lista en las pestanas (reemplaza lo que habia; si algo sonaba, se para). */
  async function usarLista(id: unknown): Promise<{ ok: boolean; error?: string }> {
    const lista = leerLista(id)
    if (!lista) return { ok: false, error: 'Esa lista ya no existe' }
    const activa = state.getActiveTab()
    if (activa) transporte.detenerInmediato(activa)
    let faltantes = 0
    await state.lote(async () => {
      state.listaActiva = null // cerrar las canciones de antes no tiene que tocar ninguna lista
      state.cerrarTodo()
      for (const pid of lista.proyectos) {
        if (!proyectoExiste(pid)) faltantes++
        else await abrirProyectoGuardado(pid, false)
      }
      const primera = state.listaTabs()[0]
      if (primera) state.setActiveTab(primera.tabId)
      state.listaActiva = { id: lista.id, nombre: lista.nombre, carpeta: lista.carpeta ?? '' }
      state.sesionAnterior = null
    })
    transporte.reprogramarTimers()
    emitirEstado()
    listasCambiaron()
    return { ok: true, error: faltantes ? `${faltantes} canción(es) de la lista ya no están en la compu` : undefined }
  }

  /** Si la cancion que suena quedaria afuera de la lista cargada arriba: no se puede sacar sonando. */
  function cancionSonandoFuera(proyectos: string[]): string | null {
    const activa = state.getActiveTab()
    if (activa && algoSuena() && !proyectos.includes(activa.proyecto.id)) return `“${activa.proyecto.nombre}” está sonando: pará la música para sacarla de la lista`
    return null
  }

  /** La lista cargada arriba se edito: las pestanas pasan a ser las de la lista, en su orden. */
  async function sincronizarPestanas(proyectos: string[]): Promise<void> {
    await state.lote(async () => {
      for (const t of state.listaTabs()) {
        if (proyectos.includes(t.proyectoId)) continue
        const tab = state.getTab(t.tabId)
        if (tab && tab.tabId === state.activeTabId) transporte.detenerInmediato(tab)
        state.cerrarTab(t.tabId)
      }
      for (const pid of proyectos) if (!state.tabDeProyecto(pid) && proyectoExiste(pid)) await abrirProyectoGuardado(pid, false)
      state.reordenarTabs(proyectos.map((pid) => state.tabDeProyecto(pid)?.tabId).filter((x): x is string => !!x))
    }, true)
    transporte.reprogramarTimers()
    emitirEstado()
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

    // ---- conexion de celulares: invitar, codigo de la banda, WiFi ----

    socket.on('invitacion:datos', (_p: unknown, ack?: Ack<DatosInvitacion>) => {
      ack?.(datosInvitacion(socket.handshake.address))
    })

    function ajustesConexion(): AjustesConexion {
      return {
        codigoBanda: conexion.ajustes.codigoBanda,
        wifi: conexion.ajustes.wifi,
        direcciones: direccionesLan(),
        puerto: conexion.puerto(),
        puertoCorto: conexion.puertoCorto()
      }
    }

    socket.on('ajustes:obtener', (_p: unknown, ack?: Ack<AjustesConexion | null>) => {
      if (!soloCompu(socket)) return ack?.(null)
      ack?.(ajustesConexion())
    })

    socket.on('ajustes:codigo', (payload: { codigo?: string | null }, ack?: Ack<{ ok: boolean; error?: string; ajustes?: AjustesConexion }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      const quitar = payload?.codigo === null || payload?.codigo === ''
      const codigo = normalizarCodigo(payload?.codigo)
      if (!quitar && !codigo) return ack?.({ ok: false, error: 'El código tiene que ser de 4 a 8 números' })
      conexion.ajustes.codigoBanda = quitar ? null : codigo
      guardarAjustes(conexion.ajustes)
      // los celulares que ya estan conectados siguen (no se corta nada en vivo); el codigo vale para los que entren
      ack?.({ ok: true, ajustes: ajustesConexion() })
    })

    socket.on('ajustes:wifi', (payload: { ssid?: string; clave?: string } | null, ack?: Ack<{ ok: boolean; ajustes?: AjustesConexion }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      const ssid = typeof payload?.ssid === 'string' ? payload.ssid.trim().slice(0, 64) : ''
      conexion.ajustes.wifi = ssid ? { ssid, clave: typeof payload?.clave === 'string' ? payload.clave.slice(0, 64) : '' } : null
      guardarAjustes(conexion.ajustes)
      ack?.({ ok: true, ajustes: ajustesConexion() })
    })

    // ---- licencia (compu) ----
    socket.on('licencia:estado', (_p: unknown, ack?: Ack<EstadoLicencia | null>) => {
      if (!soloCompu(socket)) return ack?.(null)
      ack?.(conexion.licencias?.estado() ?? null)
    })
    socket.on('licencia:activar', (payload: { texto?: unknown }, ack?: Ack<{ ok: boolean; error?: string; estado?: EstadoLicencia }>) => {
      if (!soloCompu(socket) || !conexion.licencias) return ack?.({ ok: false })
      const r = conexion.licencias.activar(typeof payload?.texto === 'string' ? payload.texto.slice(0, 10000) : '')
      ack?.({ ...r, estado: conexion.licencias.estado() })
      if (r.ok) emitirLicencia()
    })
    socket.on('licencia:quitar', (_p: unknown, ack?: Ack<{ ok: boolean; estado?: EstadoLicencia }>) => {
      if (!soloCompu(socket) || !conexion.licencias) return ack?.({ ok: false })
      conexion.licencias.quitar()
      ack?.({ ok: true, estado: conexion.licencias.estado() })
      emitirLicencia()
    })

    // "Copiar diagnostico" (compu): la compu, la cancion, la mezcla por celular y lo que mide cada dispositivo
    socket.on('diagnostico:obtener', (_p: unknown, ack?: Ack<DiagnosticoServidor | null>) => {
      if (!soloCompu(socket)) return ack?.(null)
      const p = state.getActiveTab()?.proyecto ?? null
      ack?.({
        version: conexion.version ?? '',
        sistema: `${os.type()} ${os.release()} · ${os.cpus().length} núcleos · ${Math.round(os.totalmem() / 1e9)} GB`,
        direcciones: direccionesLan(),
        puerto: conexion.puerto(),
        puertoCorto: conexion.puertoCorto(),
        mezcla: conexion.estadisticasMezcla?.() ?? null,
        licencia: resumenLicencia(conexion.licencias?.estado()),
        cancion: p ? { nombre: p.nombre, pistas: p.pistas.length, duracionMs: p.duracionTotalMs, bpm: p.tempo?.bpm ?? null } : null,
        dispositivos: devices.listar()
      })
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

    // ---- Listas por dia (y sus carpetas) ----

    socket.on('listas:obtener', (_payload: unknown, ack?: Ack<DatosListas | null>) => {
      if (!soloCompu(socket)) return ack?.(null)
      ack?.(datosListas())
    })

    socket.on(
      'listas:crear',
      (
        payload: { nombre?: unknown; carpeta?: unknown; fecha?: unknown; proyectos?: unknown; desdeActual?: unknown },
        ack?: Ack<{ ok: boolean; error?: string; id?: string }>
      ) => {
        if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede armar listas' })
        const nombre = limpiarNombre(payload?.nombre)
        if (!nombre) return ack?.({ ok: false, error: 'Poné un nombre para la lista' })
        const desdeActual = payload?.desdeActual === true
        if (desdeActual && state.listaTabs().length === 0) return ack?.({ ok: false, error: 'No hay canciones arriba para guardar' })
        const proyectos = desdeActual
          ? state.listaProyectos().map((p) => p.id)
          : Array.isArray(payload?.proyectos)
            ? payload.proyectos.filter(esIdValido)
            : []
        const lista = crearLista({
          nombre,
          carpeta: typeof payload?.carpeta === 'string' && payload.carpeta.trim() ? agregarCarpeta(payload.carpeta) : '',
          fecha: limpiarFecha(payload?.fecha) ?? null,
          proyectos
        })
        if (desdeActual) {
          // lo de arriba pasa a ser esta lista: lo que se cambie ahi se sigue guardando en ella
          state.listaActiva = { id: lista.id, nombre: lista.nombre, carpeta: lista.carpeta ?? '' }
          state.sesionAnterior = null
          state.guardarSesionAhora()
          emitirEstado()
        }
        listasCambiaron()
        ack?.({ ok: true, id: lista.id })
      }
    )

    socket.on(
      'listas:guardar',
      (
        payload: { id?: unknown; nombre?: unknown; carpeta?: unknown; fecha?: unknown; proyectos?: unknown },
        ack?: Ack<{ ok: boolean; error?: string }>
      ) => {
        if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede editar listas' })
        void enCola(async () => {
          const lista = leerLista(payload?.id)
          if (!lista) return ack?.({ ok: false, error: 'Esa lista ya no existe' })
          if (payload.nombre !== undefined) {
            const nombre = limpiarNombre(payload.nombre)
            if (!nombre) return ack?.({ ok: false, error: 'Poné un nombre para la lista' })
            lista.nombre = nombre
          }
          if (payload.carpeta !== undefined) lista.carpeta = typeof payload.carpeta === 'string' && payload.carpeta.trim() ? agregarCarpeta(payload.carpeta) : ''
          const fecha = limpiarFecha(payload.fecha)
          if (fecha !== undefined) lista.fecha = fecha
          const esActiva = state.listaActiva?.id === lista.id
          let error: string | null = null
          const proyectos = Array.isArray(payload.proyectos) ? [...new Set(payload.proyectos.filter(esIdValido))] : null
          if (proyectos) {
            error = esActiva ? cancionSonandoFuera(proyectos) : null
            if (!error) lista.proyectos = proyectos
          }
          guardarLista(lista)
          if (esActiva) {
            state.listaActiva = { id: lista.id, nombre: lista.nombre, carpeta: lista.carpeta ?? '' }
            // es la que esta arriba: las pestanas pasan a ser las de la lista
            if (proyectos && !error) await sincronizarPestanas(lista.proyectos)
            else emitirEstado()
          }
          listasCambiaron()
          ack?.(error ? { ok: false, error } : { ok: true })
        })
      }
    )

    socket.on('listas:duplicar', (payload: { id?: unknown }, ack?: Ack<{ ok: boolean; id?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      const lista = leerLista(payload?.id)
      if (!lista) return ack?.({ ok: false })
      const copia = crearLista({ nombre: `${lista.nombre} (copia)`.slice(0, 60), carpeta: lista.carpeta ?? '', fecha: null, proyectos: lista.proyectos })
      listasCambiaron()
      ack?.({ ok: true, id: copia.id })
    })

    socket.on('listas:borrar', (payload: { id?: unknown }, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket) || !esIdValido(payload?.id)) return ack?.({ ok: false })
      borrarLista(payload.id)
      if (state.listaActiva?.id === payload.id) {
        // las canciones de arriba quedan como estan, sueltas
        state.listaActiva = null
        state.guardarSesionAhora()
        emitirEstado()
      }
      listasCambiaron()
      ack?.({ ok: true })
    })

    socket.on('listas:usar', (payload: { id?: unknown }, ack?: Ack<{ ok: boolean; error?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false, error: 'Solo la computadora puede cambiar de lista' })
      void enCola(async () => {
        try {
          ack?.(await usarLista(payload?.id))
        } catch (err) {
          console.error('[listas:usar]', err)
          ack?.({ ok: false, error: 'No se pudo cargar la lista' })
        }
      })
    })

    socket.on('sesion:seguir', (_payload: unknown, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      void enCola(async () => {
        const sesion = state.sesionAnterior
        if (!sesion) return ack?.({ ok: false })
        const activa = state.getActiveTab()
        if (activa) transporte.detenerInmediato(activa)
        await state.lote(() => {
          state.listaActiva = null
          state.cerrarTodo()
        })
        await abrirSesion(state, sesion)
        transporte.reprogramarTimers()
        emitirEstado()
        listasCambiaron()
        ack?.({ ok: true })
      })
    })

    socket.on('carpetas:crear', (payload: { nombre?: unknown }, ack?: Ack<{ ok: boolean; nombre?: string; error?: string }>) => {
      if (!soloCompu(socket)) return ack?.({ ok: false })
      const nombre = limpiarNombre(payload?.nombre)
      if (!nombre) return ack?.({ ok: false, error: 'Poné un nombre para la carpeta' })
      const final = agregarCarpeta(nombre)
      listasCambiaron()
      ack?.({ ok: true, nombre: final })
    })

    socket.on('carpetas:renombrar', (payload: { de?: unknown; a?: unknown }, ack?: Ack<{ ok: boolean; error?: string }>) => {
      if (!soloCompu(socket) || typeof payload?.de !== 'string') return ack?.({ ok: false })
      if (!renombrarCarpeta(payload.de, typeof payload.a === 'string' ? payload.a : '')) return ack?.({ ok: false, error: 'Poné un nombre para la carpeta' })
      actualizarListaActiva()
      listasCambiaron()
      ack?.({ ok: true })
    })

    socket.on('carpetas:borrar', (payload: { nombre?: unknown }, ack?: Ack<{ ok: boolean }>) => {
      if (!soloCompu(socket) || typeof payload?.nombre !== 'string') return ack?.({ ok: false })
      borrarCarpeta(payload.nombre)
      actualizarListaActiva()
      listasCambiaron()
      ack?.({ ok: true })
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

  })

  return { transporte, analizador, biblioteca }
}

/** Si la app se cerro hace menos que esto (se corto a mitad de un culto), al abrirla vuelve todo como estaba. */
export const SEGUIR_DIRECTO_MS = 2 * 60 * 60 * 1000

/**
 * Al abrir la app: si se cerro hace poco (menos de 2 horas: se corto a mitad
 * de un culto), vuelve todo como estaba. Si no, arranca en la pantalla de
 * listas y lo de la ultima vez queda para "Seguir donde quede".
 */
export async function restaurarSesion(state: AppState, sesion: SesionGuardada | null, ahora = Date.now()): Promise<void> {
  if (!sesion || sesion.proyectos.length === 0) return
  if (sesion.ultimaVez === undefined || ahora - sesion.ultimaVez > SEGUIR_DIRECTO_MS) {
    state.sesionAnterior = sesion
    return
  }
  await abrirSesion(state, sesion)
}

/** Abre las canciones de una sesion guardada (con su lista del dia, si tenia). */
export async function abrirSesion(state: AppState, sesion: SesionGuardada): Promise<void> {
  await state.lote(async () => {
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
    const lista = sesion.listaId ? leerLista(sesion.listaId) : null
    state.listaActiva = lista ? { id: lista.id, nombre: lista.nombre, carpeta: lista.carpeta ?? '' } : null
    state.sesionAnterior = null
  })
}
