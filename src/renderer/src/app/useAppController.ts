import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComandoProgramado,
  DispositivoInfo,
  EstadoBuffer,
  EstadoCompleto,
  ImportProgreso,
  Marcador,
  MixerActualizadoPayload,
  OrigenCliente,
  PatchPista,
  PlaybackState,
  Proyecto,
  ProyectoResumen,
  SetlistResumen
} from '@shared/types'
import { calcularSecciones, estaSonando, posicionActualMs, seccionEn } from '@shared/playback'
import { SocketClient } from '../sync/SocketClient'
import { StreamingEngine } from '../audio/StreamingEngine'
import type { MezclaPersonal, PlaybackEngine } from '../audio/PlaybackEngine'
import { INTERVALO_MONITOREO_MS, MARGEN_RESYNC_DURO_MS, UMBRAL_DURO_MS, UMBRAL_SUAVE_MS } from '../sync/driftConfig'
import { setPlayheadMs, getPlayheadMs } from './playheadStore'
import { deviceIdPersistente, guardarPref, leerPref } from './preferencias'

export interface Aviso {
  id: number
  tipo: 'error' | 'info'
  texto: string
  accion?: { etiqueta: string; fn: () => void }
}

/**
 * (Re)ingresa en sincronia: programa un "play" local desde la posicion que
 * el servidor dice que deberia estar sonando AHORA, con un margen corto a
 * futuro. Se usa al cargar un proyecto que ya estaba sonando, al
 * reconectarse, al activar el audio a mitad de cancion, cuando el buffer se
 * recupera y para la resincronizacion dura del monitoreo de drift.
 */
function reingresarEnSync(engine: PlaybackEngine, socket: SocketClient, playback: PlaybackState, tabId: string, margenMs: number): void {
  const executeAt = socket.serverNow() + margenMs
  const posicion = posicionActualMs(playback, executeAt)
  engine.ejecutar(
    { tabId, accion: 'play', positionMs: posicion, executeAtServerTime: executeAt, playback },
    socket.clockOffsetMs
  )
}

/** Aplica el cambio de una pista del mixer a un estado (proyecto activo y lista de proyectos). */
function conPistaActualizada(estado: EstadoCompleto, m: MixerActualizadoPayload): EstadoCompleto {
  const reemplazar = (p: Proyecto): Proyecto =>
    p.id !== m.proyectoId ? p : { ...p, pistas: p.pistas.map((x) => (x.id === m.pista.id ? m.pista : x)) }
  return {
    ...estado,
    proyectoActivo: estado.proyectoActivo ? reemplazar(estado.proyectoActivo) : null,
    proyectos: estado.proyectos.map(reemplazar)
  }
}

const THROTTLE_MIXER_MS = 40

export function useAppController() {
  const origen: OrigenCliente = typeof window !== 'undefined' && window.electronAPI ? 'compu' : 'celular'

  const [conectado, setConectado] = useState(false)
  const [estado, setEstado] = useState<EstadoCompleto | null>(null)
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [driftMs, setDriftMs] = useState<number | null>(null)
  const [bufferEstado, setBufferEstado] = useState<EstadoBuffer | null>(null)
  const [errorAudio, setErrorAudio] = useState<string | null>(null)
  const [dispositivos, setDispositivos] = useState<DispositivoInfo[]>([])
  const [importProgreso, setImportProgreso] = useState<ImportProgreso | null>(null)

  // preferencias de ESTE dispositivo
  const [sonidoLocal, setSonidoLocalState] = useState<boolean>(() => (origen === 'compu' ? leerPref('sonido-compu', false) : true))
  const [audioActivo, setAudioActivo] = useState(false)
  const [volumenGeneral, setVolumenGeneralState] = useState<number>(() => leerPref('volumen', 100))
  const [ajusteManualMs, setAjusteManualMsState] = useState<number>(() => leerPref('ajuste-fino-ms', 0))
  const [mezclaPersonal, setMezclaPersonalState] = useState<MezclaPersonal>(() => leerPref('mezcla-personal', {}))
  const [nombreDispositivo, setNombreDispositivoState] = useState<string>(() => leerPref('nombre', ''))

  const nombreRef = useRef(nombreDispositivo)
  nombreRef.current = nombreDispositivo
  const socketRef = useRef<SocketClient | null>(null)
  if (!socketRef.current) {
    const deviceId = deviceIdPersistente()
    socketRef.current = new SocketClient(origen, () => ({
      token: window.electronAPI?.compuToken,
      deviceId,
      nombre: nombreRef.current || undefined
    }))
  }
  const engineRef = useRef<PlaybackEngine | null>(null)
  // espejo del estado, para callbacks/intervalos registrados una sola vez
  const estadoRef = useRef<EstadoCompleto | null>(null)
  estadoRef.current = estado
  const prefsRef = useRef({ volumenGeneral, ajusteManualMs, mezclaPersonal })
  prefsRef.current = { volumenGeneral, ajusteManualMs, mezclaPersonal }

  // diagnostico: con ?debug en la URL se exponen el motor y el estado en window.__mt (pruebas de campo)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('debug')) {
      ;(window as unknown as { __mt: unknown }).__mt = { engineRef, socketRef, estadoRef }
    }
  }, [])

  const avisar = useCallback((aviso: Omit<Aviso, 'id'>, ms = 5000) => {
    const id = Date.now() + Math.random()
    setAvisos((prev) => [...prev.slice(-3), { ...aviso, id }])
    setTimeout(() => setAvisos((prev) => prev.filter((a) => a.id !== id)), ms)
  }, [])

  /**
   * Deja al motor en linea con el estado: cancion activa, mezcla, cues y (si
   * suena) entra en sync. Con `reconciliar` (reconexion, reinicio del
   * servidor) ademas se alinea el transporte aunque sea la misma cancion: si
   * mientras estaba desconectado se pauso o se salto, el audio local quedo
   * desactualizado y no se puede esperar a un proximo comando.
   */
  const sincronizarMotor = useCallback((nuevo: EstadoCompleto | null, margenReingreso: number, reconciliar = false) => {
    const engine = engineRef.current
    const socket = socketRef.current
    if (!engine || !socket || !nuevo) return
    const proyecto = nuevo.proyectoActivo
    if (!proyecto) {
      engine.detener()
      return
    }
    const now = socket.serverNow()
    if (engine.proyectoIdCargado !== proyecto.id) {
      engine.activarProyecto(proyecto, nuevo.playbackActivo ? posicionActualMs(nuevo.playbackActivo, now) : 0)
      if (nuevo.playbackActivo && estaSonando(nuevo.playbackActivo, now)) {
        reingresarEnSync(engine, socket, nuevo.playbackActivo, nuevo.activeTabId ?? '', margenReingreso)
      }
    } else {
      engine.aplicarMezcla(proyecto.pistas)
      engine.setCues(proyecto.marcadores.map((m) => m.tiempoMs))
      if (reconciliar) {
        const pb = nuevo.playbackActivo
        if (pb && estaSonando(pb, now)) {
          reingresarEnSync(engine, socket, pb, nuevo.activeTabId ?? '', margenReingreso)
        } else {
          engine.ejecutar(
            {
              tabId: nuevo.activeTabId ?? '',
              accion: 'pause',
              positionMs: pb ? posicionActualMs(pb, now) : 0,
              executeAtServerTime: now,
              playback: pb ?? { estado: 'stopped', positionMs: 0, referenceServerTime: now }
            },
            socket.clockOffsetMs
          )
        }
      }
    }
  }, [])

  const crearEngine = useCallback((): PlaybackEngine => {
    const engine = new StreamingEngine()
    const p = prefsRef.current
    engine.setVolumenGeneral(p.volumenGeneral)
    engine.setAjusteManualMs(p.ajusteManualMs)
    engine.setMezclaPersonal(origen === 'celular' ? p.mezclaPersonal : {})
    engine.onRequiereResync(() => {
      const socket = socketRef.current
      const actual = estadoRef.current
      const playback = actual?.playbackActivo
      if (!socket || !playback || !estaSonando(playback, socket.serverNow())) return
      reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
    })
    return engine
  }, [origen])

  /** Crea el motor de audio de este dispositivo y lo engancha a lo que este sonando. */
  const encenderAudio = useCallback(async () => {
    if (!engineRef.current) engineRef.current = crearEngine()
    await engineRef.current.resumeSiHaceFalta()
    sincronizarMotor(estadoRef.current, 400)
  }, [crearEngine, sincronizarMotor])

  const apagarAudio = useCallback(() => {
    engineRef.current?.dispose()
    engineRef.current = null
    setDriftMs(null)
    setBufferEstado(null)
    setErrorAudio(null)
  }, [])

  // ---- conexion ----
  useEffect(() => {
    const socket = socketRef.current!

    function aplicarEstado(nuevo: EstadoCompleto, esReconexion = false): void {
      setEstado(nuevo)
      estadoRef.current = nuevo
      sincronizarMotor(nuevo, esReconexion ? 600 : 300, esReconexion)
    }

    const offs = [
      socket.onEstado((nuevo) => aplicarEstado(nuevo)),
      socket.onPlaybackScheduled((cmd: ComandoProgramado) => {
        const actual = estadoRef.current
        if (actual && actual.activeTabId === cmd.tabId) {
          engineRef.current?.ejecutar(cmd, socket.clockOffsetMs)
          const nuevo = { ...actual, playbackActivo: cmd.playback }
          estadoRef.current = nuevo
          setEstado(nuevo)
        } else if (cmd.accion === 'stop') {
          // stop de una cancion que se esta cerrando/cambiando: cortar igual
          engineRef.current?.ejecutar(cmd, socket.clockOffsetMs)
        }
      }),
      socket.onMixer((m) => {
        const actual = estadoRef.current
        if (!actual) return
        const nuevo = conPistaActualizada(actual, m)
        estadoRef.current = nuevo
        setEstado(nuevo)
        if (engineRef.current?.proyectoIdCargado === m.proyectoId && nuevo.proyectoActivo) {
          engineRef.current.aplicarMezcla(nuevo.proyectoActivo.pistas)
        }
      }),
      socket.onRechazado((err) => avisar({ tipo: 'error', texto: err.mensaje })),
      socket.onDispositivos((lista) => setDispositivos(lista)),
      socket.onImportProgreso((p) => setImportProgreso(p.etapa === 'listo' ? null : p)),
      socket.onConexionCambia(async (c) => {
        setConectado(c)
        if (c) {
          await socket.sincronizarReloj()
          aplicarEstado(await socket.pedirEstado(), true)
        }
      })
    ]
    return () => offs.forEach((off) => off())
  }, [avisar, sincronizarMotor])

  // compu: el sonido local se enciende/apaga segun la preferencia (en Electron no hace falta un gesto del usuario)
  useEffect(() => {
    if (origen !== 'compu') return
    if (sonidoLocal) void encenderAudio()
    else apagarAudio()
  }, [origen, sonidoLocal, encenderAudio, apagarAudio])

  // ---- monitoreo continuo de sincronizacion (drift) + reporte a la compu ----
  useEffect(() => {
    let ultimoReporte = ''
    const id = setInterval(() => {
      const socket = socketRef.current
      const engine = engineRef.current
      if (!socket) return
      if (!engine) {
        if (origen === 'celular' && ultimoReporte !== 'sin-audio') {
          socket.emit('sync:report', { driftMs: null, buffer: null, error: null, audio: false })
          ultimoReporte = 'sin-audio'
        }
        return
      }
      const actual = estadoRef.current
      const playback = actual?.playbackActivo
      const now = socket.serverNow()
      const buffer = engine.estadoBuffer()
      const error = engine.errorAudio()
      setBufferEstado(buffer)
      setErrorAudio(error)

      let drift: number | null = null
      // no se mide en la transicion de un comando programado (el audio todavia no cambio)
      if (playback && estaSonando(playback, now) && Math.abs(now - playback.referenceServerTime) > 600) {
        const posicionReal = engine.posicionRealMs()
        if (posicionReal !== null) {
          drift = posicionReal - posicionActualMs(playback, now)
          if (!engine.enCorreccionSuave()) {
            const abs = Math.abs(drift)
            if (abs >= UMBRAL_DURO_MS) {
              reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
            } else if (abs >= UMBRAL_SUAVE_MS) {
              engine.corregirDriftSuave(drift)
            }
          }
        }
      }
      setDriftMs(drift)
      const reporte = JSON.stringify({ d: drift === null ? null : Math.round(drift), buffer, error })
      if (drift !== null || reporte !== ultimoReporte) {
        socket.emit('sync:report', { driftMs: drift, buffer, error, audio: true })
        ultimoReporte = reporte
      }
    }, INTERVALO_MONITOREO_MS)
    return () => clearInterval(id)
  }, [origen])

  // estado del buffer/errores: se revisa cada segundo (no cada 4s como el drift) para que el aviso
  // de "WiFi lento" aparezca enseguida en el celular y en la compu
  useEffect(() => {
    let anterior = ''
    const id = setInterval(() => {
      const engine = engineRef.current
      const socket = socketRef.current
      if (!engine || !socket) return
      const buffer = engine.estadoBuffer()
      const error = engine.errorAudio()
      const clave = `${buffer}|${error}`
      if (clave === anterior) return
      anterior = clave
      setBufferEstado(buffer)
      setErrorAudio(error)
      socket.emit('sync:report', { driftMs: null, buffer, error, audio: true })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // al volver a primer plano (pantalla desbloqueada, cambio de app): reloj + resync inmediato
  useEffect(() => {
    async function onVisible(): Promise<void> {
      if (document.visibilityState !== 'visible') return
      const socket = socketRef.current
      const engine = engineRef.current
      if (!socket || !engine) return
      await engine.resumeSiHaceFalta()
      await socket.sincronizarReloj()
      const actual = estadoRef.current
      const playback = actual?.playbackActivo
      if (playback && estaSonando(playback, socket.serverNow())) {
        reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Media Session: el sistema operativo trata esto como reproduccion de audio real
  // (menos probable que congele la pestana en segundo plano). Sin controles remotos
  // a proposito: tocar la pantalla de bloqueo no deberia pausar a todo el grupo.
  useEffect(() => {
    if (origen !== 'celular' || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const proyecto = estado?.proyectoActivo
    if (proyecto) navigator.mediaSession.metadata = new MediaMetadata({ title: proyecto.nombre, artist: 'Multitrack Alabanza' })
    const e = estado?.playbackActivo?.estado
    navigator.mediaSession.playbackState = e === 'playing' ? 'playing' : e === 'paused' ? 'paused' : 'none'
  }, [origen, estado?.proyectoActivo?.id, estado?.proyectoActivo?.nombre, estado?.playbackActivo?.estado])

  // playhead: store externo actualizado por requestAnimationFrame (ver playheadStore)
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      const socket = socketRef.current
      const playback = estadoRef.current?.playbackActivo
      setPlayheadMs(socket && playback ? posicionActualMs(playback, socket.serverNow()) : 0)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- mixer con throttle: como mucho un mensaje cada 40ms por pista mientras se arrastra un fader ----
  const mixerPendiente = useRef(new Map<string, PatchPista>())
  const mixerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const acciones = useMemo(() => {
    const socket = socketRef.current!
    const emit = (ev: string, payload: unknown = {}): void => socket.emit(ev, payload)

    function secciones() {
      const p = estadoRef.current?.proyectoActivo
      return p ? calcularSecciones(p.marcadores, p.duracionTotalMs) : []
    }

    function flushMixer(): void {
      mixerTimer.current = null
      for (const [pistaId, patch] of mixerPendiente.current) emit('mixer:update', { pistaId, patch })
      mixerPendiente.current.clear()
    }

    return {
      // ---- audio de este dispositivo ----
      async activarAudio(): Promise<void> {
        await encenderAudio()
        setAudioActivo(true)
        // avisar ya a la compu (sin esperar el proximo ciclo del monitor) que este celular va a sonar
        emit('sync:report', { driftMs: null, buffer: null, error: null, audio: true })
      },
      setSonidoLocal(v: boolean): void {
        setSonidoLocalState(v)
        guardarPref('sonido-compu', v)
      },
      setVolumenGeneral(v: number): void {
        setVolumenGeneralState(v)
        guardarPref('volumen', v)
        engineRef.current?.setVolumenGeneral(v)
      },
      setAjusteManualMs(ms: number): void {
        const clamped = Math.max(-500, Math.min(500, Math.round(ms)))
        setAjusteManualMsState(clamped)
        guardarPref('ajuste-fino-ms', clamped)
        engineRef.current?.setAjusteManualMs(clamped)
        // el ajuste solo afecta el proximo scheduling: reentrar en sync para que se note ya
        const playback = estadoRef.current?.playbackActivo
        if (engineRef.current && playback && estaSonando(playback, socket.serverNow())) {
          reingresarEnSync(engineRef.current, socket, playback, estadoRef.current?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
        }
      },
      setMezclaPersonal(m: MezclaPersonal): void {
        setMezclaPersonalState(m)
        guardarPref('mezcla-personal', m)
        engineRef.current?.setMezclaPersonal(m)
      },
      setNombreDispositivo(nombre: string): void {
        const limpio = nombre.replace(/\s+/g, ' ').trim().slice(0, 24)
        setNombreDispositivoState(limpio)
        nombreRef.current = limpio
        guardarPref('nombre', limpio)
        emit('device:rename', { nombre: limpio })
      },

      // ---- transporte ----
      play(positionMs?: number): void {
        emit('transport:play', positionMs !== undefined ? { positionMs } : {})
      },
      pause(): void {
        emit('transport:pause')
      },
      togglePlay(): void {
        const pb = estadoRef.current?.playbackActivo
        if (pb?.estado === 'playing') emit('transport:pause')
        else emit('transport:play', {})
      },
      stop(): void {
        emit('transport:stop')
      },
      seek(positionMs: number): void {
        emit('transport:seek', { positionMs })
      },
      jumpToMarker(marcadorId: string): void {
        emit('marker:jump', { marcadorId })
      },
      /** Salta a la seccion `delta` posiciones antes/despues de la actual (o al principio de la actual si ya paso >2s). */
      saltarSeccion(delta: number): void {
        const lista = secciones()
        if (lista.length === 0) return
        const pos = getPlayheadMs()
        const actual = seccionEn(lista, pos) ?? lista[0]
        let destino = actual.indice + delta
        if (delta < 0 && pos - actual.inicioMs > 2000) destino = actual.indice // "anterior" = volver al inicio de esta
        destino = Math.max(0, Math.min(lista.length - 1, destino))
        emit('transport:seek', { positionMs: lista[destino].inicioMs })
      },
      irASeccion(numero: number): void {
        const lista = secciones().filter((s) => s.marcador)
        const s = lista[numero - 1]
        if (s) emit('transport:seek', { positionMs: s.inicioMs })
      },
      setLoop(activo: boolean): void {
        emit('loop:set', { activo })
      },

      // ---- marcadores ----
      createMarker(tiempoMs: number, nombre?: string): void {
        emit('marker:create', { tiempoMs, nombre })
      },
      updateMarker(marcadorId: string, patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>): void {
        emit('marker:update', { marcadorId, patch })
      },
      deleteMarker(marcador: Marcador): void {
        emit('marker:delete', { marcadorId: marcador.id })
        avisar(
          {
            tipo: 'info',
            texto: `Se borró “${marcador.nombre}”`,
            accion: { etiqueta: 'Deshacer', fn: () => emit('marker:restore', { marcador }) }
          },
          7000
        )
      },

      // ---- mezcla (con cambio local inmediato + envio con throttle) ----
      updateMixer(pistaId: string, patch: PatchPista): void {
        const actual = estadoRef.current
        const proyecto = actual?.proyectoActivo
        const pista = proyecto?.pistas.find((p) => p.id === pistaId)
        if (actual && proyecto && pista) {
          const nuevo = conPistaActualizada(actual, { proyectoId: proyecto.id, pista: { ...pista, ...patch } })
          estadoRef.current = nuevo
          setEstado(nuevo)
          if (engineRef.current?.proyectoIdCargado === proyecto.id) engineRef.current.aplicarMezcla(nuevo.proyectoActivo!.pistas)
        }
        mixerPendiente.current.set(pistaId, { ...mixerPendiente.current.get(pistaId), ...patch })
        if (!mixerTimer.current) mixerTimer.current = setTimeout(flushMixer, THROTTLE_MIXER_MS)
      },
      reorderPistas(orden: string[]): void {
        emit('pistas:reorder', { orden })
      },

      // ---- setlist / pestanas ----
      switchTab(tabId: string): void {
        emit('tabs:switch', { tabId })
      },
      cancionRelativa(delta: number): void {
        const e = estadoRef.current
        if (!e) return
        const i = e.tabs.findIndex((t) => t.tabId === e.activeTabId)
        const destino = e.tabs[i + delta]
        if (destino) emit('tabs:switch', { tabId: destino.tabId })
      },
      closeTab(tabId: string): void {
        emit('tabs:close', { tabId })
      },
      reorderTabs(orden: string[]): void {
        emit('tabs:reorder', { orden })
      },
      renameProject(proyectoId: string, nombre: string): void {
        emit('project:rename', { proyectoId, nombre })
      },
      setLocked(locked: boolean): void {
        emit('lock:set', { locked })
      },

      // ---- canciones y setlists guardados ----
      async loadZip(): Promise<{ ok: boolean; error?: string; activada?: boolean }> {
        if (!window.electronAPI) return { ok: false, error: 'Solo disponible en la computadora' }
        const filePath = await window.electronAPI.pickZipFile()
        if (!filePath) return { ok: false }
        setImportProgreso({ etapa: 'extrayendo', actual: 0, total: 0 })
        try {
          return await socket.emitAck('project:load-from-zip', { filePath }, 10 * 60 * 1000)
        } catch {
          return { ok: false, error: 'La importación tardó demasiado' }
        } finally {
          setImportProgreso(null)
        }
      },
      async listSavedProjects(): Promise<ProyectoResumen[]> {
        return socket.emitAck('projects:list', {})
      },
      async openSavedProject(id: string, activar = true): Promise<{ ok: boolean; error?: string; activada?: boolean }> {
        return socket.emitAck('projects:open', { id, activar }, 5 * 60 * 1000)
      },
      async deleteSavedProject(id: string): Promise<{ ok: boolean }> {
        return socket.emitAck('projects:delete', { id })
      },
      async listSetlists(): Promise<SetlistResumen[]> {
        return socket.emitAck('setlists:list', {})
      },
      async saveSetlist(nombre: string): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck('setlists:save', { nombre })
      },
      async openSetlist(id: string): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck('setlists:open', { id }, 5 * 60 * 1000)
      },
      async deleteSetlist(id: string): Promise<{ ok: boolean }> {
        return socket.emitAck('setlists:delete', { id })
      },

      // ---- dispositivos ----
      forgetDevice(id: string): void {
        emit('devices:forget', { id })
      },

      avisar,
      cerrarAviso(id: number): void {
        setAvisos((prev) => prev.filter((a) => a.id !== id))
      }
    }
  }, [avisar, encenderAudio])

  const siguienteProyecto = useMemo(() => {
    if (!estado) return null
    const i = estado.tabs.findIndex((t) => t.tabId === estado.activeTabId)
    return i === -1 ? null : (estado.proyectos[i + 1] ?? null)
  }, [estado])

  const secciones = useMemo(() => {
    const p = estado?.proyectoActivo
    return p ? calcularSecciones(p.marcadores, p.duracionTotalMs) : []
  }, [estado?.proyectoActivo])

  return {
    origen,
    conectado,
    estado,
    secciones,
    siguienteProyecto,
    dispositivos,
    avisos,
    importProgreso,
    driftMs,
    bufferEstado,
    errorAudio,
    sonidoLocal,
    audioActivo,
    volumenGeneral,
    ajusteManualMs,
    mezclaPersonal,
    nombreDispositivo,
    ...acciones
  }
}

export type AppController = ReturnType<typeof useAppController>
