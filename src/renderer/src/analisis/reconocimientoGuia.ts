import type { PedidoVoz } from '@shared/types'
import type { SocketClient } from '../sync/SocketClient'
import type { RespuestaWorker } from './reconocedor.worker'

/** Para las pruebas automaticas: un reconocedor falso inyectado en la pagina. */
type ReconocedorFalso = (audio: Float32Array, info: { proyectoId: string; n: number; inicioMs: number; finMs: number }) => Promise<string>

/**
 * Cuantos reconocedores a la vez (cada uno es un Worker con Whisper en un
 * solo hilo): con mas nucleos, mas frases en paralelo.
 */
function cuantosReconocedores(): number {
  const nucleos = navigator.hardwareConcurrency || 2
  return nucleos >= 8 ? 3 : nucleos >= 4 ? 2 : 1
}

/** Cada cuanto se mandan las secciones que ya se reconocieron (van apareciendo). */
const PARCIAL_CADA_MS = 2000

/**
 * Resuelve en la compu los pedidos de reconocimiento de la voz guia: baja el
 * audio de cada frase, lo pasa por Whisper (Workers, varios a la vez si la
 * compu tiene nucleos) y le va mandando los textos al servidor, que arma las
 * secciones (van apareciendo mientras tanto). De a una cancion por vez y
 * nunca mientras suena algo (no competir por CPU en vivo).
 */
export class ReconocimientoGuia {
  private cola: PedidoVoz[] = []
  private trabajando = false
  private workers: Worker[] = []
  private siguienteId = 1
  private esperas = new Map<number, { ok: (t: string) => void; mal: (e: Error) => void }>()
  private modeloListo = false

  constructor(
    private readonly socket: SocketClient,
    private readonly sonando: () => boolean
  ) {}

  setModeloListo(listo: boolean): void {
    this.modeloListo = listo
    if (listo) void this.procesar()
  }

  setPedidos(pedidos: PedidoVoz[]): void {
    this.cola = pedidos.filter((p) => p.cues.length > 0)
    void this.procesar()
  }

  private falso(): ReconocedorFalso | null {
    return (window as unknown as { __asrFalso?: ReconocedorFalso }).__asrFalso ?? null
  }

  /** Reconoce con el Worker `k` (cada uno procesa sus frases de a una). */
  private transcribir(audio: Float32Array, k: number): Promise<string> {
    while (this.workers.length <= k) {
      const w = new Worker(new URL('./reconocedor.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<RespuestaWorker>) => {
        const espera = this.esperas.get(e.data.id)
        if (!espera) return
        this.esperas.delete(e.data.id)
        if ('error' in e.data) espera.mal(new Error(e.data.error))
        else espera.ok(e.data.texto)
      }
      this.workers.push(w)
    }
    const id = this.siguienteId++
    return new Promise((ok, mal) => {
      this.esperas.set(id, { ok, mal })
      this.workers[k].postMessage({ id, audio }, [audio.buffer])
    })
  }

  private async esperarSilencio(): Promise<void> {
    while (this.sonando()) await new Promise((r) => setTimeout(r, 1500))
  }

  private async procesar(): Promise<void> {
    if (this.trabajando) return
    this.trabajando = true
    try {
      while (this.cola.length) {
        const falso = this.falso()
        const pedido = this.cola[0]
        if (!falso && !this.modeloListo) {
          this.socket.emit('analisis:fallo', { proyectoId: pedido.proyectoId, motivo: 'falta-modelo' })
          this.cola.shift()
          continue
        }
        await this.esperarSilencio()
        const textos = new Map<number, string>()
        let fallo: string | null = null
        let siguiente = 0
        let enviadas = 0
        let ultimoParcial = Date.now()
        const total = pedido.cues.length
        this.socket.emit('analisis:progreso', { proyectoId: pedido.proyectoId, hechos: 0, total })
        // las secciones de lo que ya se reconocio, en orden (sin huecos: una cuenta que falta correria la seccion)
        const mandarParcial = (): void => {
          let listas = 0
          while (listas < total && textos.has(pedido.cues[listas].n)) listas++
          if (listas <= enviadas || listas === total || Date.now() - ultimoParcial < PARCIAL_CADA_MS) return
          enviadas = listas
          ultimoParcial = Date.now()
          const parcial = pedido.cues.slice(0, listas).map((c) => ({ n: c.n, texto: textos.get(c.n)! }))
          this.socket.emit('analisis:parcial', { proyectoId: pedido.proyectoId, textos: parcial })
        }
        const trabajar = async (k: number): Promise<void> => {
          while (!fallo && siguiente < total) {
            const cue = pedido.cues[siguiente++]
            await this.esperarSilencio()
            try {
              // sin cache: un "Detectar" nuevo reescribe los mismos nombres de archivo
              const resp = await fetch(`/media/${pedido.proyectoId}/${cue.archivo}`, { cache: 'no-store' })
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
              const audio = new Float32Array(await resp.arrayBuffer())
              const texto = falso
                ? await falso(audio, { proyectoId: pedido.proyectoId, n: cue.n, inicioMs: cue.inicioMs, finMs: cue.finMs })
                : await this.transcribir(audio, k)
              textos.set(cue.n, texto)
            } catch (err) {
              fallo ??= (err as Error).message
              return
            }
            this.socket.emit('analisis:progreso', { proyectoId: pedido.proyectoId, hechos: textos.size, total })
            mandarParcial()
          }
        }
        await Promise.all(Array.from({ length: Math.min(total, cuantosReconocedores()) }, (_, k) => trabajar(k)))
        if (fallo) this.socket.emit('analisis:fallo', { proyectoId: pedido.proyectoId, motivo: 'error', mensaje: `No se pudo reconocer la guía: ${fallo}` })
        else this.socket.emit('analisis:textos', { proyectoId: pedido.proyectoId, textos: pedido.cues.map((c) => ({ n: c.n, texto: textos.get(c.n)! })) })
        this.cola = this.cola.filter((p) => p.proyectoId !== pedido.proyectoId)
      }
    } finally {
      this.trabajando = false
    }
  }
}
