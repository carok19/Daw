import dgram from 'node:dgram'
import os from 'node:os'

/** Los mismos de la compu de AirTracks (server/descubrimiento.ts; los usa tambien la app Android). */
export const PUERTO_DESCUBRIMIENTO = 48480
const PREGUNTA = 'MULTITRACK-ALABANZA?'

export interface CompuEncontrada {
  /** http://ip:puerto */
  url: string
  nombre: string
  id: string
  requiereCodigo: boolean
}

/** Direcciones de difusion de cada red de esta compu (192.168.1.255...). */
function difusiones(): string[] {
  const res: string[] = []
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue
      const ip = i.address.split('.').map(Number)
      const mascara = i.netmask.split('.').map(Number)
      res.push(ip.map((b, k) => (b | (~mascara[k] & 255)) & 255).join('.'))
    }
  }
  return res
}

/**
 * Busca la compu de AirTracks en la red: pregunta por difusion UDP (como la
 * app Android) y junta las que contestan en `esperaMs`. Sin internet.
 */
export function buscarCompu(esperaMs = 2500, puerto = PUERTO_DESCUBRIMIENTO): Promise<CompuEncontrada[]> {
  return new Promise((resolve) => {
    const encontradas = new Map<string, CompuEncontrada>()
    const s = dgram.createSocket('udp4')
    let listo = false
    const terminar = (): void => {
      if (listo) return
      listo = true
      try {
        s.close()
      } catch {
        // ya cerrado
      }
      resolve([...encontradas.values()])
    }
    s.on('error', terminar)
    s.on('message', (msg, rinfo) => {
      try {
        const r = JSON.parse(msg.toString('utf8')) as Record<string, unknown>
        if (r?.app !== 'multitrack-alabanza' || typeof r.puerto !== 'number') return
        const ip = typeof r.ip === 'string' && r.ip ? r.ip : rinfo.address
        const url = `http://${ip}:${r.puerto}`
        const id = typeof r.id === 'string' ? r.id : url
        encontradas.set(id, { url, id, nombre: typeof r.nombre === 'string' ? r.nombre : 'AirTracks', requiereCodigo: !!r.requiereCodigo })
      } catch {
        // no es una respuesta de AirTracks
      }
    })
    s.bind(0, () => {
      try {
        s.setBroadcast(true)
      } catch {
        // sin difusion: igual se prueba en esta misma compu
      }
      const msg = Buffer.from(PREGUNTA)
      // (127.0.0.1: AirTracks abierto en esta misma compu, para probar)
      for (const destino of new Set(['255.255.255.255', ...difusiones(), '127.0.0.1'])) s.send(msg, puerto, destino, () => undefined)
      setTimeout(terminar, esperaMs)
    })
  })
}
