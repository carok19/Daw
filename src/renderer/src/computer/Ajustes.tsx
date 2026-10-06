import { useState } from 'react'
import { CircleCheck, Laptop, LoaderCircle, Megaphone, Mic, Play, Settings, Trash2, Volume2, VolumeX, Waves } from 'lucide-react'
import { DURACIONES_FUNDIDO, type InfoVoces, type ModoSalto } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { guardarPref, leerPref } from '../app/preferencias'
import { Modal } from '../ui/Modal'
import { Toggle } from '../ui/Toggle'
import { IconoFundido } from '../ui/Fundido'
import { PadsDelColchon } from './PadsDelColchon'
import { AjusteCompu } from './Consola'
import { AjustesTalkback } from './Talkback'

const IDIOMA_VOCES: Record<InfoVoces['idioma'], string> = { es: 'en español', en: 'en inglés', otro: '' }

/**
 * Voz que avisa el salto ("Coro… 3, 4" en el último compás antes de saltar),
 * con un pack de voces que se importa una vez (no viene con la app).
 */
export function VozDelSalto(p: { voces: InfoVoces | null; onImportar: () => Promise<boolean>; onActivar: (a: boolean) => void; onBorrar: () => void }) {
  const [importando, setImportando] = useState(false)
  async function importar(): Promise<void> {
    setImportando(true)
    try {
      await p.onImportar()
    } finally {
      setImportando(false)
    }
  }
  if (importando) {
    return (
      <div className="voz-salto">
        <LoaderCircle size={14} className="girando" /> Importando las voces…
      </div>
    )
  }
  if (!p.voces) {
    return (
      <div className="voz-salto">
        <Megaphone size={14} />
        <span>No se encontraron las voces que trae el programa (reinstalarlo las repone).</span>
        <button
          className="btn-enlace"
          onClick={() => void importar()}
          title="Elegí un .zip o .rar con un audio por sección (Coro, Verso 1, Puente…) y los números 1 a 7. Si trae varios idiomas se usa el español."
        >
          Usar un pack…
        </button>
      </div>
    )
  }
  const v = p.voces
  // las del programa vienen incluidas y listas (no hay que cargar nada): otro pack es un extra
  return (
    <div className={`voz-salto incluido ${v.activo ? 'activa' : ''}`}>
      <label title="En el último compás antes del salto se escucha la sección elegida y la cuenta, con el volumen y el lado de la guía (la guía de la canción se calla en ese compás)">
        <input type="checkbox" checked={v.activo} onChange={(e) => p.onActivar(e.target.checked)} />
        <Megaphone size={14} /> Avisar con voz <em>“Coro… 3, 4”</em>
      </label>
      <small className="num" title={v.deFabrica ? 'Las voces que trae el programa (Secuencias.com)' : v.numeros ? undefined : 'El pack no trae los números: se avisa solo el nombre'}>
        <CircleCheck size={12} className="texto-verde" />{' '}
        {v.deFabrica ? `Incluidas: voces del programa ${IDIOMA_VOCES[v.idioma]}` : `Tu pack: ${v.cantidad} voces ${IDIOMA_VOCES[v.idioma]}`}
        {!v.numeros && ' · sin números'}
      </small>
      <button className="btn-enlace" onClick={() => void importar()} title="Otro pack de voces (.zip o .rar con un audio por sección y los números)" aria-label="Usar otro pack de voces">
        {v.deFabrica ? 'Usar otras (opcional)…' : 'Cambiar…'}
      </button>
      {!v.deFabrica && (
        <button className="btn-icono" onClick={p.onBorrar} title="Quitar este pack (vuelven las voces del programa)" aria-label="Quitar este pack de voces">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

const MODOS: { modo: ModoSalto; nombre: string; detalle: string }[] = [
  { modo: 'seccion', nombre: 'Al terminar la sección', detalle: 'La sección que suena termina y la música sigue directo en la elegida, sin cortes.' },
  { modo: 'compas', nombre: 'En el compás', detalle: 'En el próximo “1” del compás (hace falta el tempo: la pista de click).' },
  { modo: 'inmediato', nombre: 'Ya', detalle: 'Enseguida (con el margen para que llegue a todos los celulares a la vez).' }
]

export type PestanaAjustes = 'vivo' | 'sonidos' | 'compu' | 'talkback'

const PESTANAS: { id: PestanaAjustes; nombre: string; Icono: typeof Play }[] = [
  { id: 'vivo', nombre: 'En vivo', Icono: Play },
  { id: 'sonidos', nombre: 'Sonidos', Icono: Megaphone },
  { id: 'compu', nombre: 'Esta compu', Icono: Laptop },
  { id: 'talkback', nombre: 'Talkback', Icono: Mic }
]

/**
 * ⚙ Ajustes: lo que se elige una vez y no hace falta tener a la vista (la
 * barra de arriba queda para lo que se usa en vivo). En pestañas:
 * - En vivo: como salta al elegir una seccion y cuanto tarda Terminar.
 * - Sonidos: la voz que avisa los saltos y el pad del colchon.
 * - Esta compu: si suena tambien en la compu, y su ajuste fino.
 * - Talkback: el microfono y cuanto tarda en cada celular.
 */
export function PanelAjustes({ controller, inicial, onCerrar }: { controller: AppController; inicial?: PestanaAjustes; onCerrar: () => void }) {
  const [pestana, setPestanaState] = useState<PestanaAjustes>(() => {
    const guardada = leerPref<string>('ajustes-pestana', 'vivo')
    return inicial ?? (PESTANAS.some((x) => x.id === guardada) ? (guardada as PestanaAjustes) : 'vivo')
  })
  const setPestana = (id: PestanaAjustes): void => {
    setPestanaState(id)
    guardarPref('ajustes-pestana', id)
  }
  return (
    <Modal titulo="Ajustes" icono={<Settings size={20} color="var(--accent)" />} onCerrar={onCerrar} tamano="ancho">
      <div className="ajustes">
        <nav className="ajustes-nav" role="tablist" aria-label="Ajustes" aria-orientation="vertical">
          {PESTANAS.map(({ id, nombre, Icono }) => (
            <button key={id} role="tab" aria-selected={pestana === id} className={pestana === id ? 'activo' : ''} onClick={() => setPestana(id)}>
              <Icono size={16} /> {nombre}
            </button>
          ))}
        </nav>
        <div className="ajustes-cuerpo" role="tabpanel" aria-label={PESTANAS.find((x) => x.id === pestana)!.nombre}>
          {pestana === 'vivo' ? (
            <EnVivo controller={controller} />
          ) : pestana === 'sonidos' ? (
            <Sonidos controller={controller} />
          ) : pestana === 'compu' ? (
            <EstaCompu controller={controller} />
          ) : (
            <AjustesTalkback controller={controller} />
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Como salta al elegir una seccion sonando, y cuanto tarda en apagarse con Terminar. */
function EnVivo({ controller }: { controller: AppController }) {
  const e = controller.estado
  const modo = e?.modoSalto ?? 'seccion'
  const fundidoMs = e?.fundidoMs ?? 4000
  const hayTempo = !!e?.proyectoActivo?.tempo
  return (
    <>
      <h3 className="ajustes-titulo">Saltos de sección</h3>
      <p className="ayuda ajustes-ayuda">Al elegir una sección (o ←/→) con la canción sonando, salta:</p>
      <div className="ajustes-opciones" role="radiogroup" aria-label="Cuándo salta al elegir una sección sonando">
        {MODOS.map((m) => (
          <button key={m.modo} role="radio" aria-checked={modo === m.modo} className={`ajustes-opcion ${modo === m.modo ? 'activo' : ''}`} onClick={() => controller.setModoSalto(m.modo)}>
            <b>{m.nombre}</b>
            <small>{m.modo === 'compas' && !hayTempo ? 'Esta canción no tiene el tempo: salta al terminar la sección.' : m.detalle}</small>
          </button>
        ))}
      </div>

      <h3 className="ajustes-titulo">
        <IconoFundido size={15} /> Terminar con fundido
      </h3>
      <p className="ayuda ajustes-ayuda">
        Con <b>Terminar</b> (o la tecla <kbd>F</kbd>) la canción se apaga desde donde saltaría (según lo de arriba), en todos a la vez, y para. Se apaga en:
      </p>
      <div className="segmentado ajustes-fundido" role="radiogroup" aria-label="Cuánto tarda en apagarse">
        {DURACIONES_FUNDIDO.map((ms) => (
          <button key={ms} role="radio" aria-checked={fundidoMs === ms} className={fundidoMs === ms ? 'activo' : ''} onClick={() => controller.setDuracionFundido(ms)}>
            {ms / 1000} s
          </button>
        ))}
      </div>
    </>
  )
}

/** Los sonidos de ayuda que pone el programa: la voz que avisa los saltos y el pad del colchon. */
function Sonidos({ controller }: { controller: AppController }) {
  const e = controller.estado
  return (
    <>
      <p className="ayuda ajustes-ayuda">Vienen incluidos con el programa y listos para usar: no hace falta cargar nada. Usar los tuyos es opcional.</p>
      <h3 className="ajustes-titulo">
        <Megaphone size={15} /> Voz que avisa el salto
      </h3>
      <p className="ayuda ajustes-ayuda">En el último compás antes de saltar, “Coro… 3, 4” del lado de la guía.</p>
      <VozDelSalto voces={e?.voces ?? null} onImportar={controller.importarVoces} onActivar={controller.activarVoces} onBorrar={controller.borrarVoces} />

      <h3 className="ajustes-titulo">
        <Waves size={15} /> Pad del colchón
      </h3>
      <p className="ayuda ajustes-ayuda">El colchón de ambiente en el tono de la canción.</p>
      <PadsDelColchon controller={controller} />
    </>
  )
}

/** Si la compu tambien suena (para ensayar o probar), y su ajuste fino contra los celulares. */
function EstaCompu({ controller }: { controller: AppController }) {
  const activo = controller.sonidoLocal
  return (
    <>
      <h3 className="ajustes-titulo">
        <Volume2 size={15} /> Sonido en esta compu
      </h3>
      <p className="ayuda ajustes-ayuda">
        El audio sale de los celulares. Prendelo para escuchar también en esta compu (ensayos, pruebas). Mientras está prendido, arriba se ve{' '}
        <b>Compu</b> con un parlante, para que no quede sonando sin querer.
      </p>
      <Toggle activo={activo} onCambiar={controller.setSonidoLocal} titulo={activo ? 'Apagar el sonido de esta compu' : 'Prender el sonido de esta compu'}>
        {activo ? <Volume2 size={15} /> : <VolumeX size={15} />}
        {activo ? 'Suena también en esta compu' : 'Sonido en esta compu'}
      </Toggle>
      {activo && <AjusteCompu controller={controller} />}
    </>
  )
}
