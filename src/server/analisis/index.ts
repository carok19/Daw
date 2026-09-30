import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Marcador, PedidoVoz, Proyecto, TempoProyecto } from '../../shared/types'
import { projectDir } from '../projects'
import { aplicarPaneoAutomatico } from '../../shared/mezcla'
import { decodificarMono } from './decodificar'
import { bpmDesdeNombre, calcularTempo, compasMasCercano, detectarGolpes, pareceNombreDeClick, puntajeClick, PUNTAJE_MIN_CLICK, SR_ANALISIS } from './tempo'
import { detectarFrases, guardarFrases, pareceNombreDeGuia, SR_VOZ } from './guia'
import { anunciosDesdeFrases, faseDesdeAnuncios, seccionesDesdeFrases } from './secciones'
import { velocidadAplicada } from '../../shared/velocidad'

/**
 * Version del detector de tempo. Al mejorarlo se sube: las canciones
 * analizadas con uno anterior vuelven a detectar el tempo solas (solo el
 * tempo, sin repetir la voz guia), en segundo plano.
 * 2: click que marca corcheas/semicorcheas, BPM del nombre, compases irregulares.
 */
export const VERSION_TEMPO = 2

/** true si el tempo de la cancion salio de un detector anterior (se vuelve a detectar). */
export function tempoDesactualizado(p: Proyecto): boolean {
  return !!p.tempo?.clickPistaId && (p.tempo.version ?? 1) < VERSION_TEMPO
}

/** Acceso a un proyecto (abierto en el setlist o solo en disco) y como guardarlo/avisar. */
export interface AccesoProyecto {
  proyecto: Proyecto
  guardar(): unknown
}

export interface HooksAnalisis {
  obtener(proyectoId: string): AccesoProyecto | null
  /** algo cambio en el analisis de este proyecto (estado, tempo, secciones) */
  cambio(proyectoId: string, aviso?: string): void
  /** cambio la lista de frases que la compu tiene que reconocer */
  pedidosVoz(pedidos: PedidoVoz[]): void
  /** false mientras suena una cancion: el analisis espera (no competir por CPU en vivo) */
  puedeTrabajar(): boolean
}

/**
 * Analisis automatico de canciones: tempo/compas desde el click y secciones
 * desde la voz guia. De a una cancion por vez y en segundo plano (el audio se
 * decodifica con ffmpeg en otro proceso): la cancion se puede usar mientras.
 */
export class Analizador {
  private cola: { id: string; reemplazar: boolean; soloTempo?: boolean }[] = []
  private trabajando = false
  private detenido = false

  /** `automatico`: analizar solo al importar; si es false, solo cuando se pide "Detectar" (tests). */
  constructor(
    private readonly hooks: HooksAnalisis,
    private readonly automatico = true
  ) {}

  detener(): void {
    this.detenido = true
    this.cola = []
  }

  encolar(proyectoId: string, reemplazar = false): void {
    if (this.detenido || (!this.automatico && !reemplazar)) return
    if (this.cola.some((c) => c.id === proyectoId)) return
    this.cola.push({ id: proyectoId, reemplazar })
    void this.procesar()
  }

  /** Vuelve a detectar solo el tempo (canciones analizadas con un detector anterior). */
  revisarTempo(proyectoId: string): void {
    if (this.detenido || !this.automatico) return
    if (this.cola.some((c) => c.id === proyectoId)) return
    this.cola.push({ id: proyectoId, reemplazar: false, soloTempo: true })
    void this.procesar()
  }

  /** Canciones cuya guia ya esta recortada y espera que la compu reconozca las frases. */
  pedidos(): PedidoVoz[] {
    return this.pendientesVoz
      .map((id) => this.hooks.obtener(id))
      .filter(
        (a): a is AccesoProyecto =>
          !!a && ['esperando-voz', 'reconociendo', 'falta-modelo'].includes(a.proyecto.analisis?.estado ?? '') && !!a.proyecto.analisis?.cues
      )
      .map((a) => ({ proyectoId: a.proyecto.id, nombre: a.proyecto.nombre, cues: a.proyecto.analisis!.cues! }))
  }

  private pendientesVoz: string[] = []

  /** Registra canciones que quedaron esperando voz (p.ej. al reabrir la app). */
  registrarPendiente(proyecto: Proyecto): void {
    if (proyecto.analisis?.estado === 'esperando-voz' || proyecto.analisis?.estado === 'reconociendo' || proyecto.analisis?.estado === 'falta-modelo') {
      if (!this.pendientesVoz.includes(proyecto.id)) this.pendientesVoz.push(proyecto.id)
    }
  }

  private async procesar(): Promise<void> {
    if (this.trabajando) return
    this.trabajando = true
    try {
      for (;;) {
        while (this.cola.length && !this.detenido && !this.hooks.puedeTrabajar()) await new Promise((r) => setTimeout(r, 1000))
        if (this.detenido) break
        const sig = this.cola.shift()
        if (!sig) break
        if (sig.soloTempo) {
          await this.redetectarTempo(sig.id).catch((err) => console.error('[analisis] tempo', err))
          continue
        }
        await this.analizar(sig.id, sig.reemplazar).catch((err) => {
          const acceso = this.hooks.obtener(sig.id)
          if (acceso) {
            acceso.proyecto.analisis = { estado: 'error', fuente: null, guiaPistaId: null, mensaje: String((err as Error).message ?? err) }
            acceso.guardar()
            this.hooks.cambio(sig.id)
          }
          console.error('[analisis]', err)
        })
      }
    } finally {
      this.trabajando = false
    }
  }

  private async analizar(proyectoId: string, reemplazar: boolean): Promise<void> {
    const acceso = this.hooks.obtener(proyectoId)
    if (!acceso) return
    const p = acceso.proyecto
    const dir = projectDir(p.id)
    p.analisis = { estado: 'analizando', fuente: p.analisis?.fuente ?? null, guiaPistaId: null, reemplazar }
    this.hooks.cambio(p.id)

    // 1) click -> tempo y compases
    const tempo = await detectarTempo(p, dir)
    if (!this.hooks.obtener(proyectoId)) return // se borro mientras tanto
    // se analizan las pistas originales: si la cancion suena a otra velocidad, el tempo pasa a ese tiempo
    const v = velocidadAplicada(p)
    p.tempo = tempo && v !== 1 ? { ...tempo, bpm: tempo.bpm * v, compasesMs: tempo.compasesMs.map((c) => c / v) } : tempo
    // el click pudo detectarse por como suena (no por el nombre): pasa a la izquierda
    aplicarPaneoAutomatico(p)
    acceso.guardar()
    this.hooks.cambio(p.id)

    // 2) si las secciones ya vinieron en los archivos, no hace falta la guia
    const tieneDeArchivo = p.marcadores.some((m) => m.origen === 'archivo')
    if (tieneDeArchivo && !reemplazar) {
      p.analisis = { estado: 'listo', fuente: 'archivo', guiaPistaId: null }
      acceso.guardar()
      this.hooks.cambio(p.id)
      return
    }

    // 3) voz guia -> frases para reconocer
    const guia = p.pistas.find((x) => pareceNombreDeGuia(x.nombre))
    if (!guia) {
      p.analisis = { estado: 'sin-guia', fuente: null, guiaPistaId: null, mensaje: 'No hay una pista de guía (se busca por nombre: "Guía", "Guide", "Cues")' }
      acceso.guardar()
      this.hooks.cambio(p.id)
      return
    }
    const voz = await decodificarMono(path.join(dir, guia.archivo), SR_VOZ)
    const frases = await detectarFrases(voz)
    if (!this.hooks.obtener(proyectoId)) return
    if (frases.length === 0) {
      p.analisis = { estado: 'sin-guia', fuente: null, guiaPistaId: guia.id, mensaje: 'La pista de guía no tiene anuncios hablados' }
      acceso.guardar()
      this.hooks.cambio(p.id)
      return
    }
    const cues = guardarFrases(dir, voz, frases)
    p.analisis = { estado: 'esperando-voz', fuente: null, guiaPistaId: guia.id, cues, reemplazar }
    acceso.guardar()
    if (!this.pendientesVoz.includes(p.id)) this.pendientesVoz.push(p.id)
    this.hooks.cambio(p.id)
    this.hooks.pedidosVoz(this.pedidos())
  }

  /**
   * Tempo de nuevo con el detector actual (sin tocar lo demas). Si la grilla
   * cambio, las secciones que puso la guia (sin editar) pasan al compas mas
   * cercano de la grilla nueva: el anuncio ya se habia ubicado en un compas
   * cerca del "1".
   */
  private async redetectarTempo(proyectoId: string): Promise<void> {
    const antes = this.hooks.obtener(proyectoId)
    if (!antes || !tempoDesactualizado(antes.proyecto)) return
    const firma = (t: TempoProyecto | null | undefined): string => JSON.stringify(t ? [t.bpm, t.compas, t.compasesMs.slice(0, 4), t.version] : null)
    const firmaAntes = firma(antes.proyecto.tempo) + velocidadAplicada(antes.proyecto)
    const nuevo = await detectarTempo(antes.proyecto, projectDir(proyectoId))
    // se borro, o cambio el tempo o la velocidad mientras tanto: queda para la proxima
    const acceso = this.hooks.obtener(proyectoId)
    if (!acceso || firma(acceso.proyecto.tempo) + velocidadAplicada(acceso.proyecto) !== firmaAntes) return
    const p = acceso.proyecto
    const viejo = p.tempo!
    const v = velocidadAplicada(p)
    const escalado = nuevo && v !== 1 ? { ...nuevo, bpm: nuevo.bpm * v, compasesMs: nuevo.compasesMs.map((c) => c / v) } : nuevo
    const mismoBpm = !!escalado && Math.abs(escalado.bpm / viejo.bpm - 1) < 0.03 && escalado.compas === viejo.compas
    if (!escalado || (mismoBpm && viejo.faseDesdeGuia && !escalado.acentoClaro)) {
      // no se pudo, o el "1" ya lo habia puesto la guia: queda el de antes
      p.tempo = { ...viejo, version: VERSION_TEMPO }
    } else {
      p.tempo = escalado
      const grillaDistinta = !mismoBpm || escalado.compasesMs.some((c, i) => i < 8 && Math.abs(c - (viejo.compasesMs[i] ?? -1e9)) > 30)
      if (grillaDistinta && !p.seccionesEditadas && p.marcadores.length && p.marcadores.every((m) => m.origen === 'guia')) {
        p.marcadores = p.marcadores.map((m) => ({ ...m, tiempoMs: m.tiempoMs <= 0 ? m.tiempoMs : compasMasCercano(escalado.compasesMs, m.tiempoMs) }))
        const vistos = new Set<number>()
        p.marcadores = p.marcadores.filter((m) => !vistos.has(m.tiempoMs) && vistos.add(m.tiempoMs))
      }
    }
    acceso.guardar()
    this.hooks.cambio(p.id)
  }

  /** La compu avisa en que va el reconocimiento (o que falta el modelo / hubo un error). */
  estadoVoz(proyectoId: string, estado: 'reconociendo' | 'falta-modelo' | 'error', mensaje?: string): void {
    const acceso = this.hooks.obtener(proyectoId)
    const a = acceso?.proyecto.analisis
    if (!acceso || !a || !a.cues) return
    if (a.estado === estado && a.mensaje === mensaje) return
    a.estado = estado
    a.mensaje = mensaje
    acceso.guardar()
    this.hooks.cambio(proyectoId)
  }

  /**
   * Resultado parcial del reconocimiento (la compu manda lo que lleva): las
   * secciones van apareciendo mientras tanto, con las mismas reglas que al
   * final (no pisa las que el usuario acomodo). El resultado final las rehace
   * todas (y corrige el "1" con la guia si el click no tiene acento).
   */
  aplicarParcial(proyectoId: string, textos: { n: number; texto: string }[]): void {
    const acceso = this.hooks.obtener(proyectoId)
    const p = acceso?.proyecto
    const a = p?.analisis
    if (!acceso || !p || !a || !a.cues || (a.estado !== 'esperando-voz' && a.estado !== 'reconociendo')) return
    const v = velocidadAplicada(p)
    const frases = a.cues
      .filter((c) => textos.some((t) => t.n === c.n))
      .map((c) => ({ ...c, inicioMs: c.inicioMs / v, finMs: c.finMs / v, texto: textos.find((t) => t.n === c.n)!.texto }))
    const secciones = seccionesDesdeFrases(frases, p.tempo?.compasesMs ?? null, p.duracionTotalMs)
    const hayManuales = p.seccionesEditadas || p.marcadores.some((m) => m.origen !== 'guia')
    if (secciones.length === 0 || (hayManuales && !a.reemplazar)) return
    const iguales =
      secciones.length === p.marcadores.length && secciones.every((s, i) => s.nombre === p.marcadores[i].nombre && s.tiempoMs === p.marcadores[i].tiempoMs)
    if (iguales) return
    p.marcadores = secciones.map((s): Marcador => ({ id: crypto.randomUUID(), nombre: s.nombre, tiempoMs: s.tiempoMs, origen: 'guia' }))
    p.seccionesEditadas = false
    acceso.guardar()
    this.hooks.cambio(proyectoId)
  }

  /**
   * Resultado del reconocimiento: arma las secciones y las aplica (si la
   * cancion no tenia secciones, o si se pidio "Detectar" explicitamente).
   * Devuelve cuantas secciones se crearon.
   */
  aplicarTextos(proyectoId: string, textos: { n: number; texto: string }[]): number {
    const acceso = this.hooks.obtener(proyectoId)
    const p = acceso?.proyecto
    const a = p?.analisis
    if (!acceso || !p || !a || !a.cues) return 0
    // las frases salen de la guia original: a otra velocidad, pasan al tiempo en que suena la cancion
    const v = velocidadAplicada(p)
    const frases = a.cues.map((c) => ({ ...c, inicioMs: c.inicioMs / v, finMs: c.finMs / v, texto: textos.find((t) => t.n === c.n)?.texto ?? '' }))
    // click sin acento: el "1" de cada compas se deduce de donde terminan los anuncios de la guia
    if (p.tempo && !p.tempo.acentoClaro) {
      const corregidos = faseDesdeAnuncios(p.tempo.compasesMs, p.tempo.compas, anunciosDesdeFrases(frases))
      // (los compases se corrieron: la cuenta que trae la cancion se vuelve a revisar)
      if (corregidos) p.tempo = { ...p.tempo, compasesMs: corregidos, faseDesdeGuia: true, cuentaPropia: undefined }
    }
    const secciones = seccionesDesdeFrases(frases, p.tempo?.compasesMs ?? null, p.duracionTotalMs)
    const hayManuales = p.seccionesEditadas || p.marcadores.some((m) => m.origen !== 'guia')
    let aplicadas = 0
    if (secciones.length > 0 && (!hayManuales || a.reemplazar)) {
      p.marcadores = secciones.map(
        (s): Marcador => ({ id: crypto.randomUUID(), nombre: s.nombre, tiempoMs: s.tiempoMs, origen: 'guia' })
      )
      p.seccionesEditadas = false
      aplicadas = secciones.length
    }
    p.analisis = {
      estado: 'listo',
      fuente: aplicadas ? 'guia' : null,
      guiaPistaId: a.guiaPistaId,
      mensaje:
        secciones.length === 0
          ? 'No se reconocieron anuncios de secciones en la guía'
          : aplicadas === 0
            ? `Se detectaron ${secciones.length} secciones, pero la canción ya tenía secciones marcadas (usá "Detectar" para reemplazarlas)`
            : undefined
    }
    fs.rmSync(path.join(projectDir(p.id), 'analisis'), { recursive: true, force: true })
    this.pendientesVoz = this.pendientesVoz.filter((id) => id !== proyectoId)
    acceso.guardar()
    this.hooks.cambio(
      proyectoId,
      aplicadas ? `Se detectaron ${aplicadas} secciones en “${p.nombre}” por la voz guía` : undefined
    )
    this.hooks.pedidosVoz(this.pedidos())
    return aplicadas
  }

  olvidar(proyectoId: string): void {
    this.cola = this.cola.filter((c) => c.id !== proyectoId)
    this.pendientesVoz = this.pendientesVoz.filter((id) => id !== proyectoId)
  }
}

/** Busca la pista de click (por nombre y, si no, por como suena) y calcula el tempo. */
export async function detectarTempo(p: Proyecto, dir: string): Promise<TempoProyecto | null> {
  let click = p.pistas.find((x) => pareceNombreDeClick(x.nombre)) ?? null
  if (!click) {
    // ninguna se llama "click": se analizan los primeros 90 s de cada pista
    let mejor = { puntaje: 0, id: '' }
    for (const pista of p.pistas) {
      if (pareceNombreDeGuia(pista.nombre)) continue
      const muestra = await decodificarMono(path.join(dir, pista.archivo), SR_ANALISIS).then((x) => x.subarray(0, SR_ANALISIS * 90))
      const { golpes, silencio } = await detectarGolpes(muestra)
      const puntaje = puntajeClick(golpes, silencio)
      if (puntaje > mejor.puntaje) mejor = { puntaje, id: pista.id }
    }
    if (mejor.puntaje >= PUNTAJE_MIN_CLICK) click = p.pistas.find((x) => x.id === mejor.id) ?? null
  }
  if (!click) return null
  const x = await decodificarMono(path.join(dir, click.archivo), SR_ANALISIS)
  const { golpes } = await detectarGolpes(x)
  // (las pistas originales: la duracion, a la velocidad original)
  const r = calcularTempo(golpes, p.duracionTotalMs * velocidadAplicada(p), bpmDesdeNombre(p.nombre))
  if (!r) return null
  return { bpm: r.bpm, compas: r.compas, compasesMs: r.compasesMs, clickPistaId: click.id, acentoClaro: r.acentoClaro, version: VERSION_TEMPO }
}
