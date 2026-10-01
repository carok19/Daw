import { useState } from 'react'
import { ArrowRight, ChevronRight, Magnet, MonitorPlay, Pause, Play, Repeat, SkipBack, SkipForward, Square, Waves, X } from 'lucide-react'
import type { OndaCancion, PlaybackState, ProgresoTono, Proyecto, SaltoPendiente } from '@shared/types'
import type { Seccion } from '@shared/playback'
import { bpmDistintoEnSeccion, compasesQueFaltan, seccionEn } from '@shared/playback'
import { tonalidadEn } from '@shared/tonalidad'
import { useGolpeCuenta, usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Timeline } from './Timeline'
import { SyncBadge } from './SyncBadge'
import { ControlTono, ControlVelocidad } from './ControlTono'

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
  onCambiarVelocidad: (velocidad: number) => void
  onTonalidad: (tonalidad: string | null) => void
  onCuenta: (cuenta: 0 | 1 | 2 | null) => void
  /** forma de onda de la cancion para la linea de tiempo */
  onda: OndaCancion | null
  /** linea de tiempo alta (vista de secciones) o finita (vista de mezcla) */
  timelineGrande: boolean
  /** esta cancion esta en su colchon (la banda paro; siguen el click y el pad) */
  enColchon: boolean
  /** hay un colchon sonando (de esta cancion, de otra o de la lista) */
  hayColchon: boolean
  onColchon: () => void
  /** AirTracks Video tiene el video de esta canción (se ve en el proyector mientras suena) */
  videoEnProyector?: boolean
}

function textoCompas(compas: number): string {
  return compas === 6 ? '6/8' : `${compas}/4`
}

function Reloj({ duracionMs }: { duracionMs: number }) {
  const pos = usePlayheadPaso(200)
  const golpe = useGolpeCuenta()
  if (golpe > 0) {
    return (
      <div className="reloj num reloj-contando" role="status" aria-label={`Cuenta ${golpe}`}>
        <div className="reloj-grande">{golpe}</div>
        <div className="reloj-chico">cuenta</div>
      </div>
    )
  }
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

/** Compases que faltan para que termine la seccion (o para el salto elegido): "faltan 3", "último compás". */
export function FaltanCompases({ n, className = 'faltan-compases' }: { n: number | null; className?: string }) {
  if (n === null) return null
  return (
    <span className={`${className} ${n === 1 ? 'ultimo' : n === 2 ? 'penultimo' : ''}`} role="status" aria-label={n === 1 ? 'Último compás de la sección' : `Faltan ${n} compases`}>
      {n === 1 ? (
        'último compás'
      ) : (
        <>
          faltan <b className="num">{n}</b>
        </>
      )}
    </span>
  )
}

/** true si la cancion tiene cambios de tono marcados en sus secciones. */
export function cambiaDeTono(p: Pick<Proyecto, 'marcadores'>): boolean {
  return p.marcadores.some((m) => !!m.tonalidad)
}

/**
 * " · en E" si la seccion `s` suena en otro tono que el que suena en `desdeMs`
 * (para "Sigue: Coro final · en E").
 */
export function textoCambioDeTono(p: Proyecto, desdeMs: number, s: Pick<Seccion, 'inicioMs'> | null | undefined): string {
  if (!s || !cambiaDeTono(p)) return ''
  const ahora = tonalidadEn(p, desdeMs)
  const luego = tonalidadEn(p, s.inicioMs)
  return luego && luego !== ahora ? ` · en ${luego}` : ''
}

function SeccionActual({
  proyecto,
  secciones,
  loop,
  salto,
  onCancelarSalto
}: {
  proyecto: Proyecto
  secciones: Seccion[]
  loop: boolean
  salto: SaltoPendiente | null
  onCancelarSalto: () => void
}) {
  const pos = usePlayheadPaso(100)
  const golpe = useGolpeCuenta()
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  if (!actual) return null
  const destino = salto ? seccionEn(secciones, salto.destinoMs) : null
  const compasesMs = proyecto.tempo?.compasesMs ?? null
  // una cancion que cambia de tempo o de tono: el de la parte que suena
  const bpmAqui = bpmDistintoEnSeccion(proyecto.tempo, actual)
  const tonoAqui = cambiaDeTono(proyecto) ? tonalidadEn(proyecto, pos) : null
  return (
    <div className="seccion-actual">
      <span className="seccion-pill" style={{ background: colorDeSeccion(actual) }}>
        {loop && <Repeat size={14} />}
        {actual.nombre}
      </span>
      {golpe === 0 && <FaltanCompases n={compasesQueFaltan(compasesMs, actual, pos, salto?.limiteMs)} />}
      {tonoAqui && (
        <span className="chip-seccion-dato num" title="Tono de esta parte (la canción cambia de tono)" data-testid="tono-seccion">
          Tono {tonoAqui}
        </span>
      )}
      {bpmAqui !== null && (
        <span className="chip-seccion-dato num" title={`Tempo de esta sección (la canción va a ${Math.round(proyecto.tempo!.bpm)} BPM)`} data-testid="bpm-seccion">
          {Math.round(bpmAqui)} BPM aquí
        </span>
      )}
      {salto && destino ? (
        <span className="salto-pendiente" role="status" style={{ '--color-seccion': colorDeSeccion(destino) } as React.CSSProperties}>
          <ArrowRight size={14} />
          <b>{salto.nombre}</b>
          {textoCambioDeTono(proyecto, pos, destino)}
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
              ? `Sigue: ${siguiente.nombre}${textoCambioDeTono(proyecto, pos, siguiente)}`
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
            <SeccionActual proyecto={p.proyecto} secciones={p.secciones} loop={p.loop} salto={p.saltoPendiente} onCancelarSalto={p.onCancelarSalto} />
            {p.proyecto.tempo && (
              <span className="chip-tempo num" title={
                  p.proyecto.tempo.acentoClaro
                    ? 'Detectado del click'
                    : p.proyecto.tempo.faseDesdeGuia
                      ? 'Detectado del click; el "1" de cada compás, de la voz guía (el click no tiene acento)'
                      : 'Detectado del click (no se distinguió el acento del 1: se contó desde el primer golpe)'
                }>
                <ControlVelocidad proyecto={p.proyecto} sonando={sonando} progreso={p.progresoTono} onCambiar={p.onCambiarVelocidad} />
                {' · '}
                {textoCompas(p.proyecto.tempo.compas)}
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
            {p.videoEnProyector && (
              <span className="chip-seccion-dato" title="AirTracks Video tiene el video con la letra de esta canción: se ve en el proyector mientras suena, siguiendo las secciones" data-testid="chip-video">
                <MonitorPlay size={12} /> Video
              </span>
            )}
            {p.proyecto.tempo && p.proyecto.tempo.compasesMs.length > 1 && (
              <select
                className="chip-cuenta"
                value={p.proyecto.cuenta === undefined ? 'auto' : String(p.proyecto.cuenta)}
                onChange={(e) => p.onCuenta(e.target.value === 'auto' ? null : (Number(e.target.value) as 0 | 1 | 2))}
                title={
                  (p.proyecto.tempo.cuentaPropia ?? 0) > 0
                    ? `Esta canción ya trae su cuenta (${p.proyecto.tempo.cuentaPropia === 1 ? '1 compás' : `${p.proyecto.tempo.cuentaPropia} compases`}): desde el principio cuenta ella; desde una sección o después de una pausa, el click cuenta 1 compás. Se puede forzar otra.`
                    : 'Cuenta al dar play: el click cuenta un compás (“1 2 3 4”) y recién entra la canción, en todos a la vez'
                }
                aria-label="Cuenta antes de la canción"
              >
                <option value="auto">{(p.proyecto.tempo.cuentaPropia ?? 0) > 0 ? 'Cuenta: la de la canción (auto)' : 'Cuenta: 1 compás (auto)'}</option>
                <option value="2">Cuenta: 2 compases</option>
                <option value="1">Cuenta: 1 compás</option>
                <option value="0">Sin cuenta</option>
              </select>
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
            title={p.enColchon ? (sonando ? 'Terminar el colchón (Espacio)' : 'Seguir la canción donde quedó, en el próximo compás (Espacio)') : sonando ? 'Pausa (Espacio)' : 'Reproducir (Espacio)'}
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
          <button
            className={`tbtn tbtn-colchon ${p.enColchon ? 'activo' : ''}`}
            onClick={p.onColchon}
            disabled={!p.enColchon && (p.hayColchon || !sonando || !p.proyecto.tempo || p.proyecto.tempo.compasesMs.length < 2)}
            title={
              p.enColchon
                ? 'Terminar el colchón (C): el click para y el pad se apaga'
                : !p.proyecto.tempo
                  ? 'Colchón: hace falta el tempo de la canción (el click)'
                  : 'Colchón (C): en el próximo compás se va la banda y siguen el click y un pad en el tono de la canción. Tocá una sección para volver.'
            }
            aria-pressed={p.enColchon}
            aria-label="Colchón"
          >
            <Waves size={19} />
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
        onda={p.onda}
        grande={p.timelineGrande}
      />
    </section>
  )
}
