import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'
import type { AppController } from '../app/useAppController'

/** ¿El foco esta en algo donde se escribe? (ahi la T es una letra, no el talkback) */
function escribiendo(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Talkback en la barra: mantener apretado (o la tecla T) para hablarle a la
 * banda. Lo escuchan los oidos de todos (no la consola ni multimedia) y la
 * musica les baja un poco mientras se habla.
 */
export function BotonTalkback({ controller }: { controller: AppController }) {
  const { hablando, error } = controller.talkback
  const hablar = controller.hablarTalkback
  const apretado = useRef(false)
  const empezar = (): void => {
    if (apretado.current) return
    apretado.current = true
    void hablar(true)
  }
  const terminar = (): void => {
    if (!apretado.current) return
    apretado.current = false
    void hablar(false)
  }
  useEffect(() => {
    const abajo = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || escribiendo()) return
      e.preventDefault()
      empezar()
    }
    const arriba = (e: KeyboardEvent): void => {
      if (e.code === 'KeyT') terminar()
    }
    // si la ventana pierde el foco con la T apretada, se corta (que no quede hablando)
    const perdio = (): void => terminar()
    window.addEventListener('keydown', abajo)
    window.addEventListener('keyup', arriba)
    window.addEventListener('blur', perdio)
    return () => {
      window.removeEventListener('keydown', abajo)
      window.removeEventListener('keyup', arriba)
      window.removeEventListener('blur', perdio)
    }
    // (hablar es estable: viene de las acciones del controlador)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hablar])
  return (
    <span className={`talkback ${hablando ? 'hablando' : ''} ${error ? 'con-error' : ''}`}>
      <button
        className="talkback-boton"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          empezar()
        }}
        onPointerUp={terminar}
        onPointerCancel={terminar}
        onContextMenu={(e) => e.preventDefault()}
        title={error ? `${error} (el micrófono se elige en ⚙ Ajustes → Talkback)` : 'Talkback: mantené apretado (o la tecla T) para hablarle a la banda en los oídos'}
        aria-label="Talkback: mantené apretado para hablarle a la banda"
        aria-pressed={hablando}
      >
        {error ? <MicOff size={15} /> : <Mic size={15} />}
        <span className="texto-largo">{hablando ? 'Hablando…' : 'Talkback'}</span>
      </button>
    </span>
  )
}

/** Vumetro del microfono del talkback (lo que entra, aunque no se este hablando). */
function NivelEntrada({ leer }: { leer: () => number }) {
  const barra = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    let pico = 0
    const pintar = (): void => {
      const v = leer()
      pico = Math.max(v, pico * 0.92)
      const db = pico > 0.001 ? 20 * Math.log10(pico) : -60
      barra.current?.style.setProperty('--nivel', String(Math.min(1, Math.max(0, (db + 50) / 50))))
      raf = requestAnimationFrame(pintar)
    }
    raf = requestAnimationFrame(pintar)
    return () => cancelAnimationFrame(raf)
  }, [leer])
  return (
    <div className="talkback-nivel" ref={barra} aria-label="Nivel del micrófono">
      <i />
    </div>
  )
}

/**
 * ⚙ Ajustes → Talkback: el microfono y cuanto tarda en llegar a cada celular
 * (medido por el propio celular). Al abrirse prende la entrada (sin hablar)
 * para ver el nivel.
 */
export function AjustesTalkback({ controller }: { controller: AppController }) {
  const [entradas, setEntradas] = useState<{ id: string; nombre: string }[]>([])
  const pedirEntradas = controller.entradasTalkback
  const probar = controller.probarEntradaTalkback
  useEffect(() => {
    // abrir la entrada (sin hablar): asi se ve el nivel y los nombres de las entradas
    void probar().then(() => pedirEntradas().then(setEntradas))
  }, [probar, pedirEntradas])
  const celulares = controller.dispositivos.filter((d) => d.origen === 'celular' && d.conectado)
  return (
    <>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Mantené apretado <b>Talkback</b> (arriba) o la tecla <b>T</b> y hablale a la banda: te escuchan en los oídos, y la música les baja un poco
        mientras hablás. No va a la consola ni a multimedia. Viaja por el WiFi del router, no por internet.
      </p>
      <label className="talkback-campo">
        Entrada
        <select value={controller.talkback.entrada ?? ''} onChange={(e) => controller.setEntradaTalkback(e.target.value || null)} aria-label="Entrada del talkback">
          <option value="">La de Windows (por defecto)</option>
          {entradas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
        </select>
      </label>
      <NivelEntrada leer={controller.nivelTalkback} />
      {controller.talkback.error && <p className="error-texto">{controller.talkback.error}</p>}
      <p className="ayuda">
        Sirve el micrófono de la compu, uno USB, o la consola por una placa de sonido. Desde Reaper: mandá ese canal a un cable virtual (por
        ejemplo VB-Cable) y elegilo acá.
      </p>
      <h3 className="ajustes-titulo">Cuánto tarda en cada celular</h3>
      <ul className="lista talkback-lista">
        {celulares.length === 0 && <li className="vacio">No hay celulares conectados.</li>}
        {celulares.map((d) => {
          const tb = d.diag?.talkback
          const fuera = d.rol === 'sonido' || d.rol === 'multimedia'
          return (
            <li key={d.id} className="lista-fila">
              <div className="lista-principal">
                <span className="lista-titulo">{d.etiqueta}</span>
                <span className="lista-meta">
                  {fuera
                    ? d.rol === 'sonido'
                      ? 'Consola: no lo recibe'
                      : 'Multimedia: no lo recibe'
                    : tb
                      ? `llega en ${tb.redMs} ms por el WiFi · se escucha a los ${tb.objetivoMs} ms${tb.tardes ? ` · ${tb.tardes} pedazos tarde` : ''}`
                      : 'todavía no le hablaste'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="ayuda">
        Cada celular espera lo justo para que la voz no se corte: si el WiFi se pone lento espera un poco más, y cuando anda bien se acerca solo
        (entre 80 y 600 ms).
      </p>
    </>
  )
}
