import { useRef, useState } from 'react'
import type { Seccion } from '@shared/playback'
import { seccionEn } from '@shared/playback'
import { usePlayheadMs } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'

interface Props {
  secciones: Seccion[]
  duracionMs: number
  loop: boolean
  onSeek: (ms: number) => void
  onMoverMarcador: (marcadorId: string, ms: number) => void
}

/**
 * Linea de tiempo de la cancion dividida en secciones (una por marcador).
 * Click = ir a ese punto. Las marcas blancas (triangulos) al inicio de cada
 * seccion se arrastran para mover el marcador.
 */
export function Timeline({ secciones, duracionMs, loop, onSeek, onMoverMarcador }: Props) {
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

  return (
    <div
      ref={ref}
      className="timeline"
      onClick={(e) => {
        if (!arrastre) onSeek(msDesdeX(e.clientX))
      }}
      onMouseMove={(e) => setHover(msDesdeX(e.clientX))}
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
                setArrastre({ id, ms })
                const mover = (ev: PointerEvent): void => {
                  ultimo = msDesdeX(ev.clientX)
                  setArrastre({ id, ms: ultimo })
                  setHover(ultimo)
                }
                const soltar = (): void => {
                  el.removeEventListener('pointermove', mover)
                  el.removeEventListener('pointerup', soltar)
                  el.removeEventListener('pointercancel', soltar)
                  if (Math.abs(ultimo - s.inicioMs) > 30) onMoverMarcador(id, ultimo)
                  else onSeek(s.inicioMs) // click sin arrastrar: ir a esa seccion
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
