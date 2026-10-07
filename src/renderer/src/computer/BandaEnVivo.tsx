import { useEffect, useRef, useState } from 'react'
import { AudioLines } from 'lucide-react'
import type { AppController } from '../app/useAppController'
import { EmisorTalkback } from '../audio/talkback'
import { Toggle } from '../ui/Toggle'
import { NivelEntrada, textoDemora } from './Talkback'

/**
 * Arriba, mientras se manda la banda en vivo: que se vea que esta saliendo
 * (con lo que entra). Tocarlo abre ⚙ Ajustes → Banda en vivo (ahi se apaga).
 */
export function IndicadorBanda({ controller, onAbrir }: { controller: AppController; onAbrir: () => void }) {
  const { activo, error } = controller.banda
  if (!activo) return null
  return (
    <span className={`talkback banda-vivo ${error ? 'con-error' : 'abierto'}`}>
      <button
        className="talkback-boton"
        onClick={onAbrir}
        title={error ? `${error}: tocá para elegir otra entrada` : 'Banda en vivo: lo que sale de la consola llega a los oídos de la banda. Tocá para ver o apagarlo.'}
        aria-label="Banda en vivo"
      >
        <AudioLines size={15} />
        <span className="texto-largo">Banda en vivo</span>
        {!error && <Medidor leer={controller.nivelBanda} />}
      </button>
    </span>
  )
}

/** Barrita dentro del indicador: lo que entra de la consola. */
function Medidor({ leer }: { leer: () => number }) {
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

/**
 * ⚙ Ajustes → Banda en vivo: lo que sale de la consola (un master con los
 * instrumentos y las voces) a los oidos de la banda, de referencia. De que
 * entrada se toma y cuanto tarda en cada celular. Al abrirse prende la
 * entrada (sin mandarla) para ver el nivel.
 */
export function AjustesBanda({ controller }: { controller: AppController }) {
  const [entradas, setEntradas] = useState<{ id: string; nombre: string }[]>([])
  const pedirEntradas = controller.entradasTalkback
  const probar = controller.probarEntradaBanda
  useEffect(() => {
    void probar().then(() => pedirEntradas().then(setEntradas))
    return EmisorTalkback.alCambiar(() => void pedirEntradas().then(setEntradas))
  }, [probar, pedirEntradas])
  const b = controller.banda
  const celulares = controller.dispositivos.filter((d) => d.origen === 'celular' && d.conectado)
  const desconectada = b.entrada !== null && entradas.length > 0 && !entradas.some((e) => e.id === b.entrada)
  // el talkback toma la misma entrada con "Mejorar la voz": la compu se lo aplica tambien a la banda
  const procesada = controller.talkback.procesar && (controller.talkback.entrada ?? '') === (b.entrada ?? '')
  return (
    <>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Lo que sale de la consola (un máster con los instrumentos y las voces) llega a los oídos de cada músico como un fader más,{' '}
        <b>Banda en vivo</b>, para escuchar al resto de la banda. Cada uno le da su volumen en “Mi mezcla”. No va a la consola ni a multimedia, y
        viaja por el WiFi del router, no por internet.
      </p>
      <p className="ayuda banda-aviso">
        Llega un poco después que el sonido de verdad (unos 0,06 a 0,1 s: el WiFi y el celular): sirve de referencia, no para escucharse uno mismo
        mientras toca o canta.
      </p>
      <div className="talkback-procesar">
        <Toggle activo={b.activo} onCambiar={(v) => void controller.setBandaActivo(v)} titulo="Prendido, queda así hasta que lo apagues (también si cerrás el programa)">
          Mandar la banda a los celulares
        </Toggle>
      </div>
      {b.error && <p className="error-texto">{b.error}</p>}
      <h3 className="ajustes-titulo">Entrada</h3>
      <label className="talkback-campo">
        Interface o placa donde entra la consola
        <select value={b.entrada ?? ''} onChange={(e) => controller.setEntradaBanda(e.target.value || null)} aria-label="Entrada de la banda">
          <option value="">La de Windows (por defecto)</option>
          {entradas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
          {desconectada && <option value={b.entrada!}>No está conectada (elegí otra)</option>}
        </select>
      </label>
      {b.canales > 1 && (
        <div className="talkback-campo">
          Entrada de la consola
          <div className="segmentado talkback-canales" role="radiogroup" aria-label="Entrada de la consola">
            {Array.from({ length: b.canales }, (_, k) => (
              <button key={k} role="radio" aria-checked={b.canal === k} className={b.canal === k ? 'activo' : ''} onClick={() => controller.setCanalBanda(k)}>
                {k + 1}
              </button>
            ))}
            <button role="radio" aria-checked={b.canal === null} className={b.canal === null ? 'activo' : ''} onClick={() => controller.setCanalBanda(null)}>
              Todas
            </button>
          </div>
          <small>Donde llega la mezcla de la consola (la 1, la 2…). Si llega en estéreo (izquierda y derecha), “Todas” las junta.</small>
        </div>
      )}
      <NivelEntrada leer={controller.nivelBanda} nombre="Nivel de la banda" />
      {procesada && (
        <p className="ayuda banda-aviso" role="alert">
          El talkback usa esta misma entrada con “Mejorar la voz”, y la compu se lo aplica también a la banda (le baja el volumen y le saca
          sonido).{' '}
          <button className="btn-enlace" onClick={() => controller.setProcesarTalkback(false)}>
            Apagar “Mejorar la voz”
          </button>
        </p>
      )}
      <p className="ayuda">
        Sacá de la consola el máster o un auxiliar con la mezcla de la banda y conectalo a una interface de audio (o a la entrada de línea de la
        compu); con una consola digital por USB, elegila acá y la entrada donde viene esa mezcla. Ajustá el nivel en la consola hasta que la barra
        se mueva bien sin llegar al rojo. Va tal cual, sin procesar.
      </p>
      <h3 className="ajustes-titulo">Cuánto tarda en cada celular</h3>
      <ul className="lista talkback-lista">
        {celulares.length === 0 && <li className="vacio">No hay celulares conectados.</li>}
        {celulares.map((d) => {
          const m = d.diag?.banda
          const fuera = d.rol === 'sonido' || d.rol === 'multimedia'
          return (
            <li key={d.id} className="lista-fila">
              <div className="lista-principal">
                <span className="lista-titulo">{d.etiqueta}</span>
                <span className="lista-meta">
                  {fuera ? (d.rol === 'sonido' ? 'Consola: no la recibe' : 'Multimedia: no la recibe') : m ? textoDemora(m) : 'todavía no recibió la banda'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="ayuda">
        Cada celular espera lo justo para que no se corte, y se acerca solo cuando el WiFi anda bien. Para que tarde lo menos posible: auriculares
        con cable (los Bluetooth suman 150 a 250 ms), la app de Android (pide el WiFi de baja demora) y el router cerca, mejor de 5 GHz.
      </p>
    </>
  )
}
