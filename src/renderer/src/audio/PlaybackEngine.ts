import type { ComandoProgramado, DiagnosticoAudio, EstadoBuffer, Pista, Proyecto } from '@shared/types'

export { clavePista } from '@shared/mezcla'
export type { AjustePersonal, MezclaPersonal } from '@shared/mezcla'
import type { MezclaPersonal } from '@shared/mezcla'

/** Superficie del motor de audio que usa `useAppController`. */
export interface PlaybackEngine {
  proyectoIdCargado: string | null
  /** `revision` del proyecto cargado: si cambia (zip actualizado), hay que volver a activarlo */
  revisionCargada: number

  resumeSiHaceFalta(): Promise<void>
  setVolumenGeneral(volumen0a100: number): void
  setAjusteManualMs(ms: number): void
  setMezclaPersonal(mezcla: MezclaPersonal): void

  activarProyecto(proyecto: Proyecto, posicionMs: number): void
  /** baja de a poco el arranque (desde `posicionMs`) de la proxima cancion del setlist (null = ninguna) */
  precargar(proyecto: Proyecto | null, posicionMs?: number): void
  /** mezcla del director de la cancion activa (y su click/guia detectados) */
  aplicarMezcla(proyecto: Proyecto): void
  /** "Click y guia a la izquierda, banda a la derecha" en este dispositivo */
  setClickGuiaIzquierda(activo: boolean): void
  /** tiempos (ms) cuyo arranque conviene tener precargado (marcadores) */
  setCues(tiemposMs: number[]): void

  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void
  /** corta todo ya (p.ej. se cerro la cancion que sonaba) */
  detener(): void
  posicionRealMs(): number | null
  enCorreccionSuave(): boolean
  corregirDriftSuave(driftMs: number): void

  estadoBuffer(): EstadoBuffer | null
  errorAudio(): string | null
  /** mediciones para el diagnostico (WiFi, colchon, cortes) */
  resumenDiagnostico(): DiagnosticoAudio

  onRequiereResync(cb: () => void): void
  dispose(): void
}
