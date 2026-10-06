/**
 * Talkback: el que maneja la compu habla y lo escuchan los oidos de la banda
 * (nunca la consola ni multimedia). La compu toma el microfono (o cualquier
 * entrada: la salida de Reaper con un cable virtual, la consola por una placa
 * de sonido), lo pasa a 16 kHz mono y lo manda en pedacitos de 20 ms por el
 * WiFi, cada uno con la hora (del servidor) en que se capto. Cada celular lo
 * reproduce `objetivoMs` despues de esa hora: asi el WiFi puede demorar un
 * pedazo y otro no, y igual se escucha parejo. El objetivo se ajusta solo: si
 * algo llega tarde sube, si todo llega holgado baja (de 80 a 600 ms).
 */

/** Frecuencia del audio del talkback (voz: alcanza y sobra). */
export const SR_TALKBACK = 16000
/** Muestras por pedazo (20 ms). */
export const MUESTRAS_PEDAZO = 320

/** Captura: junta lo que entra, lo filtra y lo baja a 16 kHz; manda pedazos de 20 ms con su hora (del AudioContext). */
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

/**
 * Reproduccion: una linea de tiempo de 16 kHz donde cada pedazo se escribe en
 * su lugar (segun la hora a la que tiene que sonar) y se lee al ritmo del
 * AudioContext, interpolando. Un pedazo que llega tarde pierde lo que ya paso.
 */
const CODIGO_REPRODUCTOR = `
registerProcessor('reproductor-talkback', class extends AudioWorkletProcessor {
  constructor() {
    super()
    this.largo = ${SR_TALKBACK} * 4
    this.buf = new Float32Array(this.largo)
    this.paso = ${SR_TALKBACK} / sampleRate
    // hasta donde hay algo escrito (muestra de 16 kHz contada desde currentTime = 0)
    this.escritoHasta = -1
    this.sonando = false
    this.port.onmessage = (e) => {
      const { t, muestras } = e.data
      const desde = Math.round(t * ${SR_TALKBACK})
      const ahora = Math.floor(currentTime * ${SR_TALKBACK})
      for (let i = 0; i < muestras.length; i++) {
        const j = desde + i
        if (j < ahora || j > ahora + this.largo - 1) continue
        this.buf[j % this.largo] = muestras[i]
      }
      this.escritoHasta = Math.max(this.escritoHasta, desde + muestras.length)
    }
  }
  process(_inputs, outputs) {
    const salida = outputs[0]
    if (!salida || !salida[0]) return true
    const canal = salida[0]
    let suena = false
    for (let i = 0; i < canal.length; i++) {
      const pos = (currentTime + i / sampleRate) * ${SR_TALKBACK}
      const a = Math.floor(pos)
      const f = pos - a
      const ia = a % this.largo
      const ib = (a + 1) % this.largo
      const v = this.escritoHasta >= 0 && a + 1 < this.escritoHasta ? this.buf[ia] * (1 - f) + this.buf[ib] * f : 0
      canal[i] = v
      if (v !== 0) suena = true
      // lo leido se borra siempre: si un pedazo no llega, silencio (no lo de hace 4 s)
      if (f + this.paso >= 1) this.buf[ia] = 0
    }
    for (let c = 1; c < salida.length; c++) salida[c].set(canal)
    if (suena !== this.sonando) { this.sonando = suena; this.port.postMessage({ sonando: suena }) }
    return true
  }
})
`

const cargados = new WeakMap<BaseAudioContext, Set<string>>()

/** Carga (una vez por AudioContext) el procesador de talkback pedido. */
export async function cargarProcesador(ctx: BaseAudioContext, cual: 'captura' | 'reproductor'): Promise<void> {
  let hechos = cargados.get(ctx)
  if (!hechos) {
    hechos = new Set()
    cargados.set(ctx, hechos)
  }
  if (hechos.has(cual)) return
  const codigo = cual === 'captura' ? CODIGO_CAPTURA : CODIGO_REPRODUCTOR
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
  /** 320 muestras Int16 (16 kHz mono) */
  pcm: ArrayBuffer
}

import type { MedicionTalkback } from '@shared/types'

/**
 * Ajuste solo de la espera. Lo que manda es lo que tardan casi todos los
 * pedazos de los ultimos 3 s (el 98 %) mas un margen: si llegan tarde tres en
 * un segundo (el WiFi se puso lento) se espera mas enseguida; un tropezon
 * suelto (un pico del router, el celular ocupado un momento) no la sube (se
 * pierde ese pedacito), y un tiron la sube de a 100 ms como mucho. Con todo a
 * tiempo, cada 2 s se acerca la mitad de lo que sobra.
 */
export class EsperaTalkback {
  objetivoMs = 150
  /** demoras de los ultimos 3 s (para el objetivo) */
  private recientes: { t: number; ms: number }[] = []
  /** demoras y tardes de los ultimos 500 pedazos (para el diagnostico) */
  private demoras: number[] = []
  private tardes: boolean[] = []
  private ultimoTarde = 0
  private ultimaBaja = 0

  static readonly MIN_MS = 80
  static readonly MAX_MS = 600
  /** margen sobre lo que tardan casi todos (lo que dura el pedazo y un poco mas) */
  static readonly MARGEN_MS = 40

  /** Un pedazo llego: `demoraMs` = cuanto tardo desde que se capto (con el reloj del servidor). */
  registrar(demoraMs: number, ahora = Date.now()): void {
    this.demoras.push(demoraMs)
    if (this.demoras.length > 500) this.demoras.shift()
    this.recientes.push({ t: ahora, ms: demoraMs })
    while (this.recientes.length && ahora - this.recientes[0].t > 3000) this.recientes.shift()
    // tarde: no llega a sonar entero
    const tarde = demoraMs > this.objetivoMs - 25
    this.tardes.push(tarde)
    if (this.tardes.length > 500) this.tardes.shift()
    if (tarde) {
      this.ultimoTarde = ahora
      // 3 de los ultimos 50 (1 s): el WiFi viene lento. Un tropezon suelto (un corte de 300 ms, el celular
      // ocupado) no la sube: esperar 300 ms de mas siempre por algo que pasa una vez no conviene
      if (this.tardes.slice(-50).filter(Boolean).length >= 3) {
        // de a lo sumo 100 ms por vez: si fue un tiron (el celular trabado medio segundo), no queda 500 ms atrasado
        const necesita = this.percentil(this.recientes.map((r) => r.ms), 0.98) + EsperaTalkback.MARGEN_MS
        this.objetivoMs = this.acotar(Math.min(this.objetivoMs + 100, Math.max(this.objetivoMs + 20, necesita)))
      }
      return
    }
    // 2 s con todo a tiempo: se acerca a lo que hace falta (la mitad de lo que sobra cada vez)
    if (ahora - this.ultimoTarde > 2000 && ahora - this.ultimaBaja > 2000 && this.recientes.length >= 50) {
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
      tardes: this.tardes.filter(Boolean).length
    }
  }
}

/**
 * Compu: toma la entrada elegida (microfono, o un cable virtual desde Reaper)
 * y, mientras se habla, manda los pedazos con su hora. La entrada queda
 * abierta despues del primer uso (asi apretar y hablar es instantaneo).
 */
export class EmisorTalkback {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private fuente: MediaStreamAudioSourceNode | null = null
  private nodo: AudioWorkletNode | null = null
  private abriendo: Promise<void> | null = null
  private entrada: string | null = null
  private n = 0
  hablando = false
  /** pico de lo que entra (0 a 1), aunque no se este hablando: para el vumetro */
  onNivel: ((pico: number) => void) | null = null

  constructor(
    private readonly enviar: (p: PedazoTalkback) => void,
    private readonly horaServidor: () => number
  ) {}

  /** Las entradas de audio de la compu (los nombres aparecen despues de dar permiso una vez). */
  static async entradas(): Promise<{ id: string; nombre: string }[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const lista = await navigator.mediaDevices.enumerateDevices()
    return lista.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, nombre: d.label || `Entrada ${i + 1}` }))
  }

  /** Abre la entrada (pide permiso la primera vez). `entrada` = deviceId; null = la de Windows por defecto. */
  abrir(entrada: string | null): Promise<void> {
    if (this.abriendo && entrada === this.entrada) return this.abriendo
    this.cerrar()
    this.entrada = entrada
    this.abriendo = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: entrada ? { exact: entrada } : undefined,
          channelCount: 1,
          // la voz del que habla, sin "procesar" el retorno (no hay parlantes en el talkback)
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await cargarProcesador(ctx, 'captura')
      const fuente = ctx.createMediaStreamSource(stream)
      const nodo = new AudioWorkletNode(ctx, 'captura-talkback', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
      fuente.connect(nodo)
      nodo.port.onmessage = (e: MessageEvent<{ t: number; muestras: Float32Array; pico: number }>) => {
        this.onNivel?.(e.data.pico)
        if (!this.hablando) return
        // hora del servidor en que se capto la primera muestra del pedazo
        const t = this.horaServidor() - (ctx.currentTime - e.data.t) * 1000 - (ctx.baseLatency || 0) * 1000
        this.enviar({ n: this.n++, t, pcm: aInt16(e.data.muestras).buffer as ArrayBuffer })
      }
      if (ctx.state === 'suspended') await ctx.resume()
      this.ctx = ctx
      this.stream = stream
      this.fuente = fuente
      this.nodo = nodo
    })()
    this.abriendo.catch(() => {
      this.abriendo = null
    })
    return this.abriendo
  }

  abierto(): boolean {
    return !!this.nodo
  }

  cerrar(): void {
    this.hablando = false
    this.nodo?.disconnect()
    this.fuente?.disconnect()
    for (const tr of this.stream?.getTracks() ?? []) tr.stop()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.stream = null
    this.fuente = null
    this.nodo = null
    this.abriendo = null
  }
}
