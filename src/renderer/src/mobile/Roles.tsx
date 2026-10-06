import type { CSSProperties } from 'react'
import { Check, Crown, Guitar, MicVocal, Projector, Speaker, type LucideIcon } from 'lucide-react'
import { ROLES, type RolDispositivo } from '@shared/types'

export interface InfoRol {
  /** como se lo nombra ("Director") */
  nombre: string
  /** como lo dice el que lo elige ("Dirijo") */
  yo: string
  /** que ve y que escucha, en pocas palabras */
  que: string
  color: string
  Icono: LucideIcon
}

/** Cada rol: su nombre, que hace y su color (el mismo en el celular y en la compu). */
export const INFO_ROL: Record<RolDispositivo, InfoRol> = {
  director: { nombre: 'Director', yo: 'Dirijo', que: 'Manejo la canción: secciones, repetir, colchón', color: '#4f7cff', Icono: Crown },
  musico: { nombre: 'Músico', yo: 'Toco', que: 'Mi mezcla y por dónde va la canción', color: '#22c55e', Icono: Guitar },
  voz: { nombre: 'Voz', yo: 'Canto', que: 'La sección, lo que sigue y el tono, bien grandes', color: '#a78bfa', Icono: MicVocal },
  sonido: { nombre: 'Sonido', yo: 'Consola', que: 'A los parlantes: la banda sola, sin click ni guía', color: '#f59e0b', Icono: Speaker },
  multimedia: { nombre: 'Multimedia', yo: 'Pantallas', que: 'Qué sigue y cuánto falta, para la letra (sin audio)', color: '#ec4899', Icono: Projector }
}

const estiloRol = (r: RolDispositivo): CSSProperties => ({ '--color-rol': INFO_ROL[r].color }) as CSSProperties

/**
 * "¿Qué hacés en la banda?": cada uno elige para que usa este celular (y ve
 * solo lo suyo). Tocar un rol lo elige y, la primera vez, ya arranca.
 */
export function ElegirRol({ actual, onElegir, onCerrar }: { actual: RolDispositivo | null; onElegir: (r: RolDispositivo) => void; onCerrar?: () => void }) {
  return (
    <div className="roles" role="dialog" aria-modal aria-labelledby="roles-titulo">
      <div className="roles-cabeza">
        <h1 id="roles-titulo">¿Qué hacés en la banda?</h1>
        <p>Cada uno ve lo suyo. Se cambia cuando quieras, tocando el rol arriba.</p>
      </div>
      <div className="roles-lista">
        {ROLES.map((r) => {
          const i = INFO_ROL[r]
          return (
            <button key={r} className={`rol-tarjeta ${actual === r ? 'activo' : ''}`} style={estiloRol(r)} onClick={() => onElegir(r)} aria-pressed={actual === r} data-rol={r}>
              <span className="rol-icono">
                <i.Icono size={26} />
              </span>
              <span className="rol-textos">
                <b>{i.yo}</b>
                <small>{i.que}</small>
              </span>
              {actual === r && <Check size={20} className="rol-check" />}
            </button>
          )
        })}
      </div>
      {onCerrar && (
        <button className="btn-fantasma roles-cancelar" onClick={onCerrar}>
          Cancelar
        </button>
      )}
    </div>
  )
}

/** El rol de este celular, arriba: tocarlo deja cambiarlo. */
export function ChipRol({ rol, onClick, deshabilitado }: { rol: RolDispositivo | null; onClick: () => void; deshabilitado?: boolean }) {
  if (!rol) return null
  const i = INFO_ROL[rol]
  return (
    <button className="m-rol" style={estiloRol(rol)} onClick={onClick} disabled={deshabilitado} aria-label={`Rol: ${i.nombre}. Tocá para cambiarlo`}>
      <i.Icono size={16} />
      <span>{i.nombre}</span>
    </button>
  )
}
