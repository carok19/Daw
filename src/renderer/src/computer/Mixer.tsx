import { useEffect, useRef, useState } from 'react'
import type { PatchPista, Pista, Proyecto } from '@shared/types'
import { formatDb, formatPan } from '../format'

/** Mismos colores que asigna el servidor al importar (server/projects.ts). */
const PALETA = ['#ff8a3d', '#3dbcff', '#a6e05a', '#ff5c8a', '#b18cff', '#ffd23d', '#3de0c0', '#ff6b5c', '#6b8cff', '#e07cff', '#8fd6a0', '#d9a066']

const VOLUMEN_POR_DEFECTO = 80

interface Props {
  proyecto: Proyecto
  onUpdate: (pistaId: string, patch: PatchPista) => void
  onReorder: (orden: string[]) => void
}

export function Mixer({ proyecto, onUpdate, onReorder }: Props) {
  const [arrastrando, setArrastrando] = useState<string | null>(null)
  const [destino, setDestino] = useState<string | null>(null)

  function soltar(sobre: string): void {
    if (!arrastrando || arrastrando === sobre) return
    const ids = proyecto.pistas.map((p) => p.id)
    const desde = ids.indexOf(arrastrando)
    const hasta = ids.indexOf(sobre)
    ids.splice(hasta, 0, ...ids.splice(desde, 1))
    onReorder(ids)
  }

  const haySolo = proyecto.pistas.some((p) => p.solo)

  return (
    <div className="mixer">
      {proyecto.pistas.map((pista) => (
        <Canal
          key={pista.id}
          pista={pista}
          silenciadaPorSolo={haySolo && !pista.solo}
          arrastrando={arrastrando === pista.id}
          destino={destino === pista.id && arrastrando !== pista.id}
          onUpdate={(patch) => onUpdate(pista.id, patch)}
          onDragStart={() => setArrastrando(pista.id)}
          onDragOver={() => setDestino(pista.id)}
          onDrop={() => soltar(pista.id)}
          onDragEnd={() => {
            setArrastrando(null)
            setDestino(null)
          }}
        />
      ))}
    </div>
  )
}

function Canal({
  pista,
  silenciadaPorSolo,
  arrastrando,
  destino,
  onUpdate,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  pista: Pista
  silenciadaPorSolo: boolean
  arrastrando: boolean
  destino: boolean
  onUpdate: (patch: PatchPista) => void
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  const [editando, setEditando] = useState(false)
  const [nombre, setNombre] = useState(pista.nombre)
  const [paleta, setPaleta] = useState(false)

  function confirmarNombre(): void {
    setEditando(false)
    if (nombre.trim() && nombre.trim() !== pista.nombre) onUpdate({ nombre: nombre.trim() })
  }

  return (
    <div
      className={`canal ${pista.mute || silenciadaPorSolo ? 'muteado' : ''} ${arrastrando ? 'arrastrando' : ''} ${destino ? 'destino' : ''}`}
      style={{ '--color-pista': pista.color } as React.CSSProperties}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver()
      }}
      onDrop={onDrop}
    >
      <button className="canal-color" title="Cambiar color" aria-label={`Color de ${pista.nombre}`} onClick={() => setPaleta((v) => !v)} />
      {paleta && (
        <Paleta
          actual={pista.color}
          onElegir={(color) => {
            onUpdate({ color })
            setPaleta(false)
          }}
          onCerrar={() => setPaleta(false)}
        />
      )}
      <div
        className="canal-cabeza"
        draggable={!editando}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        title="Doble click para renombrar · arrastrá para reordenar"
      >
        {editando ? (
          <input
            className="canal-nombre-input"
            autoFocus
            value={nombre}
            maxLength={40}
            onChange={(e) => setNombre(e.target.value)}
            onBlur={confirmarNombre}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmarNombre()
              if (e.key === 'Escape') setEditando(false)
            }}
          />
        ) : (
          <div
            className="canal-nombre"
            onDoubleClick={() => {
              setNombre(pista.nombre)
              setEditando(true)
            }}
          >
            {pista.nombre}
          </div>
        )}
      </div>

      <div className="canal-pan">
        <PanControl valor={pista.pan} onCambiar={(pan) => onUpdate({ pan })} />
      </div>

      <div className="canal-fader">
        <Fader valor={pista.volumen} onCambiar={(volumen) => onUpdate({ volumen })} etiqueta={pista.nombre} />
      </div>
      <div className="canal-valor num" title="Nivel (dB)">
        {formatDb(pista.volumen)}
      </div>

      <div className="canal-botones">
        <button
          className={`btn-mute ${pista.mute ? 'activo' : ''}`}
          onClick={() => onUpdate({ mute: !pista.mute })}
          title="Mute: silenciar esta pista en todos los celulares"
          aria-pressed={pista.mute}
        >
          M
        </button>
        <button
          className={`btn-solo ${pista.solo ? 'activo' : ''}`}
          onClick={() => onUpdate({ solo: !pista.solo })}
          title="Solo: escuchar solo las pistas en solo"
          aria-pressed={pista.solo}
        >
          S
        </button>
      </div>
    </div>
  )
}

function Paleta({ actual, onElegir, onCerrar }: { actual: string; onElegir: (c: string) => void; onCerrar: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function fuera(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onCerrar()
    }
    window.addEventListener('mousedown', fuera)
    return () => window.removeEventListener('mousedown', fuera)
  }, [onCerrar])
  return (
    <div className="paleta" ref={ref}>
      {PALETA.map((c) => (
        <button key={c} className={c === actual ? 'activo' : ''} style={{ background: c }} onClick={() => onElegir(c)} aria-label={c} />
      ))}
    </div>
  )
}

/**
 * Arrastre relativo con pointer events: el valor cambia segun cuanto se mueve
 * el mouse DESDE donde se agarro (un click suelto no hace saltar el volumen,
 * como en una consola real). Shift = ajuste fino. Doble click = valor por defecto.
 */
function useArrastreRelativo(
  valor: number,
  min: number,
  max: number,
  pixelesRecorrido: () => number,
  eje: 'x' | 'y',
  onCambiar: (v: number) => void
) {
  const [local, setLocal] = useState<number | null>(null)
  const mostrado = local ?? valor

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const inicio = eje === 'y' ? e.clientY : e.clientX
    const valorInicio = valor
    let ultimo = valor
    setLocal(valor)
    const mover = (ev: PointerEvent): void => {
      const delta = (eje === 'y' ? inicio - ev.clientY : ev.clientX - inicio) * (ev.shiftKey ? 0.25 : 1)
      const nuevo = Math.round(Math.min(max, Math.max(min, valorInicio + (delta / pixelesRecorrido()) * (max - min))))
      if (nuevo !== ultimo) {
        ultimo = nuevo
        setLocal(nuevo)
        onCambiar(nuevo)
      }
    }
    const soltar = (): void => {
      el.removeEventListener('pointermove', mover)
      el.removeEventListener('pointerup', soltar)
      el.removeEventListener('pointercancel', soltar)
      setLocal(null)
    }
    el.addEventListener('pointermove', mover)
    el.addEventListener('pointerup', soltar)
    el.addEventListener('pointercancel', soltar)
  }

  return { mostrado, onPointerDown }
}

function Fader({ valor, onCambiar, etiqueta }: { valor: number; onCambiar: (v: number) => void; etiqueta: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const alto = (): number => Math.max(40, (ref.current?.clientHeight ?? 200) - 20)
  const { mostrado, onPointerDown } = useArrastreRelativo(valor, 0, 100, alto, 'y', onCambiar)
  const pct = `${mostrado}%`
  return (
    <div
      ref={ref}
      className="fader"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCambiar(VOLUMEN_POR_DEFECTO)}
      role="slider"
      aria-label={`Volumen de ${etiqueta}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={mostrado}
      title="Arrastrá para cambiar el volumen · Shift = fino · doble click = volver a −3.9 dB"
    >
      <div className="fader-escala">
        {[100, 80, 60, 40, 20, 0].map((v) => (
          <span key={v} className={v === 100 ? 'cero' : ''} style={{ bottom: `${v}%` }} />
        ))}
      </div>
      <div className="fader-riel">
        <div className="fader-relleno" style={{ height: pct }} />
      </div>
      <div className="fader-tapa" style={{ top: `calc(10px + (100% - 20px) * ${(100 - mostrado) / 100})` }} />
    </div>
  )
}

function PanControl({ valor, onCambiar }: { valor: number; onCambiar: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const ancho = (): number => Math.max(40, ref.current?.clientWidth ?? 70)
  const { mostrado, onPointerDown } = useArrastreRelativo(valor, -100, 100, ancho, 'x', onCambiar)
  const pos = (mostrado + 100) / 2
  return (
    <div>
      <div
        ref={ref}
        className="pan"
        onPointerDown={onPointerDown}
        onDoubleClick={() => onCambiar(0)}
        role="slider"
        aria-label="Paneo"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={mostrado}
        title="Paneo · doble click = centro"
      >
        <div className="pan-riel" />
        <div className="pan-relleno" style={{ left: `${Math.min(50, pos)}%`, width: `${Math.abs(pos - 50)}%` }} />
        <div className="pan-centro" />
        <div className="pan-tapa" style={{ left: `${pos}%` }} />
      </div>
      <div className="pan-etiquetas num">
        <span>L</span>
        <b>{formatPan(mostrado)}</b>
        <span>R</span>
      </div>
    </div>
  )
}
