import { useEffect, useRef, useState } from 'react'
import NoSleep from 'nosleep.js'

/**
 * Mantiene la pantalla del celular encendida mientras la app esta activa.
 *
 * Por que importa: el audio sigue sonando con la pantalla apagada, pero el
 * navegador frena los temporizadores de JS (el control de sincronia) y un
 * celular se va desfasando sin que nadie lo corrija.
 *
 * El Wake Lock API nativo solo existe en conexiones seguras (https) y la app
 * se abre por http://<ip-de-la-compu>, asi que se usa NoSleep.js: con Wake
 * Lock si esta disponible y, si no, con un video mudo en loop (funciona en
 * Android y iPhone). Tiene que habilitarse desde un toque del usuario: por
 * eso `activar()` se llama en el boton "Tocá para empezar".
 */
export function useWakeLock(): { activar: () => void; activo: boolean } {
  const noSleep = useRef<NoSleep | null>(null)
  const [activo, setActivo] = useState(false)

  useEffect(() => {
    function onVisible(): void {
      // al volver a la app, el video / wake lock se reanuda (el sistema los libera al ocultarse)
      if (document.visibilityState === 'visible' && noSleep.current && activo) {
        void noSleep.current.enable().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [activo])

  useEffect(() => () => noSleep.current?.disable(), [])

  function activar(): void {
    try {
      if (!noSleep.current) noSleep.current = new NoSleep()
      void noSleep.current
        .enable()
        .then(() => setActivo(true))
        .catch(() => setActivo(false))
    } catch {
      setActivo(false)
    }
  }

  return { activar, activo }
}
