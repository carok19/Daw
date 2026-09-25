import { compasSiguiente } from './tempo'

/**
 * Interpretacion de nombres de seccion: lo que dice la voz guia ("Verso
 * uno", "¡Coro!", "vamos al puente") o el nombre de un marcador de un
 * archivo ("Chorus 2", "PRE-CHORUS"). Tolera los errores tipicos del
 * reconocimiento de voz (berso, koro) y entiende español e ingles.
 */

export type TipoSeccion =
  | 'Intro'
  | 'Verso'
  | 'Pre-coro'
  | 'Coro'
  | 'Post-coro'
  | 'Puente'
  | 'Instrumental'
  | 'Interludio'
  | 'Solo'
  | 'Final'
  | 'Tag'
  | 'Vamp'
  | 'Coda'

export interface SeccionInterpretada {
  tipo: TipoSeccion
  numero: number | null
}

function normalizar(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function distancia(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** palabra -> tipo. Las de 5+ letras aceptan un error (berso, koro no: es corta, va explicita). */
const PALABRAS: [string[], TipoSeccion][] = [
  [['intro', 'introduccion', 'entrada'], 'Intro'],
  [['verso', 'versos', 'berso', 'estrofa', 'verse', 'versa'], 'Verso'],
  [['precoro', 'prechorus', 'precorro'], 'Pre-coro'],
  [['postcoro', 'postchorus'], 'Post-coro'],
  [['coro', 'coros', 'koro', 'corro', 'chorus', 'estribillo', 'refran'], 'Coro'],
  [['puente', 'bridge', 'fuente'], 'Puente'],
  [['instrumental', 'instrumentales', 'turnaround', 'turn'], 'Instrumental'],
  [['interludio', 'interlude'], 'Interludio'],
  [['solo'], 'Solo'],
  [['final', 'finale', 'outro', 'ending', 'cierre', 'fin'], 'Final'],
  [['tag'], 'Tag'],
  [['vamp'], 'Vamp'],
  [['coda'], 'Coda']
]

const NUMEROS: Record<string, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  uno: 1,
  una: 1,
  un: 1,
  primer: 1,
  primero: 1,
  primera: 1,
  one: 1,
  first: 1,
  dos: 2,
  segundo: 2,
  segunda: 2,
  two: 2,
  second: 2,
  tres: 3,
  tercer: 3,
  tercero: 3,
  tercera: 3,
  three: 3,
  third: 3,
  cuatro: 4,
  cuarto: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6
}

function tipoDePalabra(palabra: string): TipoSeccion | null {
  for (const [variantes, tipo] of PALABRAS) {
    for (const v of variantes) {
      if (palabra === v) return tipo
      // tolerancia a un error solo en palabras largas (y nunca para "solo"/"fin"/"tag": muy cortas)
      if (v.length >= 5 && palabra.length >= 4 && Math.abs(palabra.length - v.length) <= 1 && distancia(palabra, v) <= 1) return tipo
    }
  }
  return null
}

/** "Verso uno" -> {Verso, 1}; "pre coro" -> {Pre-coro}; "uno, dos, tres" -> null (conteo). */
export function interpretarSeccion(texto: string): SeccionInterpretada | null {
  const palabras = normalizar(texto)
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i]
    // "pre coro" / "post coro" / "pre chorus" en dos palabras
    if ((p === 'pre' || p === 'post') && i + 1 < palabras.length) {
      const sig = tipoDePalabra(palabras[i + 1])
      if (sig === 'Coro') return { tipo: p === 'pre' ? 'Pre-coro' : 'Post-coro', numero: numeroTras(palabras, i + 2) }
    }
    const tipo = tipoDePalabra(p)
    if (!tipo) continue
    // "solo" suelta suele ser una indicacion ("solo voces"), no una seccion
    if (tipo === 'Solo' && palabras.length > i + 1 && ['voces', 'voz', 'bateria', 'piano', 'teclado'].includes(palabras[i + 1])) continue
    return { tipo, numero: numeroTras(palabras, i + 1) }
  }
  return null
}

function numeroTras(palabras: string[], i: number): number | null {
  const p = palabras[i]
  return p !== undefined && NUMEROS[p] !== undefined ? NUMEROS[p] : null
}

export interface SeccionDetectada {
  nombre: string
  tiempoMs: number
}

/**
 * Convierte frases de la guia (con su momento) en secciones con nombre y
 * lugar: cada seccion empieza en el primer compas despues de que la voz
 * termina de anunciarla (la guia avisa justo antes de que empiece). Numera
 * versos ("Verso 1", "Verso 2") y repeticiones ("Coro", "Coro 2").
 */
export function seccionesDesdeFrases(
  frases: { inicioMs: number; finMs: number; texto: string }[],
  compasesMs: number[] | null,
  duracionMs: number
): SeccionDetectada[] {
  const cuenta = new Map<TipoSeccion, number>()
  const resultado: SeccionDetectada[] = []
  for (const f of [...frases].sort((a, b) => a.inicioMs - b.inicioMs)) {
    const s = interpretarSeccion(f.texto)
    if (!s) continue
    let tiempo = f.finMs
    if (compasesMs && compasesMs.length) {
      const c = compasSiguiente(compasesMs, f.finMs, 120)
      // si el proximo compas queda lejos (click cortado), se usa el final de la frase
      if (c !== null && c - f.finMs < 4000) tiempo = c
    }
    tiempo = Math.max(0, Math.min(duracionMs - 1, Math.round(tiempo)))
    const n = (cuenta.get(s.tipo) ?? 0) + 1
    cuenta.set(s.tipo, n)
    let nombre: string = s.tipo
    if (s.tipo === 'Verso') nombre = `Verso ${s.numero ?? n}`
    else if (s.numero) nombre = `${s.tipo} ${s.numero}`
    else if (n > 1 && s.tipo !== 'Final') nombre = `${s.tipo} ${n}`
    // dos anuncios que caen en el mismo compas: vale el ultimo
    const previa = resultado[resultado.length - 1]
    if (previa && Math.abs(previa.tiempoMs - tiempo) < 300) resultado.pop()
    resultado.push({ nombre, tiempoMs: tiempo })
  }
  return resultado
}

/** Traduce un nombre de marcador de archivo si es una seccion conocida ("Chorus 2" -> "Coro 2"); si no, lo deja igual. */
export function nombreDeMarcadorArchivo(nombre: string): string {
  const s = interpretarSeccion(nombre)
  const limpio = nombre.replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!s) return limpio || 'Sección'
  return s.numero ? `${s.tipo} ${s.numero}` : s.tipo
}
