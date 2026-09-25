import os from 'node:os'

interface Candidata {
  nombre: string
  ip: string
  mascara: string
}

/** Adaptadores que no son la red del escenario (virtuales, VPN, Bluetooth...). */
const VIRTUAL = /vethernet|virtualbox|vbox|vmware|hyper-?v|docker|wsl|loopback|bluetooth|zerotier|tailscale|hamachi|vpn|utun|tun\d|tap\d|br-|virbr|npcap/i
const REAL = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i

function candidatas(): Candidata[] {
  const res: Candidata[] = []
  for (const [nombre, lista] of Object.entries(os.networkInterfaces())) {
    for (const iface of lista ?? []) {
      if (iface.family !== 'IPv4' || iface.internal || iface.address.startsWith('169.254.')) continue
      res.push({ nombre, ip: iface.address, mascara: iface.netmask })
    }
  }
  return res
}

function puntaje(c: Candidata): number {
  let p = 0
  if (VIRTUAL.test(c.nombre)) p -= 100
  if (REAL.test(c.nombre)) p += 10
  if (c.ip.startsWith('192.168.')) p += 5
  else if (c.ip.startsWith('10.')) p += 3
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.ip)) p += 1
  return p
}

/** IPs de la compu en la red local, la mas probable primero (WiFi/Ethernet real antes que adaptadores virtuales). */
export function direccionesLan(): string[] {
  return candidatas()
    .map((c, i) => ({ c, i }))
    .sort((a, b) => puntaje(b.c) - puntaje(a.c) || a.i - b.i)
    .map(({ c }) => c.ip)
}

/** La IP LAN mas probable de esta compu (la que va en el QR). */
export function getLanIp(): string | null {
  return direccionesLan()[0] ?? null
}

function aNumero(ip: string): number {
  return ip.split('.').reduce((n, parte) => ((n << 8) | (Number(parte) & 255)) >>> 0, 0)
}

/**
 * La IP de esta compu que un celular en `remota` puede alcanzar: la de la
 * interfaz que comparte subred con el. Si no hay ninguna (o `remota` es la
 * misma compu), la mas probable.
 */
export function ipParaCliente(remota: string | null | undefined): string | null {
  const limpia = (remota ?? '').replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(limpia) && !limpia.startsWith('127.')) {
    const r = aNumero(limpia)
    for (const c of candidatas()) {
      const m = aNumero(c.mascara)
      if ((aNumero(c.ip) & m) === (r & m)) return c.ip
    }
  }
  return getLanIp()
}
