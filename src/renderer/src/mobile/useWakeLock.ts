import { useEffect } from 'react'

/**
 * Mantiene la pantalla encendida mientras `activo` es true (Modo Celular,
 * despues de tocar "Activar audio"). El motivo tecnico: el audio sigue
 * sonando aunque la pantalla se bloquee, pero el navegador frena los
 * temporizadores de JS (el chequeo de drift cada 4s) cuando la pantalla se
 * apaga o la app pasa a segundo plano — eso es lo que hacia que un celular
 * se fuera desincronizando sin que nadie lo corrigiera hasta que alguien
 * volvia a mirar la pantalla. Evitar que se bloquee es la primera linea de
 * defensa; `useVisibilityResync` (en useAppController) es la segunda, para
 * cuando igual se bloquea (otra app, "apagar pantalla" del sistema, etc).
 */
export function useWakeLock(activo: boolean): void {
  useEffect(() => {
    if (!activo || !('wakeLock' in navigator)) return

    let sentinel: WakeLockSentinel | null = null
    let cancelado = false

    async function pedir(): Promise<void> {
      try {
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        // rechazado o no soportado en este momento: no es critico, se sigue sin el
      }
    }

    function onVisibilityChange(): void {
      // el wake lock se libera solo cuando la pestana se oculta; hay que
      // volver a pedirlo cada vez que la pantalla se reactiva
      if (document.visibilityState === 'visible' && !cancelado) void pedir()
    }

    void pedir()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelado = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      void sentinel?.release().catch(() => {})
    }
  }, [activo])
}
