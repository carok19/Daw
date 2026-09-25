import type { Seccion } from '@shared/playback'

/** Colores de las secciones en la linea de tiempo (se alternan; un marcador puede tener el suyo). */
const COLORES_SECCION = ['#3b5bdb', '#0c8599', '#2b8a3e', '#e67700', '#c2255c', '#6741d9', '#1971c2', '#5c940d']

export function colorDeSeccion(s: Seccion): string {
  if (s.marcador?.color) return s.marcador.color
  if (!s.marcador) return '#3a4152'
  return COLORES_SECCION[(s.indice - 1 + COLORES_SECCION.length) % COLORES_SECCION.length]
}
