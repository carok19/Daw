import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Headphones,
  Lock,
  Pause,
  Play,
  Repeat,
  Settings,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Volume1,
  Volume2,
  WifiOff
} from 'lucide-react'
import { seccionEn } from '@shared/playback'
import type { AppController } from '../app/useAppController'
import { usePlayheadMs, usePlayheadPaso } from '../app/playheadStore'
import { leerPref } from '../app/preferencias'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Avisos } from '../ui/Avisos'
import { useWakeLock } from './useWakeLock'
import { HojaAjustes, HojaMezcla } from './Hojas'

export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado, secciones } = controller
  const [hoja, setHoja] = useState<null | 'ajustes' | 'mezcla'>(null)
  const wake = useWakeLock()
  const proyecto = estado?.proyectoActivo ?? null
  const locked = estado?.locked ?? false
  const loop = estado?.loop ?? false
  const estadoTransporte = estado?.playbackActivo?.estado ?? 'stopped'

  const miEtiqueta = useMemo(() => {
    const id = `celular:${leerPref<string>('device-id', '')}`
    return controller.dispositivos.find((d) => d.id === id)?.etiqueta ?? 'Este celular'
  }, [controller.dispositivos])

  async function empezar(): Promise<void> {
    wake.activar() // tiene que ser dentro del toque del usuario
    await controller.activarAudio()
  }

  return (
    <div className="mobile">
      <div className="m-top">
        <span className="m-conexion">
          <span className={`punto ${conectado ? 'verde' : 'rojo'}`} />
          <strong>{miEtiqueta}</strong>
        </span>
        <button onClick={() => setHoja('mezcla')} disabled={!proyecto} aria-label="Mi mezcla">
          <SlidersHorizontal size={18} /> Mi mezcla
        </button>
        <button onClick={() => setHoja('ajustes')} aria-label="Ajustes">
          <Settings size={18} />
        </button>
      </div>

      {!conectado && (
        <div className="m-alerta error">
          <WifiOff size={20} />
          <span>Sin conexión con la computadora. Reconectando… (revisá que el celular siga en el mismo WiFi)</span>
        </div>
      )}
      {controller.errorAudio && (
        <div className="m-alerta error">
          <AlertTriangle size={20} />
          <span>Problema de audio en {controller.errorAudio}. Avisale al que maneja la compu.</span>
        </div>
      )}
      {controller.bufferEstado === 'critico' && !controller.errorAudio && (
        <div className="m-alerta warn">
          <AlertTriangle size={20} />
          <span>El WiFi está lento: el audio puede cortarse. Acercate al router si podés.</span>
        </div>
      )}

      {proyecto ? (
        <>
          <TarjetaCancion controller={controller} />

          {locked ? (
            <div className="m-bloqueado">
              <Lock size={15} /> El control lo tiene la computadora
            </div>
          ) : (
            <div className="m-transporte" style={{ gridTemplateColumns: '1fr 1.5fr 1fr 1fr' }}>
              <button onClick={() => controller.saltarSeccion(-1)} aria-label="Sección anterior">
                <SkipBack size={20} />
              </button>
              <button
                className={`m-play ${estadoTransporte === 'playing' ? 'sonando' : ''}`}
                onClick={controller.togglePlay}
                aria-label={estadoTransporte === 'playing' ? 'Pausa' : 'Reproducir'}
              >
                {estadoTransporte === 'playing' ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              </button>
              <button onClick={() => controller.saltarSeccion(1)} aria-label="Sección siguiente">
                <SkipForward size={20} />
              </button>
              <button className={`m-loop ${loop ? 'activo' : ''}`} onClick={() => controller.setLoop(!loop)} aria-pressed={loop} aria-label="Repetir sección">
                <Repeat size={19} />
              </button>
            </div>
          )}

          <BotonesSecciones controller={controller} deshabilitado={locked} />

          {controller.siguienteProyecto && (
            <div className="m-siguiente-cancion">
              Después: <b>{controller.siguienteProyecto.nombre}</b>
            </div>
          )}
        </>
      ) : (
        <div className="m-esperando">
          <Headphones size={40} color="var(--text-3)" />
          <strong>Esperando canción…</strong>
          <span>Cuando la computadora elija una canción aparece acá.</span>
        </div>
      )}

      <div className="m-footer">
        <div className="m-volumen">
          <Volume1 size={20} />
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            value={controller.volumenGeneral}
            style={{ '--p': `${controller.volumenGeneral}%` } as React.CSSProperties}
            onChange={(e) => controller.setVolumenGeneral(Number(e.target.value))}
            aria-label="Volumen de este celular"
          />
          <Volume2 size={20} />
        </div>
      </div>

      {!controller.audioActivo && (
        <div className="activar">
          <h1>{proyecto?.nombre ?? 'Multitrack Alabanza'}</h1>
          <p>Conectá los auriculares y tocá el botón. La pantalla va a quedar encendida mientras uses la app.</p>
          <button className="activar-boton" onClick={empezar}>
            <Headphones size={40} />
            Tocá para empezar
          </button>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            <span className={`punto ${conectado ? 'verde' : 'rojo'}`} /> {conectado ? 'Conectado a la computadora' : 'Conectando…'}
          </p>
        </div>
      )}

      {hoja === 'ajustes' && <HojaAjustes controller={controller} etiqueta={miEtiqueta} pantallaEncendida={wake.activo} onCerrar={() => setHoja(null)} />}
      {hoja === 'mezcla' && proyecto && <HojaMezcla controller={controller} proyecto={proyecto} onCerrar={() => setHoja(null)} />}

      <Avisos avisos={controller.avisos} onCerrar={controller.cerrarAviso} />
    </div>
  )
}

function TarjetaCancion({ controller }: { controller: AppController }) {
  const { estado, secciones } = controller
  const proyecto = estado!.proyectoActivo!
  const pos = usePlayheadPaso(200)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  const loop = estado?.loop ?? false
  const e = estado?.playbackActivo?.estado ?? 'stopped'

  return (
    <div className="m-cancion">
      <div className="m-cancion-fila">
        <h1>{proyecto.nombre}</h1>
        <span className={`m-estado ${e === 'playing' ? 'sonando' : e === 'paused' ? 'pausa' : 'detenido'}`}>
          {e === 'playing' ? 'Sonando' : e === 'paused' ? 'Pausa' : 'Detenido'}
        </span>
      </div>
      <div className="m-seccion">
        <span className="m-seccion-actual" style={{ color: actual ? colorClaro(colorDeSeccion(actual)) : undefined }}>
          {actual?.nombre ?? '—'}
        </span>
        <span className="m-tiempo num">
          {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
        </span>
      </div>
      <div className="m-sigue">
        {loop ? (
          <>
            <Repeat size={13} /> Repitiendo <b>{actual?.nombre}</b>
          </>
        ) : siguiente ? (
          <>
            Sigue: <b>{siguiente.nombre}</b>
          </>
        ) : (
          'Última sección'
        )}
      </div>
      <MiniTimeline controller={controller} />
    </div>
  )
}

function MiniTimeline({ controller }: { controller: AppController }) {
  const { secciones, estado } = controller
  const dur = Math.max(estado?.proyectoActivo?.duracionTotalMs ?? 1, 1)
  const pos = usePlayheadMs()
  const actual = seccionEn(secciones, pos)
  return (
    <div className="m-timeline" aria-hidden>
      {secciones.map((s) => (
        <div
          key={s.marcador?.id ?? 'inicio'}
          className={actual?.indice === s.indice ? 'actual' : ''}
          style={{ width: `${((s.finMs - s.inicioMs) / dur) * 100}%`, background: colorDeSeccion(s) }}
        />
      ))}
      <div className="m-playhead" style={{ left: `${Math.min(100, (pos / dur) * 100)}%` }} />
    </div>
  )
}

function BotonesSecciones({ controller, deshabilitado }: { controller: AppController; deshabilitado: boolean }) {
  const pos = usePlayheadPaso(200)
  const conMarcador = controller.secciones.filter((s) => s.marcador)
  const actual = seccionEn(controller.secciones, pos)
  if (conMarcador.length === 0) {
    return <p className="vacio">Esta canción todavía no tiene secciones marcadas.</p>
  }
  return (
    <div className="m-marcadores">
      {conMarcador.map((s) => (
        <button
          key={s.marcador!.id}
          className={`m-marcador ${actual?.indice === s.indice ? 'actual' : ''}`}
          style={{ '--color-seccion': colorDeSeccion(s) } as React.CSSProperties}
          disabled={deshabilitado}
          onClick={() => controller.jumpToMarker(s.marcador!.id)}
        >
          <span>{s.nombre}</span>
        </button>
      ))}
    </div>
  )
}

/** Version mas clara de un color de seccion, para texto grande sobre fondo oscuro. */
function colorClaro(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const mezclar = (c: number): number => Math.round(c + (255 - c) * 0.45)
  return `rgb(${mezclar((n >> 16) & 255)}, ${mezclar((n >> 8) & 255)}, ${mezclar(n & 255)})`
}
