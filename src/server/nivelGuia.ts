import path from 'node:path'
import type { Proyecto } from '../shared/types'
import { decodificarMono } from './analisis/decodificar'
import { nivelDeHabla, pistasDeAnuncio } from './voces'

const SR = 16000

/**
 * Que tan fuerte habla la guia de cada cancion, para que la voz que avisa un
 * salto suene a ese mismo nivel (ver Voces.renderizar). Se mide una vez por
 * cancion (de su archivo de guia), en segundo plano y nunca mientras suena
 * musica; mientras no se sabe, la voz suena con su volumen propio.
 */
export class NivelesGuia {
  private niveles = new Map<string, number | null>()
  private midiendo = new Set<string>()

  constructor(
    private readonly dirDe: (proyectoId: string) => string,
    private readonly algoSuena: () => boolean
  ) {}

  private clave(p: Proyecto): string | null {
    const { guiaPistaId } = pistasDeAnuncio(p)
    const guia = p.pistas.find((x) => x.id === guiaPistaId)
    return guia ? `${p.id}/${guia.archivo}` : null
  }

  /** El nivel de la guia de la cancion; null = no tiene guia o todavia no se midio. */
  nivel(p: Proyecto): number | null {
    const k = this.clave(p)
    return k ? (this.niveles.get(k) ?? null) : null
  }

  /** Lo mide si hace falta (en segundo plano, con la musica parada). */
  preparar(p: Proyecto): void {
    const k = this.clave(p)
    if (!k || this.niveles.has(k) || this.midiendo.has(k) || this.algoSuena()) return
    const { guiaPistaId } = pistasDeAnuncio(p)
    const guia = p.pistas.find((x) => x.id === guiaPistaId)!
    this.midiendo.add(k)
    void decodificarMono(path.join(this.dirDe(p.id), guia.archivo), SR)
      .then((x) => this.niveles.set(k, nivelDeHabla(x, SR)))
      .catch(() => this.niveles.set(k, null))
      .finally(() => this.midiendo.delete(k))
  }
}
