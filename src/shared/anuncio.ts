/**
 * Voz que avisa a que seccion se salta: con un salto elegido, en el ultimo
 * compas antes del salto suena el nombre de la seccion ("Coro") en el "1" y
 * los ultimos pulsos contados ("3, 4"), con las voces del pack que se importo
 * en la compu. Mientras tanto la voz guia de la cancion no se escucha (diria
 * la seccion que venia, no la elegida).
 *
 * Aca esta lo que no depende del audio: de que archivo sale cada nombre y en
 * que momento de la cancion va cada voz.
 */

/** "Coro 2 (x2)", "PRE-CORO", "Estribillo" -> "coro 2", "pre coro", "estribillo" */
export function normalizarNombreVoz(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bx\s*\d+\b/g, ' ')
    .replace(/[-_.,:;·/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Las claves con las que se encuentra un archivo del pack:
 * "Spanish - Coro 2 (Chorus 2).wav" -> ["coro 2", "chorus 2"];
 * "Spanish - 3.wav" -> ["3"]; "Puente.wav" -> ["puente"].
 */
export function clavesDeArchivoDeVoz(nombreArchivo: string): string[] {
  const base = nombreArchivo
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    // el idioma adelante: "Spanish - ", "English Guide - ", "Español - "
    .replace(/^[^-()]*?\b(spanish|english|french|portugu?e?se|espa[nñ]ol|ingl[eé]s|guide|guia|guía)\b[^-()]*-\s*/i, '')
  const claves: string[] = []
  const fuera = normalizarNombreVoz(base)
  if (fuera) claves.push(fuera)
  for (const m of base.matchAll(/\(([^)]*)\)/g)) {
    const dentro = normalizarNombreVoz(m[1])
    if (dentro && !claves.includes(dentro)) claves.push(dentro)
  }
  return claves
}

/** Otros nombres de la misma seccion (el pack trae "Coro", la cancion dice "Estribillo"). */
const SINONIMOS: [RegExp, string][] = [
  [/^pre ?coro\b/, 'pre coro'],
  [/^pre ?estribillo\b/, 'pre coro'],
  [/^pre ?chorus\b/, 'pre chorus'],
  [/^post ?coro\b/, 'post coro'],
  [/^post ?chorus\b/, 'post chorus'],
  [/^estribillo\b/, 'coro'],
  [/^estrofa\b/, 'verso'],
  [/^introduccion\b/, 'intro'],
  [/^fin\b/, 'final'],
  [/^cierre\b/, 'final'],
  [/^inter\b/, 'interludio'],
  [/^tag\b/, 'repetir'],
  [/^ending\b/, 'final']
]

/** Claves a buscar para una seccion, de la mas exacta a la mas general ("coro 5" -> "coro"). */
export function candidatosDeSeccion(nombre: string): string[] {
  const base = normalizarNombreVoz(nombre)
  if (!base) return []
  const lista = [base]
  for (const [re, reemplazo] of SINONIMOS) if (re.test(base)) lista.push(base.replace(re, reemplazo))
  for (const c of [...lista]) {
    const sinNumero = c.replace(/\s*\d+$/, '')
    if (sinNumero && sinNumero !== c) lista.push(sinNumero)
  }
  return [...new Set(lista)]
}

export interface ParteAnuncio {
  /** clave de la voz ("coro 2", "3") */
  clave: string
  /** posicion de la cancion (ms) donde empieza a hablar */
  enMs: number
}

export interface PlanAnuncio {
  /** mientras dura (posicion de la cancion) la guia de la cancion no se escucha */
  desdeMs: number
  hastaMs: number
  partes: ParteAnuncio[]
}

export interface PedidoAnuncio {
  /** nombre de la seccion a la que se salta */
  nombre: string
  /** donde se salta (posicion de la cancion, en el "1" de un compas si hay tempo) */
  limiteMs: number
  /** lo mas temprano que puede empezar a sonar (los celulares tienen que alcanzar a bajarlo) */
  minInicioMs: number
  /** inicio de cada compas (del tempo detectado); null = sin tempo */
  compasesMs: number[] | null
  /** pulsos por compas */
  pulsos: number
  /** cuanto dura lo hablado de cada voz del pack (ms); null = no esta */
  duracion: (clave: string) => number | null
}

/** Separacion minima entre dos voces seguidas (ms). */
const RESPIRO_MS = 40
/** Sin tempo: el nombre termina un poco antes del salto. */
const ANTES_DEL_SALTO_MS = 150

/**
 * Donde va cada voz. Con tempo: el nombre en el "1" del ultimo compas antes
 * del salto y los dos ultimos pulsos contados ("3, 4" en 4/4), lo que entre
 * sin pisarse. Si el salto esta tan cerca que el "1" ya paso, el nombre va en
 * el primer pulso que llega a tiempo. Sin nombre en el pack, solo la cuenta.
 * null = no entra nada (o no hay voces).
 */
export function planearAnuncio(p: PedidoAnuncio): PlanAnuncio | null {
  let claveNombre: string | null = null
  let durNombre = 0
  for (const c of candidatosDeSeccion(p.nombre)) {
    const d = p.duracion(c)
    if (d !== null) {
      claveNombre = c
      durNombre = d
      break
    }
  }

  const compases = p.compasesMs
  let inicioCompas: number | undefined
  if (compases && compases.length > 1) {
    for (const c of compases) if (c < p.limiteMs - 1) inicioCompas = c
  }

  if (inicioCompas === undefined) {
    // sin tempo: solo el nombre, terminando justo antes del salto
    if (!claveNombre) return null
    const enMs = p.limiteMs - ANTES_DEL_SALTO_MS - durNombre
    if (enMs < p.minInicioMs) return null
    return { desdeMs: enMs, hastaMs: p.limiteMs, partes: [{ clave: claveNombre, enMs }] }
  }

  const pulsos = Math.max(1, Math.round(p.pulsos) || 4)
  const pulsoMs = (p.limiteMs - inicioCompas) / pulsos
  const pulso = (k: number): number => inicioCompas! + k * pulsoMs
  const partes: ParteAnuncio[] = []
  let libreDesde = p.minInicioMs
  if (claveNombre) {
    for (let k = 0; k < pulsos; k++) {
      const t = pulso(k)
      if (t >= p.minInicioMs && t + durNombre <= p.limiteMs - RESPIRO_MS) {
        partes.push({ clave: claveNombre, enMs: t })
        libreDesde = t + durNombre + RESPIRO_MS
        break
      }
    }
  }
  // la cuenta: los dos ultimos pulsos ("3, 4"; en 3/4 "2, 3"; en 6/8 "5, 6")
  for (let k = Math.max(1, pulsos - 2); k < pulsos; k++) {
    const t = pulso(k)
    const clave = String(k + 1)
    const d = p.duracion(clave)
    if (d === null || t < libreDesde || t + d > p.limiteMs - 10) continue
    partes.push({ clave, enMs: t })
    libreDesde = t + d + RESPIRO_MS
  }
  if (partes.length === 0) return null
  // la guia se calla todo el compas (si ya empezo, desde la primera voz)
  const desdeMs = inicioCompas >= p.minInicioMs ? inicioCompas : partes[0].enMs
  return { desdeMs, hastaMs: p.limiteMs, partes }
}
