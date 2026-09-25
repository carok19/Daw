/**
 * Preferencias guardadas en ESTE dispositivo (localStorage es por navegador /
 * por celular). Todo con try/catch: en navegacion privada o con el
 * almacenamiento bloqueado se sigue funcionando, solo que no se recuerda.
 */
const PREFIJO = 'multitrack:'

export function leerPref<T>(clave: string, porDefecto: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIJO + clave)
    return raw === null ? porDefecto : (JSON.parse(raw) as T)
  } catch {
    return porDefecto
  }
}

export function guardarPref<T>(clave: string, valor: T): void {
  try {
    window.localStorage.setItem(PREFIJO + clave, JSON.stringify(valor))
  } catch {
    // almacenamiento no disponible: no es critico
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
