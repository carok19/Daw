import crypto from 'node:crypto'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { RUTA_AUDIO_VIVO } from '../shared/audioVivo'

/**
 * Si un celular tiene esto sin mandar todavia, viene atrasado (el WiFi se
 * trabo): el pedazo se descarta en vez de acumularse (lo que llegue tarde ya
 * no suena). ~160 ms de audio.
 */
const ATRASO_MAX_BYTES = 16 * 1024

/**
 * El WebSocket de la consola en vivo (instrumentos, voces y talkback; ver
 * shared/audioVivo.ts). Cada celular conectado por socket.io pide una llave
 * y con ella abre ws://compu/audio-vivo?llave=…: asi solo entra quien
 * ya paso el codigo de la banda, y el servidor sabe que celular es (su rol:
 * la consola y multimedia no lo reciben).
 */
export class AudioVivo {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 })
  /** llave -> socket.io del celular */
  private readonly llaves = new Map<string, string>()
  /** socket.io del celular -> su WebSocket de audio */
  private readonly conexiones = new Map<string, WebSocket>()

  constructor(private readonly servidor: http.Server) {
    servidor.on('upgrade', this.alPedir)
  }

  private readonly alPedir = (req: http.IncomingMessage, socket: Duplex, cabeza: Buffer): void => {
    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://compu')
    } catch {
      return
    }
    // lo demas (socket.io) no es de aca
    if (url.pathname !== RUTA_AUDIO_VIVO) return
    const llave = url.searchParams.get('llave') ?? ''
    const socketId = this.llaves.get(llave)
    if (!socketId) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    this.wss.handleUpgrade(req, socket, cabeza, (ws) => {
      // se desconecto mientras se abria
      if (this.llaves.get(llave) !== socketId) return ws.terminate()
      this.conexiones.get(socketId)?.terminate()
      this.conexiones.set(socketId, ws)
      ws.on('close', () => {
        if (this.conexiones.get(socketId) === ws) this.conexiones.delete(socketId)
      })
      ws.on('error', () => undefined)
    })
  }

  /** La llave de un celular conectado (la misma mientras siga conectado por socket.io). */
  llaveDe(socketId: string): string {
    for (const [llave, id] of this.llaves) if (id === socketId) return llave
    const llave = crypto.randomBytes(16).toString('hex')
    this.llaves.set(llave, socketId)
    return llave
  }

  /** El celular se fue: su llave ya no sirve y su audio se corta. */
  olvidar(socketId: string): void {
    for (const [llave, id] of this.llaves) if (id === socketId) this.llaves.delete(llave)
    this.conexiones.get(socketId)?.terminate()
    this.conexiones.delete(socketId)
  }

  /**
   * Manda una trama a un celular por su WebSocket de audio. false = ese
   * celular no lo tiene abierto (va por socket.io). Si viene atrasado, se
   * descarta (y cuenta como mandada).
   */
  enviar(socketId: string, trama: Uint8Array): boolean {
    const ws = this.conexiones.get(socketId)
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount < ATRASO_MAX_BYTES) ws.send(trama, { binary: true })
    return true
  }

  /** Cuantos celulares tienen abierto el audio en vivo (para las pruebas). */
  abiertos(): number {
    return this.conexiones.size
  }

  cerrar(): void {
    this.servidor.off('upgrade', this.alPedir)
    for (const ws of this.conexiones.values()) ws.terminate()
    this.conexiones.clear()
    this.llaves.clear()
    this.wss.close()
  }
}
