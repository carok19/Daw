import type { DatosInvitacion } from '@shared/types'

/**
 * Utilidades para sumar celulares: QR del WiFi, copiar/compartir el enlace,
 * que celular es y el puente con la app Android (si la pagina corre adentro).
 */

/**
 * Puente que expone la app Android dentro de su WebView (window.AlabanzaApp).
 * Las preferencias tambien pasan por ahi (ver preferencias.ts).
 */
export interface PuenteAndroid {
  /** vuelve a la pantalla de busqueda para elegir otra compu */
  cambiarCompu(): void
  /** abre el "Compartir" de Android (WhatsApp, Telegram, SMS...) */
  compartir?(texto: string): void
  /** avisa si hay conexion con la compu: sin conexion un rato, la app la busca por si cambio de IP */
  conexion?(conectado: boolean): void
}

export function puenteAndroid(): PuenteAndroid | null {
  const p = (window as unknown as { AlabanzaApp?: PuenteAndroid }).AlabanzaApp
  return p && typeof p.cambiarCompu === 'function' ? p : null
}

export function esIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function esAndroid(): boolean {
  return /Android/i.test(navigator.userAgent)
}

/** Abierta como icono de la pantalla de inicio (modo app). */
export function enPantallaDeInicio(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

/** La pagina se abrio con una IP ("192.168.1.35"), no con un nombre (airtracks.local). */
export function abiertaPorIp(): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)
}

function escaparWifi(t: string): string {
  return t.replace(/([\\;,":])/g, '\\$1')
}

/** Texto del QR que conecta al WiFi al escanearlo (iPhone y Android lo entienden desde la camara). */
export function textoQrWifi(wifi: { ssid: string; clave: string }): string {
  return wifi.clave ? `WIFI:T:WPA;S:${escaparWifi(wifi.ssid)};P:${escaparWifi(wifi.clave)};;` : `WIFI:T:nopass;S:${escaparWifi(wifi.ssid)};;`
}

/**
 * Copia texto al portapapeles. La pagina se sirve por http (sin "contexto
 * seguro"), donde navigator.clipboard no existe: se usa el metodo clasico.
 */
export function copiarTexto(texto: string): boolean {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      void navigator.clipboard.writeText(texto)
      return true
    }
    const area = document.createElement('textarea')
    area.value = texto
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, texto.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** Enlace que entra directo (con el codigo de la banda, si hay, para no tener que escribirlo). */
export function enlaceConCodigo(url: string, codigo: string | null): string {
  return codigo ? `${url}/#codigo=${codigo}` : url
}

/** La direccion para escribir a mano, sin "http://". */
export function direccionVisible(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

/** Mensaje para mandar por WhatsApp a quien se suma. */
export function mensajeInvitacion(d: DatosInvitacion): string {
  const partes = [
    `Para escuchar la pista en tu celular: conectate al WiFi${d.wifi ? ` “${d.wifi.ssid}”` : ' de la iglesia'} y abrí ${enlaceConCodigo(d.url, d.codigo)}`
  ]
  if (d.codigo) partes.push(`Código de la banda: ${d.codigo}`)
  if (d.apk) partes.push(`Con Android podés bajar la app (encuentra la compu sola): ${d.url}/app/airtracks.apk`)
  return partes.join('\n\n')
}

/**
 * El codigo que trae la app Android en la direccion (#codigo=1234): se guarda
 * y se saca de la barra (que no quede a la vista).
 */
export function codigoDesdeDireccion(): string | null {
  const m = /(?:^#|&)codigo=(\d{4,8})/.exec(window.location.hash)
  if (!m) return null
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    // no importa
  }
  return m[1]
}
