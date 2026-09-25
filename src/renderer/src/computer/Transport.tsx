import { useState } from 'react'
import { ChevronRight, Pause, Play, Repeat, SkipBack, SkipForward, Square } from 'lucide-react'
import type { PlaybackState, Proyecto } from '@shared/types'
import type { Seccion } from '@shared/playback'
import { seccionEn } from '@shared/playback'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Timeline } from './Timeline'
import { SyncBadge } from './SyncBadge'

interface Props {
  proyecto: Proyecto
  secciones: Seccion[]
  playback: PlaybackState | null
  loop: boolean
  siguienteProyecto: Proyecto | null
  driftMs: number | null
  sonidoLocal: boolean
  onTogglePlay: () => void
  onStop: () => void
  onSeek: (ms: number) => void
  onSeccion: (delta: number) => void
  onLoop: (v: boolean) => void
  onSiguienteCancion: () => void
  onRenombrar: (nombre: string) => void
  onMoverMarcador: (id: string, ms: number) => void
}

function Reloj({ duracionMs }: { duracionMs: number }) {
  const pos = usePlayheadPaso(200)
  return (
    <div className="reloj num">
      <div className="reloj-grande">{formatMmSs(pos)}</div>
      <div className="reloj-chico">
        −{formatMmSs(Math.max(0, duracionMs - pos))} · {formatMmSs(duracionMs)}
      </div>
    </div>
  )
}

function SeccionActual({ secciones, loop }: { secciones: Seccion[]; loop: boolean }) {
  const pos = usePlayheadPaso(100)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  if (!actual) return null
  return (
    <div className="seccion-actual">
      <span className="seccion-pill" style={{ background: colorDeSeccion(actual) }}>
        {loop && <Repeat size={14} />}
        {actual.nombre}
      </span>
      <span className="seccion-siguiente">
        {secciones.length === 1 && !actual.marcador
          ? 'Sin secciones: presioná M con la canción sonando'
          : loop
            ? 'Repitiendo esta sección'
            : siguiente
              ? `Sigue: ${siguiente.nombre}`
              : 'Última sección'}
      </span>
    </div>
  )
}

export function Transport(p: Props) {
  const [editando, setEditando] = useState(false)
  const [nombre, setNombre] = useState(p.proyecto.nombre)
  const sonando = p.playback?.estado === 'playing'

  function confirmar(): void {
    setEditando(false)
    if (nombre.trim() && nombre.trim() !== p.proyecto.nombre) p.onRenombrar(nombre.trim())
  }

  return (
    <section className="transporte">
      <div className="transporte-fila">
        <div className="transporte-info">
          {editando ? (
            <input
              className="cancion-titulo-input"
              autoFocus
              value={nombre}
              maxLength={80}
              onChange={(e) => setNombre(e.target.value)}
              onBlur={confirmar}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmar()
                if (e.key === 'Escape') setEditando(false)
              }}
            />
          ) : (
            <div
              className="cancion-titulo"
              title="Doble click para renombrar"
              onDoubleClick={() => {
                setNombre(p.proyecto.nombre)
                setEditando(true)
              }}
            >
              {p.proyecto.nombre}
            </div>
          )}
          <SeccionActual secciones={p.secciones} loop={p.loop} />
        </div>

        <div className="transporte-botones">
          <button className="tbtn" onClick={() => p.onSeccion(-1)} title="Sección anterior (←)" aria-label="Sección anterior">
            <SkipBack size={20} />
          </button>
          <button className="tbtn" onClick={p.onStop} title="Stop y volver al inicio (Enter)" aria-label="Stop">
            <Square size={18} fill="currentColor" />
          </button>
          <button
            className={`tbtn tbtn-play ${sonando ? 'sonando' : ''}`}
            onClick={p.onTogglePlay}
            title={sonando ? 'Pausa (Espacio)' : 'Reproducir (Espacio)'}
            aria-label={sonando ? 'Pausa' : 'Reproducir'}
          >
            {sonando ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" style={{ marginLeft: 3 }} />}
          </button>
          <button className="tbtn" onClick={() => p.onSeccion(1)} title="Sección siguiente (→)" aria-label="Sección siguiente">
            <SkipForward size={20} />
          </button>
          <button
            className={`tbtn tbtn-loop ${p.loop ? 'activo' : ''}`}
            onClick={() => p.onLoop(!p.loop)}
            title="Repetir la sección actual (L)"
            aria-pressed={p.loop}
            aria-label="Repetir sección"
          >
            <Repeat size={19} />
          </button>
        </div>

        <div className="transporte-derecha">
          {p.sonidoLocal && sonando && <SyncBadge driftMs={p.driftMs} />}
          <Reloj duracionMs={p.proyecto.duracionTotalMs} />
          {p.siguienteProyecto && (
            <button className="siguiente-cancion" onClick={p.onSiguienteCancion} title="Pasar a la siguiente canción (Av Pág)">
              <small>Siguiente</small>
              <span>
                {p.siguienteProyecto.nombre} <ChevronRight size={14} />
              </span>
            </button>
          )}
        </div>
      </div>

      <Timeline
        secciones={p.secciones}
        duracionMs={p.proyecto.duracionTotalMs}
        loop={p.loop}
        onSeek={p.onSeek}
        onMoverMarcador={p.onMoverMarcador}
      />
    </section>
  )
}
