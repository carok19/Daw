import { spawn, type ChildProcess } from 'node:child_process'
import type { EstadoFirewall, RedWindows } from '../shared/types'

/**
 * Firewall de Windows: la causa mas comun de "el celular no encuentra la
 * compu" al cambiar de lugar.
 *
 * Windows marca cada WiFi nueva como "publica". La primera vez que se abre la
 * app pregunta si se la deja recibir conexiones, con "redes privadas" marcado
 * y "redes publicas" sin marcar; al aceptar asi, ademas de permitirla en las
 * privadas crea una regla que la BLOQUEA en las publicas (y un bloqueo gana
 * sobre cualquier permiso). En la casa (red privada) anda; en la iglesia o en
 * otro lugar (red publica nueva) los celulares no la encuentran ni por QR, ni
 * por airtracks.local, ni con la app, y Windows no vuelve a preguntar.
 *
 * Aca se lee (sin permisos de administrador) en que redes esta la compu y que
 * reglas tiene la app, y se arregla en un paso (Windows pide permiso una vez):
 * se borran los bloqueos de la app y se la permite en todas las redes. No se
 * toca nada del resto del firewall ni el tipo de red.
 */

/** Lo que devuelve la lectura del firewall (PowerShell). */
export interface DatosFirewall {
  /** redes conectadas: nombre (el del WiFi), adaptador ("Wi-Fi", "Ethernet") y categoria (Public, Private, DomainAuthenticated) */
  redes: { nombre: string; interfaz: string; categoria: string }[]
  /** reglas de entrada de la app: habilitada ("True"/"False"), accion ("Allow"/"Block"), perfiles ("Any", "Private, Public"...) */
  reglas: { nombre: string; habilitada: string; accion: string; perfil: string }[]
  /** perfiles del firewall: Domain, Private, Public y si estan activos */
  perfiles: { nombre: string; activo: string }[]
  /** se pudo leer el firewall (si no, no se sabe nada de las reglas) */
  legible: boolean
}

const PERFIL_DE_CATEGORIA: Record<string, 'Public' | 'Private' | 'Domain'> = {
  Public: 'Public',
  Private: 'Private',
  DomainAuthenticated: 'Domain'
}

function categoriaVisible(c: string): RedWindows['categoria'] {
  return c === 'Private' ? 'privada' : c === 'DomainAuthenticated' ? 'dominio' : 'publica'
}

function aplica(perfilRegla: string, perfil: string): boolean {
  const partes = perfilRegla.split(',').map((x) => x.trim())
  return partes.includes('Any') || partes.includes(perfil)
}

const si = (x: string | undefined): boolean => String(x).toLowerCase() === 'true'

/**
 * ¿La app puede recibir a los celulares en las redes donde esta la compu?
 * Una red la bloquea si hay una regla de bloqueo que aplica o si no hay
 * ninguna que la permita (Windows bloquea por defecto lo que no conoce).
 */
export function evaluarFirewall(d: DatosFirewall, esVirtual: (interfaz: string) => boolean = () => false): EstadoFirewall {
  // las redes de adaptadores virtuales (Hyper-V, VPN...) no son por donde entran los celulares
  const reales = d.redes.filter((r) => !esVirtual(r.interfaz))
  const redes: RedWindows[] = reales.map((r) => ({ nombre: r.nombre, categoria: categoriaVisible(r.categoria) }))
  if (reales.length === 0 || !d.legible) return { estado: 'desconocido', redes, bloqueadas: [] }
  const bloqueadas: RedWindows[] = []
  for (const [i, red] of reales.entries()) {
    const perfil = PERFIL_DE_CATEGORIA[red.categoria] ?? 'Public'
    const fw = d.perfiles.find((p) => p.nombre === perfil)
    // con el firewall apagado en esa red no hay nada que bloquee
    if (fw && fw.activo.toLowerCase() === 'false') continue
    const vigentes = d.reglas.filter((r) => si(r.habilitada) && aplica(r.perfil, perfil))
    const bloquea = vigentes.some((r) => r.accion === 'Block')
    const permite = vigentes.some((r) => r.accion === 'Allow')
    if (bloquea || !permite) bloqueadas.push(redes[i])
  }
  return { estado: bloqueadas.length ? 'bloqueado' : 'ok', redes, bloqueadas }
}

const lista = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x ? [x] : [])

/** Texto para PowerShell entre comillas simples. */
function literal(texto: string): string {
  return `'${texto.replace(/'/g, "''")}'`
}

/** Las reglas de entrada de la app (por su ruta, aunque este escrita con %variables%). */
function reglasDelPrograma(programa: string): string {
  return (
    `Get-NetFirewallApplicationFilter | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Program) -ieq ${literal(programa)} } | ` +
    `Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' }`
  )
}

function powershell(script: string, ms: number): Promise<{ codigo: number | null; salida: string }> {
  return new Promise((resolve) => {
    let salida = ''
    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      return resolve({ codigo: null, salida: '' })
    }
    const t = setTimeout(() => proc.kill(), ms)
    proc.stdout!.on('data', (b: Buffer) => (salida += b.toString('utf8')))
    proc.on('error', () => {
      clearTimeout(t)
      resolve({ codigo: null, salida: '' })
    })
    proc.on('close', (codigo) => {
      clearTimeout(t)
      resolve({ codigo, salida })
    })
  })
}

/** Lee las redes y las reglas de la app (sin permisos de administrador). null = no se pudo (no es Windows, sin PowerShell...). */
export async function leerFirewall(programa: string): Promise<DatosFirewall | null> {
  if (process.platform !== 'win32') return null
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$redes = @(Get-NetConnectionProfile | ForEach-Object { @{ nombre = [string]$_.Name; interfaz = [string]$_.InterfaceAlias; categoria = [string]$_.NetworkCategory } })",
    `$reglas = @(${reglasDelPrograma(programa)} | ForEach-Object { @{ nombre = [string]$_.DisplayName; habilitada = [string]$_.Enabled; accion = [string]$_.Action; perfil = [string]$_.Profile } })`,
    "$perfiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object { @{ nombre = [string]$_.Name; activo = [string]$_.Enabled } })",
    // si Windows no deja leer las reglas (no deberia pasar), no se puede decir que este bloqueada
    '$legible = [bool](Get-NetFirewallRule | Select-Object -First 1)',
    'ConvertTo-Json -Compress -Depth 4 -InputObject @{ redes = $redes; reglas = $reglas; perfiles = $perfiles; legible = $legible }'
  ].join('\n')
  const r = await powershell(script, 30000)
  if (r.codigo !== 0) return null
  try {
    const o = JSON.parse(r.salida.trim()) as Partial<DatosFirewall>
    return { redes: lista(o.redes), reglas: lista(o.reglas), perfiles: lista(o.perfiles), legible: o.legible === true }
  } catch {
    return null
  }
}

/**
 * Deja entrar a los celulares en todas las redes: borra las reglas de entrada
 * de la app (los bloqueos que creo Windows) y agrega una que la permite en
 * cualquier red. Windows pide permiso de administrador (una ventana de "¿Sí?").
 */
export async function permitirEnFirewall(programa: string): Promise<'ok' | 'cancelado' | 'error'> {
  if (process.platform !== 'win32') return 'error'
  const adentro = [
    `${reglasDelPrograma(programa)} | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName 'AirTracks Wireless Monitor' -Description 'Celulares de la banda (AirTracks)' -Direction Inbound -Program ${literal(programa)} -Action Allow -Profile Any -ErrorAction Stop | Out-Null`,
    'exit 0'
  ].join('\n')
  const codificado = Buffer.from(adentro, 'utf16le').toString('base64')
  const script = [
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${codificado}'`,
    '  exit $p.ExitCode',
    '} catch { exit 1223 }'
  ].join('\n')
  const r = await powershell(script, 120000)
  return r.codigo === 0 ? 'ok' : r.codigo === 1223 ? 'cancelado' : 'error'
}
