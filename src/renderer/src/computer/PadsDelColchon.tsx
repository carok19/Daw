import { useState } from 'react'
import { Download, LoaderCircle, Trash2, Waves } from 'lucide-react'
import { NOTAS_PAD } from '@shared/colchon'
import type { AppController } from '../app/useAppController'

/**
 * Qué pad suena en el colchón: el de la app o los de la banda ("Importar
 * pads": un .zip/.rar con un audio por tono, o un solo audio; los tonos que
 * faltan se hacen solos).
 */
export function PadsDelColchon({ controller }: { controller: AppController }) {
  const pads = controller.estado?.pads ?? null
  const [importando, setImportando] = useState(false)
  const [pedir, setPedir] = useState<{ archivo: string; filePath: string } | null>(null)
  const [nota, setNota] = useState<string>('C')

  async function importar(filePath?: string, n?: string): Promise<void> {
    setPedir(null)
    setImportando(true)
    try {
      const r = await controller.importarPads(filePath, n)
      if (r.pedirNota && r.filePath) setPedir({ archivo: r.pedirNota, filePath: r.filePath })
    } finally {
      setImportando(false)
    }
  }

  if (importando)
    return (
      <div className="voz-salto">
        <LoaderCircle size={14} className="girando" /> Preparando los pads en los 12 tonos…
      </div>
    )
  if (pedir)
    return (
      <div className="voz-salto activa" role="group" aria-label="Tono del pad">
        <span>
          ¿En qué tono está <b>{pedir.archivo}</b>?
        </span>
        <select value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Tono del pad importado">
          {NOTAS_PAD.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn-chico" onClick={() => void importar(pedir.filePath, nota)}>
          Importar
        </button>
        <button className="btn-chico" onClick={() => setPedir(null)}>
          Cancelar
        </button>
      </div>
    )
  const ayuda =
    'Un .zip o .rar con un audio por tono (el nombre dice el tono: “Pad C.wav”, “Pad F#.wav”, “Pad Bb.mp3”…), o un solo audio: los tonos que faltan se hacen solos'
  if (!pads)
    return (
      <div className="voz-salto">
        <Waves size={14} />
        <span>Pad del colchón: el de AirTracks</span>
        <button className="btn-chico" onClick={() => void importar()} title={ayuda}>
          Importar mis pads…
        </button>
      </div>
    )
  const generados = NOTAS_PAD.length - pads.originales.length
  return (
    <div className={`voz-salto ${pads.activo ? 'activa' : ''}`}>
      <Waves size={14} />
      <span>Pad del colchón:</span>
      <div className="segmentado segmentado-chico" role="radiogroup" aria-label="Pad del colchón">
        <button role="radio" aria-checked={!pads.activo} className={!pads.activo ? 'activo' : ''} onClick={() => controller.activarPads(false)}>
          De AirTracks
        </button>
        <button role="radio" aria-checked={pads.activo} className={pads.activo ? 'activo' : ''} onClick={() => controller.activarPads(true)}>
          Mis pads
        </button>
      </div>
      <small
        className="num"
        title={generados ? `Los que trae: ${pads.originales.join(', ')}. Los otros ${generados} tonos se hicieron desde el más cercano.` : 'Trae los 12 tonos'}
      >
        {pads.nombre} · {pads.originales.length === NOTAS_PAD.length ? '12 tonos' : `${pads.originales.length} de 12 tonos (el resto, hechos)`}
      </small>
      <button className="btn-icono" onClick={() => void importar()} title={`Usar otros pads. ${ayuda}`} aria-label="Importar otros pads">
        <Download size={13} />
      </button>
      <button className="btn-icono" onClick={controller.borrarPads} title="Quitar mis pads (vuelve el de AirTracks)" aria-label="Quitar mis pads">
        <Trash2 size={13} />
      </button>
    </div>
  )
}
