import type { ComandoProgramado, EstadoBuffer, Pista, Proyecto } from '@shared/types'

/** Ajuste personal de una pista en ESTE dispositivo ("Mi mezcla"), por nombre de pista. */
export interface AjustePersonal {
  /** multiplicador sobre la mezcla del director: 0 a 2 (1 = igual que el director) */
  ganancia: number
  mute: boolean
}

export type MezclaPersonal = Record<string, AjustePersonal>

/** Clave estable por nombre de pista ("Click", "click ", "CLICK" -> "click"), para que el ajuste siga de cancion en cancion. */
export function clavePista(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

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
  /** baja de a poco el principio de la proxima cancion del setlist (null = ninguna) */
  precargar(proyecto: Proyecto | null): void
  aplicarMezcla(pistas: Pista[]): void
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

  onRequiereResync(cb: () => void): void
  dispose(): void
}
