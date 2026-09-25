import { useRef, useState } from 'react'
import type { Seccion } from '@shared/playback'
import type { SaltoPendiente } from '@shared/types'
import { seccionEn } from '@shared/playback'
import { usePlayheadMs } from '../app/playheadStore'
import { ajustarACompas } from '../app/useAppController'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'

interface Props {
  secciones: Seccion[]
  duracionMs: number
  /** inicio de cada compas (si se detecto el tempo): rayitas en la linea de tiempo */
  compasesMs: number[] | null
  loop: boolean
  /** salto elegido: se marca donde se va a saltar y a que seccion */
  salto: SaltoPendiente | null
  /** iman de compas: el click (y la guia del mouse) caen en el "1" mas cercano; Alt lo desactiva */
  ajustar: boolean
  /** `inmediato`: con Shift (sonando, si no, espera al proximo compas) */
  onSeek: (ms: number, inmediato: boolean) => void
  /** `sinAjustar`: se solto con Alt apretado (no ajustar al compas) */
  onMoverMarcador: (marcadorId: string, ms: number, sinAjustar: boolean) => void
}

/**
 * Linea de tiempo de la cancion dividida en secciones (una por marcador).
 * Click = ir a ese punto. Las marcas blancas (triangulos) al inicio de cada
 * seccion se arrastran para mover el marcador.
 */
export function Timeline({ secciones, duracionMs, compasesMs, loop, salto, ajustar, onSeek, onMoverMarcador }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const playhead = usePlayheadMs()
  const [hover, setHover] = useState<number | null>(null)
  const [arrastre, setArrastre] = useState<{ id: string; ms: number } | null>(null)
  const dur = Math.max(duracionMs, 1)
  const pct = (ms: number): string => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`
  const actual = seccionEn(secciones, playhead)

  function msDesdeX(clientX: number): number {
    const rect = ref.current!.getBoundingClientRect()
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * dur)
  }

  /** Posicion del mouse, en el "1" del compas si el iman esta prendido (y no se aprieta Alt). */
  function destinoDesdeX(clientX: number, alt: boolean): number {
    const ms = msDesdeX(clientX)
    return ajustar && !alt && compasesMs ? ajustarACompas(compasesMs, ms) : ms
  }

  return (
    <div
      ref={ref}
      className="timeline"
      onClick={(e) => {
        if (!arrastre) onSeek(destinoDesdeX(e.clientX, e.altKey), e.shiftKey)
      }}
      onMouseMove={(e) => setHover(destinoDesdeX(e.clientX, e.altKey))}
      onMouseLeave={() => setHover(null)}
      role="slider"
      aria-label="Posición de la canción"
      aria-valuemin={0}
      aria-valuemax={dur}
      aria-valuenow={playhead}
    >
      {secciones.map((s, i) => {
        const ini = arrastre && s.marcador?.id === arrastre.id ? arrastre.ms : s.inicioMs
        return (
          <div
            key={s.marcador?.id ?? 'inicio'}
            className={`timeline-seccion ${i === secciones.length - 1 ? 'ultima' : ''} ${actual?.indice === s.indice ? 'actual' : ''} ${
              loop && actual?.indice === s.indice ? 'loop' : ''
            }`}
            style={{ left: pct(ini), width: pct(s.finMs - ini), background: colorDeSeccion(s) }}
            title={`${s.nombre} — ${formatMmSs(s.inicioMs)}`}
          >
            <span className="timeline-seccion-nombre">{s.nombre}</span>
          </div>
        )
      })}
      {compasesMs && <RayasCompas compasesMs={compasesMs} duracionMs={dur} />}
      {salto && (
        <>
          <div className="timeline-salto-limite" style={{ left: pct(salto.limiteMs) }} title={`Acá salta a ${salto.nombre}`} />
          <div className="timeline-salto-destino" style={{ left: pct(salto.destinoMs) }} />
        </>
      )}
      <div className="timeline-pasado" style={{ width: pct(playhead) }} />
      {secciones
        .filter((s) => s.marcador)
        .map((s) => {
          const id = s.marcador!.id
          const ms = arrastre?.id === id ? arrastre.ms : s.inicioMs
          return (
            <div
              key={id}
              className={`timeline-marca ${arrastre?.id === id ? 'arrastrando' : ''}`}
              style={{ left: pct(ms) }}
              title={`Arrastrá para mover “${s.nombre}”`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                const el = e.currentTarget
                el.setPointerCapture(e.pointerId)
                let ultimo = ms
                let alt = false
                setArrastre({ id, ms })
                const mover = (ev: PointerEvent): void => {
                  ultimo = msDesdeX(ev.clientX)
                  alt = ev.altKey
                  setArrastre({ id, ms: ultimo })
                  setHover(ultimo)
                }
                const soltar = (ev: PointerEvent): void => {
                  alt = alt || ev.altKey
                  const shift = ev.shiftKey
                  el.removeEventListener('pointermove', mover)
                  el.removeEventListener('pointerup', soltar)
                  el.removeEventListener('pointercancel', soltar)
                  if (Math.abs(ultimo - s.inicioMs) > 30) onMoverMarcador(id, ultimo, alt)
                  else onSeek(s.inicioMs, shift) // click sin arrastrar: ir a esa seccion
                  // se limpia despues del click que dispara el pointerup
                  setTimeout(() => setArrastre(null), 0)
                }
                el.addEventListener('pointermove', mover)
                el.addEventListener('pointerup', soltar)
                el.addEventListener('pointercancel', soltar)
              }}
            />
          )
        })}
      <div className="timeline-playhead" style={{ left: pct(playhead) }} />
      {hover !== null && (
        <div className="timeline-hover num" style={{ left: pct(hover) }}>
          {formatMmSs(hover)}
        </div>
      )}
    </div>
  )
}

/** Una rayita por compas (cada 4 si quedarian muy juntas), abajo de la linea de tiempo. */
function RayasCompas({ compasesMs, duracionMs }: { compasesMs: number[]; duracionMs: number }) {
  const cada = compasesMs.length > 160 ? 8 : compasesMs.length > 80 ? 4 : 1
  return (
    <svg className="timeline-compases" preserveAspectRatio="none" viewBox={`0 0 ${duracionMs} 10`} aria-hidden>
      {compasesMs.map((c, i) =>
        i % cada === 0 ? <line key={c} x1={c} x2={c} y1={i % (cada * 4) === 0 ? 2 : 5} y2={10} vectorEffect="non-scaling-stroke" /> : null
      )}
    </svg>
  )
}
