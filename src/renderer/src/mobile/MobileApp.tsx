import { useState } from 'react'
import type { AppController } from '../App'
import { formatMmSs } from '../format'

export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado, playheadMs, audioListo } = controller
  const [audioActivo, setAudioActivo] = useState(false)
  const proyecto = estado?.proyectoActivo ?? null
  const marcadoresOrdenados = [...(proyecto?.marcadores ?? [])].sort((a, b) => a.tiempoMs - b.tiempoMs)

  let marcadorActualId: string | null = null
  for (const m of marcadoresOrdenados) {
    if (m.tiempoMs <= playheadMs) marcadorActualId = m.id
    else break
  }

  async function activar(): Promise<void> {
    await controller.activarAudio()
    setAudioActivo(true)
  }

  return (
    <div className="mobile">
      <div className="mobile-header">
        <span className={`estado-conexion ${conectado ? 'conectado' : 'desconectado'}`}>
          {conectado ? '● Conectado' : '○ Desconectado'}
        </span>
        <h1>{proyecto?.nombre ?? 'Esperando canción…'}</h1>
      </div>

      {!audioActivo && (
        <div className="overlay">
          <div className="panel">
            <p>Tocá para activar el audio en este celular.</p>
            <button className="btn-primario" onClick={activar}>
              Activar audio
            </button>
          </div>
        </div>
      )}

      {proyecto && (
        <>
          <div className="mobile-marcadores">
            {marcadoresOrdenados.length === 0 && <p className="markers-vacio">Todavía no hay marcadores.</p>}
            {marcadoresOrdenados.map((m) => (
              <button
                key={m.id}
                className={`mobile-marcador-btn ${m.id === marcadorActualId ? 'actual' : ''}`}
                disabled={estado?.locked}
                onClick={() => controller.jumpToMarker(m.id)}
              >
                {m.nombre}
              </button>
            ))}
          </div>

          <div className="mobile-footer">
            <span className="mobile-tiempo">{formatMmSs(playheadMs)}</span>
            <div className="mobile-volumen">
              <span>🔈</span>
              <input
                type="range"
                min={0}
                max={100}
                value={controller.volumenGeneral}
                onChange={(e) => controller.setVolumenGeneral(Number(e.target.value))}
              />
              <span>🔊</span>
            </div>
            {!audioListo && <span className="mobile-cargando">Cargando audio…</span>}
          </div>
        </>
      )}
    </div>
  )
}
