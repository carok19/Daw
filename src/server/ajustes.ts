import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { appBaseDir } from './projects'

/**
 * Ajustes de la conexion de los celulares, guardados en la compu
 * (~/MultitrackApp/ajustes.json): el codigo de la banda, el WiFi para
 * invitar y un id propio de esta instalacion (para que la app Android la
 * reconozca aunque cambie de IP).
 */

export interface WifiInvitacion {
  ssid: string
  clave: string
}

export interface Ajustes {
  /** codigo que piden los celulares al conectarse (null = sin codigo) */
  codigoBanda: string | null
  wifi: WifiInvitacion | null
  idInstalacion: string
}

function ruta(): string {
  return path.join(appBaseDir(), 'ajustes.json')
}

export function leerAjustes(): Ajustes {
  let datos: Partial<Ajustes> = {}
  try {
    datos = JSON.parse(fs.readFileSync(ruta(), 'utf-8')) as Partial<Ajustes>
  } catch {
    // primera vez
  }
  const ajustes: Ajustes = {
    codigoBanda: normalizarCodigo(datos.codigoBanda),
    wifi: datos.wifi && typeof datos.wifi.ssid === 'string' && datos.wifi.ssid ? { ssid: datos.wifi.ssid, clave: String(datos.wifi.clave ?? '') } : null,
    idInstalacion: typeof datos.idInstalacion === 'string' && datos.idInstalacion ? datos.idInstalacion : crypto.randomUUID()
  }
  if (!datos.idInstalacion) guardarAjustes(ajustes)
  return ajustes
}

export function guardarAjustes(a: Ajustes): void {
  try {
    fs.mkdirSync(appBaseDir(), { recursive: true })
    const tmp = `${ruta()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2))
    fs.renameSync(tmp, ruta())
  } catch {
    // no es critico
  }
}

/** 4 a 8 digitos; cualquier otra cosa = sin codigo. */
export function normalizarCodigo(c: unknown): string | null {
  if (typeof c !== 'string') return null
  const limpio = c.replace(/\s+/g, '')
  return /^\d{4,8}$/.test(limpio) ? limpio : null
}
