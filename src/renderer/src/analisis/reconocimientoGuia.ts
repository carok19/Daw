import type { PedidoVoz } from '@shared/types'
import type { SocketClient } from '../sync/SocketClient'
import type { RespuestaWorker } from './reconocedor.worker'

/** Para las pruebas automaticas: un reconocedor falso inyectado en la pagina. */
type ReconocedorFalso = (audio: Float32Array, info: { proyectoId: string; n: number; inicioMs: number; finMs: number }) => Promise<string>

/**
 * Resuelve en la compu los pedidos de reconocimiento de la voz guia: baja el
 * audio de cada frase, lo pasa por Whisper (Worker) y le devuelve los textos
 * al servidor, que arma las secciones. De a una cancion por vez y nunca
 * mientras suena algo (no competir por CPU en vivo).
 */
export class ReconocimientoGuia {
  private cola: PedidoVoz[] = []
  private trabajando = false
  private worker: Worker | null = null
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

  private transcribir(audio: Float32Array): Promise<string> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./reconocedor.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<RespuestaWorker>) => {
        const espera = this.esperas.get(e.data.id)
        if (!espera) return
        this.esperas.delete(e.data.id)
        if ('error' in e.data) espera.mal(new Error(e.data.error))
        else espera.ok(e.data.texto)
      }
    }
    const id = this.siguienteId++
    return new Promise((ok, mal) => {
      this.esperas.set(id, { ok, mal })
      this.worker!.postMessage({ id, audio }, [audio.buffer])
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
        const textos: { n: number; texto: string }[] = []
        let fallo: string | null = null
        this.socket.emit('analisis:progreso', { proyectoId: pedido.proyectoId, hechos: 0, total: pedido.cues.length })
        for (const cue of pedido.cues) {
          await this.esperarSilencio()
          try {
            // sin cache: un "Detectar" nuevo reescribe los mismos nombres de archivo
            const resp = await fetch(`/media/${pedido.proyectoId}/${cue.archivo}`, { cache: 'no-store' })
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            const audio = new Float32Array(await resp.arrayBuffer())
            const texto = falso
              ? await falso(audio, { proyectoId: pedido.proyectoId, n: cue.n, inicioMs: cue.inicioMs, finMs: cue.finMs })
              : await this.transcribir(audio)
            textos.push({ n: cue.n, texto })
          } catch (err) {
            fallo = (err as Error).message
            break
          }
          this.socket.emit('analisis:progreso', { proyectoId: pedido.proyectoId, hechos: textos.length, total: pedido.cues.length })
        }
        if (fallo) this.socket.emit('analisis:fallo', { proyectoId: pedido.proyectoId, motivo: 'error', mensaje: `No se pudo reconocer la guía: ${fallo}` })
        else this.socket.emit('analisis:textos', { proyectoId: pedido.proyectoId, textos })
        this.cola = this.cola.filter((p) => p.proyectoId !== pedido.proyectoId)
      }
    } finally {
      this.trabajando = false
    }
  }
}
