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

/** Palabras de una cuenta ("uno, dos, tres, cuatro", "three, four", "1 2 3 4"). */
const CUENTA = new Set([
  ...['1', '2', '3', '4', '5', '6', '7', '8'],
  ...['uno', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'],
  ...['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
  ...['y', 'and', 'a']
])

/** "tres, cuatro" / "1, 2, 3, 4" / "one two three four": una cuenta (sin nombre de seccion). */
export function esCuenta(texto: string): boolean {
  const palabras = normalizar(texto)
  return palabras.length > 0 && palabras.some((p) => p !== 'y' && p !== 'and' && p !== 'a') && palabras.every((p) => CUENTA.has(p))
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

export interface Anuncio {
  seccion: SeccionInterpretada
  inicioMs: number
  /** cuando termina de hablar la guia, contando la cuenta que sigue al nombre ("Coro… tres, cuatro") */
  finMs: number
}

/**
 * Anuncios de seccion de la guia. Si al nombre le sigue una cuenta ("Coro…
 * uno, dos, tres, cuatro"), el anuncio termina con la cuenta: la seccion
 * empieza despues, no en el compas donde se cuenta.
 */
export function anunciosDesdeFrases(frases: { inicioMs: number; finMs: number; texto: string }[]): Anuncio[] {
  const ordenadas = [...frases].sort((a, b) => a.inicioMs - b.inicioMs)
  const anuncios: Anuncio[] = []
  for (let i = 0; i < ordenadas.length; i++) {
    const seccion = interpretarSeccion(ordenadas[i].texto)
    if (!seccion) continue
    let finMs = ordenadas[i].finMs
    for (let j = i + 1; j < ordenadas.length && esCuenta(ordenadas[j].texto) && ordenadas[j].inicioMs - finMs < 3500; j++) {
      finMs = ordenadas[j].finMs
    }
    anuncios.push({ seccion, inicioMs: ordenadas[i].inicioMs, finMs })
  }
  return anuncios
}

/**
 * Con un click sin acento no se sabe cual golpe es el "1": se conto desde el
 * primero. La guia lo dice: termina de anunciar justo antes del "1" de la
 * seccion. Se mira en que pulso del compas cae el golpe siguiente a cada
 * anuncio y, si la mayoria coincide en otro pulso, se corren los compases.
 * Devuelve los compases corregidos, o null si no hace falta (o no esta claro).
 */
export function faseDesdeAnuncios(compasesMs: number[], pulsosPorCompas: number, anuncios: Anuncio[]): number[] | null {
  if (compasesMs.length < 2 || anuncios.length < 2 || pulsosPorCompas < 2) return null
  const votos = new Array<number>(pulsosPorCompas).fill(0)
  for (const a of anuncios) {
    const i = compasesMs.findIndex((c, k) => c <= a.finMs && (compasesMs[k + 1] ?? Infinity) > a.finMs)
    if (i < 0 || i + 1 >= compasesMs.length) continue
    const pulso = (compasesMs[i + 1] - compasesMs[i]) / pulsosPorCompas
    const siguiente = Math.ceil((a.finMs - compasesMs[i] - 120) / pulso)
    votos[((siguiente % pulsosPorCompas) + pulsosPorCompas) % pulsosPorCompas]++
  }
  const total = votos.reduce((a, b) => a + b, 0)
  const fase = votos.indexOf(Math.max(...votos))
  if (fase === 0 || total < 2 || votos[fase] < total * 0.6) return null
  // cada compas se corre `fase` pulsos (con el largo de ese compas: sigue al click real)
  const corridos = compasesMs.slice(0, -1).map((c, k) => Math.round(c + ((compasesMs[k + 1] - c) / pulsosPorCompas) * fase))
  const ultimo = compasesMs[compasesMs.length - 1]
  const largo = ultimo - compasesMs[compasesMs.length - 2]
  corridos.push(Math.round(ultimo + (largo / pulsosPorCompas) * fase))
  const primero = corridos[0] - (compasesMs[1] - compasesMs[0])
  return primero >= 0 ? [primero, ...corridos] : corridos
}

/**
 * Convierte frases de la guia (con su momento) en secciones con nombre y
 * lugar: cada seccion empieza en el primer compas despues de que la voz
 * termina de anunciarla, cuenta incluida (la guia avisa justo antes de que
 * empiece). Numera versos ("Verso 1", "Verso 2") y repeticiones ("Coro", "Coro 2").
 */
export function seccionesDesdeFrases(
  frases: { inicioMs: number; finMs: number; texto: string }[],
  compasesMs: number[] | null,
  duracionMs: number
): SeccionDetectada[] {
  const cuenta = new Map<TipoSeccion, number>()
  const resultado: SeccionDetectada[] = []
  for (const { seccion: s, finMs } of anunciosDesdeFrases(frases)) {
    let tiempo = finMs
    if (compasesMs && compasesMs.length) {
      const c = compasSiguiente(compasesMs, finMs, 120)
      // si el proximo compas queda lejos (click cortado), se usa el final del anuncio
      if (c !== null && c - finMs < 4000) tiempo = c
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
