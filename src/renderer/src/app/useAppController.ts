import { useEffect, useMemo, useRef, useState } from 'react'
import type { EstadoCompleto, Marcador, OrigenCliente, Pista, ProyectoResumen } from '@shared/types'
import { posicionActualMs } from '@shared/playback'
import { SocketClient } from '../sync/SocketClient'
import { AudioEngine } from '../audio/AudioEngine'

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

  const proyectoIdEnCarga = useRef<string | null>(null)
  const detuvoAlFinal = useRef(false)

  useEffect(() => {
    const socket = socketRef.current!

    function getEngine(): AudioEngine {
      if (!engineRef.current) engineRef.current = new AudioEngine()
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
        const duracionDetectadaMs = await engine.cargarProyecto(proyecto)
        proyectoIdEnCarga.current = null
        setAudioListo(true)
        detuvoAlFinal.current = false

        if (origen === 'compu' && duracionDetectadaMs > 0 && duracionDetectadaMs !== proyecto.duracionTotalMs) {
          socket.emit('project:duration', { duracionTotalMs: duracionDetectadaMs })
        }

        // si nos unimos con la cancion ya sonando, nos programamos para entrar en sync
        if (nuevo.playbackActivo?.estado === 'playing') {
          const serverNow = socket.serverNow()
          const posicionAhora = posicionActualMs(nuevo.playbackActivo, serverNow)
          const margen = esReconexion ? 600 : 300
          engine.ejecutar(
            {
              tabId: nuevo.activeTabId ?? '',
              accion: 'play',
              positionMs: posicionAhora,
              executeAtServerTime: serverNow + margen
            },
            socket.clockOffsetMs
          )
        }
      } else if (!esProyectoNuevo) {
        engine.aplicarMezcla(proyecto.pistas)
      }
    }

    return () => {
      offEstado()
      offPlayback()
      offError()
      offConexion()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (!engineRef.current) engineRef.current = new AudioEngine()
        await engineRef.current.resumeSiHaceFalta()
      },
      setVolumenGeneral(v: number): void {
        setVolumenGeneralState(v)
        engineRef.current?.setVolumenGeneral(v)
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
    ultimoError,
    ...acciones
  }
}
