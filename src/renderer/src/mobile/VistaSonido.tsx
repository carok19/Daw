import { useEffect, useRef, useState } from 'react'
import { BellOff, Cable, Check, Lock, LockOpen, Plug, Speaker, Volume2 } from 'lucide-react'
import { seccionEn } from '@shared/playback'
import type { AppController } from '../app/useAppController'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'

/** dB de un pico (0 a 1); -60 = silencio. */
const aDb = (v: number): number => (v > 0.001 ? 20 * Math.log10(v) : -60)
/** Posicion en la barra (0 a 1) de -48 dB a 0 dB. */
const enBarra = (db: number): number => Math.min(1, Math.max(0, (db + 48) / 48))

/**
 * Vumetro de lo que sale (izquierda y derecha), con el pico que queda un
 * momento: el sonidista ve que llega señal sin tener que escuchar el celular.
 */
function Vumetro({ leer }: { leer: () => { izq: number; der: number } | null }) {
  const izq = useRef<HTMLDivElement>(null)
  const der = useRef<HTMLDivElement>(null)
  const texto = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const picos = [{ v: -60, t: 0 }, { v: -60, t: 0 }]
    const pintar = (): void => {
      const n = leer()
      const ahora = performance.now()
      ;[n?.izq ?? 0, n?.der ?? 0].forEach((valor, k) => {
        const db = aDb(valor)
        const p = picos[k]
        if (db >= p.v || ahora - p.t > 1500) {
          p.v = db
          p.t = ahora
        }
        const barra = k === 0 ? izq.current : der.current
        if (!barra) return
        barra.style.setProperty('--nivel', String(enBarra(db)))
        barra.style.setProperty('--pico', String(enBarra(p.v)))
        barra.classList.toggle('alto', p.v > -3)
      })
      if (texto.current) {
        const max = Math.max(picos[0].v, picos[1].v)
        texto.current.textContent = max <= -59 ? 'sin señal' : `${Math.round(max)} dB`
      }
      raf = requestAnimationFrame(pintar)
    }
    raf = requestAnimationFrame(pintar)
    return () => cancelAnimationFrame(raf)
  }, [leer])
  return (
    <div className="consola-vumetro" aria-label="Nivel de salida">
      <div className="consola-vu-fila">
        <span>L</span>
        <div className="consola-vu-barra" ref={izq}>
          <i />
          <em />
        </div>
      </div>
      <div className="consola-vu-fila">
        <span>R</span>
        <div className="consola-vu-barra" ref={der}>
          <i />
          <em />
        </div>
      </div>
      <span className="consola-vu-texto num" ref={texto}>
        sin señal
      </span>
    </div>
  )
}

/** Un interruptor grande: "Click en los parlantes", "Guía en los parlantes". */
function FilaSalida({ nombre, detalle, activo, deshabilitado, onCambiar }: { nombre: string; detalle: string; activo: boolean; deshabilitado: boolean; onCambiar: (v: boolean) => void }) {
  return (
    <button
      className={`consola-fila ${activo ? 'activo' : ''}`}
      role="switch"
      aria-checked={activo}
      aria-label={`${nombre} en los parlantes`}
      disabled={deshabilitado}
      onClick={() => onCambiar(!activo)}
    >
      <span className="consola-fila-texto">
        <b>{nombre}</b>
        <small>{activo ? 'Suena en los parlantes' : detalle}</small>
      </span>
      <span className="consola-interruptor" aria-hidden>
        <i />
      </span>
    </button>
  )
}

/** Mantener apretado para desbloquear (un toque sin querer no cambia nada en pleno culto). */
function Desbloquear({ onDesbloquear }: { onDesbloquear: () => void }) {
  const [apretando, setApretando] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soltar = (): void => {
    setApretando(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => soltar, [])
  return (
    <button
      className={`consola-desbloquear ${apretando ? 'apretando' : ''}`}
      onPointerDown={() => {
        setApretando(true)
        timer.current = setTimeout(() => {
          soltar()
          onDesbloquear()
        }, 1200)
      }}
      onPointerUp={soltar}
      onPointerLeave={soltar}
      onPointerCancel={soltar}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Mantené apretado para desbloquear"
    >
      <Lock size={16} /> Mantené apretado para desbloquear
    </button>
  )
}

/**
 * Celular de Sonido: va a la consola. Manda la banda sola (en estereo, sin
 * click ni guia, ni la voz que avisa los saltos); para un ensayo se pueden
 * sumar la guia o el click a los parlantes. Pantalla quieta, con vumetro y
 * bloqueo contra toques sin querer.
 */
export function VistaSonido({ controller, bloqueada, onBloquear: setBloqueada }: { controller: AppController; bloqueada: boolean; onBloquear: (v: boolean) => void }) {
  const { estado, secciones } = controller
  const proyecto = estado?.proyectoActivo ?? null
  const pos = usePlayheadPaso(250)
  const actual = proyecto ? seccionEn(secciones, pos) : null
  const salida = controller.salidaSonido
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const drift = controller.driftMs
  const enSync = drift !== null && Math.abs(drift) < 20
  const extra = [salida.guia ? 'guía' : null, salida.click ? 'click' : null].filter(Boolean)

  return (
    <section className={`m-vista-sonido ${bloqueada ? 'bloqueada' : ''}`} aria-label="Sonido: celular de la consola">
      <div className="consola-cabeza">
        <span className="consola-icono">
          <Speaker size={28} />
        </span>
        <div>
          <h2>A la consola</h2>
          <p>
            Banda en estéreo{extra.length ? ` + ${extra.join(' y ')}` : ''} · sin {[!salida.click && 'click', !salida.guia && 'guía'].filter(Boolean).join(' ni ') || 'nada más'}
          </p>
        </div>
      </div>

      <Vumetro leer={controller.nivelSalida} />

      <div className="consola-ahora">
        {proyecto ? (
          <>
            <span className="consola-cancion">{proyecto.nombre}</span>
            <span className="consola-seccion">
              <i style={{ background: actual ? colorDeSeccion(actual) : 'var(--text-3)' }} />
              {actual?.nombre ?? '—'}
              <small className="num">
                {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
              </small>
            </span>
            <span className={`consola-estado ${!controller.audioActivo ? 'mal' : sonando && !enSync && drift !== null ? 'aviso' : 'ok'}`}>
              {!controller.audioActivo ? (
                'Sin audio: tocá para empezar'
              ) : controller.bufferEstado === 'critico' ? (
                'WiFi lento: puede cortarse'
              ) : sonando ? (
                drift === null ? (
                  'Sonando'
                ) : enSync ? (
                  <>
                    <Check size={14} /> Sonando en sync
                  </>
                ) : (
                  `Ajustando el sync (${Math.round(drift)} ms)`
                )
              ) : (
                'Listo'
              )}
            </span>
          </>
        ) : (
          <span className="consola-cancion">Esperando canción…</span>
        )}
      </div>

      <div className="consola-salidas" aria-label="Qué más va a los parlantes">
        <FilaSalida
          nombre="Guía"
          detalle="No va a los parlantes (solo a los oídos)"
          activo={salida.guia}
          deshabilitado={bloqueada}
          onCambiar={(v) => controller.setSalidaSonido({ guia: v })}
        />
        <FilaSalida
          nombre="Click"
          detalle="No va a los parlantes (solo a los oídos)"
          activo={salida.click}
          deshabilitado={bloqueada}
          onCambiar={(v) => controller.setSalidaSonido({ click: v })}
        />
        {(salida.guia || salida.click) && <p className="consola-aviso">Para ensayar. Antes del culto, apagalos: la gente escucharía {extra.join(' y ')}.</p>}
      </div>

      {bloqueada ? (
        <Desbloquear onDesbloquear={() => setBloqueada(false)} />
      ) : (
        <button className="consola-bloquear" onClick={() => setBloqueada(true)}>
          <LockOpen size={16} /> Bloquear la pantalla (contra toques sin querer)
        </button>
      )}

      <details className="consola-consejos">
        <summary>Cómo conectarlo a la consola</summary>
        <ul>
          <li>
            <Cable size={15} /> Cable de la salida de auriculares a una entrada de línea (o a una caja directa): miniplug estéreo a dos plugs.
          </li>
          <li>
            <Volume2 size={15} /> Subí el volumen del celular al máximo y ajustá la ganancia en la consola.
          </li>
          <li>
            <BellOff size={15} /> Poné “No molestar” (o modo avión con el WiFi prendido): una llamada o una notificación saldría por los parlantes.
          </li>
          <li>
            <Plug size={15} /> Dejalo cargando: la pantalla queda encendida.
          </li>
        </ul>
      </details>
    </section>
  )
}
