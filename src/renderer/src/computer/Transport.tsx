import { useState } from 'react'
import { ArrowRight, ChevronRight, Magnet, Pause, Play, Repeat, SkipBack, SkipForward, Square, X } from 'lucide-react'
import type { PlaybackState, ProgresoTono, Proyecto, SaltoPendiente } from '@shared/types'
import type { Seccion } from '@shared/playback'
import { seccionEn } from '@shared/playback'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Timeline } from './Timeline'
import { SyncBadge } from './SyncBadge'
import { ControlTono } from './ControlTono'

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
  onSeek: (ms: number, inmediato: boolean) => void
  onSeccion: (delta: number) => void
  onLoop: (v: boolean) => void
  onSiguienteCancion: () => void
  onRenombrar: (nombre: string) => void
  onMoverMarcador: (id: string, ms: number, sinAjustar: boolean) => void
  ajustarCompas: boolean
  onAjustarCompas: (v: boolean) => void
  saltoPendiente: SaltoPendiente | null
  onCancelarSalto: () => void
  progresoTono: ProgresoTono | null
  onCambiarTono: (semitonos: number) => void
  onTonalidad: (tonalidad: string | null) => void
}

function textoCompas(compas: number): string {
  return compas === 6 ? '6/8' : `${compas}/4`
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

/** "en 3 s" hasta el limite del salto (en tiempo de la cancion: sigue al playhead). */
export function faltaParaSalto(salto: SaltoPendiente, pos: number): string {
  const s = Math.max(0, Math.ceil((salto.limiteMs - pos) / 1000))
  return s <= 0 ? 'ya' : `en ${s} s`
}

function SeccionActual({
  secciones,
  loop,
  salto,
  onCancelarSalto
}: {
  secciones: Seccion[]
  loop: boolean
  salto: SaltoPendiente | null
  onCancelarSalto: () => void
}) {
  const pos = usePlayheadPaso(100)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  if (!actual) return null
  const destino = salto ? seccionEn(secciones, salto.destinoMs) : null
  return (
    <div className="seccion-actual">
      <span className="seccion-pill" style={{ background: colorDeSeccion(actual) }}>
        {loop && <Repeat size={14} />}
        {actual.nombre}
      </span>
      {salto && destino ? (
        <span className="salto-pendiente" role="status" style={{ '--color-seccion': colorDeSeccion(destino) } as React.CSSProperties}>
          <ArrowRight size={14} />
          <b>{salto.nombre}</b>
          <span className="num">{faltaParaSalto(salto, pos)}</span>
          <button onClick={onCancelarSalto} title="Cancelar el salto (Esc)" aria-label="Cancelar el salto">
            <X size={13} />
          </button>
        </span>
      ) : (
      <span className="seccion-siguiente">
        {secciones.length === 1 && !actual.marcador
          ? 'Sin secciones: presioná M con la canción sonando'
          : loop
            ? 'Repitiendo esta sección'
            : siguiente
              ? `Sigue: ${siguiente.nombre}`
              : 'Última sección'}
      </span>
      )}
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
          <div className="transporte-titulo-fila">
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
            <ControlTono proyecto={p.proyecto} sonando={sonando} progreso={p.progresoTono} onCambiar={p.onCambiarTono} onTonalidad={p.onTonalidad} />
          </div>
          <div className="transporte-meta">
            <SeccionActual secciones={p.secciones} loop={p.loop} salto={p.saltoPendiente} onCancelarSalto={p.onCancelarSalto} />
            {p.proyecto.tempo && (
              <span className="chip-tempo num" title={
                  p.proyecto.tempo.acentoClaro
                    ? 'Detectado del click'
                    : p.proyecto.tempo.faseDesdeGuia
                      ? 'Detectado del click; el "1" de cada compás, de la voz guía (el click no tiene acento)'
                      : 'Detectado del click (no se distinguió el acento del 1: se contó desde el primer golpe)'
                }>
                {Math.round(p.proyecto.tempo.bpm)} BPM · {textoCompas(p.proyecto.tempo.compas)}
                <button
                  className={`boton-iman ${p.ajustarCompas ? 'activo' : ''}`}
                  onClick={() => p.onAjustarCompas(!p.ajustarCompas)}
                  title={p.ajustarCompas ? 'Ajustar al compás: las secciones caen en el "1" (Alt al arrastrar para moverlas libres)' : 'Ajustar al compás: desactivado'}
                  aria-pressed={p.ajustarCompas}
                  aria-label="Ajustar al compás"
                >
                  <Magnet size={13} />
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="transporte-botones">
          <button className="tbtn" onClick={() => p.onSeccion(-1)} title="Sección anterior (←; sonando, al terminar la sección — Shift+← salta ya)" aria-label="Sección anterior">
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
          <button className="tbtn" onClick={() => p.onSeccion(1)} title="Sección siguiente (→; sonando, en el próximo compás — Shift+→ salta ya)" aria-label="Sección siguiente">
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
        compasesMs={p.proyecto.tempo?.compasesMs ?? null}
        loop={p.loop}
        salto={p.saltoPendiente}
        ajustar={p.ajustarCompas}
        onSeek={p.onSeek}
        onMoverMarcador={p.onMoverMarcador}
      />
    </section>
  )
}
