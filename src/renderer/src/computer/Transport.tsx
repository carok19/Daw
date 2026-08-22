import { useEffect, useRef, useState } from 'react'
import type { PlaybackState, Proyecto } from '@shared/types'
import { formatMmSs } from '../format'

interface Props {
  proyecto: Proyecto
  playback: PlaybackState | null
  playheadMs: number
  onPlay: () => void
  onPause: () => void
  onStop: () => void
  onSeek: (positionMs: number) => void
  onJumpMarker: (marcadorId: string) => void
  onDragMarker: (marcadorId: string, tiempoMs: number) => void
}

export function Transport({
  proyecto,
  playback,
  playheadMs,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onJumpMarker,
  onDragMarker
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [arrastre, setArrastre] = useState<{ id: string; ratio: number } | null>(null)
  const duracion = Math.max(proyecto.duracionTotalMs, 1)
  const jugando = playback?.estado === 'playing'

  function ratioDesdeClientX(clientX: number): number {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  function onClickTrack(e: React.MouseEvent): void {
    onSeek(Math.round(ratioDesdeClientX(e.clientX) * duracion))
  }

  useEffect(() => {
    if (!arrastre) return
    function onMove(e: MouseEvent): void {
      setArrastre((prev) => (prev ? { ...prev, ratio: ratioDesdeClientX(e.clientX) } : prev))
    }
    function onUp(): void {
      setArrastre((prev) => {
        if (prev) onDragMarker(prev.id, Math.round(prev.ratio * duracion))
        return null
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrastre?.id])

  return (
    <div className="transport">
      <div className="transport-botones">
        <button onClick={onStop} title="Stop">
          ■
        </button>
        {jugando ? (
          <button onClick={onPause} title="Pausar (espacio)">
            ❚❚
          </button>
        ) : (
          <button onClick={onPlay} title="Reproducir (espacio)">
            ▶
          </button>
        )}
        <span className="transport-tiempo">
          {formatMmSs(playheadMs)} / {formatMmSs(proyecto.duracionTotalMs)}
        </span>
      </div>

      <div className="transport-track" ref={trackRef} onClick={onClickTrack}>
        <div className="transport-progreso" style={{ width: `${(playheadMs / duracion) * 100}%` }} />
        <div className="transport-playhead" style={{ left: `${(playheadMs / duracion) * 100}%` }} />
      </div>

      <div className="transport-marcadores">
        {proyecto.marcadores.map((m) => {
          const ratio = arrastre && arrastre.id === m.id ? arrastre.ratio : m.tiempoMs / duracion
          return (
            <div
              key={m.id}
              className="marcador-flag"
              style={{ left: `${ratio * 100}%` }}
              onMouseDown={(e) => {
                e.stopPropagation()
                setArrastre({ id: m.id, ratio: m.tiempoMs / duracion })
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (!arrastre) onJumpMarker(m.id)
              }}
              title={m.nombre}
            >
              <span>{m.nombre}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
