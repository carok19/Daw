/**
 * Licencias: una linea de texto que se manda por WhatsApp o mail y se pega en
 * la compu. Se verifica sin internet: esta firmada (Ed25519) con la clave
 * privada del vendedor, que nunca sale de su computadora; la app solo trae la
 * clave publica (licencias/clave-publica.txt), que sirve para verificar pero
 * no para crear licencias.
 *
 *   LIC1.<datos en base64url>.<firma en base64url>
 *
 * Lo usan la app (para verificar) y el generador de licencias (para crear).
 */

export const PREFIJO_LICENCIA = 'LIC1'

/** Sin licencia (version de prueba): cuantos celulares pueden estar conectados a la vez. */
export const CELULARES_PRUEBA = 2

export interface DatosLicencia {
  v: 1
  /** id unico de la licencia */
  id: string
  /** a quien se vendio (iglesia, banda, persona) */
  nombre: string
  email?: string
  /** celulares a la vez (0 = sin limite) */
  celulares: number
  /** AAAA-MM-DD */
  emitida: string
  /** AAAA-MM-DD; sin vencimiento si falta */
  vence?: string
  /** solo sirve en la compu con este codigo ("EQ-XXXX-XXXX-XXXX"); en cualquiera si falta */
  equipo?: string
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/
const EQUIPO_RE = /^EQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/

export function aBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function deBase64Url(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) return null
  try {
    const b64 = texto.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (texto.length % 4)) % 4)
    const bin = atob(b64)
    const res = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) res[i] = bin.charCodeAt(i)
    return res
  } catch {
    return null
  }
}

/** Los bytes que se firman: el JSON de los datos (en base64url, tal como viaja). */
export function datosAFirmar(datos: DatosLicencia): string {
  return aBase64Url(new TextEncoder().encode(JSON.stringify(datos)))
}

/** Arma la linea de la licencia con los datos y la firma. */
export function armarLicencia(datosB64: string, firma: Uint8Array): string {
  return `${PREFIJO_LICENCIA}.${datosB64}.${aBase64Url(firma)}`
}

/** Una firma Ed25519 (64 bytes) en base64url sin relleno: siempre 86 caracteres. */
const LARGO_FIRMA = 86

/**
 * Separa una licencia pegada (tolera espacios, saltos de linea y texto
 * alrededor, como queda al copiarla de un chat: al sacar los espacios, el
 * texto de despues queda pegado a la firma, por eso la firma se corta en
 * su largo exacto). null si no hay ninguna.
 */
export function separarLicencia(texto: string): { texto: string; datosB64: string; firma: Uint8Array } | null {
  const limpio = texto.replace(/\s+/g, '')
  const m = new RegExp(`${PREFIJO_LICENCIA}\\.([A-Za-z0-9_-]{20,4000})\\.([A-Za-z0-9_-]{${LARGO_FIRMA}})`).exec(limpio)
  if (!m) return null
  const firma = deBase64Url(m[2])
  if (!firma || firma.length !== 64) return null
  return { texto: m[0], datosB64: m[1], firma }
}

/** Lee y valida los datos (sin verificar la firma). null si no son datos de licencia. */
export function leerDatos(datosB64: string): DatosLicencia | null {
  const bytes = deBase64Url(datosB64)
  if (!bytes) return null
  try {
    const d = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DatosLicencia>
    if (d.v !== 1 || typeof d.id !== 'string' || !d.id || typeof d.nombre !== 'string' || !d.nombre.trim()) return null
    if (typeof d.celulares !== 'number' || !Number.isInteger(d.celulares) || d.celulares < 0) return null
    if (typeof d.emitida !== 'string' || !FECHA_RE.test(d.emitida)) return null
    if (d.vence !== undefined && (typeof d.vence !== 'string' || !FECHA_RE.test(d.vence))) return null
    if (d.equipo !== undefined && (typeof d.equipo !== 'string' || !EQUIPO_RE.test(d.equipo))) return null
    if (d.email !== undefined && typeof d.email !== 'string') return null
    return d as DatosLicencia
  } catch {
    return null
  }
}

/** Codigo de equipo escrito a mano ("eq 4f3a-9c21 7b55" -> "EQ-4F3A-9C21-7B55"); null si no es uno. */
export function normalizarEquipo(texto: string): string | null {
  const hex = texto.toUpperCase().replace(/^\s*EQ/, '').replace(/[^0-9A-F]/g, '')
  if (hex.length !== 12) return null
  return `EQ-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

/** Clave publica (32 bytes en base64url) a partir del texto del archivo: ignora comentarios (#) y lineas vacias. */
export function leerClavePublica(texto: string | null | undefined): Uint8Array | null {
  if (!texto) return null
  const linea = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  if (!linea) return null
  const bytes = deBase64Url(linea)
  return bytes && bytes.length === 32 ? bytes : null
}
