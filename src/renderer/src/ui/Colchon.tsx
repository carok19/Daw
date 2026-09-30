import type { AjustesColchon, ColchonActivo } from '@shared/types'
import { bpmDeColchon } from '@shared/colchon'
import { useGolpeColchon } from '../app/playheadStore'

/** "Colchón · D · 72 BPM" (el que suena). */
export function textoColchon(c: ColchonActivo): string {
  return ['Colchón', c.pad ?? 'sin pad', c.click ? `${Math.round(bpmDeColchon(c))} BPM` : null].filter(Boolean).join(' · ')
}

/** "4/4", "3/4", "6/8". */
export function textoCompasColchon(pulsos: number): string {
  return pulsos === 6 ? '6/8' : `${pulsos}/4`
}

/** Los golpes del compas que suena (el "1" mas grande), y el numero de compas. */
export function PulsoColchon({ pulsos, grande = false }: { pulsos: number; grande?: boolean }) {
  const g = useGolpeColchon()
  return (
    <span className={`pulso-colchon ${grande ? 'grande' : ''}`} role="status" aria-label={g ? `Compás ${g.compas}, golpe ${g.golpe}` : 'Colchón'}>
      <span className="pulso-colchon-golpes" aria-hidden>
        {Array.from({ length: pulsos }, (_, i) => (
          <span key={i} className={`pulso-golpe ${i === 0 ? 'uno' : ''} ${g?.golpe === i + 1 ? 'activo' : ''}`} />
        ))}
      </span>
      {g && <span className="pulso-colchon-compas num">compás {g.compas}</span>}
    </span>
  )
}

/** Ajustes del colchon de la lista que se muestran ("D · 72 BPM · 4/4 · con click"). */
export function resumenAjustes(a: AjustesColchon): string {
  return [a.tonalidad ? `Pad en ${a.tonalidad}` : 'Sin pad', a.click ? `click a ${a.bpm} BPM (${textoCompasColchon(a.compas)})` : 'sin click'].join(' · ')
}
