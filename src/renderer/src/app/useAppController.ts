import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AvisoFundido,
  AjustesColchon,
  AnuncioSalto,
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
  MarcadorActualizarPayload,
  ModoSalto,
  MixerActualizadoPayload,
  MotivoCodigo,
  OrigenCliente,
  PatchPista,
  Pista,
  PlaybackState,
  Proyecto,
  ProyectoResumen,
  DatosListas,
  EstadoFirewall,
  ProgresoTono,
  RolDispositivo,
  SalidaSonido
} from '@shared/types'
import { ROLES } from '@shared/types'
import { calcularSecciones, estaSonando, largoTipicoDeCompas, posicionActualMs, seccionEn, tramoVigente } from '@shared/playback'
import { golpeActual } from '@shared/cuenta'
import { compasYPulso } from '@shared/colchon'
import { SocketClient } from '../sync/SocketClient'
import { StreamingEngine } from '../audio/StreamingEngine'
import type { CurvaFundido, MezclaPersonal, PlaybackEngine } from '../audio/PlaybackEngine'
import { INTERVALO_MONITOREO_MS, MARGEN_RESYNC_DURO_MS, UMBRAL_DURO_MS, UMBRAL_SUAVE_MS, UMBRAL_SUAVE_PRECISO_MS } from '../sync/driftConfig'
import { setPlayheadMs, getPlayheadMs, setGolpeCuenta, setGolpeColchon } from './playheadStore'
import { deviceIdPersistente, guardarPref, leerPref } from './preferencias'
import { ReconocimientoGuia } from '../analisis/reconocimientoGuia'
import { EmisorTalkback, type OpcionesEntrada, type PedazoTalkback } from '../audio/talkback'
import { codigoDesdeDireccion, puenteAndroid } from '../conexion'

/** Compas mas cercano (si esta a menos de medio compas): "ajustar al compas". */
export function ajustarACompas(compasesMs: number[] | undefined, ms: number): number {
  if (!compasesMs || compasesMs.length < 2) return ms
  let mejor = 0
  let dist = Infinity
  compasesMs.forEach((c, i) => {
    const d = Math.abs(c - ms)
    if (d < dist) {
      dist = d
      mejor = i
    }
  })
  // (el compas de ahi: la cancion puede cambiar de tempo)
  const medioCompas = largoTipicoDeCompas(compasesMs, Math.min(mejor, compasesMs.length - 2)) / 2
  return dist <= medioCompas ? compasesMs[mejor] : ms
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
  // la musica todavia no empezo (se esta contando, o esta por arrancar): se entra justo cuando empieza
  const porEmpezar = playback.estado === 'playing' && playback.referenceServerTime > executeAt && tramoVigente(playback, executeAt) === playback
  if (porEmpezar) {
    executeAt = playback.referenceServerTime
    posicion = playback.positionMs
  }
  const proximo = compasesMs && !porEmpezar ? proximoCompas(compasesMs, posicion) : null
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

const esRolValido = (r: unknown): r is RolDispositivo => typeof r === 'string' && (ROLES as string[]).includes(r)

function salidaValida(s: unknown): SalidaSonido {
  const x = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  return { click: x.click === true, guia: x.guia === true }
}

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
  /** pistas ya preparadas del tono que se esta preparando, por cancion */
  const [progresoTono, setProgresoTono] = useState<Record<string, ProgresoTono>>({})
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
  // para que usa la app ESTE celular (director, musico, voz, sonido, multimedia): manda lo que dice la
  // compu (se puede cambiar desde alla); sin conexion, lo guardado aca. null = todavia no eligio
  const [rol, setRolState] = useState<RolDispositivo | null>(() => {
    const r = origen === 'celular' ? leerPref<unknown>('rol', null) : null
    return esRolValido(r) ? r : null
  })
  const [salidaSonido, setSalidaSonidoState] = useState<SalidaSonido>(() => salidaValida(leerPref('salida-sonido', null)))
  /** multimedia: escuchar el audio en este celular (por defecto no: solo mira) */
  const [escucharMultimedia, setEscucharMultimediaState] = useState<boolean>(() => leerPref('escuchar-multimedia', false))
  /** el rol se cambio aca sin que la compu lo confirmara (sin conexion): al conectar manda el de aca */
  const rolPendienteRef = useRef<boolean>(leerPref('rol-pendiente', false))
  const rolRef = useRef({ rol, salida: salidaSonido })
  rolRef.current = { rol, salida: salidaSonido }
  /** hasta cuando manda la "salida" cambiada aca (la lista de la compu que llega mientras tanto puede ser de antes) */
  const salidaLocalHastaRef = useRef(0)
  /** el ajuste fino (lo puede cambiar la compu) */
  const ajusteFinoRef = useRef<((ms: number) => void) | null>(null)
  // talkback (ver audio/talkback.ts). Celular: si esta sonando ahora y si ya llego alguna vez (para mostrar su volumen)
  const [talkbackSonando, setTalkbackSonando] = useState(false)
  const [talkbackRecibido, setTalkbackRecibido] = useState(false)
  /** la compu esta hablando (el aviso en pantalla no parpadea entre palabra y palabra) */
  const [talkbackHablando, setTalkbackHablando] = useState(false)
  // compu: de donde sale la voz (microfono o interface, que entrada, si se mejora) y si se esta hablando
  const [talkback, setTalkback] = useState<{
    hablando: boolean
    error: string | null
    entrada: string | null
    /** que entrada de la interface (0 = la 1…); null = todas juntas */
    canal: number | null
    procesar: boolean
    /** cuantas entradas tiene lo abierto (una interface: 2 o mas; 0 = todavia cerrado) */
    canales: number
  }>(() => ({
    hablando: false,
    error: null,
    entrada: origen === 'compu' ? leerPref<string | null>('talkback-entrada', null) : null,
    canal: origen === 'compu' ? leerPref<number | null>('talkback-canal', null) : null,
    procesar: leerPref<boolean>('talkback-procesar', true),
    canales: 0
  }))
  const talkbackRef = useRef<EmisorTalkback | null>(null)
  const nivelTalkbackRef = useRef(0)

  /** la compu pide el codigo de la banda (n: cuantas veces, para reaccionar a cada rechazo) */
  const [pedidoCodigo, setPedidoCodigo] = useState<{ motivo: MotivoCodigo; n: number } | null>(null)
  /** celular: la compu ya tiene el maximo de celulares que permite la licencia (o la prueba) */
  const [pedidoLicencia, setPedidoLicencia] = useState<{ limite: number; prueba: boolean; n: number } | null>(null)
  /** compu: licencia de esta compu */
  const [licencia, setLicencia] = useState<EstadoLicencia | null>(null)
  /** compu (Windows): si el firewall deja que los celulares encuentren la compu en esta red */
  const [firewall, setFirewall] = useState<EstadoFirewall | null>(null)

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
      codigo: codigoRef.current ?? undefined,
      rol: rolRef.current.rol ?? undefined,
      salida: rolRef.current.rol === 'sonido' ? rolRef.current.salida : undefined,
      rolPendiente: rolPendienteRef.current || undefined
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
  // voz que avisa el salto elegido (ver actualizarAnuncio) y la ultima orden de transporte
  const anuncioRef = useRef<{ anuncio: AnuncioSalto; destinoMs: number; tSalto: number } | null>(null)
  const soltarAnuncioRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ultimoComandoRef = useRef<ComandoProgramado | null>(null)
  // "Terminar con fundido": la curva que tiene el motor (de que cancion, y si ya se sabe cuando vuelve el volumen)
  const fundidoRef = useRef<(CurvaFundido & { tabId: string }) | null>(null)
  estadoRef.current = estado
  const prefsRef = useRef({ volumenGeneral, ajusteManualMs, mezclaPersonal })
  prefsRef.current = { volumenGeneral, ajusteManualMs, mezclaPersonal }

  // la fila de este celular en "Dispositivos": su rol lo puede cambiar la compu
  const miFila = useMemo(() => (origen === 'celular' ? (dispositivos.find((d) => d.id === `celular:${deviceIdPersistente()}`) ?? null) : null), [dispositivos, origen])
  useEffect(() => {
    if (!miFila || !miFila.conectado) return
    const mismaSalida = !miFila.salida || (miFila.salida.click === salidaSonido.click && miFila.salida.guia === salidaSonido.guia)
    if (miFila.rol === rol && rolPendienteRef.current) {
      rolPendienteRef.current = false
      guardarPref('rol-pendiente', false)
    }
    if (mismaSalida) salidaLocalHastaRef.current = 0
    // lo que se cambio aca y todavia no llego a la compu: se espera; si no, manda la compu
    if (miFila.rol !== rol && !rolPendienteRef.current && esRolValido(miFila.rol)) {
      setRolState(miFila.rol)
      guardarPref('rol', miFila.rol)
    }
    if (!mismaSalida && miFila.salida && Date.now() > salidaLocalHastaRef.current) {
      setSalidaSonidoState(miFila.salida)
      guardarPref('salida-sonido', miFila.salida)
    }
  }, [miFila, rol, salidaSonido])

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

  // compu (Windows): el firewall bloquea a los celulares en esta red? (se revisa al abrir y al cambiar de WiFi)
  useEffect(() => {
    const api = window.electronAPI?.firewall
    if (!api) return
    let anterior: EstadoFirewall['estado'] | null = null
    const recibir = (e: EstadoFirewall | null): void => {
      if (!e) return
      setFirewall(e)
      if (e.estado === 'bloqueado' && anterior !== 'bloqueado') {
        const red = e.bloqueadas[0]
        avisar(
          {
            tipo: 'error',
            texto: `Los celulares no van a encontrar la compu: Windows bloquea AirTracks en esta red${red ? ` (“${red.nombre}”)` : ''}. Abrí “Celulares” para permitirlo.`
          },
          15000
        )
      }
      anterior = e.estado
    }
    void api.estado().then(recibir, () => undefined)
    return api.alCambiar(recibir)
  }, [avisar])

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
    const sonido = rolRef.current.rol === 'sonido'
    // la consola: la banda sola al centro, a volumen fijo (lo fino se hace en la consola)
    engine.setVolumenGeneral(sonido ? 100 : p.volumenGeneral)
    engine.setAjusteManualMs(p.ajusteManualMs)
    engine.setMezclaPersonal(origen === 'celular' ? p.mezclaPersonal : {})
    engine.setSalidaSonido(sonido ? rolRef.current.salida : null)
    // (se activo el audio con la cancion apagandose: entra con la curva)
    if (fundidoRef.current && socketRef.current) engine.setFundido(fundidoRef.current, socketRef.current.clockOffsetMs)
    engine.onTalkback((v) => {
      setTalkbackSonando(v)
      if (v) setTalkbackRecibido(true)
    })
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
    if (!engineRef.current) {
      engineRef.current = crearEngine()
      engineRef.current.setAnuncio(anuncioRef.current?.anuncio ?? null)
      const socket = socketRef.current!
      engineRef.current.setColchon(estadoRef.current?.colchon ?? null, () => socket.clockOffsetMs)
    }
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

  // multimedia: sin audio (salvo que lo pida): no baja nada por el WiFi
  useEffect(() => {
    if (origen !== 'celular' || rol !== 'multimedia' || escucharMultimedia || !engineRef.current) return
    apagarAudio()
    setAudioActivo(false)
  }, [rol, escucharMultimedia, origen, apagarAudio])

  // el rol cambia lo que suena: la consola (banda sola, al centro, volumen fijo) o un celular comun
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || origen !== 'celular') return
    const sonido = rol === 'sonido'
    engine.setSalidaSonido(sonido ? salidaSonido : null)
    engine.setVolumenGeneral(sonido ? 100 : volumenGeneral)
  }, [rol, salidaSonido, volumenGeneral, origen])

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
      actualizarAnuncio(nuevo)
      actualizarFundido(nuevo)
      engineRef.current?.setColchon(nuevo.colchon ?? null, () => socket.clockOffsetMs)
    }

    /** La curva de "Terminar con fundido" en el motor (el aviso ya la puso; esto cubre al que entra o se reconecta a mitad). */
    function ponerFundido(f: (CurvaFundido & { tabId: string }) | null): void {
      fundidoRef.current = f
      engineRef.current?.setFundido(f, socket.clockOffsetMs)
    }
    function actualizarFundido(nuevo: EstadoCompleto): void {
      const actual = fundidoRef.current
      const f = nuevo.fundido ?? null
      if (actual && actual.tabId !== nuevo.activeTabId) return ponerFundido(null)
      if (f && nuevo.activeTabId && (!actual || actual.desde !== f.desde)) return ponerFundido({ ...f, tabId: nuevo.activeTabId })
      // ya no se apaga y no llego la orden que lo cierra (p.ej. se perdio el aviso de que se cancelo): vuelve el volumen
      if (!f && actual && actual.vuelve === undefined) ponerFundido({ ...actual, vuelve: socket.serverNow() + 100, suave: true })
    }

    /**
     * La voz que avisa el salto elegido. Cuando el salto se hace, el servidor
     * lo saca de "pendiente" con la orden del salto (un momento ANTES de que
     * suene): la voz tiene que seguir hasta el salto. Si se cancelo, se corta.
     */
    function actualizarAnuncio(nuevo: EstadoCompleto): void {
      const s = nuevo.saltoPendiente
      const previo = anuncioRef.current
      if (s?.anuncio) {
        clearTimeout(soltarAnuncioRef.current)
        anuncioRef.current = { anuncio: s.anuncio, destinoMs: s.destinoMs, tSalto: s.tSalto }
        engineRef.current?.setAnuncio(s.anuncio)
        return
      }
      if (!previo) return
      anuncioRef.current = null
      const cmd = ultimoComandoRef.current
      const hecho = cmd?.accion === 'play' && cmd.positionMs === previo.destinoMs && Math.abs(cmd.executeAtServerTime - previo.tSalto) < 250
      if (!hecho) {
        engineRef.current?.setAnuncio(null)
        return
      }
      clearTimeout(soltarAnuncioRef.current)
      soltarAnuncioRef.current = setTimeout(() => {
        if (!anuncioRef.current) engineRef.current?.setAnuncio(null)
      }, Math.max(0, previo.tSalto - socket.serverNow()) + 500)
    }

    const offs = [
      socket.onEstado((nuevo) => aplicarEstado(nuevo)),
      // la compu mide cuanto tardan en llegar sus ordenes (ver server/entrega.ts)
      socket.on<{ t: number }>('sync:ping', (p) => socket.emit('sync:pong', { t: p.t })),
      socket.onPlaybackScheduled((cmd: ComandoProgramado) => {
        ultimoComandoRef.current = cmd
        // llego sin tiempo para programarla: la compu vuelve a esperar mas antes de cada orden
        if (origen === 'celular' && cmd.accion !== 'stop' && cmd.accion !== 'seek' && cmd.executeAtServerTime - socket.serverNow() < 60) socket.emit('sync:tarde', {})
        const actual = estadoRef.current
        // apagandose con "Terminar": la curva sigue hasta esta orden (el stop del final, una pausa, otra seccion) y ahi vuelve el volumen
        const f = fundidoRef.current
        if (f && f.tabId === cmd.tabId && f.vuelve === undefined && cmd.accion !== 'seek') {
          ponerFundido({ ...f, vuelve: cmd.executeAtServerTime + (cmd.accion === 'play' ? 0 : 60) })
        }
        if (actual && actual.activeTabId === cmd.tabId) {
          engineRef.current?.ejecutar(cmd, socket.clockOffsetMs)
          const nuevo = { ...actual, playbackActivo: cmd.playback, fundido: null }
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
      // la compu cambio el ajuste fino de este celular (p.ej. el de la consola)
      socket.on<{ ms: number }>('ajuste:fino', (p) => {
        if (typeof p?.ms === 'number') ajusteFinoRef.current?.(p.ms)
      }),
      // talkback: la compu le habla a la banda (20 ms por mensaje)
      socket.on<PedazoTalkback>('talkback:audio', (p) => engineRef.current?.recibirTalkback(p, socket.clockOffsetMs)),
      socket.on<{ hablando: boolean }>('talkback:estado', (p) => {
        setTalkbackHablando(!!p?.hablando)
        if (p?.hablando) setTalkbackRecibido(true)
      }),
      // "Terminar con fundido": empieza a apagarse (o se cancelo a mitad y vuelve)
      socket.on<AvisoFundido>('transport:fundido', (p) => {
        const actual = estadoRef.current
        if (!p || !actual || p.tabId !== actual.activeTabId || typeof p.desde !== 'number' || typeof p.ms !== 'number') return
        ponerFundido({ tabId: p.tabId, desde: p.desde, ms: p.ms, ...(typeof p.vuelve === 'number' ? { vuelve: p.vuelve, suave: true } : {}) })
        const nuevo = { ...actual, saltoPendiente: null, fundido: typeof p.vuelve === 'number' ? null : { desde: p.desde, ms: p.ms } }
        estadoRef.current = nuevo
        setEstado(nuevo)
      }),
      // "Probar el sync": un click en todos a la vez
      socket.on<{ golpes: { t: number; n: number }[] }>('sync:prueba', (p) => {
        if (Array.isArray(p?.golpes)) engineRef.current?.probarSync(p.golpes, socket.clockOffsetMs)
      }),
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
      socket.on<ProgresoTono>('tono:progreso', (p) =>
        setProgresoTono((prev) => {
          const r = { ...prev }
          if (p.total > 0) r[p.proyectoId] = p
          else delete r[p.proyectoId]
          return r
        })
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
          if (origen === 'compu')
            void socket.emitAck<ProgresoTono[]>('tono:preparando', {}, 5000).then(
              (l) => setProgresoTono(Object.fromEntries(l.map((p) => [p.proyectoId, p]))),
              () => undefined
            )
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
          socket.emit('sync:report', { driftMs: null, buffer: null, error: null, audio: false, ajusteMs: prefsRef.current.ajusteManualMs })
          ultimoReporte = 'sin-audio'
        }
        return
      }
      const actual = estadoRef.current
      const playback = actual?.playbackActivo
      // si la hora del sistema salto recien, primero se compensa (sino pareceria un desfase del audio)
      socket.revisarReloj()
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
            } else if (abs >= (engine.relojPreciso() ? UMBRAL_SUAVE_PRECISO_MS : UMBRAL_SUAVE_MS)) {
              engine.corregirDriftSuave(drift)
            }
          }
        }
      }
      setDriftMs(drift)
      // cada 2 s: desfase, buffer y el diagnostico (WiFi, colchon, cortes) para la compu
      socket.emit('sync:report', {
        driftMs: drift,
        buffer,
        error,
        audio: true,
        ajusteMs: prefsRef.current.ajusteManualMs,
        diag: {
          ...engine.resumenDiagnostico(),
          resyncs: resyncsRef.current,
          plataforma: plataforma(origen),
          talkback: engine.esperaTalkback.medicion().redMs !== null ? engine.esperaTalkback.medicion() : null
        }
      })
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
      const ahora = socket?.serverNow() ?? 0
      setPlayheadMs(socket && playback ? posicionActualMs(playback, ahora) : 0)
      setGolpeCuenta(playback?.estado === 'playing' ? golpeActual(playback.cuenta, ahora) : 0)
      const col = estadoRef.current?.colchon
      if (col && ahora >= col.empezo && (col.hasta === null || ahora < col.hasta)) {
        // (recien cambiado el BPM, hasta el primer "1" del pulso nuevo queda lo ultimo)
        const { compas, pulso } = compasYPulso(col, ahora)
        if (compas > 0) setGolpeColchon(compas * 100 + pulso)
      } else setGolpeColchon(0)
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

    /** De donde y como se toma la voz del talkback (lo elegido en ⚙ Ajustes → Talkback). */
    function opcionesTalkback(): OpcionesEntrada {
      return {
        entrada: leerPref<string | null>('talkback-entrada', null),
        canal: leerPref<number | null>('talkback-canal', null),
        procesar: leerPref<boolean>('talkback-procesar', true)
      }
    }
    /** Si el microfono ya estaba abierto, lo vuelve a abrir con lo elegido (sin dejar de hablar). */
    function reabrirTalkback(): void {
      const emisor = talkbackRef.current
      if (!emisor?.abierto()) return
      emisor.abrir(opcionesTalkback()).then(
        () => setTalkback((t) => ({ ...t, canales: emisor.canales() })),
        () => setTalkback((t) => ({ ...t, canales: 0, error: 'No se pudo abrir esa entrada' }))
      )
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
        prefsRef.current = { ...prefsRef.current, ajusteManualMs: clamped }
        // que la compu lo vea ya (no en el proximo reporte)
        emit('sync:report', { ajusteMs: clamped })
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
      // ---- rol de este celular ----
      elegirRol(nuevo: RolDispositivo): void {
        setRolState(nuevo)
        guardarPref('rol', nuevo)
        rolPendienteRef.current = true
        guardarPref('rol-pendiente', true)
        rolRef.current = { ...rolRef.current, rol: nuevo }
        if (!socket.conectado) return
        socket
          .emitAck<{ ok: boolean }>('rol:elegir', { rol: nuevo, salida: nuevo === 'sonido' ? rolRef.current.salida : undefined })
          .then((r) => {
            if (!r?.ok) return
            rolPendienteRef.current = false
            guardarPref('rol-pendiente', false)
          })
          .catch(() => {
            // se manda al reconectar (queda pendiente)
          })
      },
      /** El celular de Sonido: que mas va a la consola (guia, click), ademas de la banda. */
      setSalidaSonido(cambio: Partial<SalidaSonido>): void {
        const nueva = { ...rolRef.current.salida, ...cambio }
        salidaLocalHastaRef.current = Date.now() + 3000
        setSalidaSonidoState(nueva)
        guardarPref('salida-sonido', nueva)
        rolRef.current = { ...rolRef.current, salida: nueva }
        emit('sonido:salida', cambio)
      },
      /** Pico de lo que sale por cada lado (vumetro de la consola); null = sin audio. */
      nivelSalida(): { izq: number; der: number } | null {
        return engineRef.current?.nivelSalida() ?? null
      },
      setEscucharMultimedia(v: boolean): void {
        setEscucharMultimediaState(v)
        guardarPref('escuchar-multimedia', v)
      },
      /** Compu: cambiarle el rol a un celular (p.ej. elegir cual va a la consola). */
      setRolDe(id: string, nuevo: RolDispositivo): Promise<{ ok: boolean }> {
        return socket.emitAck<{ ok: boolean }>('dispositivo:rol', { id, rol: nuevo }).catch(() => ({ ok: false }))
      },
      /** Compu: que mas va a la consola por un celular de Sonido. */
      setSalidaDe(id: string, cambio: Partial<SalidaSonido>): void {
        emit('sonido:salida', { id, ...cambio })
      },
      /** Compu: el ajuste fino de sincronizacion de un celular (ms; + = que suene despues). */
      setAjusteDe(id: string, ms: number): Promise<{ ok: boolean }> {
        return socket.emitAck<{ ok: boolean }>('dispositivo:ajuste', { id, ms }).catch(() => ({ ok: false }))
      },
      /**
       * Compu: talkback. true = empieza a hablar (la primera vez pide el
       * microfono), false = deja de hablar. Lo escuchan los oidos de la banda
       * (no la consola ni multimedia).
       */
      async hablarTalkback(si: boolean): Promise<void> {
        let emisor = talkbackRef.current
        if (!emisor) {
          emisor = new EmisorTalkback(
            (p) => socket.socket.volatile.emit('talkback:audio', p),
            () => socket.serverNow()
          )
          emisor.onNivel = (v) => {
            nivelTalkbackRef.current = v
          }
          talkbackRef.current = emisor
        }
        if (!si) {
          emisor.hablando = false
          emit('talkback:hablando', { hablando: false })
          setTalkback((t) => ({ ...t, hablando: false }))
          return
        }
        setTalkback((t) => ({ ...t, hablando: true, error: null }))
        try {
          await emisor.abrir(opcionesTalkback())
          setTalkback((t) => ({ ...t, canales: emisor!.canales() }))
        } catch (e) {
          const nombre = (e as { name?: string })?.name
          setTalkback((t) => ({
            ...t,
            hablando: false,
            error: nombre === 'NotAllowedError' ? 'Windows no dejó usar el micrófono' : nombre === 'NotFoundError' || nombre === 'OverconstrainedError' ? 'No se encontró esa entrada de audio' : 'No se pudo abrir el micrófono'
          }))
          return
        }
        emisor.hablando = true
        emit('talkback:hablando', { hablando: true })
      },
      /** Compu: lo que entra por el microfono del talkback (0 a 1), para el vumetro. */
      nivelTalkback(): number {
        return nivelTalkbackRef.current
      },
      /** Compu: las entradas de audio para el talkback. */
      entradasTalkback(): Promise<{ id: string; nombre: string }[]> {
        return EmisorTalkback.entradas().catch(() => [])
      },
      /** Compu: elegir el microfono o la interface del talkback (null = el de Windows); si ya estaba abierta, se cambia. */
      setEntradaTalkback(id: string | null): void {
        guardarPref('talkback-entrada', id)
        // otro aparato: sus entradas son otras (se empieza por "todas")
        guardarPref('talkback-canal', null)
        setTalkback((t) => ({ ...t, entrada: id, canal: null, error: null }))
        reabrirTalkback()
      },
      /**
       * Compu: que entrada de la interface (0 = la 1…; null = todas juntas).
       * Una entrada elegida va directa: "Mejorar la voz" se apaga (con el
       * navegador mejorando la voz, las entradas ya llegan mezcladas).
       */
      setCanalTalkback(canal: number | null): void {
        guardarPref('talkback-canal', canal)
        if (canal !== null) guardarPref('talkback-procesar', false)
        setTalkback((t) => ({ ...t, canal, procesar: canal !== null ? false : t.procesar, error: null }))
        reabrirTalkback()
      },
      /** Compu: "Mejorar la voz" (menos ruido, volumen parejo); apagado = la senal tal cual (interface, consola). Prendido, todas las entradas juntas. */
      setProcesarTalkback(procesar: boolean): void {
        guardarPref('talkback-procesar', procesar)
        if (procesar) guardarPref('talkback-canal', null)
        setTalkback((t) => ({ ...t, procesar, canal: procesar ? null : t.canal, error: null }))
        reabrirTalkback()
      },
      /** Compu: abrir la entrada sin hablar (para ver el nivel en el vumetro). */
      async probarEntradaTalkback(): Promise<boolean> {
        if (!talkbackRef.current) {
          const emisor = new EmisorTalkback(
            (p) => socket.socket.volatile.emit('talkback:audio', p),
            () => socket.serverNow()
          )
          emisor.onNivel = (v) => {
            nivelTalkbackRef.current = v
          }
          talkbackRef.current = emisor
        }
        try {
          await talkbackRef.current.abrir(opcionesTalkback())
          setTalkback((t) => ({ ...t, canales: talkbackRef.current?.canales() ?? 0 }))
          return true
        } catch {
          setTalkback((t) => ({ ...t, error: 'No se pudo abrir el micrófono' }))
          return false
        }
      },

      /** Compu: un click en todos los dispositivos a la vez, para escuchar si suenan juntos (con la musica parada). */
      probarSync(): Promise<{ ok: boolean; error?: string }> {
        return socket.emitAck<{ ok: boolean; error?: string }>('sync:prueba', {}).catch(() => ({ ok: false }))
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
        const e = estadoRef.current
        const pb = e?.playbackActivo
        // un colchon de la lista no "suena" como cancion: play lo empieza y pausa lo termina
        const colchonAca = !!e?.proyectoActivo?.colchon && e.colchon?.tabId === e.activeTabId && e.colchon.hasta === null
        if (pb?.estado === 'playing' || colchonAca) emit('transport:pause')
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
      /** Ir a la seccion que empieza en `inicioMs` (la de "Inicio", que no tiene marca, tambien). */
      irASeccionEn(inicioMs: number, inmediato = false): void {
        emit('seccion:saltar', { posicionMs: inicioMs, inmediato })
      },
      saltarSeccion(delta: number, inmediato = false): void {
        emit('seccion:saltar', { relativo: delta, inmediato })
      },
      irASeccion(numero: number, inmediato = false): void {
        const lista = secciones().filter((s) => s.marcador)
        const s = lista[numero - 1]
        if (s) emit('seccion:saltar', { posicionMs: s.inicioMs, inmediato })
      },
      /** Cancela el salto elegido (o "Terminar": antes de que empiece, o a mitad del fundido, y la musica vuelve). */
      cancelarSalto(): void {
        emit('salto:cancelar')
      },
      setModoSalto(modo: ModoSalto): void {
        emit('salto:modo', { modo })
      },
      /**
       * "Terminar con fundido": al terminar la seccion (o en el compas, o ya,
       * segun el modo de salto) la cancion se apaga en todos y para. Otra vez
       * (o Esc) lo cancela.
       */
      async terminar(): Promise<void> {
        const e = estadoRef.current
        if (e?.saltoPendiente?.fin || e?.fundido) return void emit('salto:cancelar')
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string }>('transport:terminar', {}, 5000)
          if (!r.ok && r.error) avisar({ tipo: 'error', texto: r.error })
        } catch {
          avisar({ tipo: 'error', texto: 'No se pudo terminar la canción (sin conexión con la compu)' })
        }
      },
      /** Cuanto tarda en apagarse con "Terminar" (la compu). */
      setDuracionFundido(ms: number): void {
        emit('fundido:duracion', { ms })
      },
      setLoop(activo: boolean): void {
        emit('loop:set', { activo })
      },

      // ---- marcadores (con "ajustar al compas" si hay tempo detectado) ----
      createMarker(tiempoMs: number, nombre?: string): void {
        const compases = estadoRef.current?.proyectoActivo?.tempo?.compasesMs
        emit('marker:create', { tiempoMs: ajustarRef.current ? ajustarACompas(compases, tiempoMs) : tiempoMs, nombre })
      },
      updateMarker(marcadorId: string, patch: MarcadorActualizarPayload['patch'], sinAjustar = false): void {
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
      /** Pasa la cancion a otro tono (semitonos respecto del original): la compu prepara las pistas antes. */
      async cambiarTono(proyectoId: string, semitonos: number): Promise<void> {
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string }>('tono:cambiar', { proyectoId, semitonos }, 5000)
          if (!r.ok && r.error) avisar({ tipo: 'error', texto: r.error })
        } catch {
          avisar({ tipo: 'error', texto: 'No se pudo cambiar el tono (sin conexión con la compu)' })
        }
      },
      /** Pasa la cancion a otra velocidad (1 = la original), sin cambiar el tono: la compu prepara las pistas antes. */
      async cambiarVelocidad(proyectoId: string, velocidad: number): Promise<void> {
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string }>('velocidad:cambiar', { proyectoId, velocidad }, 5000)
          if (!r.ok && r.error) avisar({ tipo: 'error', texto: r.error })
        } catch {
          avisar({ tipo: 'error', texto: 'No se pudo cambiar la velocidad (sin conexión con la compu)' })
        }
      },
      // ---- colchon: pad y click sin la banda (ver shared/colchon.ts) ----
      /** Con la cancion sonando: en el proximo compas se va la banda y siguen el click y el pad. */
      async entrarEnColchon(): Promise<void> {
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string }>('colchon:entrar', {}, 5000)
          if (!r.ok && r.error) avisar({ tipo: 'error', texto: r.error })
        } catch {
          avisar({ tipo: 'error', texto: 'No se pudo armar el colchón (sin conexión con la compu)' })
        }
      },
      terminarColchon(): void {
        emit('colchon:terminar')
      },
      /** Cambia el colchon: el que suena (en vivo) y, si arriba hay uno de la lista, lo que tiene guardado. */
      ajustarColchon(cambio: Partial<AjustesColchon>): void {
        emit('colchon:ajustar', cambio)
      },
      /** Crea un colchon para la lista (queda en la biblioteca). Devuelve su id. */
      async crearColchon(ajustes: AjustesColchon): Promise<string | null> {
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string; id?: string }>('colchon:crear', { ajustes }, 5000)
          if (!r.ok) avisar({ tipo: 'error', texto: r.error ?? 'No se pudo crear el colchón' })
          return r.ok ? (r.id ?? null) : null
        } catch {
          avisar({ tipo: 'error', texto: 'No se pudo crear el colchón (sin conexión con la compu)' })
          return null
        }
      },
      /** Compases de cuenta antes de la cancion (null = automatica: 2, o 1 en las lentas). */
      setCuenta(proyectoId: string, cuenta: 0 | 1 | 2 | null): void {
        emit('cuenta:set', { proyectoId, cuenta })
      },
      /** Tonalidad original de la cancion (null = la que dice el nombre). */
      ponerTonalidad(proyectoId: string, tonalidad: string | null): void {
        emit('tono:tonalidad', { proyectoId, tonalidad })
      },
      setLocked(locked: boolean): void {
        emit('lock:set', { locked })
      },

      // ---- voces que avisan los saltos ----
      /** Importa un pack de voces (.zip o .rar con un audio por seccion y los numeros). true = quedo importado. */
      async importarVoces(): Promise<boolean> {
        if (!window.electronAPI) return false
        const filePath = await window.electronAPI.pickZipFile()
        if (!filePath) return false
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string }>('voces:importar', { filePath }, 5 * 60 * 1000)
          if (!r.ok) avisar({ tipo: 'error', texto: r.error ?? 'No se pudieron importar las voces' })
          else avisar({ tipo: 'info', texto: 'Voces importadas: al elegir una sección con la música sonando, se avisa con voz' }, 6000)
          return r.ok
        } catch {
          avisar({ tipo: 'error', texto: 'La importación de las voces tardó demasiado' })
          return false
        }
      },
      // ---- pads propios del colchon ----
      /**
       * Importa pads (de `filePath`, o elegir el archivo). Un audio cuyo nombre no dice el tono:
       * devuelve `pedirNota` y se vuelve a llamar con la nota elegida.
       */
      async importarPads(filePath?: string, nota?: string): Promise<{ ok: boolean; pedirNota?: string; filePath?: string }> {
        const ruta = filePath ?? (await window.electronAPI?.pickPadsFile?.())
        if (!ruta) return { ok: false }
        try {
          const r = await socket.emitAck<{ ok: boolean; error?: string; pedirNota?: string }>('pads:importar', { filePath: ruta, nota }, 10 * 60 * 1000)
          if (r.pedirNota) return { ok: false, pedirNota: r.pedirNota, filePath: ruta }
          if (!r.ok) avisar({ tipo: 'error', texto: r.error ?? 'No se pudieron importar los pads' })
          else avisar({ tipo: 'info', texto: 'Pads importados: el colchón usa tus pads en los 12 tonos' }, 6000)
          return { ok: r.ok }
        } catch {
          avisar({ tipo: 'error', texto: 'La importación de los pads tardó demasiado' })
          return { ok: false }
        }
      },
      activarPads(activo: boolean): void {
        emit('pads:activar', { activo })
      },
      borrarPads(): void {
        emit('pads:borrar', {})
      },
      activarVoces(activo: boolean): void {
        emit('voces:activar', { activo })
      },
      borrarVoces(): void {
        emit('voces:borrar', {})
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
      /** compu (Windows): vuelve a revisar el firewall (al abrir la ventana de Celulares) */
      async revisarFirewall(): Promise<void> {
        const e = await window.electronAPI?.firewall?.revisar()
        if (e) setFirewall(e)
      },
      /** compu (Windows): deja entrar a los celulares en todas las redes (Windows pide permiso) */
      async permitirFirewall(): Promise<'ok' | 'cancelado' | 'error'> {
        const api = window.electronAPI?.firewall
        if (!api) return 'error'
        const r = await api.permitir()
        if (r.estado) setFirewall(r.estado)
        return r.resultado === 'ok' && r.estado?.estado === 'bloqueado' ? 'error' : r.resultado
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

  ajusteFinoRef.current = acciones.setAjusteManualMs

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
    firewall,
    estado,
    secciones,
    siguienteProyecto,
    dispositivos,
    avisos,
    importProgreso,
    modeloVoz,
    biblioteca,
    progresoAnalisis,
    progresoTono,
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
    rol,
    salidaSonido,
    escucharMultimedia,
    talkback,
    talkbackSonando,
    talkbackRecibido,
    talkbackHablando,
    /** este celular maneja la cancion: director (o todavia sin rol, como antes) y sin el control bloqueado */
    puedeControlar: origen === 'compu' || (!(estado?.locked ?? false) && (rol === null || rol === 'director')),
    ...acciones
  }
}

export type AppController = ReturnType<typeof useAppController>
