import { leerTrama, RUTA_AUDIO_VIVO, type PedazoVivo } from '@shared/audioVivo'

/**
 * Celular: el WebSocket del audio en vivo (talkback y banda en vivo; ver
 * shared/audioVivo.ts). Se abre con la llave que da la compu por socket.io;
 * si se corta, se vuelve a abrir solo mientras la llave siga valiendo (con
 * otra conexion se pide otra llave).
 */
export class ReceptorVivo {
  private ws: WebSocket | null = null
  private llave: string | null = null
  private reintento: ReturnType<typeof setTimeout> | null = null
  /** cuantos pedazos llegaron por aca (diagnostico y pruebas) */
  pedazos = 0

  constructor(private readonly alRecibir: (p: PedazoVivo) => void) {}

  abrir(llave: string): void {
    // la misma llave, ya abierto o abriendose: nada que hacer
    if (llave === this.llave && (this.ws || this.reintento)) return
    this.cerrar()
    this.llave = llave
    this.conectar()
  }

  private conectar(): void {
    if (!this.llave || typeof WebSocket === 'undefined') return
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RUTA_AUDIO_VIVO}?llave=${encodeURIComponent(this.llave)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.reintentar()
      return
    }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer)) return
      const p = leerTrama(e.data)
      if (!p) return
      this.pedazos++
      this.alRecibir(p)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.reintentar()
    }
    this.ws = ws
  }

  private reintentar(): void {
    if (!this.llave || this.reintento) return
    this.reintento = setTimeout(() => {
      this.reintento = null
      this.conectar()
    }, 1000)
  }

  abierto(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  cerrar(): void {
    this.llave = null
    if (this.reintento) clearTimeout(this.reintento)
    this.reintento = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
  }
}
