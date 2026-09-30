import { Minus, Plus } from 'lucide-react'
import type { ProgresoTono, Proyecto } from '@shared/types'
import { TONALIDADES, TONO_MAX, TONO_MIN, textoSemitonos, tonalidadDesdeNombre, tonalidadOriginal, transponerTonalidad } from '@shared/tonalidad'
import { bpmOriginal, esVelocidadValida, redondearVelocidad, textoPorcentaje, VELOCIDAD_MAX, VELOCIDAD_MIN, velocidadAplicada } from '@shared/velocidad'

interface Props {
  proyecto: Proyecto
  sonando: boolean
  progreso: ProgresoTono | null
  onCambiar: (semitonos: number) => void
  onTonalidad: (tonalidad: string | null) => void
}

/**
 * Tono de la cancion: "− A → B +2 +". La compu prepara las pistas en el tono
 * nuevo antes de tocar (el click, la guia y la bateria quedan igual); con la
 * cancion sonando no se cambia.
 */
export function ControlTono(p: Props) {
  const original = tonalidadOriginal(p.proyecto)
  const delNombre = tonalidadDesdeNombre(p.proyecto.nombre)
  const pedido = p.proyecto.tono ?? 0
  const suena = p.proyecto.tonoAplicado ?? 0
  const preparando = pedido !== suena
  const destino = original ? transponerTonalidad(original, pedido) : null
  const ayuda = p.sonando ? 'Pará la música para cambiar el tono' : null
  const progreso = p.progreso && p.progreso.semitonos === pedido && p.progreso.total > 0 ? p.progreso : null

  return (
    <span className={`chip-tono ${pedido ? 'cambiado' : ''} ${preparando ? 'preparando' : ''}`} data-testid="control-tono">
      <button
        className="boton-tono"
        disabled={p.sonando || pedido <= TONO_MIN}
        onClick={() => p.onCambiar(pedido - 1)}
        title={ayuda ?? 'Bajar medio tono (el click, la guía y la batería quedan igual)'}
        aria-label="Bajar medio tono"
      >
        <Minus size={13} />
      </button>
      <select
        className="tono-original"
        value={p.proyecto.tonalidad ?? ''}
        onChange={(e) => p.onTonalidad(e.target.value || null)}
        title="Tonalidad original de la canción"
        aria-label="Tonalidad original"
      >
        <option value="">{delNombre ?? 'Tono'}</option>
        {TONALIDADES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {pedido !== 0 && (
        <button
          className="tono-destino"
          disabled={p.sonando}
          onClick={() => p.onCambiar(0)}
          title={ayuda ?? 'Volver al tono original'}
        >
          {destino && <>→ {destino} </>}
          <b className="num">{textoSemitonos(pedido)}</b>
        </button>
      )}
      <button
        className="boton-tono"
        disabled={p.sonando || pedido >= TONO_MAX}
        onClick={() => p.onCambiar(pedido + 1)}
        title={ayuda ?? 'Subir medio tono (el click, la guía y la batería quedan igual)'}
        aria-label="Subir medio tono"
      >
        <Plus size={13} />
      </button>
      {preparando && (
        <span className="tono-progreso num" title="La compu está preparando las pistas en el tono nuevo: la canción pasa a ese tono cuando están todas">
          {pedido === 0 ? 'Volviendo…' : `Preparando${progreso ? ` ${progreso.hechos}/${progreso.total}` : '…'}${p.sonando ? ' · al parar' : ''}`}
          {progreso && <i style={{ width: `${Math.round((progreso.hechos / progreso.total) * 100)}%` }} />}
        </span>
      )}
    </span>
  )
}

/**
 * Velocidad de la cancion, de a 1 BPM: "− 76 BPM +" (con "+6 %" si se cambio;
 * tocandolo vuelve a la original). Como el tono, la compu prepara las pistas antes de tocar (todas,
 * tambien el click y la guia) y la cancion pasa a esa velocidad cuando estan.
 */
export function ControlVelocidad(p: {
  proyecto: Proyecto
  sonando: boolean
  progreso: ProgresoTono | null
  onCambiar: (velocidad: number) => void
}) {
  const original = bpmOriginal(p.proyecto)
  if (!original) return null
  const suena = velocidadAplicada(p.proyecto)
  const pedida = esVelocidadValida(p.proyecto.velocidad) ? p.proyecto.velocidad : 1
  const bpm = Math.round(original * pedida)
  const preparando = Math.abs(pedida - suena) > 1e-6
  const progreso = p.progreso && Math.abs((p.progreso.velocidad ?? 1) - pedida) < 1e-6 && p.progreso.total > 0 ? p.progreso : null
  const ayuda = p.sonando ? 'Pará la música para cambiar la velocidad' : null
  const a = (nuevo: number): number => redondearVelocidad(Math.abs(nuevo - original) < 0.5 ? 1 : nuevo / original)
  const puede = (nuevo: number): boolean => a(nuevo) >= VELOCIDAD_MIN - 1e-9 && a(nuevo) <= VELOCIDAD_MAX + 1e-9
  return (
    <span className={`chip-velocidad ${pedida !== 1 ? 'cambiado' : ''} ${preparando ? 'preparando' : ''}`} data-testid="control-velocidad">
      <button
        className="boton-tono"
        disabled={p.sonando || !puede(bpm - 1)}
        onClick={() => p.onCambiar(a(bpm - 1))}
        title={ayuda ?? 'Más lento (1 BPM; el tono no cambia)'}
        aria-label="Más lento"
      >
        <Minus size={13} />
      </button>
      <span className="num velocidad-bpm">{bpm} BPM</span>
      {pedida !== 1 && (
        <button
          className="tono-destino"
          disabled={p.sonando}
          onClick={() => p.onCambiar(1)}
          title={ayuda ?? `Era ${Math.round(original)} BPM: tocá para volver a la velocidad original`}
          aria-label={`Volver a la velocidad original (${Math.round(original)} BPM)`}
        >
          <b className="num">{textoPorcentaje(pedida)}</b>
        </button>
      )}
      <button
        className="boton-tono"
        disabled={p.sonando || !puede(bpm + 1)}
        onClick={() => p.onCambiar(a(bpm + 1))}
        title={ayuda ?? 'Más rápido (1 BPM; el tono no cambia)'}
        aria-label="Más rápido"
      >
        <Plus size={13} />
      </button>
      {preparando && (
        <span className="tono-progreso num" title="La compu está preparando las pistas a la velocidad nueva: la canción pasa a esa velocidad cuando están todas">
          {pedida === 1 ? 'Volviendo…' : `Preparando${progreso ? ` ${progreso.hechos}/${progreso.total}` : '…'}${p.sonando ? ' · al parar' : ''}`}
          {progreso && <i style={{ width: `${Math.round((progreso.hechos / progreso.total) * 100)}%` }} />}
        </span>
      )}
    </span>
  )
}
