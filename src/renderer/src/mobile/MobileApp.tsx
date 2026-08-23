import { useState } from 'react'
import type { AppController } from '../App'
import { formatMmSs } from '../format'
import { LoadingRing } from './LoadingRing'

export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado, playheadMs, audioListo, cargaProgreso } = controller
  const [audioActivo, setAudioActivo] = useState(false)
  const [mostrarAjuste, setMostrarAjuste] = useState(false)
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
        <button className="mobile-ajuste-toggle" onClick={() => setMostrarAjuste(true)} title="Ajuste fino de sincronización">
          ⚙ Ajuste fino{controller.ajusteManualMs !== 0 ? ` (${controller.ajusteManualMs > 0 ? '+' : ''}${controller.ajusteManualMs}ms)` : ''}
        </button>
      </div>

      {mostrarAjuste && (
        <div className="overlay" onClick={() => setMostrarAjuste(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h2>Ajuste fino de sincronización</h2>
            <p>
              Si ESTE celular suena <strong>después</strong> que los demás, movelo a la derecha (+). Si suena{' '}
              <strong>antes</strong>, movelo a la izquierda (–). Se guarda solo en este celular.
            </p>
            <p className="ajuste-valor">
              {controller.ajusteManualMs > 0 ? '+' : ''}
              {controller.ajusteManualMs} ms
            </p>
            <input
              type="range"
              min={-500}
              max={500}
              step={10}
              value={controller.ajusteManualMs}
              onChange={(e) => controller.setAjusteManualMs(Number(e.target.value))}
            />
            <div className="ajuste-botones">
              <button onClick={() => controller.setAjusteManualMs(0)}>Restablecer</button>
              <button className="btn-primario" onClick={() => setMostrarAjuste(false)}>
                Listo
              </button>
            </div>
          </div>
        </div>
      )}

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

      {proyecto && !audioListo && (
        <div className="mobile-cargando-pantalla">
          <LoadingRing progreso={cargaProgreso} />
          <p>Descargando la canción…</p>
        </div>
      )}

      {proyecto && audioListo && (
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
          </div>
        </>
      )}
    </div>
  )
}
