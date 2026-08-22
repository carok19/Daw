import { useState } from 'react'
import type { Pista, Proyecto } from '@shared/types'
import { colorDePista } from '../trackColors'

interface Props {
  proyecto: Proyecto
  onUpdatePista: (pistaId: string, patch: Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre'>>) => void
  onReorder: (orden: string[]) => void
}

export function Mixer({ proyecto, onUpdatePista, onReorder }: Props) {
  const [arrastrando, setArrastrando] = useState<string | null>(null)

  function onDrop(destinoId: string): void {
    if (!arrastrando || arrastrando === destinoId) return
    const ids = proyecto.pistas.map((p) => p.id)
    const desde = ids.indexOf(arrastrando)
    const hasta = ids.indexOf(destinoId)
    ids.splice(hasta, 0, ...ids.splice(desde, 1))
    onReorder(ids)
    setArrastrando(null)
  }

  return (
    <div className="mixer">
      {proyecto.pistas.map((pista) => (
        <ChannelStrip
          key={pista.id}
          pista={pista}
          onUpdate={(patch) => onUpdatePista(pista.id, patch)}
          onDragStart={() => setArrastrando(pista.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => onDrop(pista.id)}
        />
      ))}
    </div>
  )
}

function ChannelStrip({
  pista,
  onUpdate,
  onDragStart,
  onDragOver,
  onDrop
}: {
  pista: Pista
  onUpdate: (patch: Partial<Pick<Pista, 'volumen' | 'pan' | 'mute' | 'solo' | 'nombre'>>) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
}) {
  const [editandoNombre, setEditandoNombre] = useState(false)
  const [nombreTmp, setNombreTmp] = useState(pista.nombre)
  const color = colorDePista(pista.id)

  function confirmarNombre(): void {
    setEditandoNombre(false)
    if (nombreTmp.trim() && nombreTmp.trim() !== pista.nombre) onUpdate({ nombre: nombreTmp.trim() })
  }

  return (
    <div
      className="channel"
      style={{ '--color-pista': color } as React.CSSProperties}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="channel-color-bar" />
      {editandoNombre ? (
        <input
          className="channel-nombre-input"
          autoFocus
          value={nombreTmp}
          onChange={(e) => setNombreTmp(e.target.value)}
          onBlur={confirmarNombre}
          onKeyDown={(e) => e.key === 'Enter' && confirmarNombre()}
        />
      ) : (
        <div className="channel-nombre" onDoubleClick={() => setEditandoNombre(true)}>
          {pista.nombre}
        </div>
      )}

      <div className="channel-pan">
        <span>Pan</span>
        <input
          type="range"
          min={-100}
          max={100}
          value={pista.pan}
          onChange={(e) => onUpdate({ pan: Number(e.target.value) })}
        />
        <span className="channel-pan-valor">{pista.pan}</span>
      </div>

      <div className="channel-fader-wrap">
        <input
          className="channel-fader"
          type="range"
          min={0}
          max={100}
          value={pista.volumen}
          onChange={(e) => onUpdate({ volumen: Number(e.target.value) })}
        />
        <span className="channel-fader-valor">{pista.volumen}</span>
      </div>

      <div className="channel-botones">
        <button className={`btn-mute ${pista.mute ? 'activo' : ''}`} onClick={() => onUpdate({ mute: !pista.mute })}>
          M
        </button>
        <button className={`btn-solo ${pista.solo ? 'activo' : ''}`} onClick={() => onUpdate({ solo: !pista.solo })}>
          S
        </button>
      </div>
    </div>
  )
}
