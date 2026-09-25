import { useState } from 'react'
import { ArrowRight, CircleAlert, Download, FileAudio, Flag, LoaderCircle, Mic, Pencil, Trash2, WandSparkles, X } from 'lucide-react'
import type { AnalisisProyecto, InfoModeloVoz, Marcador, ModoSalto, SaltoPendiente } from '@shared/types'
import type { Seccion } from '@shared/playback'
import { seccionEn } from '@shared/playback'
import { usePlayheadPaso } from '../app/playheadStore'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'

interface Props {
  secciones: Seccion[]
  analisis: AnalisisProyecto | null
  progreso: { hechos: number; total: number } | null
  modeloVoz: InfoModeloVoz
  sonando: boolean
  onJump: (marcadorId: string, inmediato: boolean) => void
  saltoPendiente: SaltoPendiente | null
  modoSalto: ModoSalto
  hayTempo: boolean
  onModoSalto: (m: ModoSalto) => void
  onCancelarSalto: () => void
  onCreate: (tiempoMs: number, nombre?: string) => void
  onRename: (marcadorId: string, nombre: string) => void
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

  function agregar(): void {
    onCreate(pos, nombreNuevo.trim() || undefined)
    setNombreNuevo('')
  }

  return (
    <aside className="secciones">
      <div className="secciones-cabecera">
        <h3>
          <span>
            Secciones <span className="num">{conMarcador.length}</span>
          </span>
          <button
            className="btn-detectar"
            onClick={p.onDetectar}
            disabled={EN_CURSO.includes(p.analisis?.estado ?? '')}
            title="Detectar las secciones automáticamente por la voz guía (Verso, Coro, Puente…), ajustadas al compás del click"
          >
            <WandSparkles size={14} /> Detectar
          </button>
        </h3>
        <div className="modo-salto" role="radiogroup" aria-label="Cuándo salta al elegir una sección sonando">
          <span>Al elegir una sección sonando, saltar:</span>
          <div className="segmentado segmentado-chico">
            <button
              role="radio"
              aria-checked={p.modoSalto === 'seccion'}
              className={p.modoSalto === 'seccion' ? 'activo' : ''}
              onClick={() => p.onModoSalto('seccion')}
              title="La sección actual termina y la música sigue directo en la elegida (sin cortes)"
            >
              Al terminar
            </button>
            <button
              role="radio"
              aria-checked={p.modoSalto === 'compas'}
              className={p.modoSalto === 'compas' ? 'activo' : ''}
              onClick={() => p.onModoSalto('compas')}
              disabled={!p.hayTempo}
              title={p.hayTempo ? 'En el próximo "1" del compás' : 'Hace falta el tempo (pista de click)'}
            >
              En el compás
            </button>
            <button
              role="radio"
              aria-checked={p.modoSalto === 'inmediato'}
              className={p.modoSalto === 'inmediato' ? 'activo' : ''}
              onClick={() => p.onModoSalto('inmediato')}
              title="Enseguida (con el margen de sincronización de los celulares)"
            >
              Ya
            </button>
          </div>
        </div>
        <EstadoAnalisisVista
          analisis={p.analisis}
          progreso={p.progreso}
          modeloVoz={p.modeloVoz}
          sonando={p.sonando}
          onDescargarModelo={p.onDescargarModelo}
          onReintentar={p.onDetectar}
        />
        <div className="secciones-nueva">
          <input
            placeholder="Nombre (Intro, Coro…)"
            value={nombreNuevo}
            maxLength={60}
            onChange={(e) => setNombreNuevo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && agregar()}
          />
          <button className="btn-primario" onClick={agregar} title="Marcar una sección en la posición actual (M)">
            <Flag size={15} />
            <span className="num">{formatMmSs(pos)}</span>
          </button>
        </div>
      </div>

      <ul className="secciones-lista">
        {conMarcador.length === 0 && (
          <li className="vacio">
            Todavía no hay secciones.
            <br />
            Con la canción sonando, presioná <kbd>M</kbd> en cada parte
            {p.analisis?.estado !== 'sin-guia' ? ', o dejá que se detecten por la voz guía.' : '.'}
          </li>
        )}
        {conMarcador.map((s, i) => (
          <FilaSeccion
            key={s.marcador!.id}
            seccion={s}
            numero={i + 1}
            actual={actual?.indice === s.indice}
            pendiente={p.saltoPendiente?.destinoMs === s.inicioMs}
            onCancelarSalto={p.onCancelarSalto}
            onJump={(inmediato) => onJump(s.marcador!.id, inmediato)}
            onRename={(n) => onRename(s.marcador!.id, n)}
            onDelete={() => onDelete(s.marcador!)}
          />
        ))}
      </ul>

      <div className="secciones-pie">
        <kbd>1</kbd>…<kbd>9</kbd> ir a una sección (con <kbd>Shift</kbd>, ya) · <kbd>←</kbd> <kbd>→</kbd> anterior / siguiente ·{' '}
        <kbd>Esc</kbd> cancela el salto · arrastrá los triángulos de la línea de tiempo para mover una sección.
      </div>
    </aside>
  )
}

function FilaSeccion({
  seccion,
  numero,
  actual,
  pendiente,
  onCancelarSalto,
  onJump,
  onRename,
  onDelete
}: {
  seccion: Seccion
  numero: number
  actual: boolean
  pendiente: boolean
  onCancelarSalto: () => void
  onJump: (inmediato: boolean) => void
  onRename: (nombre: string) => void
  onDelete: () => void
}) {
  const [editando, setEditando] = useState(false)
  const [nombre, setNombre] = useState(seccion.nombre)

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
      className={`seccion-fila ${actual ? 'actual' : ''} ${pendiente ? 'pendiente' : ''}`}
      onClick={(e) => !editando && onJump(e.shiftKey)}
      title="Click para ir a esta sección (sonando, según el modo de salto; Shift+click: ya)"
    >
      <span className="seccion-numero num">{numero <= 9 ? numero : ''}</span>
      <span className="seccion-color" style={{ background: colorDeSeccion(seccion) }} />
      <span className="seccion-tiempo num">{formatMmSs(seccion.inicioMs)}</span>
      <OrigenSeccion marcador={seccion.marcador} />
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
        <span className="seccion-nombre" onDoubleClick={(e) => (e.stopPropagation(), empezar())}>
          {seccion.nombre}
        </span>
      )}
      {pendiente && !editando && (
        <span className="seccion-pendiente" title="Sigue esta sección">
          <ArrowRight size={14} />
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
      )}
      {!editando && (
        <span className="seccion-acciones">
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
