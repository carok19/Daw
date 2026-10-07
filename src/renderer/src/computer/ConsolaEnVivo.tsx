import { useEffect, useRef, useState } from 'react'
import { AudioLines } from 'lucide-react'
import type { MedicionVivo } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { EmisorVivo } from '../audio/consolaEnVivo'

/** ¿El foco esta en algo donde se escribe? (ahi la T es una letra, no la consola en vivo) */
function escribiendo(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Lo que entra, de 0 a 1 en la escala del vumetro (-50 a 0 dB). */
function usarVumetro(leer: () => number, caida: number): React.RefObject<HTMLSpanElement & HTMLDivElement> {
  const barra = useRef<HTMLSpanElement & HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    let pico = 0
    const pintar = (): void => {
      pico = Math.max(leer(), pico * caida)
      const db = pico > 0.001 ? 20 * Math.log10(pico) : -60
      barra.current?.style.setProperty('--nivel', String(Math.min(1, Math.max(0, (db + 50) / 50))))
      raf = requestAnimationFrame(pintar)
    }
    raf = requestAnimationFrame(pintar)
    return () => cancelAnimationFrame(raf)
  }, [leer, caida])
  return barra
}

/**
 * "Consola en vivo" en la barra: un interruptor (o la tecla T). Prendido, lo
 * que sale de la consola (instrumentos, voces y el microfono del talkback)
 * va todo el tiempo a los oidos de la banda (no a la consola ni a
 * multimedia), como un fader mas de su mezcla, y queda asi hasta que alguien
 * lo apague. La barrita muestra lo que entra.
 */
export function BotonVivo({ controller }: { controller: AppController }) {
  const { activo, error } = controller.vivo
  const cambiar = controller.setVivoActivo
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
            ? `${error} (la entrada se elige en ⚙ Ajustes → Consola en vivo). Tocá para apagarla.`
            : activo
              ? 'Consola en vivo: la banda escucha la consola (instrumentos, voces y talkback) en los oídos todo el tiempo. Tocá (o T) para apagarla.'
              : 'Consola en vivo: tocá (o T) para mandar la consola (instrumentos, voces y talkback) a los oídos; queda prendida, como un fader más en la mezcla de cada uno, hasta que la apagues'
        }
        aria-label="Consola en vivo"
      >
        <AudioLines size={15} />
        <span className="texto-largo">Consola en vivo</span>
        {abierto && <Medidor leer={controller.nivelVivo} />}
      </button>
    </span>
  )
}

/** Barrita dentro del boton: lo que entra de la consola. */
function Medidor({ leer }: { leer: () => number }) {
  const barra = usarVumetro(leer, 0.9)
  return <span className="talkback-medidor" ref={barra} aria-hidden />
}

/** Vumetro de la entrada (lo que entra, aunque no se este mandando). */
function NivelEntrada({ leer }: { leer: () => number }) {
  const barra = usarVumetro(leer, 0.92)
  return (
    <div className="talkback-nivel" ref={barra} aria-label="Nivel de la consola">
      <i />
    </div>
  )
}

/** Cuanto tarda en escucharse en un celular, lo que suma cada parte. */
export function textoDemora(m: MedicionVivo): string {
  const salida = m.salidaMs !== undefined ? ` + salida del celular ${m.salidaMs} ms${m.salidaMs >= 120 ? ' (¿auriculares Bluetooth? con cable es mucho menos)' : ''}` : ''
  return `se escucha a los ${m.objetivoMs} ms: WiFi ${m.redMs} ms${salida}${m.tardes ? ` · ${m.tardes} pedazos tarde` : ''}`
}

/**
 * ⚙ Ajustes → Consola en vivo: de que entrada se toma la consola y cuanto
 * tarda en cada celular (medido por el propio celular). Al abrirse prende la
 * entrada (sin mandarla) para ver el nivel.
 */
export function AjustesVivo({ controller }: { controller: AppController }) {
  const [entradas, setEntradas] = useState<{ id: string; nombre: string }[]>([])
  const pedirEntradas = controller.entradasVivo
  const probar = controller.probarEntradaVivo
  useEffect(() => {
    // abrir la entrada (sin mandarla): asi se ve el nivel y los nombres de las entradas
    void probar().then(() => pedirEntradas().then(setEntradas))
    // se enchufa (o desenchufa) una interface con la ventana abierta: la lista se pone al dia
    return EmisorVivo.alCambiar(() => void pedirEntradas().then(setEntradas))
  }, [probar, pedirEntradas])
  const v = controller.vivo
  const celulares = controller.dispositivos.filter((d) => d.origen === 'celular' && d.conectado)
  const desconectada = v.entrada !== null && entradas.length > 0 && !entradas.some((e) => e.id === v.entrada)
  return (
    <>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Tocá <b>Consola en vivo</b> (arriba) o la tecla <b>T</b>: lo que sale de la consola (los instrumentos, las voces y el micrófono del
        talkback, todo en una mezcla) llega a los oídos de cada músico como un fader más, y queda prendida hasta que la apagues. Cada uno le da su
        volumen en “Mi mezcla”. No va a la consola ni a multimedia, y viaja por el WiFi del router, no por internet.
      </p>
      <p className="ayuda banda-aviso">
        Llega un poco después que el sonido de verdad (unos 0,06 a 0,1 s con un buen WiFi y auriculares con cable): para indicaciones y para
        escuchar al resto alcanza; para escucharse uno mismo mientras toca o canta, se nota.
      </p>
      <h3 className="ajustes-titulo">Entrada</h3>
      <label className="talkback-campo">
        Interface o placa donde entra la consola
        <select value={v.entrada ?? ''} onChange={(e) => controller.setEntradaVivo(e.target.value || null)} aria-label="Entrada de la consola en vivo">
          <option value="">La de Windows (por defecto)</option>
          {entradas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
          {desconectada && <option value={v.entrada!}>No está conectada (elegí otra)</option>}
        </select>
      </label>
      {v.canales > 1 && (
        <div className="talkback-campo">
          Entrada de la interface
          <div className="segmentado talkback-canales" role="radiogroup" aria-label="Entrada de la interface">
            {Array.from({ length: v.canales }, (_, k) => (
              <button key={k} role="radio" aria-checked={v.canal === k} className={v.canal === k ? 'activo' : ''} onClick={() => controller.setCanalVivo(k)}>
                {k + 1}
              </button>
            ))}
            <button role="radio" aria-checked={v.canal === null} className={v.canal === null ? 'activo' : ''} onClick={() => controller.setCanalVivo(null)}>
              Todas
            </button>
          </div>
          <small>Donde llega la mezcla de la consola (la 1, la 2…). Si llega en estéreo (izquierda y derecha), “Todas” las junta.</small>
        </div>
      )}
      <NivelEntrada leer={controller.nivelVivo} />
      {v.error && <p className="error-texto">{v.error}</p>}
      <p className="ayuda">
        Sacá de la consola una mezcla para los músicos (el máster o un auxiliar, con el micrófono del talkback adentro) y conectala a una
        interface de audio o a la entrada de línea de la compu; con una consola digital por USB, elegila acá y la entrada donde viene esa mezcla.
        Ajustá el nivel en la consola hasta que la barra se mueva bien sin llegar al rojo. Va tal cual, sin procesar. Desde Reaper: mandá esa
        mezcla a un cable virtual (por ejemplo VB-Cable) y elegilo acá.
      </p>
      <h3 className="ajustes-titulo">Cuánto tarda en cada celular</h3>
      <ul className="lista talkback-lista">
        {celulares.length === 0 && <li className="vacio">No hay celulares conectados.</li>}
        {celulares.map((d) => {
          const m = d.diag?.vivo
          const fuera = d.rol === 'sonido' || d.rol === 'multimedia'
          return (
            <li key={d.id} className="lista-fila">
              <div className="lista-principal">
                <span className="lista-titulo">{d.etiqueta}</span>
                <span className="lista-meta">
                  {fuera ? (d.rol === 'sonido' ? 'Consola: no la recibe' : 'Multimedia: no la recibe') : m ? textoDemora(m) : 'todavía no la recibió'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="ayuda">
        Cada celular espera lo justo para que no se corte (lo que tarda el WiFi más lo que tarda el celular en sacar el audio) y se acerca solo
        cuando el WiFi anda bien. Para que tarde lo menos posible: auriculares con cable (los Bluetooth suman 150 a 250 ms), la app de Android
        (pide el WiFi de baja demora) y el router cerca, mejor de 5 GHz y sin otros equipos usando internet.
      </p>
    </>
  )
}
