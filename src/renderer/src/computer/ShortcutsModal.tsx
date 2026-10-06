import { Fragment } from 'react'
import { Keyboard } from 'lucide-react'
import { Modal } from '../ui/Modal'

const ATAJOS: [string[], string][] = [
  [['Espacio'], 'Reproducir / pausa'],
  [['Enter'], 'Stop (vuelve al inicio)'],
  [['←', '→'], 'Sección anterior / siguiente'],
  [['1', '…', '9'], 'Ir a la sección 1 a 9'],
  [['M'], 'Marcar una sección en la posición actual'],
  [['L'], 'Repetir la sección actual (activar / desactivar)'],
  [['C'], 'Colchón: al terminar la sección (o en el próximo compás, según el modo de salto) se va la banda y siguen el click y un pad; con la canción parada, empiezan ya (otra vez C: terminar)'],
  [['T'], 'Talkback: mantener apretada para hablarle a la banda en los oídos'],
  [['Re Pág', 'Av Pág'], 'Canción anterior / siguiente del setlist'],
  [['?'], 'Mostrar esta ayuda'],
  [['Esc'], 'Cerrar ventanas']
]

export function ShortcutsModal({ onCerrar }: { onCerrar: () => void }) {
  return (
    <Modal titulo="Atajos de teclado" icono={<Keyboard size={20} color="var(--accent)" />} onCerrar={onCerrar}>
      <div className="atajos">
        {ATAJOS.map(([teclas, texto]) => (
          <Fragment key={texto}>
            <div className="atajo-teclas">
              {teclas.map((t) => (t === '…' ? <span key={t}>…</span> : <kbd key={t}>{t}</kbd>))}
            </div>
            <div className="atajo-texto">{texto}</div>
          </Fragment>
        ))}
      </div>
      <p className="ayuda" style={{ marginBottom: 0 }}>
        Los atajos funcionan siempre, salvo mientras escribís en un campo de texto.
      </p>
    </Modal>
  )
}
