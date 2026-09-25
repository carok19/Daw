/** Clave estable por nombre de pista ("Click", "click ", "CLICK" -> "click"). Igual que en el renderer (PlaybackEngine). */
export function clavePista(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
