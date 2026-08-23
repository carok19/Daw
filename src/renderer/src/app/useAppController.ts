import { useEffect, useMemo, useRef, useState } from 'react'
import type { DispositivoInfo, EstadoCompleto, Marcador, OrigenCliente, PlaybackState, Pista, ProyectoResumen } from '@shared/types'
import { posicionActualMs } from '@shared/playback'
import { SocketClient } from '../sync/SocketClient'
import { AudioEngine } from '../audio/AudioEngine'
import { INTERVALO_MONITOREO_MS, MARGEN_RESYNC_DURO_MS, UMBRAL_DURO_MS, UMBRAL_SUAVE_MS } from '../sync/driftConfig'

/** Ajuste fino de sincronizacion: guardado por dispositivo (localStorage es por navegador/celular). */
const AJUSTE_FINO_KEY = 'multitrack:ajuste-fino-ms'

function leerAjusteFinoGuardado(): number {
  try {
    const valor = Number(window.localStorage.getItem(AJUSTE_FINO_KEY))
    return Number.isFinite(valor) ? valor : 0
  } catch {
    return 0
  }
}

/**
 * (Re)ingresa en sincronia: programa un "play" local desde la posicion que
 * el modelo del servidor dice que deberia estar sonando AHORA, con un margen
 * corto a futuro. Se usa para tres casos: cargar un proyecto que ya estaba
 * sonando, reconectarse a mitad de cancion, y la resincronizacion dura del
 * monitoreo de drift — los tres son variantes de "ponerme al dia con lo que
 * el servidor dice que deberia estar pasando".
 */
function reingresarEnSync(
  engine: AudioEngine,
  socket: SocketClient,
  playback: PlaybackState,
  tabId: string,
  margenMs: number
): void {
  const serverNow = socket.serverNow()
  const executeAt = serverNow + margenMs
  const posicion = posicionActualMs(playback, executeAt)
  engine.ejecutar({ tabId, accion: 'play', positionMs: posicion, executeAtServerTime: executeAt }, socket.clockOffsetMs)
}

export function useAppController() {
  const origen: OrigenCliente = typeof window !== 'undefined' && window.electronAPI ? 'compu' : 'celular'

  const socketRef = useRef<SocketClient | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  if (!socketRef.current) socketRef.current = new SocketClient(origen)

  const [conectado, setConectado] = useState(false)
  const [estado, setEstado] = useState<EstadoCompleto | null>(null)
  const [ultimoError, setUltimoError] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [volumenGeneral, setVolumenGeneralState] = useState(100)
  const [audioListo, setAudioListo] = useState(false)
  const [cargaProgreso, setCargaProgreso] = useState(0)
  const [ajusteManualMs, setAjusteManualMsState] = useState(0)
  const [driftMs, setDriftMs] = useState<number | null>(null)
  const [dispositivos, setDispositivos] = useState<DispositivoInfo[]>([])

  const proyectoIdEnCarga = useRef<string | null>(null)
  const detuvoAlFinal = useRef(false)
  const ajusteManualMsRef = useRef(0)
  // Espejo del estado, actualizado en cada render: lo lee el loop de monitoreo
  // de drift (un setInterval con deps []) para no reinstalarse cada vez que
  // cambia `estado`, y siempre leer el playback mas fresco.
  const estadoRef = useRef<EstadoCompleto | null>(null)
  estadoRef.current = estado

  useEffect(() => {
    const guardado = leerAjusteFinoGuardado()
    ajusteManualMsRef.current = guardado
    setAjusteManualMsState(guardado)
    engineRef.current?.setAjusteManualMs(guardado)
  }, [])

  useEffect(() => {
    const socket = socketRef.current!

    function getEngine(): AudioEngine {
      if (!engineRef.current) {
        engineRef.current = new AudioEngine()
        engineRef.current.setAjusteManualMs(ajusteManualMsRef.current)
      }
      return engineRef.current
    }

    const offEstado = socket.onEstado((nuevo) => aplicarEstado(nuevo))
    const offPlayback = socket.onPlaybackScheduled((cmd) => {
      getEngine().ejecutar(cmd, socket.clockOffsetMs)

      // El servidor no reenvia un 'estado:actualizado' completo por cada play/pause/
      // seek (solo por cambios estructurales), asi que la posicion mostrada en la UI
      // (barra de progreso, "En mm:ss" de nuevo marcador) se predice localmente a
      // partir del comando programado, igual que hace el motor de audio.
      setEstado((prev) => {
        if (!prev || prev.activeTabId !== cmd.tabId) return prev
        const estadoTransporte =
          cmd.accion === 'play'
            ? 'playing'
            : cmd.accion === 'pause'
              ? 'paused'
              : cmd.accion === 'stop'
                ? 'stopped'
                : (prev.playbackActivo?.estado ?? 'paused')
        return {
          ...prev,
          playbackActivo: {
            estado: estadoTransporte,
            positionMs: cmd.positionMs,
            referenceServerTime: cmd.executeAtServerTime
          }
        }
      })
    })
    const offError = socket.onRechazado((err) => setUltimoError(err.mensaje))
    const offDispositivos = socket.onDispositivos((lista) => setDispositivos(lista))
    const offConexion = socket.onConexionCambia(async (c) => {
      setConectado(c)
      if (c) {
        await socket.sincronizarReloj()
        const snapshot = await socket.pedirEstado()
        aplicarEstado(snapshot, true)
      }
    })

    async function aplicarEstado(nuevo: EstadoCompleto, esReconexion = false): Promise<void> {
      setEstado(nuevo)
      const proyecto = nuevo.proyectoActivo
      if (!proyecto) return

      const engine = getEngine()
      const esProyectoNuevo = engine.proyectoIdCargado !== proyecto.id
      if (esProyectoNuevo && proyectoIdEnCarga.current !== proyecto.id) {
        proyectoIdEnCarga.current = proyecto.id
        setAudioListo(false)
        setCargaProgreso(0)
        const duracionDetectadaMs = await engine.cargarProyecto(proyecto, setCargaProgreso)
        proyectoIdEnCarga.current = null
        setAudioListo(true)
        detuvoAlFinal.current = false

        if (origen === 'compu' && duracionDetectadaMs > 0 && duracionDetectadaMs !== proyecto.duracionTotalMs) {
          socket.emit('project:duration', { duracionTotalMs: duracionDetectadaMs })
        }

        // si nos unimos con la cancion ya sonando, nos programamos para entrar en sync
        if (nuevo.playbackActivo?.estado === 'playing') {
          reingresarEnSync(engine, socket, nuevo.playbackActivo, nuevo.activeTabId ?? '', esReconexion ? 600 : 300)
        }
      } else if (!esProyectoNuevo) {
        engine.aplicarMezcla(proyecto.pistas)
      }
    }

    return () => {
      offEstado()
      offPlayback()
      offError()
      offDispositivos()
      offConexion()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Monitoreo continuo de sincronizacion (drift): mientras se esta
  // reproduciendo, cada INTERVALO_MONITOREO_MS compara la posicion que el
  // reloj de audio de ESTE dispositivo dice que esta sonando contra la que
  // el modelo del servidor dice que deberia sonar. Si se separan, corrige.
  // Deps [] a proposito (igual que el atajo de teclado): lee todo por ref
  // para no reinstalar el interval en cada render.
  useEffect(() => {
    const id = setInterval(() => {
      const socket = socketRef.current
      const engine = engineRef.current
      const estadoActual = estadoRef.current
      const playback = estadoActual?.playbackActivo
      if (!socket || !engine || !playback || playback.estado !== 'playing') {
        setDriftMs(null)
        return
      }
      const posicionReal = engine.posicionRealMs()
      if (posicionReal === null) return // el start() programado todavia no llego a su horario

      const posicionEsperada = posicionActualMs(playback, socket.serverNow())
      const drift = posicionReal - posicionEsperada
      setDriftMs(drift)
      socket.emit('sync:report', { driftMs: drift })

      if (engine.enCorreccionSuave()) return // ya hay una correccion en curso, esperar a que termine

      const abs = Math.abs(drift)
      if (abs >= UMBRAL_DURO_MS) {
        reingresarEnSync(engine, socket, playback, estadoActual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
      } else if (abs >= UMBRAL_SUAVE_MS) {
        engine.corregirDriftSuave(drift)
      }
    }, INTERVALO_MONITOREO_MS)
    return () => clearInterval(id)
  }, [])

  // Al bloquear la pantalla o pasar la app a segundo plano, el navegador frena
  // los temporizadores de JS — el monitor de drift de arriba deja de correr,
  // aunque el audio siga sonando. Al volver a primer plano, en vez de esperar
  // el proximo tick (hasta INTERVALO_MONITOREO_MS despues, con el drift
  // acumulado mientras tanto sin corregir), se resincroniza de inmediato:
  // primero el reloj (el offset tambien pudo quedar desactualizado) y, si
  // estaba reproduciendo, un resync duro ya mismo.
  useEffect(() => {
    async function onVisible(): Promise<void> {
      if (document.visibilityState !== 'visible') return
      const socket = socketRef.current
      const engine = engineRef.current
      if (!socket || !engine) return
      await socket.sincronizarReloj()
      const estadoActual = estadoRef.current
      const playback = estadoActual?.playbackActivo
      if (playback?.estado === 'playing') {
        reingresarEnSync(engine, socket, playback, estadoActual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // playhead: recalculado en cada frame a partir del estado de reproduccion + offset de reloj
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      const socket = socketRef.current
      const playback = estado?.playbackActivo
      if (socket && playback) {
        const pos = posicionActualMs(playback, socket.serverNow())
        setPlayheadMs(pos)

        const duracion = estado?.proyectoActivo?.duracionTotalMs ?? 0
        if (
          origen === 'compu' &&
          duracion > 0 &&
          playback.estado === 'playing' &&
          pos >= duracion &&
          !detuvoAlFinal.current
        ) {
          detuvoAlFinal.current = true
          socketRef.current?.emit('transport:stop')
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [estado, origen])

  const acciones = useMemo(
    () => ({
      async activarAudio(): Promise<void> {
        if (!engineRef.current) {
          engineRef.current = new AudioEngine()
          engineRef.current.setAjusteManualMs(ajusteManualMsRef.current)
        }
        await engineRef.current.resumeSiHaceFalta()
      },
      setVolumenGeneral(v: number): void {
        setVolumenGeneralState(v)
        engineRef.current?.setVolumenGeneral(v)
      },
      /** Ajuste fino de sincronizacion (ms), calibrado a oido y guardado en ESTE dispositivo. */
      setAjusteManualMs(ms: number): void {
        const clamped = Math.max(-500, Math.min(500, Math.round(ms)))
        ajusteManualMsRef.current = clamped
        setAjusteManualMsState(clamped)
        engineRef.current?.setAjusteManualMs(clamped)
        try {
          window.localStorage.setItem(AJUSTE_FINO_KEY, String(clamped))
        } catch {
          // almacenamiento no disponible (navegacion privada, etc.): se pierde al recargar, no es critico
        }
      },
      play(positionMs?: number): void {
        socketRef.current?.emit('transport:play', positionMs !== undefined ? { positionMs } : {})
      },
      pause(): void {
        socketRef.current?.emit('transport:pause')
      },
      stop(): void {
        socketRef.current?.emit('transport:stop')
      },
      seek(positionMs: number): void {
        socketRef.current?.emit('transport:seek', { positionMs })
      },
      jumpToMarker(marcadorId: string): void {
        socketRef.current?.emit('marker:jump', { marcadorId })
      },
      createMarker(tiempoMs: number, nombre?: string): void {
        socketRef.current?.emit('marker:create', { tiempoMs, nombre })
      },
      updateMarker(marcadorId: string, patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>): void {
        socketRef.current?.emit('marker:update', { marcadorId, patch })
      },
      deleteMarker(marcadorId: string): void {
        socketRef.current?.emit('marker:delete', { marcadorId })
      },
      updateMixer(pistaId: string, patch: Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre'>>): void {
        socketRef.current?.emit('mixer:update', { pistaId, patch })
      },
      reorderPistas(orden: string[]): void {
        socketRef.current?.emit('pistas:reorder', { orden })
      },
      switchTab(tabId: string): void {
        socketRef.current?.emit('tabs:switch', { tabId })
      },
      closeTab(tabId: string): void {
        socketRef.current?.emit('tabs:close', { tabId })
      },
      setLocked(locked: boolean): void {
        socketRef.current?.emit('lock:set', { locked })
      },
      async loadZip(): Promise<{ ok: boolean; error?: string }> {
        if (!window.electronAPI) return { ok: false, error: 'Solo disponible en la computadora' }
        const filePath = await window.electronAPI.pickZipFile()
        if (!filePath) return { ok: false }
        return socketRef.current!.emitAck('project:load-from-zip', { filePath })
      },
      async listSavedProjects(): Promise<ProyectoResumen[]> {
        return socketRef.current!.emitAck('projects:list', {})
      },
      async openSavedProject(id: string): Promise<{ ok: boolean; error?: string }> {
        return socketRef.current!.emitAck('projects:open', { id })
      },
      async deleteSavedProject(id: string): Promise<{ ok: boolean }> {
        return socketRef.current!.emitAck('projects:delete', { id })
      },
      limpiarError(): void {
        setUltimoError(null)
      }
    }),
    []
  )

  return {
    origen,
    conectado,
    estado,
    playheadMs,
    volumenGeneral,
    audioListo,
    cargaProgreso,
    ajusteManualMs,
    driftMs,
    dispositivos,
    ultimoError,
    ...acciones
  }
}
