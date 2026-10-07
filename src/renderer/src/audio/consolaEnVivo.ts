import type { MedicionVivo } from '@shared/types'

/**
 * "Consola en vivo": lo que sale de la consola (instrumentos, voces y el
 * microfono del talkback, todo en una mezcla) a los oidos de la banda, como
 * un fader mas de "Mi mezcla". Se prende en la compu y queda prendido hasta
 * que alguien lo apague. La compu toma la entrada elegida (una interface o
 * la placa de sonido, y cual de sus entradas) y la manda tal cual en pedazos
 * de 10 ms por el WiFi, cada uno con la hora (del servidor) en que se capto;
 * tambien el silencio, asi el WiFi del celular no se "duerme". Cada celular
 * lo reproduce `objetivoMs` despues de esa hora: asi el WiFi puede demorar
 * un pedazo y otro no, y igual se escucha parejo. El objetivo se ajusta solo
 * (de 30 a 600 ms).
 */

/**
 * Captura (AudioWorklet): lo que sale de la consola tal cual, sin filtrar ni
 * bajar la frecuencia (la de la compu, casi siempre 48 kHz, la misma que los
 * celulares: ni la compu ni el celular la tienen que cambiar); manda pedazos
 * de 10 ms con su hora (del AudioContext).
 */
const CODIGO_CAPTURA = `
registerProcessor('captura-vivo', class extends AudioWorkletProcessor {
  constructor() {
    super()
    this.largo = Math.round(sampleRate / 100)
    this.pedazo = new Float32Array(this.largo)
    this.n = 0
    this.t0 = 0
    this.pico = 0
  }
  process(inputs) {
    const entrada = inputs[0] && inputs[0][0]
    if (!entrada) return true
    for (let i = 0; i < entrada.length; i++) {
      if (this.n === 0) this.t0 = currentTime + i / sampleRate
      const x = entrada[i]
      this.pedazo[this.n++] = x
      const a = x < 0 ? -x : x
      if (a > this.pico) this.pico = a
      if (this.n === this.largo) {
        this.port.postMessage({ t: this.t0, muestras: this.pedazo, pico: this.pico }, [this.pedazo.buffer])
        this.pedazo = new Float32Array(this.largo)
        this.n = 0
        this.pico = 0
      }
    }
    return true
  }
})
`

const cargados = new WeakSet<BaseAudioContext>()

/**
 * Carga (una vez por AudioContext) el procesador que toma la consola en la
 * compu (la compu abre su pagina en localhost: ahi el navegador si habilita
 * los AudioWorklet; los celulares, por http:// en la red local, no: ellos
 * reproducen sin worklet, ver StreamingEngine.recibirVivo).
 */
export async function cargarProcesador(ctx: BaseAudioContext): Promise<void> {
  if (cargados.has(ctx)) return
  const url = URL.createObjectURL(new Blob([CODIGO_CAPTURA], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    cargados.add(ctx)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Float32 (-1..1) a Int16 (lo que viaja por el WiFi: a 48 kHz, 960 bytes por pedazo, 768 kbps por celular). */
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
export interface PedazoCaptura {
  /** numero de pedazo (para ver si se pierde alguno) */
  n: number
  /** hora del servidor en que se capto la primera muestra */
  t: number
  /** muestras por segundo (las de la compu) */
  sr: number
  /** 10 ms de muestras Int16, una sola via */
  pcm: ArrayBuffer
}

/**
 * La espera del celular, que se ajusta sola para que la consola llegue lo
 * antes posible sin cortarse. Cada pedazo tiene que sonar `objetivoMs` despues de
 * captado; para eso hace falta lo que tardo en llegar por el WiFi mas lo que
 * tarda el celular en sacar el audio (su salida). La espera va a lo que
 * necesitan casi todos los pedazos de los ultimos 2 s (el 98 %) mas 15 ms: si
 * llegan tarde tres en un segundo se sube enseguida (de a 60 ms como mucho);
 * un tropezon suelto no (se pierden esos 10 ms); con todo a tiempo, cada
 * segundo se acerca la mitad de lo que sobra.
 */
export class EsperaVivo {
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
    const tarde = necesita > this.objetivoMs - EsperaVivo.HOLGURA_MS
    this.tardes.push(tarde)
    if (this.tardes.length > 500) this.tardes.shift()
    if (tarde) {
      this.ultimoTarde = ahora
      this.tardesRecientes.push(ahora)
      while (this.tardesRecientes.length && ahora - this.tardesRecientes[0] > 1000) this.tardesRecientes.shift()
      // 3 en un segundo: el WiFi viene lento. Uno suelto no la sube (esperar de mas siempre por algo que pasa una vez no conviene)
      if (this.tardesRecientes.length >= 3) {
        const meta = this.percentil(this.recientes.map((r) => r.ms), 0.98) + EsperaVivo.MARGEN_MS
        // de a lo sumo 60 ms por vez: si fue un tiron (el celular trabado un momento), no queda muy atrasado
        this.objetivoMs = this.acotar(Math.min(this.objetivoMs + 60, Math.max(this.objetivoMs + 10, meta)))
        this.tardesRecientes = []
      }
      return
    }
    // 1,5 s con todo a tiempo: cada segundo se acerca a lo justo (la mitad de lo que sobra)
    if (ahora - this.ultimoTarde > 1500 && ahora - this.ultimaBaja > 1000 && this.recientes.length >= 50) {
      const meta = this.acotar(this.percentil(this.recientes.map((r) => r.ms), 0.98) + EsperaVivo.MARGEN_MS)
      if (meta < this.objetivoMs) {
        this.objetivoMs = Math.max(meta, Math.round((this.objetivoMs + meta) / 2))
        this.ultimaBaja = ahora
      }
    }
  }

  private acotar(ms: number): number {
    return Math.min(EsperaVivo.MAX_MS, Math.max(EsperaVivo.MIN_MS, Math.round(ms)))
  }

  private percentil(valores: number[], p: number): number {
    if (valores.length === 0) return 0
    const orden = [...valores].sort((a, b) => a - b)
    return orden[Math.min(orden.length - 1, Math.floor(p * orden.length))]
  }

  medicion(): MedicionVivo {
    return {
      objetivoMs: Math.round(this.objetivoMs),
      redMs: this.demoras.length ? Math.round(this.percentil(this.demoras, 0.95)) : null,
      salidaMs: Math.round(this.salidaMs),
      tardes: this.tardes.filter(Boolean).length
    }
  }
}

/** De donde se toma la consola. */
export interface OpcionesEntrada {
  /** el dispositivo (deviceId): una interface, la placa de sonido; null = la de Windows por defecto */
  entrada: string | null
  /** que entrada de la interface (0 = la 1, 1 = la 2…); null = todas juntas (estereo: izquierda y derecha) */
  canal: number | null
}

/** Los ids que Chrome agrega aparte en Windows ("Predeterminado", "Comunicaciones"): ya estan como "la de Windows". */
const IDS_DE_WINDOWS = ['default', 'communications']

/**
 * Compu: toma la entrada elegida y, mientras la consola en vivo esta
 * prendida, manda los pedazos con su hora. La entrada queda abierta despues
 * del primer uso (asi prenderla es instantaneo).
 */
export class EmisorVivo {
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
    private readonly enviar: (p: PedazoCaptura) => void,
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
          // tal cual: "mejorar" la senal le arruina la musica y suma demora
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await cargarProcesador(ctx)
      const fuente = ctx.createMediaStreamSource(stream)
      const nodo = new AudioWorkletNode(ctx, 'captura-vivo', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
      // la entrada elegida de la interface, o el promedio de todas
      const canales = Math.max(1, stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1)
      const nodos: AudioNode[] = []
      if (canales > 1) {
        const division = ctx.createChannelSplitter(canales)
        const mezcla = ctx.createGain()
        mezcla.channelCount = 1
        mezcla.channelCountMode = 'explicit'
        fuente.connect(division)
        if (op.canal !== null && op.canal < canales) division.connect(mezcla, op.canal)
        else {
          mezcla.gain.value = 1 / canales
          for (let k = 0; k < canales; k++) division.connect(mezcla, k)
        }
        mezcla.connect(nodo)
        nodos.push(division, mezcla)
      } else fuente.connect(nodo)
      nodo.port.onmessage = (e: MessageEvent<{ t: number; muestras: Float32Array; pico: number }>) => {
        this.onNivel?.(e.data.pico)
        // cada pedazo lleva su numero aunque no viaje: el celular sabe que hubo un hueco
        const n = this.n++
        if (!this.enviando) return
        // hora del servidor en que se capto la primera muestra del pedazo
        const t = this.horaServidor() - (ctx.currentTime - e.data.t) * 1000 - (ctx.baseLatency || 0) * 1000
        const pcm = aInt16(e.data.muestras).buffer as ArrayBuffer
        this.enviar({ n, t, sr: ctx.sampleRate, pcm })
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
