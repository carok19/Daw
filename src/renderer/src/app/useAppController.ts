import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AjustesConexion,
  ComandoProgramado,
  DatosInvitacion,
  DiagnosticoDispositivo,
  DiagnosticoServidor,
  EstadoLicencia,
  DispositivoInfo,
  EstadoBiblioteca,
  EstadoBuffer,
  EstadoCompleto,
  ImportProgreso,
  InfoModeloVoz,
  PedidoVoz,
  Marcador,
  ModoSalto,
  MixerActualizadoPayload,
  MotivoCodigo,
  OrigenCliente,
  PatchPista,
  Pista,
  PlaybackState,
  Proyecto,
  ProyectoResumen,
  DatosListas
} from '@shared/types'
import { calcularSecciones, estaSonando, posicionActualMs, seccionEn } from '@shared/playback'
import { SocketClient } from '../sync/SocketClient'
import { StreamingEngine } from '../audio/StreamingEngine'
import type { MezclaPersonal, PlaybackEngine } from '../audio/PlaybackEngine'
import { INTERVALO_MONITOREO_MS, MARGEN_RESYNC_DURO_MS, UMBRAL_DURO_MS, UMBRAL_SUAVE_MS } from '../sync/driftConfig'
import { setPlayheadMs, getPlayheadMs } from './playheadStore'
import { deviceIdPersistente, guardarPref, leerPref } from './preferencias'
import { ReconocimientoGuia } from '../analisis/reconocimientoGuia'
import { codigoDesdeDireccion, puenteAndroid } from '../conexion'

/** Compas mas cercano (si esta a menos de medio compas): "ajustar al compas". */
export function ajustarACompas(compasesMs: number[] | undefined, ms: number): number {
  if (!compasesMs || compasesMs.length < 2) return ms
  let mejor = ms
  let dist = Infinity
  for (const c of compasesMs) {
    const d = Math.abs(c - ms)
    if (d < dist) {
      dist = d
      mejor = c
    }
  }
  const medioCompas = (compasesMs[1] - compasesMs[0]) / 2
  return dist <= medioCompas ? mejor : ms
}

export interface Aviso {
  id: number
  tipo: 'error' | 'info'
  texto: string
  accion?: { etiqueta: string; fn: () => void }
}

/**
 * (Re)ingresa en sincronia: programa un "play" local desde la posicion que
 * el servidor dice que deberia estar sonando, con un margen corto a futuro.
 * Se usa al cargar un proyecto que ya estaba sonando, al reconectarse, al
 * activar el audio a mitad de cancion, cuando el buffer se recupera y para la
 * resincronizacion dura del monitoreo de drift.
 *
 * Con el tempo detectado (`compasesMs`), la entrada se hace en el "1" del
 * proximo compas, como un musico que retoma: nunca a mitad de un acorde.
 */
function reingresarEnSync(
  engine: PlaybackEngine,
  socket: SocketClient,
  playback: PlaybackState,
  tabId: string,
  margenMs: number,
  compasesMs?: number[] | null
): void {
  let executeAt = socket.serverNow() + margenMs
  let posicion = posicionActualMs(playback, executeAt)
  const proximo = compasesMs ? proximoCompas(compasesMs, posicion) : null
  if (proximo !== null && estaSonando(playback, executeAt)) {
    const candidato = executeAt + (proximo - posicion)
    // (si antes del compas hay un salto programado, no aplica: se entra donde toque)
    if (Math.abs(posicionActualMs(playback, candidato) - proximo) < 2) {
      executeAt = candidato
      posicion = proximo
    }
  }
  engine.ejecutar({ tabId, accion: 'play', positionMs: posicion, executeAtServerTime: executeAt, playback }, socket.clockOffsetMs)
}

/** Inicio del proximo compas desde `posicionMs` (null si no hay tempo o falta mas de un compas). */
function proximoCompas(compasesMs: number[], posicionMs: number): number | null {
  if (compasesMs.length < 2) return null
  const k = compasesMs.findIndex((c) => c >= posicionMs - 1)
  if (k <= 0) return null
  const largo = compasesMs[k] - compasesMs[k - 1]
  return compasesMs[k] - posicionMs <= largo + 1 ? compasesMs[k] : null
}

/** "Android · Chrome", "iPhone · Safari", "App Android"... (para el diagnostico). */
function plataforma(origen: OrigenCliente): string {
  if (origen === 'compu') return 'Computadora'
  if (puenteAndroid()) return 'App Android'
  const ua = navigator.userAgent
  const so = /Android/i.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Otro'
  const nav = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'navegador'
  return `${so} · ${nav}`
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
  const [modeloVoz, setModeloVoz] = useState<InfoModeloVoz>({ estado: 'falta' })
  const [biblioteca, setBiblioteca] = useState<EstadoBiblioteca | null>(null)
  const [progresoAnalisis, setProgresoAnalisis] = useState<Record<string, { hechos: number; total: number }>>({})
  /** sube cada vez que el servidor avisa que cambio alguna cancion guardada (para refrescar listas) */
  const [versionProyectos, setVersionProyectos] = useState(0)
  /** cambia cuando cambia alguna lista del dia o carpeta (para recargar la pantalla de listas) */
  const [versionListas, setVersionListas] = useState(0)
  const [ajustarCompas, setAjustarCompasState] = useState<boolean>(() => leerPref('ajustar-compas', true))

  // preferencias de ESTE dispositivo
  const [sonidoLocal, setSonidoLocalState] = useState<boolean>(() => (origen === 'compu' ? leerPref('sonido-compu', false) : true))
  const [audioActivo, setAudioActivo] = useState(false)
  const [volumenGeneral, setVolumenGeneralState] = useState<number>(() => leerPref('volumen', 100))
  const [ajusteManualMs, setAjusteManualMsState] = useState<number>(() => leerPref('ajuste-fino-ms', 0))
  const [mezclaPersonal, setMezclaPersonalState] = useState<MezclaPersonal>(() => leerPref('mezcla-personal', {}))
  const [nombreDispositivo, setNombreDispositivoState] = useState<string>(() => leerPref('nombre', ''))

  /** la compu pide el codigo de la banda (n: cuantas veces, para reaccionar a cada rechazo) */
  const [pedidoCodigo, setPedidoCodigo] = useState<{ motivo: MotivoCodigo; n: number } | null>(null)
  /** celular: la compu ya tiene el maximo de celulares que permite la licencia (o la prueba) */
  const [pedidoLicencia, setPedidoLicencia] = useState<{ limite: number; prueba: boolean; n: number } | null>(null)
  /** compu: licencia de esta compu */
  const [licencia, setLicencia] = useState<EstadoLicencia | null>(null)

  const nombreRef = useRef(nombreDispositivo)
  nombreRef.current = nombreDispositivo
  // codigo de la banda: el del enlace de invitacion (#codigo=...) o el que ya funciono en este celular
  const codigoRef = useRef<string | null | undefined>(undefined)
  if (codigoRef.current === undefined) {
    codigoRef.current = origen === 'celular' ? (codigoDesdeDireccion() ?? leerPref<string | null>('codigo-banda', null)) : null
  }
  const socketRef = useRef<SocketClient | null>(null)
  if (!socketRef.current) {
    const deviceId = deviceIdPersistente()
    socketRef.current = new SocketClient(origen, () => ({
      token: window.electronAPI?.compuToken,
      deviceId,
      nombre: nombreRef.current || undefined,
      codigo: codigoRef.current ?? undefined
    }))
  }
  const engineRef = useRef<PlaybackEngine | null>(null)
  /** resincronizaciones duras de este dispositivo (diagnostico) */
  const resyncsRef = useRef(0)
  const reconocimientoRef = useRef<ReconocimientoGuia | null>(null)
  if (origen === 'compu' && !reconocimientoRef.current) {
    reconocimientoRef.current = new ReconocimientoGuia(socketRef.current!, () => estadoRef.current?.playbackActivo?.estado === 'playing')
  }
  const ajustarRef = useRef(ajustarCompas)
  ajustarRef.current = ajustarCompas
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
  const compases = (): number[] | null => estadoRef.current?.proyectoActivo?.tempo?.compasesMs ?? null

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
    if (engine.proyectoIdCargado !== proyecto.id || engine.revisionCargada !== (proyecto.revision ?? 0)) {
      engine.activarProyecto(proyecto, nuevo.playbackActivo ? posicionActualMs(nuevo.playbackActivo, now) : 0)
      if (nuevo.playbackActivo && estaSonando(nuevo.playbackActivo, now)) {
        reingresarEnSync(engine, socket, nuevo.playbackActivo, nuevo.activeTabId ?? '', margenReingreso, proyecto.tempo?.compasesMs)
      }
    } else {
      engine.aplicarMezcla(proyecto)
      engine.setCues(proyecto.marcadores.map((m) => m.tiempoMs))
      if (reconciliar) {
        const pb = nuevo.playbackActivo
        if (pb && estaSonando(pb, now)) {
          reingresarEnSync(engine, socket, pb, nuevo.activeTabId ?? '', margenReingreso, proyecto.tempo?.compasesMs)
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
    // la siguiente del setlist se va bajando de a poco: al pasar, arranca sin esperar la red.
    // (despues de activar: si la activada ES la que se venia precargando, primero se aprovecha)
    const iActiva = nuevo.tabs.findIndex((t) => t.tabId === nuevo.activeTabId)
    const siguiente = iActiva === -1 ? null : (nuevo.proyectos[iActiva + 1] ?? null)
    engine.precargar(siguiente, nuevo.tabs[iActiva + 1]?.posicionMs ?? 0)
  }, [])

  const crearEngine = useCallback((): PlaybackEngine => {
    // celulares: la mezcla la hace la compu (una pista estereo); la compu: pistas sueltas (faders al instante)
    const modoForzado = new URLSearchParams(window.location.search).get('modo')
    const engine = new StreamingEngine(modoForzado === 'pistas' || modoForzado === 'mezcla' ? modoForzado : origen === 'celular' ? 'mezcla' : 'pistas')
    const p = prefsRef.current
    engine.setVolumenGeneral(p.volumenGeneral)
    engine.setAjusteManualMs(p.ajusteManualMs)
    engine.setMezclaPersonal(origen === 'celular' ? p.mezclaPersonal : {})
    engine.onRequiereResync(() => {
      const socket = socketRef.current
      const actual = estadoRef.current
      const playback = actual?.playbackActivo
      if (!socket || !playback || !estaSonando(playback, socket.serverNow())) return
      resyncsRef.current++
      reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS, compases())
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

    // avisos que llegan en tanda (secciones detectadas en varias canciones): uno solo con el resumen
    const grupos = new Map<string, { textos: string[]; timer?: ReturnType<typeof setTimeout>; desde: number }>()
    function avisarAgrupado(a: { tipo: 'info' | 'error'; texto: string; grupo?: string }): void {
      if (!a.grupo) return avisar({ tipo: a.tipo, texto: a.texto }, 6000)
      const grupo = a.grupo
      const g = grupos.get(grupo) ?? { textos: [], desde: Date.now() }
      clearTimeout(g.timer)
      g.textos.push(a.texto)
      const vaciar = (): void => {
        grupos.delete(grupo)
        const n = g.textos.length
        const texto = n === 1 ? g.textos[0] : grupo === 'secciones' ? `Se detectaron las secciones de ${n} canciones por la voz guía` : `${n} avisos nuevos`
        avisar({ tipo: a.tipo, texto }, 6000)
      }
      // se espera a que la tanda se calme (como mucho 15 s desde el primero)
      g.timer = setTimeout(vaciar, Math.max(0, Math.min(3000, g.desde + 15000 - Date.now())))
      grupos.set(grupo, g)
    }

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
          engineRef.current.aplicarMezcla(nuevo.proyectoActivo)
        }
      }),
      socket.onRechazado((err) => avisar({ tipo: 'error', texto: err.mensaje })),
      socket.onDispositivos((lista) => setDispositivos(lista)),
      socket.onImportProgreso((p) => setImportProgreso(p.etapa === 'listo' ? null : p)),
      socket.on<InfoModeloVoz>('modelo:estado', (m) => {
        setModeloVoz(m)
        reconocimientoRef.current?.setModeloListo(m.estado === 'listo')
      }),
      socket.on<EstadoBiblioteca>('biblioteca:estado', (b) => setBiblioteca(b)),
      socket.on<PedidoVoz[]>('analisis:pedidos', (p) => reconocimientoRef.current?.setPedidos(p)),
      socket.on<{ proyectoId: string; hechos: number; total: number }>('analisis:progreso', (p) =>
        setProgresoAnalisis((prev) => ({ ...prev, [p.proyectoId]: { hechos: p.hechos, total: p.total } }))
      ),
      socket.on<{ tipo: 'info' | 'error'; texto: string; grupo?: string }>('aviso', (a) => avisarAgrupado(a)),
      socket.on('proyectos:cambio', () => setVersionProyectos((v) => v + 1)),
      socket.on('listas:cambio', () => setVersionListas((v) => v + 1)),
      socket.onCodigo((motivo) => setPedidoCodigo((prev) => ({ motivo, n: (prev?.n ?? 0) + 1 }))),
      socket.onLicencia((limite, prueba) => {
        setPedidoCodigo(null)
        setPedidoLicencia((prev) => ({ limite, prueba, n: (prev?.n ?? 0) + 1 }))
      }),
      socket.on<EstadoLicencia>('licencia:estado', (l) => setLicencia(l)),
      socket.onConexionCambia(async (c) => {
        setConectado(c)
        try {
          puenteAndroid()?.conexion?.(c)
        } catch {
          // la app no respondio
        }
        if (c) {
          setPedidoCodigo(null)
          setPedidoLicencia(null)
          if (origen === 'compu') void socket.emitAck<EstadoLicencia | null>('licencia:estado', {}, 5000).then(setLicencia, () => undefined)
          // el codigo funciono: queda guardado para la proxima
          if (codigoRef.current) guardarPref('codigo-banda', codigoRef.current)
          await socket.sincronizarReloj()
          aplicarEstado(await socket.pedirEstado(), true)
        }
      })
    ]
    return () => {
      offs.forEach((off) => off())
      for (const g of grupos.values()) clearTimeout(g.timer)
    }
  }, [avisar, sincronizarMotor])

  // celular sin lugar (licencia): se reintenta solo, por si alguien se desconecta
  useEffect(() => {
    if (!pedidoLicencia) return
    const t = setTimeout(() => socketRef.current?.reconectar(), 8000)
    return () => clearTimeout(t)
  }, [pedidoLicencia])

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
              resyncsRef.current++
              reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS, compases())
            } else if (abs >= UMBRAL_SUAVE_MS) {
              engine.corregirDriftSuave(drift)
            }
          }
        }
      }
      setDriftMs(drift)
      // cada 2 s: desfase, buffer y el diagnostico (WiFi, colchon, cortes) para la compu
      socket.emit('sync:report', { driftMs: drift, buffer, error, audio: true, diag: { ...engine.resumenDiagnostico(), resyncs: resyncsRef.current, plataforma: plataforma(origen) } })
      ultimoReporte = JSON.stringify({ d: drift === null ? null : Math.round(drift), buffer, error })
    }, INTERVALO_MONITOREO_MS)
    return () => clearInterval(id)
  }, [origen])

  // estado del buffer/errores: se revisa cada segundo (no cada 2s como el drift) para que el aviso
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
        reingresarEnSync(engine, socket, playback, actual?.activeTabId ?? '', MARGEN_RESYNC_DURO_MS, compases())
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
    if (proyecto) navigator.mediaSession.metadata = new MediaMetadata({ title: proyecto.nombre, artist: 'AirTracks Wireless Monitor' })
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
      /** Ir a un punto: sonando, a tiempo (proximo compas, al "1" mas cercano); con `inmediato`, ya. */
      seek(positionMs: number, inmediato = false): void {
        emit('transport:seek', { positionMs, inmediato })
      },
      /** Ir a una seccion (sonando: en el limite segun el modo de salto; `inmediato`: ya). */
      jumpToMarker(marcadorId: string, inmediato = false): void {
        const m = estadoRef.current?.proyectoActivo?.marcadores.find((x) => x.id === marcadorId)
        if (m) emit('seccion:saltar', { posicionMs: m.tiempoMs, inmediato })
      },
      /**
       * Seccion anterior/siguiente. Sonando, el servidor la hace en el limite
       * (al terminar la seccion o en el compas, segun el modo) y es relativa a
       * la que ya se habia elegido: dos veces "siguiente" saltea una.
       */
      saltarSeccion(delta: number, inmediato = false): void {
        emit('seccion:saltar', { relativo: delta, inmediato })
      },
      irASeccion(numero: number, inmediato = false): void {
        const lista = secciones().filter((s) => s.marcador)
        const s = lista[numero - 1]
        if (s) emit('seccion:saltar', { posicionMs: s.inicioMs, inmediato })
      },
      cancelarSalto(): void {
        emit('salto:cancelar')
      },
      setModoSalto(modo: ModoSalto): void {
        emit('salto:modo', { modo })
      },
      setLoop(activo: boolean): void {
        emit('loop:set', { activo })
      },

      // ---- marcadores (con "ajustar al compas" si hay tempo detectado) ----
      createMarker(tiempoMs: number, nombre?: string): void {
        const compases = estadoRef.current?.proyectoActivo?.tempo?.compasesMs
        emit('marker:create', { tiempoMs: ajustarRef.current ? ajustarACompas(compases, tiempoMs) : tiempoMs, nombre })
      },
      updateMarker(marcadorId: string, patch: Partial<Pick<Marcador, 'nombre' | 'tiempoMs' | 'color'>>, sinAjustar = false): void {
        const compases = estadoRef.current?.proyectoActivo?.tempo?.compasesMs
        const p = { ...patch }
        if (p.tiempoMs !== undefined && ajustarRef.current && !sinAjustar) p.tiempoMs = ajustarACompas(compases, p.tiempoMs)
        emit('marker:update', { marcadorId, patch: p })
      },
      setAjustarCompas(v: boolean): void {
        setAjustarCompasState(v)
        guardarPref('ajustar-compas', v)
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
          const { rol, ...resto } = patch
          const cambiada: Pista = { ...pista, ...resto }
          if (rol === null) delete cambiada.rol
          else if (rol) cambiada.rol = rol
          const nuevo = conPistaActualizada(actual, { proyectoId: proyecto.id, pista: cambiada })
          estadoRef.current = nuevo
          setEstado(nuevo)
          if (engineRef.current?.proyectoIdCargado === proyecto.id) engineRef.current.aplicarMezcla(nuevo.proyectoActivo!)
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

      // ---- canciones guardadas ----
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

      // ---- listas por dia y carpetas (compu) ----
      async obtenerListas(): Promise<DatosListas | null> {
        return socket.emitAck('listas:obtener', {})
      },
      async crearLista(datos: {
        nombre: string
        carpeta?: string
        fecha?: string | null
        proyectos?: string[]
        desdeActual?: boolean
      }): Promise<{ ok: boolean; error?: string; id?: string }> {
        return socket.emitAck('listas:crear', datos)
      },
      async guardarLista(datos: {
        id: string
        nombre?: string
        carpeta?: string
        fecha?: string | null
        proyectos?: string[]
      }): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck('listas:guardar', datos, 5 * 60 * 1000)
      },
      async duplicarLista(id: string): Promise<{ ok: boolean; id?: string }> {
        return socket.emitAck('listas:duplicar', { id })
      },
      async borrarLista(id: string): Promise<{ ok: boolean }> {
        return socket.emitAck('listas:borrar', { id })
      },
      /** carga la lista en la barra de arriba (reemplaza lo que habia) */
      async usarLista(id: string): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck('listas:usar', { id }, 5 * 60 * 1000)
      },
      async seguirSesion(): Promise<{ ok: boolean }> {
        return socket.emitAck('sesion:seguir', {}, 5 * 60 * 1000)
      },
      async crearCarpeta(nombre: string): Promise<{ ok: boolean; nombre?: string; error?: string }> {
        return socket.emitAck('carpetas:crear', { nombre })
      },
      async renombrarCarpeta(de: string, a: string): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck('carpetas:renombrar', { de, a })
      },
      async borrarCarpeta(nombre: string): Promise<{ ok: boolean }> {
        return socket.emitAck('carpetas:borrar', { nombre })
      },

      // ---- dispositivos ----
      forgetDevice(id: string): void {
        emit('devices:forget', { id })
      },

      // ---- diagnostico ----
      /** lo que mide este dispositivo ahora (null = el audio no esta activado) */
      diagnosticoLocal(): DiagnosticoDispositivo | null {
        const engine = engineRef.current
        return engine ? { ...engine.resumenDiagnostico(), resyncs: resyncsRef.current, plataforma: plataforma(origen) } : null
      },
      /** compu: todo junto para "Copiar diagnostico" */
      async diagnosticoServidor(): Promise<DiagnosticoServidor | null> {
        return socket.emitAck<DiagnosticoServidor | null>('diagnostico:obtener', {}, 5000)
      },

      // ---- licencia (compu) ----
      async activarLicencia(texto: string): Promise<{ ok: boolean; error?: string }> {
        const r = await socket.emitAck<{ ok: boolean; error?: string; estado?: EstadoLicencia }>('licencia:activar', { texto }, 5000)
        if (r.estado) setLicencia(r.estado)
        return r
      },
      async quitarLicencia(): Promise<void> {
        const r = await socket.emitAck<{ ok: boolean; estado?: EstadoLicencia }>('licencia:quitar', {}, 5000)
        if (r.estado) setLicencia(r.estado)
      },
      /** celular: "Probar de nuevo" (sin lugar por la licencia, o la compu no respondio) */
      reintentarConexion(): void {
        socket.reconectar()
      },

      // ---- conexion: codigo de la banda, invitar, ajustes (compu) ----
      enviarCodigo(codigo: string): void {
        codigoRef.current = codigo.replace(/\D/g, '')
        socket.reconectar()
      },
      async datosInvitacion(): Promise<DatosInvitacion> {
        return socket.emitAck<DatosInvitacion>('invitacion:datos', {}, 5000)
      },
      async ajustesConexion(): Promise<AjustesConexion | null> {
        return socket.emitAck<AjustesConexion | null>('ajustes:obtener', {}, 5000)
      },
      async setCodigoBanda(codigo: string | null): Promise<{ ok: boolean; error?: string; ajustes?: AjustesConexion }> {
        return socket.emitAck('ajustes:codigo', { codigo }, 5000)
      },
      async setWifiInvitacion(wifi: { ssid: string; clave: string } | null): Promise<{ ok: boolean; ajustes?: AjustesConexion }> {
        return socket.emitAck('ajustes:wifi', wifi, 5000)
      },

      // ---- analisis automatico / modelo de voz / biblioteca ----
      detectarSecciones(proyectoId: string): void {
        emit('analisis:detectar', { proyectoId })
      },
      descargarModeloVoz(): void {
        emit('modelo:descargar')
      },
      async elegirCarpetaBiblioteca(): Promise<{ ok: boolean; error?: string }> {
        const ruta = await window.electronAPI?.elegirCarpeta?.()
        if (!ruta) return { ok: false }
        return socket.emitAck('biblioteca:ruta', { ruta })
      },
      abrirCarpetaBiblioteca(ruta: string): void {
        void window.electronAPI?.abrirCarpeta?.(ruta)
      },
      escanearBiblioteca(): void {
        emit('biblioteca:escanear')
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
    pedidoCodigo,
    pedidoLicencia,
    licencia,
    estado,
    secciones,
    siguienteProyecto,
    dispositivos,
    avisos,
    importProgreso,
    modeloVoz,
    biblioteca,
    progresoAnalisis,
    versionProyectos,
    versionListas,
    ajustarCompas,
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
