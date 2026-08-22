import os from 'node:os'

/** Primera IP LAN no interna (IPv4). Si hay varias interfaces, se usa la primera que aparezca. */
export function getLanIp(): string | null {
  const interfaces = os.networkInterfaces()
  for (const nombre of Object.keys(interfaces)) {
    for (const iface of interfaces[nombre] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}
