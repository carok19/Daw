import type { CSSProperties } from 'react'
import { ArrowRight, ChevronDown, Headphones, Repeat } from 'lucide-react'
import type { Proyecto } from '@shared/types'
import { compasesQueFaltan, seccionEn, type Seccion } from '@shared/playback'
import { textoSemitonos, tonalidadEn } from '@shared/tonalidad'
import type { AppController } from '../app/useAppController'
import { useGolpeCuenta, usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { useOnda } from '../ui/Onda'
import { AvisoTono, avisoDeTono, cambioDeTono, colorClaro, faltaPara, MiniTimeline } from './Comunes'

type AbrirHoja = (h: 'canciones' | 'secciones') => void

const conColor = (s: Seccion | null | undefined): CSSProperties => ({ '--color-seccion': s ? colorDeSeccion(s) : 'var(--panel-4)' }) as CSSProperties

/** Lo que pasa ahora y lo que viene (seccion actual, la que sigue, el salto elegido, el repetir). */
function useMomento(controller: AppController, proyecto: Proyecto) {
  const { estado, secciones } = controller
  const pos = usePlayheadPaso(200)
  const golpe = useGolpeCuenta()
  const actual = seccionEn(secciones, pos)
  const loop = estado?.loop ?? false
  const salto = estado?.saltoPendiente ?? null
  const destino = salto ? seccionEn(secciones, salto.destinoMs) : null
  const siguiente = actual ? (secciones[actual.indice + 1] ?? null) : null
  // lo que viene: el salto elegido, la misma (repitiendo) o la siguiente
  const proxima = salto ? destino : loop ? actual : siguiente
  const compases = proyecto.tempo?.compasesMs ?? null
  const faltan = compasesQueFaltan(compases, actual, pos, salto?.limiteMs)
  // cuando cambia de seccion (el salto elegido, o el final de esta)
  const limiteMs = salto ? salto.limiteMs : actual ? actual.finMs : null
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const aviso = avisoDeTono(proyecto, pos, salto ? destino : loop ? null : siguiente, faltan, limiteMs)
  return { pos, golpe, actual, loop, salto, destino, siguiente, proxima, faltan, limiteMs, sonando, aviso, secciones }
}

/** "faltan 3" con un punto por compas (hasta 8): se ve de reojo, sin leer. */
function Compases({ faltan }: { faltan: number }) {
  return (
    <span className={`rol-faltan ${faltan === 1 ? 'ultimo' : faltan === 2 ? 'penultimo' : ''}`} role="status" aria-label={faltan === 1 ? 'Último compás de la sección' : `Faltan ${faltan} compases`}>
      {faltan <= 8 && (
        <span className="rol-faltan-puntos" aria-hidden>
          {Array.from({ length: faltan }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      )}
      <b className="num">{faltan}</b>
      <small>{faltan === 1 ? 'último compás' : 'compases'}</small>
    </span>
  )
}

function Cabeza({ proyecto, pos, onHoja }: { proyecto: Proyecto; pos: number; onHoja: AbrirHoja }) {
  return (
    <div className="m-cancion-cabeza">
      <button className="m-cancion-nombre" onClick={() => onHoja('canciones')} aria-label={`${proyecto.nombre}: ver las canciones`}>
        <span>{proyecto.nombre}</span>
        <ChevronDown size={16} />
      </button>
      <span className="m-cancion-tiempo num">
        {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
      </span>
    </div>
  )
}

/**
 * Voz (cantantes y coros): la seccion que se canta, bien grande y con su
 * color; lo que sigue (para saber que letra viene); los compases que faltan
 * y el tono. Sin botones que se toquen sin querer.
 */
export function VistaVoz({ controller, proyecto, onHoja }: { controller: AppController; proyecto: Proyecto; onHoja: AbrirHoja }) {
  const m = useMomento(controller, proyecto)
  const onda = useOnda(proyecto)
  const tono = tonalidadEn(proyecto, m.pos)
  const semitonos = proyecto.tonoAplicado ?? 0
  return (
    <section className="m-vista-voz" aria-label="Canción (voz)">
      <Cabeza proyecto={proyecto} pos={m.pos} onHoja={onHoja} />
      <div className="voz-ahora" style={conColor(m.actual)}>
        <div className="voz-fila">
          {m.golpe > 0 ? (
            <span className="voz-seccion m-contando num" role="status">
              Cuenta {m.golpe}
            </span>
          ) : (
            <span className="voz-seccion" style={{ color: m.actual ? colorClaro(colorDeSeccion(m.actual)) : undefined }}>
              {m.loop && <Repeat size={26} />}
              {m.actual?.nombre ?? '—'}
            </span>
          )}
          {(tono || semitonos !== 0) && (
            <span className="voz-tono num" title={semitonos ? `Tono cambiado ${textoSemitonos(semitonos)} semitonos` : 'Tonalidad'}>
              <small>Tono</small>
              <b>{tono ?? '—'}</b>
              {semitonos !== 0 && <em>{textoSemitonos(semitonos)}</em>}
            </span>
          )}
        </div>
        <div className="voz-fila">
          {m.faltan !== null && <Compases faltan={m.faltan} />}
          <AvisoTono aviso={m.aviso} />
        </div>
      </div>
      <div className={`voz-sigue ${m.salto ? 'salto' : ''}`} style={conColor(m.proxima)}>
        <small>{m.salto ? 'Ahora va' : m.loop ? 'Se repite' : 'Sigue'}</small>
        <b>
          <ArrowRight size={20} /> {m.proxima?.nombre ?? 'Final'}
        </b>
        <span className="voz-sigue-detalle num">
          {cambioDeTono(proyecto, m.pos, m.proxima)}
          {m.salto ? ` · ${faltaPara(m.salto, m.pos)}` : ''}
        </span>
      </div>
      <MiniTimeline controller={controller} onda={onda} grande />
      <button className="voz-ver-secciones btn-fantasma" onClick={() => onHoja('secciones')}>
        Ver todas las secciones
      </button>
    </section>
  )
}

/**
 * Multimedia (el que pasa la letra en las pantallas): que suena, que viene y
 * cuanto falta en segundos, bien grande; la lista de secciones y la cancion
 * que sigue. Sin audio, salvo que lo pida.
 */
export function VistaMultimedia({ controller, proyecto, onHoja }: { controller: AppController; proyecto: Proyecto | null; onHoja: AbrirHoja }) {
  if (!proyecto) {
    return (
      <section className="m-vista-multimedia" aria-label="Multimedia">
        <div className="m-esperando">
          <strong>Esperando canción…</strong>
          <span>Cuando la computadora elija una canción aparece acá, con sus secciones.</span>
        </div>
        <Escuchar controller={controller} />
      </section>
    )
  }
  return <Multimedia controller={controller} proyecto={proyecto} onHoja={onHoja} />
}

function Multimedia({ controller, proyecto, onHoja }: { controller: AppController; proyecto: Proyecto; onHoja: AbrirHoja }) {
  const m = useMomento(controller, proyecto)
  const segundos = m.limiteMs !== null && m.sonando ? Math.max(0, Math.ceil((m.limiteMs - m.pos) / 1000)) : null
  const pronto = segundos !== null && segundos <= 3
  const estado = controller.estado
  const iActiva = estado ? estado.tabs.findIndex((t) => t.tabId === estado.activeTabId) : -1
  const despues = iActiva >= 0 ? estado!.tabs[iActiva + 1] : undefined
  return (
    <section className="m-vista-multimedia" aria-label="Multimedia">
      <Cabeza proyecto={proyecto} pos={m.pos} onHoja={onHoja} />
      <div className="mm-ahora" style={conColor(m.actual)}>
        <small>Ahora</small>
        <b>{m.golpe > 0 ? `Cuenta ${m.golpe}` : (m.actual?.nombre ?? '—')}</b>
        {!m.sonando && <span className="mm-pausa">{estado?.playbackActivo?.estado === 'paused' ? 'en pausa' : 'parado'}</span>}
      </div>
      <div className={`mm-sigue ${pronto ? 'pronto' : ''}`} style={conColor(m.proxima)} role="status" aria-live="polite">
        <small>{m.salto ? 'Ahora va' : m.loop ? 'Se repite' : 'Sigue'}</small>
        <b>{m.proxima?.nombre ?? 'Final'}</b>
        <span className="mm-cuenta num">
          {segundos !== null ? (segundos === 0 ? 'ya' : `en ${segundos} s`) : ''}
          {m.faltan !== null && m.sonando && <small> · {m.faltan === 1 ? 'último compás' : `${m.faltan} compases`}</small>}
        </span>
      </div>
      <MiniTimeline controller={controller} grande />
      <ol className="mm-secciones" aria-label="Secciones de la canción">
        {m.secciones
          .filter((s) => s.marcador || s.indice === 0)
          .map((s) => {
            const esActual = m.actual?.indice === s.indice
            const esProxima = !esActual && m.proxima?.indice === s.indice
            return (
              <li key={s.marcador?.id ?? 'inicio'} className={`${esActual ? 'actual' : ''} ${esProxima ? 'proxima' : ''}`} style={conColor(s)}>
                <span className="mm-sec-nombre">{s.nombre}</span>
                <span className="mm-sec-tiempo num">{formatMmSs(s.inicioMs)}</span>
              </li>
            )
          })}
      </ol>
      {despues && (
        <p className="mm-despues">
          Después: <b>{despues.nombre}</b>
        </p>
      )}
      <Escuchar controller={controller} />
    </section>
  )
}

/** Multimedia: escuchar tambien en este celular (por defecto no baja audio). */
function Escuchar({ controller }: { controller: AppController }) {
  const activo = controller.escucharMultimedia
  return (
    <button
      className={`mm-escuchar ${activo ? 'activo' : ''}`}
      role="switch"
      aria-checked={activo}
      onClick={() => {
        controller.setEscucharMultimedia(!activo)
        // (dentro del toque: el navegador deja arrancar el audio)
        if (!activo) void controller.activarAudio()
      }}
    >
      <Headphones size={18} />
      {activo ? 'Escuchando en este celular' : 'Escuchar también en este celular'}
    </button>
  )
}
