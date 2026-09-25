/**
 * Preferencias guardadas en ESTE dispositivo (localStorage es por navegador /
 * por celular). Todo con try/catch: en navegacion privada o con el
 * almacenamiento bloqueado se sigue funcionando, solo que no se recuerda.
 */
const PREFIJO = 'multitrack:'

/**
 * Dentro de la app Android las preferencias se guardan tambien en la app:
 * el localStorage del navegador es por direccion (http://IP:puerto) y si la
 * compu cambia de IP entre un ensayo y otro, el celular perderia su nombre,
 * su mezcla y el codigo de la banda.
 */
interface PrefsDeLaApp {
  leerPref?(clave: string): string | null | undefined
  guardarPref?(clave: string, valor: string): void
}

function prefsDeLaApp(): PrefsDeLaApp | null {
  return (window as unknown as { AlabanzaApp?: PrefsDeLaApp }).AlabanzaApp ?? null
}

export function leerPref<T>(clave: string, porDefecto: T): T {
  try {
    const desdeApp = prefsDeLaApp()?.leerPref?.(clave)
    const raw = typeof desdeApp === 'string' ? desdeApp : window.localStorage.getItem(PREFIJO + clave)
    return raw === null ? porDefecto : (JSON.parse(raw) as T)
  } catch {
    return porDefecto
  }
}

export function guardarPref<T>(clave: string, valor: T): void {
  const json = JSON.stringify(valor)
  try {
    window.localStorage.setItem(PREFIJO + clave, json)
  } catch {
    // almacenamiento no disponible: no es critico
  }
  try {
    prefsDeLaApp()?.guardarPref?.(clave, json)
  } catch {
    // la app no respondio: queda el localStorage
  }
}

function idAleatorio(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Id estable de este dispositivo, para que al reconectar el servidor lo reconozca (y no sume un "Celular N" nuevo). */
export function deviceIdPersistente(): string {
  let id = leerPref<string | null>('device-id', null)
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = idAleatorio()
    guardarPref('device-id', id)
  }
  return id
}
