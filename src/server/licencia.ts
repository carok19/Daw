import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { EstadoLicencia } from '../shared/types'
import { CELULARES_PRUEBA, leerClavePublica, leerDatos, separarLicencia, type DatosLicencia } from '../shared/licencia'
import { appBaseDir } from './projects'
import textoClavePublica from '../../licencias/clave-publica.txt'

/**
 * Licencias de la compu (ver shared/licencia.ts). Todo sin internet:
 *  - si la app no trae clave publica (licencias/clave-publica.txt vacio), no
 *    hay licencias: todo funciona sin limites;
 *  - con clave publica y sin licencia (o vencida): version de prueba, con
 *    hasta CELULARES_PRUEBA celulares a la vez;
 *  - con licencia valida: los celulares que diga (0 = sin limite).
 */

/** Prefijo DER de una clave publica Ed25519 (SPKI) + los 32 bytes de la clave. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export type ResultadoVerificacion = { ok: true; datos: DatosLicencia } | { ok: false; error: string }

/**
 * Verifica una licencia pegada: firma, formato, vencimiento y equipo.
 * `hoy` en AAAA-MM-DD (los tests lo fijan).
 */
export function verificarLicencia(texto: string, clavePublica: Uint8Array, equipo: string, hoy = fechaHoy()): ResultadoVerificacion {
  const partes = separarLicencia(texto)
  if (!partes) return { ok: false, error: 'Eso no es una licencia (tiene que empezar con LIC1.)' }
  let valida = false
  try {
    const clave = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(clavePublica)]), format: 'der', type: 'spki' })
    valida = crypto.verify(null, Buffer.from(partes.datosB64, 'utf8'), clave, Buffer.from(partes.firma))
  } catch {
    valida = false
  }
  if (!valida) return { ok: false, error: 'La licencia no es válida (está incompleta o no es de este programa)' }
  const datos = leerDatos(partes.datosB64)
  if (!datos) return { ok: false, error: 'La licencia no es válida' }
  if (datos.vence && datos.vence < hoy) return { ok: false, error: `La licencia venció el ${fechaLegible(datos.vence)}` }
  if (datos.equipo && datos.equipo !== equipo) return { ok: false, error: `Esta licencia es para otra computadora (${datos.equipo})` }
  return { ok: true, datos }
}

function fechaHoy(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fechaLegible(aaaammdd: string): string {
  const [a, m, d] = aaaammdd.split('-')
  return `${d}/${m}/${a}`
}

let equipoCache: string | null = null

/**
 * Codigo de esta computadora, para licencias atadas a una compu: sale del id
 * que el sistema operativo le da a la instalacion (no cambia al reiniciar ni
 * al cambiar de red; si al reinstalar Windows).
 */
export function idEquipo(): string {
  if (equipoCache) return equipoCache
  let base = ''
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
      })
      base = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? ''
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 })
      base = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? ''
    } else {
      base = fs.readFileSync('/etc/machine-id', 'utf8').trim()
    }
  } catch {
    base = ''
  }
  if (!base) base = `${os.hostname()}|${os.platform()}|${os.cpus()[0]?.model ?? ''}`
  const h = crypto.createHash('sha256').update(`multitrack-alabanza:${base}`).digest('hex').toUpperCase()
  equipoCache = `EQ-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`
  return equipoCache
}

export class Licencias {
  private readonly clave: Uint8Array | null
  private texto: string | null = null
  private resultado: ResultadoVerificacion | null = null

  /** `clavePublica`: undefined = la que trae la app; null = sin licencias (tests). */
  constructor(clavePublica?: string | null) {
    this.clave = leerClavePublica(clavePublica === undefined ? textoClavePublica : clavePublica)
    try {
      this.texto = fs.readFileSync(this.ruta(), 'utf-8')
    } catch {
      this.texto = null
    }
    this.revisar()
  }

  private ruta(): string {
    return path.join(appBaseDir(), 'licencia.txt')
  }

  /** Se vuelve a revisar (p.ej. la licencia pudo vencer mientras la app estaba abierta). */
  private revisar(): void {
    this.resultado = this.clave && this.texto ? verificarLicencia(this.texto, this.clave, idEquipo()) : null
  }

  configuradas(): boolean {
    return this.clave !== null
  }

  /** Cuantos celulares pueden estar conectados a la vez (null = sin limite). */
  limiteCelulares(): number | null {
    if (!this.clave) return null
    this.revisar()
    if (this.resultado?.ok) return this.resultado.datos.celulares === 0 ? null : this.resultado.datos.celulares
    return CELULARES_PRUEBA
  }

  estado(): EstadoLicencia {
    this.revisar()
    const r = this.resultado
    const base = { configuradas: this.clave !== null, equipo: idEquipo(), celularesPrueba: CELULARES_PRUEBA }
    if (!this.clave) return { ...base, activa: false, prueba: false }
    if (r?.ok) {
      return {
        ...base,
        activa: true,
        prueba: false,
        nombre: r.datos.nombre,
        celulares: r.datos.celulares,
        vence: r.datos.vence ?? null,
        atadaAEquipo: !!r.datos.equipo,
        id: r.datos.id
      }
    }
    return { ...base, activa: false, prueba: true, error: r && !r.ok ? r.error : undefined }
  }

  activar(texto: string): { ok: boolean; error?: string } {
    if (!this.clave) return { ok: false, error: 'Esta versión no usa licencias' }
    const r = verificarLicencia(texto, this.clave, idEquipo())
    if (!r.ok) return { ok: false, error: r.error }
    // se guarda solo la licencia (sin el texto del chat que vino alrededor)
    this.texto = separarLicencia(texto)?.texto ?? texto
    try {
      fs.mkdirSync(appBaseDir(), { recursive: true })
      fs.writeFileSync(this.ruta(), this.texto)
    } catch {
      return { ok: false, error: 'No se pudo guardar la licencia en la computadora' }
    }
    this.revisar()
    return { ok: true }
  }

  quitar(): void {
    this.texto = null
    try {
      fs.rmSync(this.ruta(), { force: true })
    } catch {
      // no estaba
    }
    this.revisar()
  }
}
