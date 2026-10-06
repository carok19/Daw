import { useState } from 'react'
import { ArrowRight, CircleAlert, Download, FileAudio, Flag, LoaderCircle, Mic, Music, Pencil, Repeat, SkipBack, Trash2, WandSparkles, X } from 'lucide-react'
import type { AnalisisProyecto, InfoModeloVoz, Marcador, Proyecto, SaltoPendiente } from '@shared/types'
import { TONALIDADES, tonalidadEn, transponerTonalidad } from '@shared/tonalidad'
import type { Seccion } from '@shared/playback'
import { compasesQueFaltan, seccionEn } from '@shared/playback'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { faltaParaSalto } from './Transport'

interface Props {
  secciones: Seccion[]
  analisis: AnalisisProyecto | null
  progreso: { hechos: number; total: number } | null
  modeloVoz: InfoModeloVoz
  sonando: boolean
  onJump: (marcadorId: string, inmediato: boolean) => void
  /** ir a la seccion que empieza ahi (la de "Inicio", que no tiene marca) */
  onJumpInicio: (inicioMs: number, inmediato: boolean) => void
  saltoPendiente: SaltoPendiente | null
  compasesMs: number[] | null
  loop: boolean
  onCancelarSalto: () => void
  onCreate: (tiempoMs: number, nombre?: string) => void
  onRename: (marcadorId: string, nombre: string) => void
  /** la cancion cambia de tono en esta seccion (null = no) */
  onTonalidad: (marcadorId: string, tonalidad: string | null) => void
  /** para el tono de cada seccion (el de la cancion y el tono cambiado) */
  proyecto: Pick<Proyecto, 'nombre' | 'tonalidad' | 'tonoAplicado' | 'marcadores'>
  onDelete: (marcador: Marcador) => void
  onDetectar: () => void
  onDescargarModelo: () => void
}

const EN_CURSO = ['analizando', 'esperando-voz', 'reconociendo']

export function MarkersPanel(p: Props) {
  const { secciones, onJump, onCreate, onRename, onDelete } = p
  const [nombreNuevo, setNombreNuevo] = useState('')
  const pos = usePlayheadPaso(100)
  const actual = seccionEn(secciones, pos)
  const conMarcador = secciones.filter((s) => s.marcador)
  // las tarjetas: las secciones marcadas y, siempre primero, el comienzo de la cancion ("Inicio")
  const tarjetas = secciones.filter((s) => s.marcador || s.indice === 0)
  const destino = p.saltoPendiente && !p.saltoPendiente.fin ? seccionEn(secciones, p.saltoPendiente.destinoMs) : null

  function agregar(): void {
    onCreate(pos, nombreNuevo.trim() || undefined)
    setNombreNuevo('')
  }

  return (
    <section className="secciones" aria-label="Secciones">
      <div className="secciones-herramientas">
        <div className="secciones-nueva">
          <input
            placeholder="Nombre (Intro, Coro…)"
            value={nombreNuevo}
            maxLength={60}
            onChange={(e) => setNombreNuevo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && agregar()}
            aria-label="Nombre de la sección nueva"
          />
          <button className="btn-primario" onClick={agregar} title="Marcar una sección en la posición actual (M)">
            <Flag size={15} />
            <span className="num">{formatMmSs(pos)}</span>
          </button>
        </div>
        <button
          className="btn-detectar"
          onClick={p.onDetectar}
          disabled={EN_CURSO.includes(p.analisis?.estado ?? '')}
          title="Detectar las secciones automáticamente por la voz guía (Verso, Coro, Puente…), ajustadas al compás del click"
        >
          <WandSparkles size={14} /> Detectar
        </button>
      </div>
      <EstadoAnalisisVista
        analisis={p.analisis}
        progreso={p.progreso}
        modeloVoz={p.modeloVoz}
        sonando={p.sonando}
        onDescargarModelo={p.onDescargarModelo}
        onReintentar={p.onDetectar}
      />

      {tarjetas.length > 0 && (
        <ul className="secciones-tarjetas">
          {tarjetas.map((s) => (
            <TarjetaSeccion
              key={s.marcador?.id ?? 'inicio'}
              seccion={s}
              numero={s.marcador ? conMarcador.indexOf(s) + 1 : 0}
              pos={pos}
              compasesMs={p.compasesMs}
              actual={actual?.indice === s.indice}
              loop={p.loop && actual?.indice === s.indice}
              salto={destino?.indice === s.indice ? p.saltoPendiente : null}
              limiteSalto={p.saltoPendiente?.limiteMs ?? null}
              onCancelarSalto={p.onCancelarSalto}
              onJump={(inmediato) => (s.marcador ? onJump(s.marcador.id, inmediato) : p.onJumpInicio(s.inicioMs, inmediato))}
              onRename={(n) => s.marcador && onRename(s.marcador.id, n)}
              proyecto={p.proyecto}
              onTonalidad={(t) => s.marcador && p.onTonalidad(s.marcador.id, t)}
              onDelete={() => s.marcador && onDelete(s.marcador)}
            />
          ))}
        </ul>
      )}
      {conMarcador.length === 0 && (
        <p className="secciones-vacio">
          Todavía no hay secciones.
          <br />
          Con la canción sonando, presioná <kbd>M</kbd> en cada parte
          {p.analisis?.estado !== 'sin-guia' ? ', o dejá que se detecten por la voz guía.' : '.'}
        </p>
      )}

      <div className="secciones-pie">
        Click en una sección para ir (sonando, según el modo de salto de ⚙ Ajustes; con <kbd>Shift</kbd>, ya) · <kbd>1</kbd>…<kbd>9</kbd> ·{' '}
        <kbd>←</kbd> <kbd>→</kbd> anterior / siguiente · <kbd>F</kbd> terminar con fundido · <kbd>Esc</kbd> cancela el salto · doble click en el
        nombre para renombrar · arrastrá los triángulos de la línea de tiempo para mover una sección.
      </div>
    </section>
  )
}

/** Cuantos compases (con tempo) o cuanto dura una seccion. */
function largoDeSeccion(s: Seccion, compasesMs: number[] | null): string {
  if (compasesMs && compasesMs.length > 1) {
    const n = compasesMs.filter((c) => c >= s.inicioMs - 50 && c < s.finMs - 50).length
    if (n > 0) return `${n} ${n === 1 ? 'compás' : 'compases'}`
  }
  return formatMmSs(s.finMs - s.inicioMs)
}

/**
 * Una seccion como tarjeta grande: click = ir ahi (sonando, segun el modo de
 * salto; Shift = ya). La que suena muestra cuanto va; la elegida para saltar,
 * cuanto falta.
 */
function TarjetaSeccion({
  seccion,
  numero,
  pos,
  compasesMs,
  actual,
  loop,
  salto,
  limiteSalto,
  onCancelarSalto,
  onJump,
  onRename,
  proyecto,
  onTonalidad,
  onDelete
}: {
  seccion: Seccion
  numero: number
  pos: number
  compasesMs: number[] | null
  actual: boolean
  loop: boolean
  salto: SaltoPendiente | null
  /** donde se hace el salto elegido (los compases que faltan cuentan hasta ahi) */
  limiteSalto: number | null
  onCancelarSalto: () => void
  onJump: (inmediato: boolean) => void
  onRename: (nombre: string) => void
  proyecto: Pick<Proyecto, 'nombre' | 'tonalidad' | 'tonoAplicado' | 'marcadores'>
  onTonalidad: (tonalidad: string | null) => void
  onDelete: () => void
}) {
  const [editando, setEditando] = useState(false)
  const [eligiendoTono, setEligiendoTono] = useState(false)
  const tonoPropio = seccion.marcador?.tonalidad ?? null
  const semitonos = proyecto.tonoAplicado ?? 0
  const [nombre, setNombre] = useState(seccion.nombre)
  const color = colorDeSeccion(seccion)
  const avance = actual ? Math.min(1, Math.max(0, (pos - seccion.inicioMs) / Math.max(1, seccion.finMs - seccion.inicioMs))) : 0
  const faltan = actual ? compasesQueFaltan(compasesMs, seccion, pos, limiteSalto) : null

  function empezar(): void {
    setNombre(seccion.nombre)
    setEditando(true)
  }
  function confirmar(): void {
    setEditando(false)
    if (nombre.trim() && nombre.trim() !== seccion.nombre) onRename(nombre.trim())
  }

  return (
    <li
      className={`seccion-tarjeta ${actual ? 'actual' : ''} ${salto ? 'pendiente' : ''} ${loop ? 'loop' : ''} ${seccion.marcador ? '' : 'inicio'}`}
      style={{ '--color-seccion': color } as React.CSSProperties}
      onClick={(e) => !editando && !eligiendoTono && onJump(e.shiftKey)}
      title={
        seccion.marcador
          ? 'Click para ir a esta sección (sonando, según el modo de salto; Shift+click: ya)'
          : 'Volver al principio de la canción (sonando, según el modo de salto; Shift+click: ya)'
      }
    >
      <div className="seccion-tarjeta-arriba">
        {numero >= 1 && numero <= 9 && <kbd className="seccion-numero num">{numero}</kbd>}
        {!seccion.marcador && <SkipBack size={13} className="seccion-inicio-icono" />}
        <OrigenSeccion marcador={seccion.marcador} />
        <span className="seccion-tiempo num">{formatMmSs(seccion.inicioMs)}</span>
        {tonoPropio && !eligiendoTono && (
          <span
            className="seccion-tono num"
            title={`La canción pasa a ${transponerTonalidad(tonoPropio, semitonos)} en esta sección${semitonos ? ` (original: ${tonoPropio})` : ''}: el pad del colchón y los celulares lo siguen`}
          >
            <Music size={11} /> {transponerTonalidad(tonoPropio, semitonos)}
          </span>
        )}
        {eligiendoTono && (
          <select
            className="seccion-tono-elegir"
            autoFocus
            value={tonoPropio ?? ''}
            aria-label={`Tono de ${seccion.nombre}`}
            title="La canción cambia de tono en esta sección (en el tono original de la canción; sigue así hasta otra sección que diga otro)"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              onTonalidad(e.target.value || null)
              setEligiendoTono(false)
            }}
            onBlur={() => setEligiendoTono(false)}
            onKeyDown={(e) => e.key === 'Escape' && setEligiendoTono(false)}
          >
            <option value="">Sin cambio de tono</option>
            {TONALIDADES.map((t) => (
              <option key={t} value={t}>
                {semitonos ? `${t} (suena ${transponerTonalidad(t, semitonos)})` : t}
              </option>
            ))}
          </select>
        )}
        {!editando && !eligiendoTono && seccion.marcador && (
          <span className="seccion-acciones">
            <button
              title={tonoPropio ? 'Cambiar el tono de esta sección' : `Marcar un cambio de tono en esta sección (ahora: ${tonalidadEn(proyecto, seccion.inicioMs) ?? 'sin tonalidad'})`}
              aria-label={`Tono de ${seccion.nombre}`}
              onClick={(e) => {
                e.stopPropagation()
                setEligiendoTono(true)
              }}
            >
              <Music size={14} />
            </button>
            <button
              title="Renombrar"
              aria-label={`Renombrar ${seccion.nombre}`}
              onClick={(e) => {
                e.stopPropagation()
                empezar()
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              title="Borrar (se puede deshacer)"
              aria-label={`Borrar ${seccion.nombre}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 size={14} />
            </button>
          </span>
        )}
      </div>
      {editando ? (
        <input
          className="seccion-nombre-input"
          autoFocus
          value={nombre}
          maxLength={60}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNombre(e.target.value)}
          onBlur={confirmar}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirmar()
            if (e.key === 'Escape') setEditando(false)
          }}
        />
      ) : (
        <span className="seccion-nombre" onDoubleClick={(e) => seccion.marcador && (e.stopPropagation(), empezar())}>
          {loop && <Repeat size={16} />}
          {seccion.nombre}
        </span>
      )}
      <span className="seccion-tarjeta-abajo">
        {salto ? (
          <span className="seccion-pendiente" role="status">
            <ArrowRight size={14} /> sigue <b className="num">{faltaParaSalto(salto, pos)}</b>
            <button
              title="Cancelar el salto (Esc)"
              aria-label="Cancelar el salto"
              onClick={(e) => {
                e.stopPropagation()
                onCancelarSalto()
              }}
            >
              <X size={13} />
            </button>
          </span>
        ) : (
          <span className={`seccion-largo ${actual && faltan === 1 ? 'ultimo' : ''}`}>
            {actual
              ? [loop ? 'repitiendo' : null, faltan === null ? (loop ? null : 'sonando') : faltan === 1 ? 'último compás' : `faltan ${faltan} compases`].filter(Boolean).join(' · ')
              : largoDeSeccion(seccion, compasesMs)}
          </span>
        )}
      </span>
      {actual && <span className="seccion-avance" style={{ width: `${avance * 100}%` }} />}
    </li>
  )
}

function OrigenSeccion({ marcador }: { marcador?: Marcador | null }) {
  if (marcador?.origen === 'guia')
    return (
      <span className="seccion-origen" title="Detectada por la voz guía">
        <Mic size={12} />
      </span>
    )
  if (marcador?.origen === 'archivo')
    return (
      <span className="seccion-origen" title="Tomada de los archivos de la canción">
        <FileAudio size={12} />
      </span>
    )
  return null
}

/** Una linea (o una tarjeta, si hay que hacer algo) con el estado del analisis automatico. */
function EstadoAnalisisVista({
  analisis,
  progreso,
  modeloVoz,
  sonando,
  onDescargarModelo,
  onReintentar
}: {
  analisis: AnalisisProyecto | null
  progreso: { hechos: number; total: number } | null
  modeloVoz: InfoModeloVoz
  sonando: boolean
  onDescargarModelo: () => void
  onReintentar: () => void
}) {
  if (!analisis) return null
  const girando = <LoaderCircle size={13} className="girando" />
  switch (analisis.estado) {
    case 'analizando':
      return (
        <div className="analisis-linea" role="status">
          {girando} Analizando click y voz guía…
        </div>
      )
    case 'esperando-voz':
      return (
        <div className="analisis-linea" role="status">
          {girando} {sonando ? 'La guía se lee cuando pare la música' : 'Preparando la lectura de la guía…'}
        </div>
      )
    case 'reconociendo': {
      const pct = progreso && progreso.total ? Math.round((progreso.hechos / progreso.total) * 100) : 0
      return (
        <div className="analisis-linea" role="status">
          {girando}
          <span className="analisis-texto">
            {sonando ? 'En pausa mientras suena la música' : 'Escuchando la voz guía'}
            {progreso && progreso.total > 0 && (
              <span className="num"> · {progreso.hechos}/{progreso.total}</span>
            )}
          </span>
          <span className="analisis-barra">
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
      )
    }
    case 'falta-modelo':
      return (
        <div className="analisis-tarjeta">
          <p>
            Para leer la voz guía (“Verso”, “Coro”…) hace falta el <b>reconocedor de voz</b>. Se descarga una sola vez
            (~80&nbsp;MB) y después funciona sin internet.
          </p>
          {modeloVoz.estado === 'descargando' ? (
            <div className="analisis-linea">
              {girando}
              <span className="analisis-texto num">Descargando… {Math.round((modeloVoz.progreso ?? 0) * 100)}%</span>
              <span className="analisis-barra">
                <span style={{ width: `${Math.round((modeloVoz.progreso ?? 0) * 100)}%` }} />
              </span>
            </div>
          ) : (
            <>
              {modeloVoz.estado === 'error' && <p className="analisis-error">{modeloVoz.mensaje ?? 'No se pudo descargar.'}</p>}
              <button className="btn-primario" onClick={onDescargarModelo}>
                <Download size={14} /> {modeloVoz.estado === 'error' ? 'Reintentar descarga' : 'Descargar reconocedor'}
              </button>
            </>
          )}
        </div>
      )
    case 'error':
      return (
        <div className="analisis-linea analisis-error" role="status">
          <CircleAlert size={13} />
          <span className="analisis-texto" title={analisis.mensaje}>
            {analisis.mensaje ?? 'No se pudo analizar la canción'}
          </span>
          <button className="btn-mini" onClick={onReintentar}>
            Reintentar
          </button>
        </div>
      )
    case 'sin-guia':
      return null
    case 'listo':
      if (analisis.mensaje)
        return (
          <div className="analisis-linea" role="status">
            <CircleAlert size={13} />
            <span className="analisis-texto">{analisis.mensaje}</span>
          </div>
        )
      if (analisis.fuente === 'guia')
        return (
          <div className="analisis-linea" role="status">
            <Mic size={13} /> Secciones detectadas por la voz guía
          </div>
        )
      if (analisis.fuente === 'archivo')
        return (
          <div className="analisis-linea" role="status">
            <FileAudio size={13} /> Secciones tomadas de los archivos
          </div>
        )
      return null
  }
}
