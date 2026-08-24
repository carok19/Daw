import type { ComandoProgramado, Pista, PreparacionProyecto, Proyecto } from '@shared/types'

/**
 * Superficie comun que `useAppController` usa sobre el motor de audio, sin
 * importar cual implementacion hay detras. La compu sigue usando `AudioEngine`
 * (cache completo en memoria, sin cambios). El celular usa `StreamingEngine`
 * (buffer deslizante por segmentos, ver README "Streaming progresivo") — el
 * objetivo de esta interfaz es que `useAppController` no necesite saber cual
 * de las dos tiene enfrente para CLOCK/TRANSPORT/DRIFT SYNC.
 */
export interface PlaybackEngine {
  proyectoIdCargado: string | null

  resumeSiHaceFalta(): Promise<void>
  setVolumenGeneral(volumen0a100: number): void
  setAjusteManualMs(ms: number): void

  estaListo(proyectoId: string): boolean
  setProtegidos(proyectoIds: string[]): void
  precargarProyecto(proyecto: Proyecto, onEstado?: (p: PreparacionProyecto) => void): Promise<void>
  activarProyecto(proyecto: Proyecto, onEstado?: (p: PreparacionProyecto) => void): Promise<number>
  aplicarMezcla(pistas: Pista[]): void

  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void
  posicionRealMs(): number | null
  enCorreccionSuave(): boolean
  corregirDriftSuave(driftMs: number): void

  /**
   * Solo lo implementa `StreamingEngine`: se llama cuando el buffer estaba
   * agotado (o recien arrancando) y ya alcanzo el minimo para reproducir, asi
   * el llamador puede reingresar a sync con el mecanismo YA EXISTENTE
   * (`reingresarEnSync`) en vez de que el motor invente su propio scheduling.
   * Opcional: `AudioEngine` (compu) no lo necesita, nunca espera buffer.
   */
  onRequiereResync?(cb: () => void): void
}
