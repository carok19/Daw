// Paleta fija (estilo DAW) para distinguir pistas de un vistazo. El color se
// deriva del id de la pista, asi que se mantiene estable aunque se reordenen.
const PALETA = [
  '#e8833a', // naranja
  '#e05c7a', // rosa/rojo
  '#a3c93a', // verde lima
  '#3ac9a0', // verde agua
  '#3aa0e8', // celeste
  '#5c6ee8', // azul
  '#a05ce8', // violeta
  '#e85ce0', // magenta
  '#e8c93a', // amarillo
  '#3ae86e', // verde
  '#e85c5c', // rojo
  '#5ce8d8' // turquesa
]

export function colorDePista(pistaId: string): string {
  let hash = 0
  for (let i = 0; i < pistaId.length; i++) {
    hash = (hash * 31 + pistaId.charCodeAt(i)) >>> 0
  }
  return PALETA[hash % PALETA.length]
}
