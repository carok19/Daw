import type { AnuncioSalto, ColchonActivo, ComandoProgramado, DiagnosticoAudio, EstadoBuffer, Pista, Proyecto, SalidaSonido } from '@shared/types'

export { clavePista } from '@shared/mezcla'
export type { AjustePersonal, MezclaPersonal } from '@shared/mezcla'
import type { MezclaPersonal } from '@shared/mezcla'
import type { EsperaTalkback, PedazoTalkback } from './talkback'

/** Superficie del motor de audio que usa `useAppController`. */
export interface PlaybackEngine {
  proyectoIdCargado: string | null
  /** `revision` del proyecto cargado: si cambia (zip actualizado), hay que volver a activarlo */
  revisionCargada: number

  resumeSiHaceFalta(): Promise<void>
  setVolumenGeneral(volumen0a100: number): void
  setAjusteManualMs(ms: number): void
  setMezclaPersonal(mezcla: MezclaPersonal): void
  /** celular de Sonido (va a la consola): la banda sola al centro, y lo que se pida ademas; null = un celular comun */
  setSalidaSonido(salida: SalidaSonido | null): void
  /** pico de lo que sale ahora por cada lado (0 a 1): el vumetro de la consola */
  nivelSalida(): { izq: number; der: number }
  /** "Probar el sync": un click en cada golpe (hora del servidor), igual en todos */
  probarSync(golpes: { t: number; n: number }[], clockOffsetMs: number): void
  /** un pedazo de talkback (la compu habla a los oidos) */
  recibirTalkback(p: PedazoTalkback, clockOffsetMs: number): void
  /** lo que mide del talkback (para la compu) */
  readonly esperaTalkback: EsperaTalkback
  /** aviso de que el talkback empieza o termina de sonar */
  onTalkback(cb: (sonando: boolean) => void): void

  activarProyecto(proyecto: Proyecto, posicionMs: number): void
  /** baja de a poco el arranque (desde `posicionMs`) de la proxima cancion del setlist (null = ninguna) */
  precargar(proyecto: Proyecto | null, posicionMs?: number): void
  /** mezcla del director de la cancion activa (y su click/guia detectados) */
  aplicarMezcla(proyecto: Proyecto): void
  /** tiempos (ms) cuyo arranque conviene tener precargado (marcadores) */
  setCues(tiemposMs: number[]): void
  /** la voz que avisa el salto elegido (null = no hay o se cancelo) */
  setAnuncio(anuncio: AnuncioSalto | null): void
  /** el colchon que suena (pad y click sin la banda; null = ninguno), con el reloj del servidor */
  setColchon(colchon: ColchonActivo | null, offsetMs: () => number): void

  ejecutar(cmd: ComandoProgramado, clockOffsetMs: number): void
  /** corta todo ya (p.ej. se cerro la cancion que sonaba) */
  detener(): void
  posicionRealMs(): number | null
  enCorreccionSuave(): boolean
  /** el navegador da la hora exacta de salida del audio (se puede corregir desde menos ms) */
  relojPreciso(): boolean
  corregirDriftSuave(driftMs: number): void

  estadoBuffer(): EstadoBuffer | null
  errorAudio(): string | null
  /** mediciones para el diagnostico (WiFi, colchon, cortes) */
  resumenDiagnostico(): DiagnosticoAudio

  onRequiereResync(cb: () => void): void
  dispose(): void
}
