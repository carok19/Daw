import { useState } from 'react'
import { CircleAlert, Download, FileAudio, Flag, LoaderCircle, Mic, Pencil, Trash2, WandSparkles } from 'lucide-react'
import type { AnalisisProyecto, InfoModeloVoz, Marcador } from '@shared/types'
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
  onJump: (marcadorId: string) => void
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
            onJump={() => onJump(s.marcador!.id)}
            onRename={(n) => onRename(s.marcador!.id, n)}
            onDelete={() => onDelete(s.marcador!)}
          />
        ))}
      </ul>

      <div className="secciones-pie">
        <kbd>1</kbd>…<kbd>9</kbd> saltar a una sección · <kbd>←</kbd> <kbd>→</kbd> anterior / siguiente · arrastrá los
        triángulos de la línea de tiempo para mover una sección.
      </div>
    </aside>
  )
}

function FilaSeccion({
  seccion,
  numero,
  actual,
  onJump,
  onRename,
  onDelete
}: {
  seccion: Seccion
  numero: number
  actual: boolean
  onJump: () => void
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
    <li className={`seccion-fila ${actual ? 'actual' : ''}`} onClick={() => !editando && onJump()} title="Click para ir a esta sección">
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
