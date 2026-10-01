import { useEffect, useRef, useState } from 'react'
import { Minus, Play, Plus, Square, Waves } from 'lucide-react'
import type { AjustesColchon, ColchonActivo, Proyecto } from '@shared/types'
import { AJUSTES_COLCHON_POR_DEFECTO, NOTAS_PAD, SALIDA_PAD_VUELTA_MS } from '@shared/colchon'
import type { AppController } from '../app/useAppController'
import { Modal } from '../ui/Modal'
import { PulsoColchon, textoColchon, textoCompasColchon } from '../ui/Colchon'
import { useGolpeColchon } from '../app/playheadStore'

/** Compases que se pueden elegir (6 = 6/8, contado en 6). */
const COMPASES = [4, 3, 6, 2]

function SelectorPad({ valor, onCambio, etiqueta }: { valor: string | null; onCambio: (nota: string | null) => void; etiqueta: string }) {
  return (
    <select value={valor ?? ''} onChange={(e) => onCambio(e.target.value || null)} aria-label={etiqueta}>
      <option value="">Sin pad</option>
      {NOTAS_PAD.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

/**
 * Volumen 0-100. Mientras se arrastra se muestra enseguida y se manda como
 * mucho cada 150 ms (cada cambio llega a todos los celulares).
 */
function Volumen({ valor, onCambio, etiqueta }: { valor: number; onCambio: (v: number) => void; etiqueta: string }) {
  const [local, setLocal] = useState(valor)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ultimo = useRef(valor)
  useEffect(() => {
    if (!timer.current) setLocal(valor)
  }, [valor])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return (
    <span className="volumen-colchon">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={local}
        aria-label={etiqueta}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          ultimo.current = v
          if (!timer.current)
            timer.current = setTimeout(() => {
              timer.current = null
              onCambio(ultimo.current)
            }, 150)
        }}
      />
      <span className="num">{local}</span>
    </span>
  )
}

function BpmColchon({ valor, onCambio }: { valor: number; onCambio: (bpm: number) => void }) {
  const [texto, setTexto] = useState(String(valor))
  useEffect(() => setTexto(String(valor)), [valor])
  const poner = (v: number): void => {
    const bpm = Math.min(240, Math.max(30, Math.round(v)))
    setTexto(String(bpm))
    if (bpm !== valor) onCambio(bpm)
  }
  return (
    <span className="bpm-colchon">
      <button className="btn-icono" onClick={() => poner(valor - 1)} aria-label="Más lento" title="1 BPM más lento">
        <Minus size={14} />
      </button>
      <input
        type="number"
        min={30}
        max={240}
        value={texto}
        aria-label="BPM del colchón"
        onChange={(e) => setTexto(e.target.value)}
        onBlur={() => poner(Number(texto) || valor)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <button className="btn-icono" onClick={() => poner(valor + 1)} aria-label="Más rápido" title="1 BPM más rápido">
        <Plus size={14} />
      </button>
    </span>
  )
}

/**
 * Colchon sonando (arriba de la cancion): de que es, el pulso, la nota y el
 * volumen del pad, y "Terminar". Dentro de una cancion: se vuelve tocando una
 * seccion (entra en el proximo compas) o con play (donde quedo).
 */
export function BannerColchon({ controller, colchon }: { controller: AppController; colchon: ColchonActivo }) {
  const e = controller.estado
  const empezo = useGolpeColchon() !== null
  const terminando = colchon.hasta !== null
  const deEstaCancion = colchon.desdeCancion && colchon.tabId === e?.activeTabId
  const ayuda = terminando
    ? colchon.salidaPadMs <= SALIDA_PAD_VUELTA_MS
      ? 'Vuelve la banda…'
      : 'Se está apagando…'
    : deEstaCancion
      ? `${empezo ? 'La banda paró.' : e?.modoSalto === 'seccion' ? 'La banda se va al terminar la sección (el pad ya está entrando).' : 'La banda se va en el próximo compás.'} Tocá una sección para volver (entra en el próximo compás) o ▶ para seguir donde quedó.`
      : 'Sigue sonando: al darle ▶ a una canción, acompaña la cuenta y se va.'
  return (
    <div className={`banner-colchon ${terminando ? 'terminando' : ''}`} role="region" aria-label="Colchón">
      <Waves size={18} className="banner-colchon-icono" />
      <b className="banner-colchon-titulo">{textoColchon(colchon)}</b>
      {!terminando && <PulsoColchon pulsos={colchon.pulsos} />}
      <span className="banner-colchon-ayuda">{ayuda}</span>
      {!terminando && (
        <span className="banner-colchon-controles">
          <label>
            Pad <SelectorPad valor={colchon.pad} etiqueta="Tono del pad" onCambio={(tonalidad) => controller.ajustarColchon({ tonalidad })} />
          </label>
          <label>
            <Volumen valor={colchon.volumenPad} etiqueta="Volumen del pad" onCambio={(volumenPad) => controller.ajustarColchon({ volumenPad })} />
          </label>
          <button className="btn-chico" onClick={controller.terminarColchon} title="El click para y el pad se apaga despacio">
            <Square size={12} fill="currentColor" /> Terminar
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * Un colchon de la lista (sin pistas) arriba: su tono, BPM y compas, y
 * Empezar / Terminar. Todo se puede cambiar sonando (el BPM, desde el
 * proximo golpe).
 */
export function PantallaColchon({ controller, proyecto }: { controller: AppController; proyecto: Proyecto }) {
  const a = proyecto.colchon!
  const e = controller.estado
  const c = e?.colchon ?? null
  const suena = !!c && c.tabId === e?.activeTabId && c.hasta === null
  const ajustar = (cambio: Partial<AjustesColchon>): void => controller.ajustarColchon(cambio)
  return (
    <main className="compu-main pantalla-colchon">
      <section className={`colchon-tarjeta ${suena ? 'sonando' : ''}`} aria-label="Colchón">
        <div className="colchon-cabeza">
          <Waves size={22} />
          <h2>{proyecto.nombre}</h2>
        </div>
        <div className="colchon-grande">
          <div className="colchon-nota" title="Tono del pad">
            {a.tonalidad ?? '—'}
          </div>
          <div className="colchon-bpm num">{a.click ? `${a.bpm} BPM · ${textoCompasColchon(a.compas)}` : 'sin click'}</div>
          {suena && c && <PulsoColchon pulsos={c.pulsos} grande />}
        </div>
        <div className="colchon-botones">
          {suena ? (
            <button className="btn-play btn-terminar" onClick={controller.terminarColchon} title="El click para y el pad se apaga despacio (Espacio)">
              <Square size={16} fill="currentColor" /> Terminar
            </button>
          ) : (
            <button className="btn-play" onClick={controller.togglePlay} title="Empieza en todos los celulares a la vez (Espacio)">
              <Play size={18} fill="currentColor" /> Empezar
            </button>
          )}
        </div>
        <div className="colchon-ajustes">
          <label className="campo">
            <span>Tono del pad</span>
            <SelectorPad valor={a.tonalidad} etiqueta="Tono del pad" onCambio={(tonalidad) => ajustar({ tonalidad })} />
          </label>
          <div className="campo">
            <span>BPM del click</span>
            <BpmColchon valor={a.bpm} onCambio={(bpm) => ajustar({ bpm })} />
          </div>
          <label className="campo">
            <span>Compás</span>
            <select value={a.compas} onChange={(ev) => ajustar({ compas: Number(ev.target.value) })} aria-label="Compás del colchón">
              {[...new Set([...COMPASES, a.compas])].map((n) => (
                <option key={n} value={n}>
                  {textoCompasColchon(n)}
                </option>
              ))}
            </select>
          </label>
          <label className="campo campo-check">
            <input type="checkbox" checked={a.click} onChange={(ev) => ajustar({ click: ev.target.checked })} />
            <span>Con click</span>
          </label>
          <label className="campo">
            <span>Volumen del pad</span>
            <Volumen valor={a.volumenPad} etiqueta="Volumen del pad" onCambio={(volumenPad) => ajustar({ volumenPad })} />
          </label>
          <label className="campo">
            <span>Volumen del click</span>
            <Volumen valor={a.volumenClick} etiqueta="Volumen del click" onCambio={(volumenClick) => ajustar({ volumenClick })} />
          </label>
        </div>
        <p className="colchon-ayuda">
          Suena en todos los celulares a la vez: el pad del lado de la banda y el click del lado del click (cada uno lo ajusta en “Mi
          mezcla”). Si pasás a otra canción, el colchón sigue sonando; cuando le das ▶, acompaña la cuenta y se va.
        </p>
      </section>
    </main>
  )
}

/** Crear un colchon para la lista (queda en la biblioteca). */
export function NuevoColchon({ controller, onCreado, onCerrar }: { controller: AppController; onCreado: (id: string) => void; onCerrar: () => void }) {
  const [a, setA] = useState<AjustesColchon>(AJUSTES_COLCHON_POR_DEFECTO)
  const [creando, setCreando] = useState(false)
  async function crear(): Promise<void> {
    setCreando(true)
    const id = await controller.crearColchon(a)
    setCreando(false)
    if (id) onCreado(id)
  }
  return (
    <Modal
      titulo="Colchón para la lista"
      icono={<Waves size={18} />}
      tamano="chico"
      onCerrar={onCerrar}
      pie={
        <>
          <button onClick={onCerrar}>Cancelar</button>
          <button className="btn-primario" disabled={creando} onClick={() => void crear()}>
            <Plus size={15} /> Sumar a la lista
          </button>
        </>
      }
    >
      <p className="colchon-explicacion">Un pad de ambiente y el click, sin la banda: para la oración, la ministración o entre canciones.</p>
      <div className="colchon-ajustes">
        <label className="campo">
          <span>Tono del pad</span>
          <SelectorPad valor={a.tonalidad} etiqueta="Tono del pad" onCambio={(tonalidad) => setA({ ...a, tonalidad })} />
        </label>
        <label className="campo campo-check">
          <input type="checkbox" checked={a.click} onChange={(ev) => setA({ ...a, click: ev.target.checked })} />
          <span>Con click</span>
        </label>
        <div className="campo">
          <span>BPM del click</span>
          <BpmColchon valor={a.bpm} onCambio={(bpm) => setA({ ...a, bpm })} />
        </div>
        <label className="campo">
          <span>Compás</span>
          <select value={a.compas} onChange={(ev) => setA({ ...a, compas: Number(ev.target.value) })} aria-label="Compás del colchón">
            {COMPASES.map((n) => (
              <option key={n} value={n}>
                {textoCompasColchon(n)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="colchon-explicacion chico">
        El pad es raíz, quinta y octava (sin tercera): sirve igual en mayor y en menor. Todo se puede cambiar después, también sonando.
      </p>
    </Modal>
  )
}
