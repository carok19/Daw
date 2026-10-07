import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'
import type { MedicionTalkback } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { EmisorTalkback } from '../audio/talkback'
import { Toggle } from '../ui/Toggle'

/** ¿El foco esta en algo donde se escribe? (ahi la T es una letra, no el talkback) */
function escribiendo(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Talkback en la barra: un interruptor (o la tecla T). Prendido, lo que entra
 * por el microfono va todo el tiempo a los oidos de la banda (no a la consola
 * ni a multimedia), como un fader mas de su mezcla, y queda asi hasta que
 * alguien lo apague. El medidor muestra que esta entrando voz.
 */
export function BotonTalkback({ controller }: { controller: AppController }) {
  const { activo, error } = controller.talkback
  const cambiar = controller.setTalkbackActivo
  const prendido = useRef(activo)
  prendido.current = activo
  useEffect(() => {
    const abajo = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || escribiendo()) return
      e.preventDefault()
      void cambiar(!prendido.current)
    }
    window.addEventListener('keydown', abajo)
    return () => window.removeEventListener('keydown', abajo)
    // (cambiar es estable: viene de las acciones del controlador)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cambiar])
  const abierto = activo && !error
  return (
    <span className={`talkback ${abierto ? 'abierto' : ''} ${activo && error ? 'con-error' : ''}`}>
      <button
        className="talkback-boton"
        role="switch"
        aria-checked={activo}
        onClick={() => void cambiar(!activo)}
        title={
          activo && error
            ? `${error} (el micrófono se elige en ⚙ Ajustes → Talkback). Tocá para apagarlo.`
            : activo
              ? 'Talkback abierto: la banda te escucha en los oídos todo el tiempo. Tocá (o T) para cerrarlo.'
              : 'Talkback: tocá (o T) para abrirlo; queda abierto, como un fader más en la mezcla de cada uno, hasta que lo cierres'
        }
        aria-label="Talkback"
      >
        {activo && error ? <MicOff size={15} /> : <Mic size={15} />}
        <span className="texto-largo">{abierto ? 'Talkback abierto' : 'Talkback'}</span>
        {abierto && <MedidorTalkback leer={controller.nivelTalkback} />}
      </button>
    </span>
  )
}

/** Cuanto tarda en escucharse en un celular (talkback o banda en vivo), lo que suma cada parte. */
export function textoDemora(m: MedicionTalkback): string {
  const salida = m.salidaMs !== undefined ? ` + salida del celular ${m.salidaMs} ms${m.salidaMs >= 120 ? ' (¿auriculares Bluetooth? con cable es mucho menos)' : ''}` : ''
  return `se escucha a los ${m.objetivoMs} ms: WiFi ${m.redMs} ms${salida}${m.tardes ? ` · ${m.tardes} pedazos tarde` : ''}`
}

/** Barrita dentro del boton: lo que entra por el microfono (se ve que esta mandando voz). */
function MedidorTalkback({ leer }: { leer: () => number }) {
  const barra = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let pico = 0
    const pintar = (): void => {
      pico = Math.max(leer(), pico * 0.9)
      const db = pico > 0.001 ? 20 * Math.log10(pico) : -60
      barra.current?.style.setProperty('--nivel', String(Math.min(1, Math.max(0, (db + 50) / 50))))
      raf = requestAnimationFrame(pintar)
    }
    raf = requestAnimationFrame(pintar)
    return () => cancelAnimationFrame(raf)
  }, [leer])
  return <span className="talkback-medidor" ref={barra} aria-hidden />
}

/** Vumetro de una entrada (lo que entra, aunque no se este mandando). */
export function NivelEntrada({ leer, nombre = 'Nivel del micrófono' }: { leer: () => number; nombre?: string }) {
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
    <div className="talkback-nivel" ref={barra} aria-label={nombre}>
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
    // se enchufa (o desenchufa) una interface con la ventana abierta: la lista se pone al dia
    return EmisorTalkback.alCambiar(() => void pedirEntradas().then(setEntradas))
  }, [probar, pedirEntradas])
  const tb = controller.talkback
  const celulares = controller.dispositivos.filter((d) => d.origen === 'celular' && d.conectado)
  const desconectada = tb.entrada !== null && entradas.length > 0 && !entradas.some((e) => e.id === tb.entrada)
  return (
    <>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Tocá <b>Talkback</b> (arriba) o la tecla <b>T</b>: queda abierto y la banda te escucha en los oídos todo el tiempo, como un fader más en
        la mezcla de cada uno (cada músico le da el volumen que quiera en “Mi mezcla”), hasta que lo cierres. No va a la consola ni a multimedia.
        Viaja por el WiFi del router, no por internet.
      </p>
      <h3 className="ajustes-titulo">Micrófono</h3>
      <label className="talkback-campo">
        Micrófono o interface
        <select value={tb.entrada ?? ''} onChange={(e) => controller.setEntradaTalkback(e.target.value || null)} aria-label="Micrófono del talkback">
          <option value="">El de Windows (por defecto)</option>
          {entradas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
          {desconectada && <option value={tb.entrada!}>No está conectada (elegí otra)</option>}
        </select>
      </label>
      {tb.canales > 1 && (
        <div className="talkback-campo">
          Entrada de la interface
          <div className="segmentado talkback-canales" role="radiogroup" aria-label="Entrada de la interface">
            {Array.from({ length: tb.canales }, (_, k) => (
              <button key={k} role="radio" aria-checked={tb.canal === k} className={tb.canal === k ? 'activo' : ''} onClick={() => controller.setCanalTalkback(k)}>
                {k + 1}
              </button>
            ))}
            <button role="radio" aria-checked={tb.canal === null} className={tb.canal === null ? 'activo' : ''} onClick={() => controller.setCanalTalkback(null)}>
              Todas
            </button>
          </div>
          <small>Elegí la entrada donde está enchufado el micrófono (la 1, la 2…): va directa, sin “Mejorar la voz”. “Todas” las mezcla.</small>
        </div>
      )}
      <NivelEntrada leer={controller.nivelTalkback} />
      {tb.error && <p className="error-texto">{tb.error}</p>}
      <div className="talkback-procesar">
        <Toggle activo={tb.procesar} onCambiar={controller.setProcesarTalkback} titulo="Menos ruido de fondo y volumen parejo">
          Mejorar la voz
        </Toggle>
        <small>
          Con el micrófono de la compu, dejalo prendido. Con una interface o la consola, apagalo (elegir una entrada lo apaga) y ajustá la ganancia
          en la interface hasta que la barra se mueva bien al hablar.
        </small>
      </div>
      <p className="ayuda">
        Sirve el micrófono de la compu, uno USB, una interface (eligiendo su entrada) o la consola por una placa de sonido. Desde Reaper: mandá ese
        canal a un cable virtual (por ejemplo VB-Cable) y elegilo acá.
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
                      ? textoDemora(tb)
                      : 'todavía no recibió voz'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="ayuda">
        Cada celular espera lo justo para que la voz no se corte: lo que tarda el WiFi más lo que tarda el celular en sacar el audio. Si el WiFi
        se pone lento espera un poco más, y cuando anda bien se acerca solo. Para que tarde lo menos posible: auriculares con cable (los
        Bluetooth suman 150 a 250 ms), la app de Android (pide al celular el WiFi de baja demora) y el router cerca.
      </p>
    </>
  )
}
