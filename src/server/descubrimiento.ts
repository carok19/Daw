import dgram from 'node:dgram'
import makeMdns from 'multicast-dns'
import type { RemoteInfo } from 'node:dgram'
import { ipParaCliente } from './network'

/**
 * Como encuentran los celulares a la compu sin QR (todo por el WiFi, sin internet):
 *
 *  - Nombre fijo "alabanza.local" (mDNS/Bonjour): la compu responde con su IP
 *    a quien pregunte por ese nombre. En iPhone funciona en Safari, asi que
 *    el icono guardado en la pantalla de inicio anda aunque cambie la IP.
 *  - Servicio "_multitrack._tcp" (mDNS): lo busca la app Android (NsdManager).
 *  - Pregunta por difusion UDP ("MULTITRACK-ALABANZA?" al puerto 48480): el
 *    respaldo de la app Android para los celulares o routers donde mDNS falla.
 *
 * A cada uno se le responde con la IP de la compu que esta en SU misma red
 * (una compu con varios adaptadores no da una IP inalcanzable).
 */

export const NOMBRE_FIJO = 'alabanza.local'
export const TIPO_SERVICIO = '_multitrack._tcp.local'
export const PUERTO_DESCUBRIMIENTO = 48480
export const PREGUNTA_UDP = 'MULTITRACK-ALABANZA?'

export interface InfoAnuncio {
  /** nombre visible ("Multitrack Alabanza · PC-IGLESIA") */
  nombre: string
  puerto: number
  id: string
  version: string
  requiereCodigo: boolean
}

export interface OpcionesDescubrimiento {
  /** puerto mDNS (5353; los tests usan otro) */
  puertoMdns?: number
  puertoUdp?: number
}

function instancia(info: InfoAnuncio): string {
  // etiqueta DNS: sin puntos
  return `${info.nombre.replace(/\./g, ' ').slice(0, 60)}.${TIPO_SERVICIO}`
}

type Respuesta = { answers: makeMdns.ResponseOutgoingPacket['answers']; additionals: NonNullable<makeMdns.ResponseOutgoingPacket['additionals']> }

/** Arma la respuesta mDNS a una pregunta (exportada para probarla sin red). */
export function responderMdns(
  preguntas: { name: string; type: string }[],
  info: InfoAnuncio,
  ip: string
): Respuesta | null {
  const inst = instancia(info)
  const a = { name: NOMBRE_FIJO, type: 'A' as const, ttl: 120, data: ip }
  const srv = { name: inst, type: 'SRV' as const, ttl: 120, data: { port: info.puerto, target: NOMBRE_FIJO } }
  const txt = {
    name: inst,
    type: 'TXT' as const,
    ttl: 120,
    data: [`id=${info.id}`, `v=${info.version}`, `codigo=${info.requiereCodigo ? 1 : 0}`, 'app=multitrack-alabanza']
  }
  const ptr = { name: TIPO_SERVICIO, type: 'PTR' as const, ttl: 120, data: inst }
  const answers: Respuesta['answers'] = []
  const additionals: Respuesta['additionals'] = []
  for (const q of preguntas) {
    const nombre = q.name.toLowerCase().replace(/\.$/, '')
    const tipo = q.type
    if (nombre === NOMBRE_FIJO && (tipo === 'A' || tipo === 'ANY')) answers.push(a)
    else if (nombre === TIPO_SERVICIO && (tipo === 'PTR' || tipo === 'ANY')) {
      answers.push(ptr)
      additionals.push(srv, txt, a)
    } else if (nombre === inst.toLowerCase() && (tipo === 'SRV' || tipo === 'ANY')) {
      answers.push(srv)
      additionals.push(a)
    } else if (nombre === inst.toLowerCase() && tipo === 'TXT') answers.push(txt)
  }
  return answers.length ? { answers, additionals } : null
}

export class Descubrimiento {
  private mdns: makeMdns.MulticastDNS | null = null
  private udp: dgram.Socket | null = null

  constructor(
    private readonly info: () => InfoAnuncio,
    private readonly opciones: OpcionesDescubrimiento = {}
  ) {}

  iniciar(): void {
    this.iniciarMdns()
    this.iniciarUdp()
  }

  private iniciarMdns(): void {
    try {
      const m = makeMdns({ port: this.opciones.puertoMdns ?? 5353, reuseAddr: true, loopback: true })
      m.on('error', () => undefined)
      m.on('warning', () => undefined)
      m.on('query', (paquete: makeMdns.QueryPacket, rinfo: RemoteInfo) => {
        const ip = ipParaCliente(rinfo.address)
        if (!ip) return
        const r = responderMdns(paquete.questions ?? [], this.info(), ip)
        if (!r) return
        // pregunta "legacy" (no desde el puerto mDNS): se contesta directo a quien pregunto
        if (rinfo.port !== (this.opciones.puertoMdns ?? 5353)) m.respond({ id: paquete.id, ...r }, rinfo)
        else m.respond(r)
      })
      this.mdns = m
    } catch {
      this.mdns = null // sin mDNS: quedan el QR y la busqueda por UDP
    }
  }

  private iniciarUdp(): void {
    try {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      s.on('error', () => {
        try {
          s.close()
        } catch {
          // ya cerrado
        }
        if (this.udp === s) this.udp = null
      })
      s.on('message', (msg, rinfo) => {
        if (!msg.toString('utf8').startsWith(PREGUNTA_UDP)) return
        const info = this.info()
        const respuesta = JSON.stringify({
          app: 'multitrack-alabanza',
          nombre: info.nombre,
          ip: ipParaCliente(rinfo.address),
          puerto: info.puerto,
          id: info.id,
          version: info.version,
          requiereCodigo: info.requiereCodigo
        })
        s.send(respuesta, rinfo.port, rinfo.address)
      })
      s.bind(this.opciones.puertoUdp ?? PUERTO_DESCUBRIMIENTO)
      this.udp = s
    } catch {
      this.udp = null
    }
  }

  detener(): void {
    try {
      this.mdns?.destroy()
    } catch {
      // ya cerrado
    }
    try {
      this.udp?.close()
    } catch {
      // ya cerrado
    }
    this.mdns = null
    this.udp = null
  }
}
