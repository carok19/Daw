import type { OndaCancion, Proyecto, SaltoPendiente } from '@shared/types'
import { seccionEn, type Seccion } from '@shared/playback'
import { textoSemitonos, tonalidadEn } from '@shared/tonalidad'
import type { AppController } from '../app/useAppController'
import { usePlayheadMs } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { OndaDibujo } from '../ui/Onda'

/** Piezas que comparten las pantallas del celular (cancion, voz, multimedia). */

export function faltaPara(salto: SaltoPendiente, pos: number): string {
  const s = Math.max(0, Math.ceil((salto.limiteMs - pos) / 1000))
  return s <= 0 ? 'ya' : `en ${s} s`
}

/** Tonalidad en la que suena la cancion ("B +2"): asi la banda sabe en que tono esta tocando. */
/** La tonalidad que suena en `pos` (la de la seccion, si la cancion cambia de tono), con el tono cambiado. */
export function TonoQueSuena({ proyecto, pos }: { proyecto: Proyecto; pos: number }) {
  const n = proyecto.tonoAplicado ?? 0
  const tono = tonalidadEn(proyecto, pos)
  if (!tono && !n) return null
  return (
    <span className={`m-barra-tono num ${n ? 'cambiado' : ''}`} title={n ? `Tono cambiado ${textoSemitonos(n)} semitonos` : 'Tonalidad'}>
      {tono}
      {n !== 0 && <small>{textoSemitonos(n)}</small>}
    </span>
  )
}

/** " · en E" si la seccion `s` suena en otro tono que el de ahora. */
export function cambioDeTono(p: Proyecto, pos: number, s: Seccion | null | undefined): string {
  if (!s || !p.marcadores.some((m) => m.tonalidad)) return ''
  const luego = tonalidadEn(p, s.inicioMs)
  return luego && luego !== tonalidadEn(p, pos) ? ` · en ${luego}` : ''
}

/** Cuanto se muestra "Tono: E" despues de que la cancion cambio de tono. */
export const AVISO_TONO_MS = 8000

/**
 * "Tono: E" grande cuando la cancion cambia de tono: los ultimos 2 compases
 * antes (lo que viene: la seccion siguiente o la elegida) y los primeros
 * segundos despues. null = no hay cambio cerca.
 */
export function avisoDeTono(
  p: Proyecto,
  pos: number,
  proxima: Seccion | null | undefined,
  faltan: number | null,
  finMs: number | null
): { tono: string; ya: boolean } | null {
  if (!p.marcadores.some((m) => m.tonalidad)) return null
  const ahora = tonalidadEn(p, pos)
  if (proxima) {
    const luego = tonalidadEn(p, proxima.inicioMs)
    const cerca = faltan !== null ? faltan <= 2 : finMs !== null && finMs - pos < 5000
    if (luego && luego !== ahora && cerca) return { tono: luego, ya: false }
  }
  // donde empezo el tono que suena: si fue hace poco (y era otro), se sigue avisando
  let desde = -Infinity
  for (const m of p.marcadores) if (m.tonalidad && m.tiempoMs <= pos + 1 && m.tiempoMs > desde) desde = m.tiempoMs
  if (ahora && desde > 0 && pos - desde < AVISO_TONO_MS && tonalidadEn(p, desde - 1) !== ahora) return { tono: ahora, ya: true }
  return null
}

/** "Tono: E" (o "→ Tono: E" antes de que cambie). */
export function AvisoTono({ aviso }: { aviso: { tono: string; ya: boolean } | null }) {
  if (!aviso) return null
  return (
    <span className={`m-aviso-tono num ${aviso.ya ? 'ya' : 'viene'}`} role="status" aria-label={aviso.ya ? `La canción pasó a ${aviso.tono}` : `La canción pasa a ${aviso.tono}`} data-testid="aviso-tono">
      <small>{aviso.ya ? 'Tono' : 'Pasa a'}</small>
      <b>{aviso.tono}</b>
    </span>
  )
}

/** La cancion de punta a punta, dividida en secciones. Grande (el "recorrido"), con la forma de onda y los nombres. */
export function MiniTimeline({ controller, onda, grande }: { controller: AppController; onda?: OndaCancion | null; grande?: boolean }) {
  const { secciones, estado } = controller
  const dur = Math.max(estado?.proyectoActivo?.duracionTotalMs ?? 1, 1)
  const pos = usePlayheadMs()
  const actual = seccionEn(secciones, pos)
  const salto = estado?.saltoPendiente ?? null
  const destino = salto && !salto.fin ? seccionEn(secciones, salto.destinoMs) : null
  const pct = (ms: number): string => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`
  return (
    <span className={`m-timeline ${grande ? 'm-recorrido' : ''} ${onda ? 'con-onda' : ''}`} aria-hidden>
      {secciones.map((s) => (
        <span
          key={s.marcador?.id ?? 'inicio'}
          className={`${actual?.indice === s.indice ? 'actual' : ''} ${destino?.indice === s.indice ? 'destino' : ''}`}
          style={{ width: `${((s.finMs - s.inicioMs) / dur) * 100}%`, background: colorDeSeccion(s) }}
        >
          {grande && s.marcador && <em>{s.nombre}</em>}
        </span>
      ))}
      {onda && <OndaDibujo onda={onda} duracionMs={dur} className="m-onda" />}
      {grande && <span className="m-pasado" style={{ width: pct(pos) }} />}
      {salto && <span className="m-salto-limite" style={{ left: pct(salto.limiteMs) }} />}
      <span className="m-playhead" style={{ left: pct(pos) }} />
    </span>
  )
}

/** Cuantos compases (con tempo) o cuanto dura una seccion. */
export function largoDeSeccion(s: Seccion, compasesMs: number[] | null): string {
  if (compasesMs && compasesMs.length > 1) {
    const n = compasesMs.filter((c) => c >= s.inicioMs - 50 && c < s.finMs - 50).length
    if (n > 0) return `${n} ${n === 1 ? 'compás' : 'compases'}`
  }
  return formatMmSs(s.finMs - s.inicioMs)
}

/** Version mas clara de un color de seccion, para texto sobre fondo oscuro. */
export function colorClaro(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const mezclar = (c: number): number => Math.round(c + (255 - c) * 0.45)
  return `rgb(${mezclar((n >> 16) & 255)}, ${mezclar((n >> 8) & 255)}, ${mezclar(n & 255)})`
}
