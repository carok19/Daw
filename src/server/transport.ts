import crypto from 'node:crypto'
import type { Server } from 'socket.io'
import type { AccionProgramada, AnuncioSalto, ColchonActivo, ComandoProgramado, SeccionSaltarPayload, TramoReproduccion } from '../shared/types'
import { calcularSecciones, nuevoPlayback, posicionActualMs, seccionEn, type Seccion } from '../shared/playback'
import { compasesDeCuenta, programarCuenta } from '../shared/cuenta'
import { SALIDA_PAD_MS, SALIDA_PAD_STOP_MS, SALIDA_PAD_VUELTA_MS, largoDeCompas, notaDelPad, padDeCancion, proximoCompas, proximoPulso } from '../shared/colchon'
import type { AppState, Tab } from './state'

/**
 * Margen (ms) para programar una accion de audio a futuro, usado cuando hay al
 * menos un celular conectado: tiempo de sobra para que el comando llegue por
 * WiFi a todos y cada uno programe su audio para el mismo instante. Es el
 * maximo: con los celulares medidos se usa menos (ver entrega.ts).
 */
export const MARGIN_MS = 1500

/** Margen minimo sin celulares conectados: la compu no tiene con quien sincronizarse. */
export const MARGIN_SIN_CELULARES_MS = 30

/** Anticipacion minima con la que se emite el salto de "repetir seccion" (aunque no haya celulares). */
const ANTICIPO_MIN_LOOP_MS = 250

/** Una seccion mas corta que esto no se repite (no da el tiempo para programarla en todos). */
const MIN_SECCION_LOOP_MS = 1000

/**
 * Anticipacion minima de un salto de seccion en el limite (fin de seccion o
 * compas) con celulares: si el limite esta mas cerca, se usa el siguiente.
 * Menor que MARGIN_MS a proposito: el comando se manda igual con todo el
 * margen posible, y en una WiFi local llega en milisegundos.
 */
const ANTICIPO_MIN_SALTO_MS = 700

/**
 * La voz que avisa un salto empieza al menos esto despues de elegirlo, con
 * celulares: tienen que alcanzar a bajar los pedazos de su mezcla que la
 * traen (ver el "primero lo urgente" de StreamingEngine).
 */
const ANTICIPO_ANUNCIO_MS = 1000

/** Arma la voz que avisa un salto (ver voces.ts); null = no hay voces o no entra. */
export type Anunciador = (tab: Tab, nombre: string, limiteMs: number, minInicioMs: number) => AnuncioSalto | null

/** Compas mas cercano a `ms` (a menos de medio compas); sin tempo detectado, `ms` tal cual. */
function alCompas(tab: Tab, ms: number): number {
  const compases = tab.proyecto.tempo?.compasesMs
  if (!compases || compases.length < 2) return ms
  let mejor = ms
  let dist = Infinity
  for (const c of compases) {
    const d = Math.abs(c - ms)
    if (d < dist) {
      dist = d
      mejor = c
    }
  }
  const medio = (compases[1] - compases[0]) / 2
  return dist <= medio ? mejor : ms
}

function formatoTiempo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function clampPos(ms: number, duracionTotalMs: number): number {
  const max = duracionTotalMs > 0 ? duracionTotalMs : Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(0, Math.round(ms)))
}

/**
 * Transporte del lado del servidor: unica fuente de verdad de play/pausa/stop/
 * saltos, y de los eventos que dependen del tiempo — fin de cancion y
 * "repetir seccion" — que se programan aca (y no en la UI de la compu) para
 * que funcionen igual aunque la ventana de la compu este ocupada o cerrada.
 */
export class Transporte {
  private timer: NodeJS.Timeout | null = null
  private timerColchon: NodeJS.Timeout | null = null
  /**
   * Colchon dentro de una cancion: la cancion se pausa al terminar el compas
   * en que se apaga la banda (en silencio). null = no hay que pausar nada.
   */
  private pausaDeColchon: { tabId: string; tPausa: number } | null = null
  /** cambio el colchon: avisar a todos YA (antes de la orden que lo termina, asi el click para justo) */
  alCambiarColchon: () => void = () => {}

  constructor(
    private readonly io: Server,
    private readonly state: AppState,
    private readonly hayCelulares: () => boolean,
    /** cambio el salto pendiente (se eligio, se cambio, se cancelo o se hizo): avisar a todos */
    private readonly alCambiarSalto: () => void = () => {},
    /** margen con celulares: lo que tardan en llegarles las ordenes (ver entrega.ts) */
    private readonly margenConCelulares: () => number = () => MARGIN_MS,
    private readonly anunciar: Anunciador = () => null
  ) {}

  /** La voz que avisa el salto (la seccion a la que se va; sin nombre, solo la cuenta). */
  private anunciarSalto(tab: Tab, nombre: string, destinoMs: number, limiteMs: number): AnuncioSalto | null {
    // la seccion elegida es justo la que sigue: la guia de la cancion ya la anuncia
    if (destinoMs === limiteMs) return null
    const anticipo = this.hayCelulares() ? ANTICIPO_ANUNCIO_MS : 100
    try {
      return this.anunciar(tab, nombre, limiteMs, posicionActualMs(tab.playback, Date.now() + anticipo))
    } catch {
      return null // sin voz, el salto se hace igual
    }
  }

  margen(): number {
    return this.hayCelulares() ? this.margenConCelulares() : MARGIN_SIN_CELULARES_MS
  }

  play(positionMs?: number): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    if (tab.proyecto.colchon) return this.iniciarColchonDeLista(tab)
    const now = Date.now()
    const valida = positionMs !== undefined && Number.isFinite(positionMs)
    // en el colchon de esta cancion: "seguir" = la cancion vuelve donde quedo, en el "1" del proximo compas
    // (la pausa del colchon puede estar programada y no haberse hecho todavia: donde queda al hacerse)
    const propio = this.colchonDe(tab)
    const dondeQuedo = (): number => this.posicionDeReanudacion(tab, Math.max(now, tab.playback.referenceServerTime))
    if (propio && this.volverDeColchon(tab, propio, valida ? positionMs! : tab.playback.estado === 'playing' ? null : dondeQuedo())) return
    if (!valida && tab.playback.estado === 'playing') return // ya esta sonando
    const pos = valida ? clampPos(positionMs!, tab.proyecto.duracionTotalMs) : this.posicionDeReanudacion(tab, now)
    const inicio = now + this.margen()
    // desde parado o en pausa: primero la cuenta ("1 2 3 4, 1 2 3 4") y despues la musica, en el tiempo
    const cuenta = tab.playback.estado !== 'playing' ? programarCuenta(tab.proyecto.tempo, pos, compasesDeCuenta(tab.proyecto, pos), inicio) : null
    // un colchon sonando (el de otra cancion o uno de la lista) termina cuando arranca esta: el pad acompana la cuenta y se va
    const otro = this.colchonSonando()
    if (otro) this.terminarColchonEn(otro, inicio, (cuenta ? cuenta.inicioMusica - inicio : 0) + SALIDA_PAD_VUELTA_MS)
    if (cuenta) this.emitir(tab, 'play', { estado: 'playing', positionMs: pos, referenceServerTime: cuenta.inicioMusica, cuenta: cuenta.cuenta })
    else this.emitir(tab, 'play', { estado: 'playing', positionMs: pos, referenceServerTime: inicio })
  }

  pause(): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    // pausa en un colchon (el de la lista o el de esta cancion) = se apaga despacio
    if (tab.proyecto.colchon || this.colchonDe(tab)) return this.terminarColchon()
    if (tab.playback.estado !== 'playing') return
    const executeAt = Date.now() + this.margen()
    const pos = clampPos(posicionActualMs(tab.playback, executeAt), tab.proyecto.duracionTotalMs)
    this.emitir(tab, 'pause', { estado: 'paused', positionMs: pos, referenceServerTime: executeAt })
  }

  stop(): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    // stop = silencio: tambien el colchon que este sonando (de esta cancion, de otra o de la lista),
    // mas rapido que con "Terminar" (que el pad no quede sonando despues de parar)
    this.terminarColchon(SALIDA_PAD_STOP_MS)
    if (tab.proyecto.colchon) return
    if (tab.playback.estado === 'stopped' && tab.playback.positionMs === 0) return
    const executeAt = Date.now() + (tab.playback.estado === 'playing' ? this.margen() : 0)
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: executeAt })
  }

  /** Corta YA (sin margen): se usa al cerrar la pestana que esta sonando o borrar su proyecto. */
  detenerInmediato(tab: Tab): void {
    if (tab.playback.estado !== 'playing') return
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: Date.now() })
  }

  seek(positionMs: number): void {
    const tab = this.state.getActiveTab()
    if (!tab || !Number.isFinite(positionMs)) return
    const pos = clampPos(positionMs, tab.proyecto.duracionTotalMs)
    if (tab.playback.estado === 'playing') {
      this.emitir(tab, 'play', { estado: 'playing', positionMs: pos, referenceServerTime: Date.now() + this.margen() })
    } else {
      const estado = pos === 0 ? tab.playback.estado : 'paused'
      this.emitir(tab, 'seek', { estado, positionMs: pos, referenceServerTime: Date.now() })
    }
  }

  saltarAMarcador(marcadorId: string): boolean {
    const tab = this.state.getActiveTab()
    const marcador = tab?.proyecto.marcadores.find((m) => m.id === marcadorId)
    if (!tab || !marcador) return false
    this.saltarASeccion({ posicionMs: marcador.tiempoMs })
    return true
  }

  /**
   * Ir a una seccion. Parado o en pausa, va enseguida. Sonando, segun el modo:
   * al terminar la seccion actual (o en el proximo compas) la musica sigue
   * directo en la seccion elegida, sin cortes; mientras tanto el salto queda
   * pendiente y se puede cambiar (elegir otra) o cancelar.
   */
  saltarASeccion(p: SeccionSaltarPayload): void {
    const tab = this.state.getActiveTab()
    if (!tab) return
    const dur = tab.proyecto.duracionTotalMs
    const secciones = calcularSecciones(tab.proyecto.marcadores, dur)
    if (secciones.length === 0) return
    const now = Date.now()
    const pendiente = this.state.saltoPendiente?.tabId === tab.tabId ? this.state.saltoPendiente : null

    let destino: Seccion | null = null
    let relativoNatural = false
    if (typeof p.relativo === 'number' && p.relativo !== 0) {
      const pos = posicionActualMs(tab.playback, now)
      // relativo a lo que ya se eligio (dos veces "siguiente" = saltear una seccion) o a la actual
      const base = seccionEn(secciones, pendiente ? pendiente.destinoMs : pos) ?? secciones[0]
      let i = base.indice + Math.sign(p.relativo)
      // "anterior" pasados 2 s de la seccion = repetir esta desde su comienzo
      if (!pendiente && p.relativo < 0 && pos - base.inicioMs > 2000) i = base.indice
      destino = secciones[Math.max(0, Math.min(secciones.length - 1, i))]
      relativoNatural = p.relativo > 0 && !pendiente
    } else if (typeof p.posicionMs === 'number' && Number.isFinite(p.posicionMs)) {
      destino = seccionEn(secciones, p.posicionMs)
    }
    if (!destino) return

    // en el colchon de esta cancion: la cancion vuelve en esa seccion, en el "1" del proximo compas del colchon
    const propio = this.colchonDe(tab)
    if (propio && this.volverDeColchon(tab, propio, alCompas(tab, destino.inicioMs))) return

    if (tab.playback.estado !== 'playing' || p.inmediato || this.state.modoSalto === 'inmediato') {
      this.cancelarSalto()
      this.seek(destino.inicioMs)
      return
    }

    // se cae en el "1" del compas (aunque la marca haya quedado unos ms corrida): el pulso sigue parejo
    const destinoMs = alCompas(tab, destino.inicioMs)
    let limite = this.limiteDeSalto(tab, secciones, this.state.modoSalto, now)
    // "siguiente" en modo seccion: la siguiente ya viene sola al terminar esta;
    // lo que se quiere es pasar ya, a tiempo: en el proximo compas (o enseguida si no hay tempo)
    if (relativoNatural && limite && limite.limiteMs === destinoMs) {
      limite = this.state.modoSalto === 'seccion' ? this.limiteDeSalto(tab, secciones, 'compas', now) : null
      if (!limite || limite.limiteMs === destinoMs) {
        this.cancelarSalto()
        this.seek(destino.inicioMs)
        return
      }
    }
    if (!limite) {
      this.cancelarSalto()
      this.seek(destino.inicioMs)
      return
    }
    const anuncio = this.anunciarSalto(tab, destino.nombre, destinoMs, limite.limiteMs)
    this.state.saltoPendiente = { tabId: tab.tabId, destinoMs, nombre: destino.nombre, ...limite, anuncio }
    this.reprogramarTimers()
    this.alCambiarSalto()
  }

  /**
   * Ir a un punto cualquiera (click en la linea de tiempo). Sonando y con el
   * tempo detectado, se hace a tiempo: en el proximo compas, y al "1" del
   * compas mas cercano al punto elegido, asi el pulso no se corta. Sin tempo,
   * con el modo "ya" o con `inmediato` (Shift), va enseguida.
   */
  saltarAPosicion(positionMs: number, inmediato = false): void {
    const tab = this.state.getActiveTab()
    if (!tab || !Number.isFinite(positionMs)) return
    const propio = this.colchonDe(tab)
    if (propio && this.volverDeColchon(tab, propio, alCompas(tab, positionMs))) return
    const compases = tab.proyecto.tempo?.compasesMs
    if (tab.playback.estado !== 'playing' || inmediato || this.state.modoSalto === 'inmediato' || !compases || compases.length < 2) {
      this.cancelarSalto()
      this.seek(positionMs)
      return
    }
    const dur = tab.proyecto.duracionTotalMs
    const destinoMs = clampPos(alCompas(tab, positionMs), dur)
    const limite = this.limiteDeSalto(tab, calcularSecciones(tab.proyecto.marcadores, dur), 'compas', Date.now())
    if (!limite) {
      this.cancelarSalto()
      this.seek(destinoMs)
      return
    }
    const seccion = seccionEn(calcularSecciones(tab.proyecto.marcadores, dur), destinoMs)
    const nombre = `${seccion?.nombre ?? 'Posición'} · ${formatoTiempo(destinoMs)}`
    // a un punto cualquiera (no al comienzo de una seccion): sin nombre, solo la cuenta
    const anuncio = this.anunciarSalto(tab, seccion && Math.abs(seccion.inicioMs - destinoMs) < 50 ? seccion.nombre : '', destinoMs, limite.limiteMs)
    this.state.saltoPendiente = { tabId: tab.tabId, destinoMs, nombre, ...limite, anuncio }
    this.reprogramarTimers()
    this.alCambiarSalto()
  }

  /** Cancela el salto elegido que todavia no se hizo. */
  cancelarSalto(): void {
    if (!this.state.saltoPendiente) return
    this.state.saltoPendiente = null
    this.reprogramarTimers()
    this.alCambiarSalto()
  }

  /**
   * Proximo limite donde puede caer un salto: el fin de la seccion que va a
   * estar sonando (o el proximo compas), al menos ANTICIPO_MIN_SALTO_MS a futuro
   * y nunca antes de que se ejecute un comando ya programado.
   */
  private limiteDeSalto(
    tab: Tab,
    secciones: Seccion[],
    modo: 'seccion' | 'compas' | 'inmediato',
    now: number
  ): { limiteMs: number; tSalto: number } | null {
    const dur = tab.proyecto.duracionTotalMs
    const anticipo = this.hayCelulares() ? ANTICIPO_MIN_SALTO_MS : MARGIN_SIN_CELULARES_MS
    const desde = Math.max(now + anticipo, tab.playback.referenceServerTime)
    const posDesde = posicionActualMs(tab.playback, desde)
    const compases = tab.proyecto.tempo?.compasesMs
    let limiteMs: number | undefined
    if (modo === 'compas' && compases && compases.length > 1) limiteMs = compases.find((c) => c >= posDesde)
    else {
      limiteMs = seccionEn(secciones, posDesde)?.finMs
      // el fin de la seccion, en el "1" del compas; si eso ya quedo atras, el compas siguiente
      if (limiteMs !== undefined && limiteMs < dur) {
        const enCompas = alCompas(tab, limiteMs)
        limiteMs = enCompas >= posDesde ? enCompas : (compases?.find((c) => c >= posDesde) ?? limiteMs)
      }
    }
    if (limiteMs === undefined || limiteMs > dur || limiteMs < posDesde) return null
    return { limiteMs, tSalto: desde + (limiteMs - posDesde) }
  }

  private ejecutarSalto(tabId: string, tSalto: number): void {
    const tab = this.state.getActiveTab()
    const pendiente = this.state.saltoPendiente
    if (!tab || tab.tabId !== tabId || !pendiente || pendiente.tabId !== tabId || pendiente.tSalto !== tSalto) return
    if (tab.playback.estado !== 'playing') {
      this.cancelarSalto()
      return
    }
    if (pendiente.destinoMs === pendiente.limiteMs) {
      // la seccion elegida es justo la que sigue: la musica ya continua ahi sola
      this.cancelarSalto()
      return
    }
    const executeAt = Math.max(tSalto, Date.now() + 20)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: pendiente.destinoMs, referenceServerTime: executeAt })
  }

  // ---- colchon (ver shared/colchon.ts) ----

  /** El colchon que esta sonando (null = ninguno, o ya se esta apagando). */
  private colchonSonando(): ColchonActivo | null {
    const c = this.state.colchon
    return c && c.hasta === null ? c : null
  }

  /** El colchon de esta cancion (se armo sonando ella): se sale volviendo a la cancion. */
  private colchonDe(tab: Tab): ColchonActivo | null {
    const c = this.colchonSonando()
    return c && c.desdeCancion && c.tabId === tab.tabId ? c : null
  }

  /**
   * Colchon dentro de la cancion que suena: en el proximo compas la banda se
   * apaga (en ese compas) y siguen el click, en el mismo pulso, y un pad en el
   * tono de la cancion. Devuelve el motivo si no se puede (null = listo).
   */
  entrarEnColchon(): string | null {
    const tab = this.state.getActiveTab()
    if (!tab || tab.proyecto.colchon) return 'No hay una canción sonando'
    if (this.colchonSonando()) return null // ya esta
    if (tab.playback.estado !== 'playing') return 'El colchón se arma con la canción sonando'
    const tempo = tab.proyecto.tempo
    if (!tempo || tempo.compasesMs.length < 2) return 'Esta canción no tiene el tempo detectado: el colchón sigue su click'
    const now = Date.now()
    const dur = tab.proyecto.duracionTotalMs
    // como los saltos: "al terminar" = cuando termina la seccion que suena (en la ultima, al final de
    // la cancion: el pad sigue despues); si no, en el proximo compas
    const alTerminar = this.state.modoSalto === 'seccion'
    const limite = this.limiteDeSalto(tab, calcularSecciones(tab.proyecto.marcadores, dur), alTerminar ? 'seccion' : 'compas', now)
    if (!limite || limite.limiteMs > dur || (!alTerminar && limite.limiteMs >= dur)) return 'La canción ya está terminando'
    if (limite.limiteMs >= dur) {
      // la ultima seccion: el colchon sigue cuando termina la cancion, en el pulso de su click (el "1" que seguiria)
      const c = tempo.compasesMs
      const largo = largoDeCompas(c, c[c.length - 1])
      let grilla = c.find((x) => x >= dur - 50) ?? c[c.length - 1]
      while (grilla < dur - 50) grilla += largo
      limite.tSalto += grilla - limite.limiteMs
      limite.limiteMs = grilla
    }
    const compasMs = largoDeCompas(tempo.compasesMs, Math.min(limite.limiteMs, dur - 1))
    // el pad entra por debajo de la banda los 2 compases antes (si hay tiempo): cuando la banda se va, ya esta sonando
    const padDesde = Math.min(limite.tSalto, Math.max(now + this.margen(), limite.tSalto - 2 * compasMs))
    // un salto elegido queda sin efecto: la banda se va
    this.state.saltoPendiente = null
    this.state.colchon = {
      id: crypto.randomUUID(),
      tabId: tab.tabId,
      empezo: limite.tSalto,
      inicio: limite.tSalto,
      padDesde,
      compasMs,
      pulsos: Math.max(1, tempo.compas),
      desdeCancion: true,
      // el tono de la seccion que termina (si la cancion cambia de tono)
      pad: padDeCancion(tab.proyecto, Math.min(limite.limiteMs, dur) - 1),
      click: true,
      volumenPad: this.state.volumenPadColchon,
      volumenClick: 100,
      hasta: null,
      salidaPadMs: SALIDA_PAD_MS
    }
    this.pausaDeColchon = { tabId: tab.tabId, tPausa: limite.tSalto + compasMs }
    this.reprogramarTimers()
    this.alCambiarColchon()
    return null
  }

  /**
   * Sale del colchon de esta cancion: la cancion vuelve en `destinoMs` (null =
   * donde va a estar, si todavia suena) en el "1" del proximo compas del
   * colchon, sin cuenta (el click nunca paro). false = el colchon todavia no
   * habia empezado: se cancela y la cancion sigue como si nada.
   */
  private volverDeColchon(tab: Tab, c: ColchonActivo, destinoMs: number | null): boolean {
    const now = Date.now()
    const anticipo = this.hayCelulares() ? ANTICIPO_MIN_SALTO_MS : MARGIN_SIN_CELULARES_MS
    const t = proximoCompas(c, now + anticipo)
    if (t <= c.empezo) {
      this.state.colchon = null
      this.pausaDeColchon = null
      this.reprogramarTimers()
      this.alCambiarColchon()
      return false
    }
    c.hasta = t
    c.salidaPadMs = SALIDA_PAD_VUELTA_MS
    this.programarFinDeColchon()
    this.alCambiarColchon()
    const pos = destinoMs ?? posicionActualMs(tab.playback, t)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: clampPos(pos, tab.proyecto.duracionTotalMs), referenceServerTime: t })
    return true
  }

  /** Colchon de la lista (una "cancion" sin pistas): arranca enseguida, sin cuenta. */
  private iniciarColchonDeLista(tab: Tab): void {
    const a = tab.proyecto.colchon!
    const actual = this.colchonSonando()
    if (actual && actual.tabId === tab.tabId && !actual.desdeCancion) return // ya suena
    const inicio = Date.now() + this.margen()
    // otro colchon sonando: se va cuando entra este
    if (actual) this.terminarColchonEn(actual, inicio, SALIDA_PAD_VUELTA_MS, false)
    this.state.colchon = {
      id: crypto.randomUUID(),
      tabId: tab.tabId,
      empezo: inicio,
      inicio,
      padDesde: inicio,
      compasMs: (60000 / a.bpm) * a.compas,
      pulsos: a.compas,
      desdeCancion: false,
      pad: notaDelPad(a.tonalidad),
      click: a.click,
      volumenPad: a.volumenPad,
      volumenClick: a.volumenClick,
      hasta: null,
      salidaPadMs: SALIDA_PAD_MS
    }
    this.alCambiarColchon()
  }

  /**
   * Termina el colchon que suena: el click para en el proximo golpe y el pad
   * se apaga despacio. Si todavia no habia empezado, se cancela (la banda de
   * la cancion sigue).
   */
  terminarColchon(salidaPadMs = SALIDA_PAD_MS): void {
    const c = this.colchonSonando()
    if (!c) return
    const desde = Date.now() + this.margen()
    if (desde <= c.empezo) {
      this.state.colchon = null
      if (this.pausaDeColchon?.tabId === c.tabId) this.pausaDeColchon = null
      this.reprogramarTimers()
      this.alCambiarColchon()
      return
    }
    this.terminarColchonEn(c, proximoPulso(c, desde), salidaPadMs)
  }

  private terminarColchonEn(c: ColchonActivo, t: number, salidaPadMs: number, avisar = true): void {
    c.hasta = Math.max(c.empezo, t)
    c.salidaPadMs = salidaPadMs
    this.programarFinDeColchon()
    if (avisar) this.alCambiarColchon()
  }

  /** Cuando el pad termino de apagarse, el colchon deja de estar. */
  private programarFinDeColchon(): void {
    const c = this.state.colchon
    if (!c || c.hasta === null) return
    const id = c.id
    if (this.timerColchon) clearTimeout(this.timerColchon)
    this.timerColchon = setTimeout(
      () => {
        this.timerColchon = null
        if (this.state.colchon?.id !== id) return
        this.state.colchon = null
        this.alCambiarColchon()
      },
      Math.max(0, c.hasta + c.salidaPadMs + 250 - Date.now())
    )
  }

  /**
   * Cambia el colchon que suena en vivo: nota y volumen del pad, click, y
   * (el de la lista) BPM y compas, desde el proximo golpe.
   */
  ajustarColchon(cambio: { pad?: string | null; volumenPad?: number; volumenClick?: number; click?: boolean; bpm?: number; compas?: number }): boolean {
    const c = this.colchonSonando()
    if (!c) return false
    if (cambio.pad !== undefined) c.pad = cambio.pad === null ? null : notaDelPad(cambio.pad)
    if (cambio.volumenPad !== undefined) {
      c.volumenPad = cambio.volumenPad
      if (c.desdeCancion) this.state.volumenPadColchon = cambio.volumenPad
    }
    if (cambio.volumenClick !== undefined) c.volumenClick = cambio.volumenClick
    if (cambio.click !== undefined) c.click = cambio.click
    const pulsos = cambio.compas ?? c.pulsos
    const compasMs = cambio.bpm !== undefined ? (60000 / cambio.bpm) * pulsos : (c.compasMs / c.pulsos) * pulsos
    if (!c.desdeCancion && (Math.abs(compasMs - c.compasMs) > 0.01 || pulsos !== c.pulsos)) {
      // otro pulso: arranca de nuevo (en el "1") en el proximo golpe
      c.inicio = proximoPulso(c, Date.now() + this.margen())
      c.compasMs = compasMs
      c.pulsos = pulsos
    }
    this.alCambiarColchon()
    return true
  }

  private ejecutarPausaDeColchon(tabId: string, tPausa: number): void {
    const tab = this.state.getActiveTab()
    const p = this.pausaDeColchon
    if (!tab || tab.tabId !== tabId || !p || p.tabId !== tabId || p.tPausa !== tPausa) return
    this.pausaDeColchon = null
    if (tab.playback.estado !== 'playing') return
    const executeAt = Math.max(tPausa, Date.now() + 20)
    this.emitir(tab, 'pause', { estado: 'paused', positionMs: clampPos(posicionActualMs(tab.playback, executeAt), tab.proyecto.duracionTotalMs), referenceServerTime: executeAt })
  }

  /** Posicion desde la que reanuda un play sin posicion explicita. */
  private posicionDeReanudacion(tab: Tab, now: number): number {
    const pos = posicionActualMs(tab.playback, now)
    const dur = tab.proyecto.duracionTotalMs
    // si quedo parado al final, "play" arranca de nuevo desde el principio
    return dur > 0 && pos >= dur - 50 ? 0 : clampPos(pos, dur)
  }

  private emitir(tab: Tab, accion: AccionProgramada, tramo: TramoReproduccion): void {
    // cualquier comando (pausa, otro salto, el salto mismo) reemplaza al salto que estaba esperando
    const habiaSalto = this.state.saltoPendiente !== null
    this.state.saltoPendiente = null
    // otra orden para esta cancion (volver del colchon, pausa, stop): la pausa del colchon ya no va
    if (this.pausaDeColchon?.tabId === tab.tabId) this.pausaDeColchon = null
    const now = Date.now()
    const playback = nuevoPlayback(tab.playback, tramo, now)
    this.state.setPlayback(tab.tabId, playback)
    const cmd: ComandoProgramado = {
      tabId: tab.tabId,
      accion,
      positionMs: tramo.positionMs,
      executeAtServerTime: tramo.referenceServerTime,
      playback
    }
    this.io.emit('playback:scheduled', cmd)
    this.reprogramarTimers()
    if (habiaSalto) this.alCambiarSalto()
  }

  /**
   * (Re)calcula el proximo evento temporal de la pestana activa: el salto de
   * "repetir seccion" (si esta activo) o el fin de la cancion. Llamar ante
   * cualquier cambio de reproduccion, marcadores, loop o pestana activa.
   */
  reprogramarTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // se cerro (o se borro) la cancion del colchon que sonaba: se apaga
    const colchon = this.colchonSonando()
    if (colchon && !this.state.getTab(colchon.tabId)) this.terminarColchon()
    const tab = this.state.getActiveTab()
    if (!tab || tab.playback.estado !== 'playing') return
    const dur = tab.proyecto.duracionTotalMs
    if (dur <= 0) return

    const now = Date.now()
    const tRef = Math.max(now, tab.playback.referenceServerTime)
    const pos = posicionActualMs(tab.playback, tRef)
    const tabId = tab.tabId

    // entrando al colchon: la cancion se pausa (ya en silencio) al terminar el compas en que se apaga la banda
    const pausa = this.pausaDeColchon
    if (pausa && pausa.tabId === tabId) {
      this.timer = setTimeout(() => this.ejecutarPausaDeColchon(tabId, pausa.tPausa), Math.max(0, pausa.tPausa - this.margen() - now))
      return
    }

    // un salto elegido tiene prioridad sobre "repetir seccion" y el fin de la cancion
    const salto = this.state.saltoPendiente
    if (salto && salto.tabId === tabId) {
      const emitirEn = salto.tSalto - this.margen()
      this.timer = setTimeout(() => this.ejecutarSalto(tabId, salto.tSalto), Math.max(0, emitirEn - now))
      return
    }

    if (this.state.loop) {
      const seccion = seccionEn(calcularSecciones(tab.proyecto.marcadores, dur), pos)
      // la vuelta tambien en el "1": del compas del fin de la seccion al compas de su comienzo
      const inicio = seccion ? alCompas(tab, seccion.inicioMs) : 0
      const fin = seccion ? (seccion.finMs >= dur ? seccion.finMs : alCompas(tab, seccion.finMs)) : 0
      if (seccion && fin - inicio >= MIN_SECCION_LOOP_MS && fin > pos) {
        const tSalto = tRef + (fin - pos)
        // se emite con anticipacion (al menos ANTICIPO_MIN_LOOP_MS) para que cada cliente programe el salto exacto
        const emitirEn = tSalto - Math.max(this.margen(), ANTICIPO_MIN_LOOP_MS)
        this.timer = setTimeout(() => this.saltoDeLoop(tabId, inicio, tSalto), Math.max(0, emitirEn - now))
        return
      }
    }

    const tFin = tRef + Math.max(0, dur - pos)
    this.timer = setTimeout(() => this.finDeCancion(tabId), Math.max(0, tFin - now))
  }

  private saltoDeLoop(tabId: string, inicioMs: number, tSalto: number): void {
    const tab = this.state.getActiveTab()
    if (!tab || tab.tabId !== tabId || tab.playback.estado !== 'playing' || !this.state.loop) return
    const now = Date.now()
    // si el timer se atraso (proceso ocupado), el salto no puede quedar en el pasado
    const executeAt = Math.max(tSalto, now + 20)
    this.emitir(tab, 'play', { estado: 'playing', positionMs: inicioMs, referenceServerTime: executeAt })
  }

  private finDeCancion(tabId: string): void {
    const tab = this.state.getActiveTab()
    if (!tab || tab.tabId !== tabId || tab.playback.estado !== 'playing') return
    const now = Date.now()
    if (posicionActualMs(tab.playback, now) < tab.proyecto.duracionTotalMs - 20) {
      this.reprogramarTimers() // algo cambio en el medio (p.ej. un salto): recalcular
      return
    }
    this.emitir(tab, 'stop', { estado: 'stopped', positionMs: 0, referenceServerTime: now })
  }

  cancelarTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.timerColchon) clearTimeout(this.timerColchon)
    this.timerColchon = null
  }
}
