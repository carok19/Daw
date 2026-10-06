/**
 * Talkback: la compu le habla a los oidos de la banda (nunca a la consola ni
 * a multimedia), como un fader mas de la mezcla: se prende y queda abierto
 * (entrada constante) hasta que alguien lo apaga. La compu toma el microfono
 * (o una interface, la salida de Reaper con un cable virtual, la consola por
 * una placa de sonido), lo pasa a 16 kHz mono y lo manda en pedacitos de 10 ms
 * por el WiFi, cada uno con la hora (del servidor) en que se capto. Viaja
 * siempre, tambien el silencio: asi el WiFi del celular no se "duerme" (al
 * despertar, los primeros pedazos llegan tarde y la espera sube). Cada celular lo
 * reproduce `objetivoMs` despues de esa hora: asi el WiFi puede demorar un
 * pedazo y otro no, y igual se escucha parejo. El objetivo se ajusta solo: si
 * algo llega tarde sube, si todo llega holgado baja (de 30 a 600 ms).
 */

/** Frecuencia del audio del talkback (voz: alcanza y sobra). */
export const SR_TALKBACK = 16000
/** Muestras por pedazo (10 ms: lo que se espera a juntar antes de mandar). */
export const MUESTRAS_PEDAZO = 160

/** Captura: junta lo que entra, lo filtra y lo baja a 16 kHz; manda pedazos de 10 ms con su hora (del AudioContext). */
const CODIGO_CAPTURA = `
registerProcessor('captura-talkback', class extends AudioWorkletProcessor {
  constructor() {
    super()
    this.paso = sampleRate / ${SR_TALKBACK}
    this.fase = 0
    this.pedazo = new Float32Array(${MUESTRAS_PEDAZO})
    this.n = 0
    this.t0 = 0
    // filtro pasabajos de 2 polos (corta arriba de ~7 kHz antes de bajar a 16 kHz)
    const fc = 7000 / sampleRate
    const k = Math.tan(Math.PI * fc)
    const q = Math.SQRT1_2
    const norma = 1 / (1 + k / q + k * k)
    this.b0 = k * k * norma
    this.b1 = 2 * this.b0
    this.b2 = this.b0
    this.a1 = 2 * (k * k - 1) * norma
    this.a2 = (1 - k / q + k * k) * norma
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    this.pico = 0
  }
  process(inputs) {
    const entrada = inputs[0] && inputs[0][0]
    if (!entrada) return true
    for (let i = 0; i < entrada.length; i++) {
      const x = entrada[i]
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
      this.fase += 1
      if (this.fase >= this.paso) {
        this.fase -= this.paso
        if (this.n === 0) this.t0 = currentTime + i / sampleRate
        this.pedazo[this.n++] = y
        this.pico = Math.max(this.pico, Math.abs(y))
        if (this.n === ${MUESTRAS_PEDAZO}) {
          this.port.postMessage({ t: this.t0, muestras: this.pedazo, pico: this.pico }, [this.pedazo.buffer])
          this.pedazo = new Float32Array(${MUESTRAS_PEDAZO})
          this.n = 0
          this.pico = 0
        }
      }
    }
    return true
  }
})
`

const cargados = new WeakMap<BaseAudioContext, Set<string>>()

/**
 * Carga (una vez por AudioContext) el procesador que toma la voz en la compu
 * (la compu abre su pagina en localhost: ahi el navegador si habilita los
 * AudioWorklet; los celulares, por http:// en la red local, no: ellos
 * reproducen sin worklet, ver StreamingEngine.recibirTalkback).
 */
export async function cargarProcesador(ctx: BaseAudioContext, cual: 'captura'): Promise<void> {
  let hechos = cargados.get(ctx)
  if (!hechos) {
    hechos = new Set()
    cargados.set(ctx, hechos)
  }
  if (hechos.has(cual)) return
  const codigo = CODIGO_CAPTURA
  const url = URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    hechos.add(cual)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Float32 (-1..1) a Int16 (lo que viaja por el WiFi: 640 bytes por pedazo, 256 kbps). */
export function aInt16(x: Float32Array): Int16Array {
  const r = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) r[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)))
  return r
}

export function deInt16(x: Int16Array): Float32Array {
  const r = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) r[i] = x[i] / 32768
  return r
}

/** Lo que manda la compu por cada pedazo. */
export interface PedazoTalkback {
  /** numero de pedazo (para ver si se pierde alguno) */
  n: number
  /** hora del servidor en que se capto la primera muestra */
  t: number
  /** 160 muestras Int16 (16 kHz mono: 10 ms) */
  pcm: ArrayBuffer
}

import type { MedicionTalkback } from '@shared/types'

/**
 * La espera del celular, que se ajusta sola para que la voz llegue lo antes
 * posible sin cortarse. Cada pedazo tiene que sonar `objetivoMs` despues de
 * captado; para eso hace falta lo que tardo en llegar por el WiFi mas lo que
 * tarda el celular en sacar el audio (su salida). La espera va a lo que
 * necesitan casi todos los pedazos de los ultimos 2 s (el 98 %) mas 15 ms: si
 * llegan tarde tres en un segundo se sube enseguida (de a 60 ms como mucho);
 * un tropezon suelto no (se pierden esos 10 ms); con todo a tiempo, cada
 * segundo se acerca la mitad de lo que sobra.
 */
export class EsperaTalkback {
  objetivoMs = 120
  /** lo que necesito cada pedazo (red + salida) en los ultimos 2 s */
  private recientes: { t: number; ms: number }[] = []
  /** demoras de red y si llego tarde, de los ultimos 500 pedazos (para el diagnostico) */
  private demoras: number[] = []
  private tardes: boolean[] = []
  /** cuando llegaron tarde los ultimos (para ver si fueron 3 en un segundo) */
  private tardesRecientes: number[] = []
  private ultimoTarde = 0
  private ultimaBaja = 0
  private salidaMs = 0

  static readonly MIN_MS = 30
  static readonly MAX_MS = 600
  /** margen sobre lo que necesitan casi todos */
  static readonly MARGEN_MS = 15
  /** antes de esto ya no se puede programar (el motor necesita unos ms por delante) */
  static readonly HOLGURA_MS = 3

  /**
   * Un pedazo llego: `redMs` = cuanto tardo desde que se capto (reloj del
   * servidor); `salidaMs` = cuanto tarda este celular en sacar el audio por el
   * parlante o los auriculares.
   */
  registrar(redMs: number, salidaMs = 0, ahora = Date.now()): void {
    this.salidaMs = salidaMs
    const necesita = redMs + salidaMs
    this.demoras.push(redMs)
    if (this.demoras.length > 500) this.demoras.shift()
    this.recientes.push({ t: ahora, ms: necesita })
    while (this.recientes.length && ahora - this.recientes[0].t > 2000) this.recientes.shift()
    const tarde = necesita > this.objetivoMs - EsperaTalkback.HOLGURA_MS
    this.tardes.push(tarde)
    if (this.tardes.length > 500) this.tardes.shift()
    if (tarde) {
      this.ultimoTarde = ahora
      this.tardesRecientes.push(ahora)
      while (this.tardesRecientes.length && ahora - this.tardesRecientes[0] > 1000) this.tardesRecientes.shift()
      // 3 en un segundo: el WiFi viene lento. Uno suelto no la sube (esperar de mas siempre por algo que pasa una vez no conviene)
      if (this.tardesRecientes.length >= 3) {
        const meta = this.percentil(this.recientes.map((r) => r.ms), 0.98) + EsperaTalkback.MARGEN_MS
        // de a lo sumo 60 ms por vez: si fue un tiron (el celular trabado un momento), no queda muy atrasado
        this.objetivoMs = this.acotar(Math.min(this.objetivoMs + 60, Math.max(this.objetivoMs + 10, meta)))
        this.tardesRecientes = []
      }
      return
    }
    // 1,5 s con todo a tiempo: cada segundo se acerca a lo justo (la mitad de lo que sobra)
    if (ahora - this.ultimoTarde > 1500 && ahora - this.ultimaBaja > 1000 && this.recientes.length >= 50) {
      const meta = this.acotar(this.percentil(this.recientes.map((r) => r.ms), 0.98) + EsperaTalkback.MARGEN_MS)
      if (meta < this.objetivoMs) {
        this.objetivoMs = Math.max(meta, Math.round((this.objetivoMs + meta) / 2))
        this.ultimaBaja = ahora
      }
    }
  }

  private acotar(ms: number): number {
    return Math.min(EsperaTalkback.MAX_MS, Math.max(EsperaTalkback.MIN_MS, Math.round(ms)))
  }

  private percentil(valores: number[], p: number): number {
    if (valores.length === 0) return 0
    const orden = [...valores].sort((a, b) => a - b)
    return orden[Math.min(orden.length - 1, Math.floor(p * orden.length))]
  }

  medicion(): MedicionTalkback {
    return {
      objetivoMs: Math.round(this.objetivoMs),
      redMs: this.demoras.length ? Math.round(this.percentil(this.demoras, 0.95)) : null,
      salidaMs: Math.round(this.salidaMs),
      tardes: this.tardes.filter(Boolean).length
    }
  }
}

/**
 * Compu: toma la entrada elegida (microfono, o un cable virtual desde Reaper)
 * y, mientras el talkback esta abierto, manda los pedazos con su hora. La
 * entrada queda abierta despues del primer uso (asi abrirlo es instantaneo).
 */
/** De donde y como se toma la voz del talkback. */
export interface OpcionesEntrada {
  /** el dispositivo (deviceId): un microfono, una interface; null = el de Windows por defecto */
  entrada: string | null
  /** que entrada de la interface (0 = la 1, 1 = la 2…); null = todas juntas */
  canal: number | null
  /** "Mejorar la voz": menos ruido y volumen parejo (para el microfono de la compu); apagado = la senal tal cual (interface, consola) */
  procesar: boolean
}

/** Los ids que Chrome agrega aparte en Windows ("Predeterminado", "Comunicaciones"): ya estan como "la de Windows". */
const IDS_DE_WINDOWS = ['default', 'communications']

export class EmisorTalkback {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private fuente: MediaStreamAudioSourceNode | null = null
  private nodos: AudioNode[] = []
  private nodo: AudioWorkletNode | null = null
  private abriendo: Promise<void> | null = null
  private clave: string | null = null
  private nCanales = 0
  private n = 0
  /** abierto: lo que entra va a los celulares (si no, solo se mide para el vumetro) */
  enviando = false
  /** pico de lo que entra (0 a 1), aunque no se este mandando: para el vumetro */
  onNivel: ((pico: number) => void) | null = null

  constructor(
    private readonly enviar: (p: PedazoTalkback) => void,
    private readonly horaServidor: () => number
  ) {}

  /** Las entradas de audio de la compu: microfonos e interfaces (los nombres aparecen despues de dar permiso una vez). */
  static async entradas(): Promise<{ id: string; nombre: string }[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const lista = await navigator.mediaDevices.enumerateDevices()
    return lista
      .filter((d) => d.kind === 'audioinput' && !IDS_DE_WINDOWS.includes(d.deviceId))
      .map((d, i) => ({ id: d.deviceId, nombre: d.label || `Entrada ${i + 1}` }))
  }

  /** Avisa cuando se enchufa o desenchufa un microfono o una interface. Devuelve como dejar de escuchar. */
  static alCambiar(cb: () => void): () => void {
    const md = navigator.mediaDevices
    if (!md?.addEventListener) return () => {}
    md.addEventListener('devicechange', cb)
    return () => md.removeEventListener('devicechange', cb)
  }

  /** Abre la entrada (pide permiso la primera vez). Si ya estaba abierta con otras opciones, la cambia (sin dejar de hablar). */
  abrir(op: OpcionesEntrada): Promise<void> {
    const clave = JSON.stringify(op)
    if (this.abriendo && clave === this.clave) return this.abriendo
    const enviaba = this.enviando
    this.cerrar()
    this.clave = clave
    this.abriendo = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: op.entrada ? { exact: op.entrada } : undefined,
          // todas las entradas que tenga (una interface: 2, 4…), para poder elegir una
          channelCount: { ideal: 8 },
          // la voz del que habla, sin "procesar" el retorno (no hay parlantes en el talkback)
          echoCancellation: false,
          noiseSuppression: op.procesar,
          autoGainControl: op.procesar
        }
      })
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await cargarProcesador(ctx, 'captura')
      const fuente = ctx.createMediaStreamSource(stream)
      const nodo = new AudioWorkletNode(ctx, 'captura-talkback', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
      // la entrada elegida de la interface, o el promedio de todas
      const canales = Math.max(1, stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1)
      const nodos: AudioNode[] = []
      if (canales > 1) {
        const division = ctx.createChannelSplitter(canales)
        const voz = ctx.createGain()
        voz.channelCount = 1
        voz.channelCountMode = 'explicit'
        fuente.connect(division)
        if (op.canal !== null && op.canal < canales) division.connect(voz, op.canal)
        else {
          voz.gain.value = 1 / canales
          for (let k = 0; k < canales; k++) division.connect(voz, k)
        }
        voz.connect(nodo)
        nodos.push(division, voz)
      } else fuente.connect(nodo)
      nodo.port.onmessage = (e: MessageEvent<{ t: number; muestras: Float32Array; pico: number }>) => {
        this.onNivel?.(e.data.pico)
        // cada pedazo lleva su numero aunque no viaje: el celular sabe que hubo un hueco
        const n = this.n++
        if (!this.enviando) return
        // hora del servidor en que se capto la primera muestra del pedazo
        const t = this.horaServidor() - (ctx.currentTime - e.data.t) * 1000 - (ctx.baseLatency || 0) * 1000
        this.enviar({ n, t, pcm: aInt16(e.data.muestras).buffer as ArrayBuffer })
      }
      if (ctx.state === 'suspended') await ctx.resume()
      this.ctx = ctx
      this.stream = stream
      this.fuente = fuente
      this.nodos = nodos
      this.nodo = nodo
      this.nCanales = canales
      this.enviando = enviaba
    })()
    this.abriendo.catch(() => {
      this.abriendo = null
    })
    return this.abriendo
  }

  abierto(): boolean {
    return !!this.nodo
  }

  /** Cuantas entradas tiene lo que esta abierto (una interface: 2 o mas; 0 = cerrado). */
  canales(): number {
    return this.nodo ? this.nCanales : 0
  }

  cerrar(): void {
    this.enviando = false
    this.nodo?.disconnect()
    for (const n of this.nodos) n.disconnect()
    this.fuente?.disconnect()
    for (const tr of this.stream?.getTracks() ?? []) tr.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.stream = null
    this.fuente = null
    this.nodos = []
    this.nodo = null
    this.nCanales = 0
    this.abriendo = null
    this.clave = null
  }
}
