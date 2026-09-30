import { ceder } from './decodificar'

/**
 * Deteccion de la pista de click, el tempo, el compas y los tiempos fuertes.
 *
 * Un click es la señal mas facil de analizar que existe: golpes cortos y
 * regulares con silencio en el medio. Cada golpe ES un pulso, asi que no hace
 * falta "adivinar" el tempo: se detectan los golpes con precision de
 * milisegundos y el tempo sale de la distancia entre ellos. El tiempo fuerte
 * (el "1" de cada compas) se reconoce porque los clicks lo acentuan: suena
 * mas fuerte y/o mas agudo que los demas.
 */

export const SR_ANALISIS = 22050
const HOP = 64 // ~2.9 ms

export interface Golpe {
  /** segundos */
  t: number
  amplitud: number
  /** cruces por cero por segundo en los primeros ms: sube con el tono del click */
  brillo: number
}

export interface ResultadoTempo {
  bpm: number
  compas: number
  /** inicio (ms) de cada compas: donde caen las secciones */
  compasesMs: number[]
  /** cantidad de golpes reales de click detectados */
  golpes: number
  /** si el acento de los tiempos fuertes fue claro (si no, se asumio 4/4 desde el primer golpe) */
  acentoClaro: boolean
}

/** Maximo absoluto por bloque de HOP muestras. */
function envolvente(x: Float32Array): Float32Array {
  const n = Math.floor(x.length / HOP)
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let m = 0
    const base = f * HOP
    for (let i = 0; i < HOP; i++) {
      const v = Math.abs(x[base + i])
      if (v > m) m = v
    }
    env[f] = m
  }
  return env
}

function percentil(valores: Float32Array | number[], p: number): number {
  const copia = Float32Array.from(valores).sort()
  if (copia.length === 0) return 0
  return copia[Math.min(copia.length - 1, Math.max(0, Math.floor((p / 100) * (copia.length - 1))))]
}

function mediana(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Detecta golpes (ataques cortos) en una señal mono a SR_ANALISIS. */
export async function detectarGolpes(x: Float32Array, sr = SR_ANALISIS): Promise<{ golpes: Golpe[]; silencio: number }> {
  const env = envolvente(x)
  const pico = percentil(env, 99.9)
  if (pico < 1e-4) return { golpes: [], silencio: 1 }
  const umbral = pico * 0.3
  const separacionMin = Math.round((0.1 * sr) / HOP) // 100 ms entre golpes como minimo
  const golpes: Golpe[] = []
  let ultimo = -Infinity
  let silenciosos = 0
  for (let f = 1; f < env.length; f++) {
    if (env[f] < pico * 0.05) silenciosos++
    if (env[f] >= umbral && env[f - 1] < umbral && f - ultimo >= separacionMin) {
      // posicion precisa: primera muestra del bloque que supera la mitad del umbral
      let i0 = f * HOP
      const fin = i0 + HOP
      while (i0 < fin && Math.abs(x[i0]) < umbral * 0.5) i0++
      // amplitud y "brillo" en los 20 ms siguientes
      const largo = Math.floor(0.02 * sr)
      let amp = 0
      let cruces = 0
      for (let i = i0; i < Math.min(x.length - 1, i0 + largo); i++) {
        const v = Math.abs(x[i])
        if (v > amp) amp = v
        if (x[i] >= 0 !== x[i + 1] >= 0) cruces++
      }
      golpes.push({ t: i0 / sr, amplitud: amp, brillo: cruces / 0.02 })
      ultimo = f
    }
    if (f % 200000 === 0) await ceder()
  }
  return { golpes, silencio: silenciosos / env.length }
}

/**
 * Que tan "click" es una pista: golpes muy regulares con mucho silencio en el
 * medio (una bateria es regular pero no silenciosa; una voz no es regular).
 */
export function puntajeClick(golpes: Golpe[], silencio: number): number {
  if (golpes.length < 16) return 0
  const iois = golpes.slice(1).map((g, i) => g.t - golpes[i].t)
  const med = mediana(iois)
  if (med < 0.2 || med > 2) return 0 // fuera de 30-300 BPM
  const regulares = iois.filter((d) => Math.abs(d - med) / med < 0.06 || Math.abs(d - 2 * med) / med < 0.1).length / iois.length
  return regulares * silencio
}

export const PUNTAJE_MIN_CLICK = 0.45

export { pareceNombreDeClick } from '../../shared/mezcla'

/** Pulso del click (un golpe detectado, o uno que falta en un hueco). */
interface Pulso {
  t: number
  golpe: Golpe | null
}

/**
 * Los golpes, rellenando los huecos (el click se corta en un break) con el
 * periodo de alrededor: asi una parte lenta de una cancion mayormente rapida
 * no se toma como si le faltaran golpes.
 */
function rellenarHuecos(golpes: Golpe[], iois: number[]): Pulso[] {
  const pulsos: Pulso[] = []
  for (let i = 0; i < golpes.length; i++) {
    pulsos.push({ t: golpes[i].t, golpe: golpes[i] })
    const sig = golpes[i + 1]
    if (!sig) continue
    const vecinos: number[] = []
    for (let k = Math.max(0, i - 8); k < Math.min(iois.length, i + 9); k++) if (k !== i && iois[k] < 2.5) vecinos.push(iois[k])
    const local = mediana(vecinos)
    if (!local) continue
    const hueco = sig.t - golpes[i].t
    const faltan = Math.round(hueco / local) - 1
    if (faltan > 0 && faltan < 64) {
      const paso = hueco / (faltan + 1)
      for (let k = 1; k <= faltan; k++) pulsos.push({ t: golpes[i].t + paso * k, golpe: null })
    }
  }
  return pulsos
}

const RASGOS: ((g: Golpe) => number)[] = [(g) => g.amplitud, (g) => g.brillo]

/** Percentil de una lista (0-100). */
function pct(v: number[], p: number): number {
  return percentil(v, p)
}

/**
 * Que tan separados estan los pulsos `fase + k*m` del resto: en esa fase TODOS
 * los golpes son mas fuertes (o agudos) que TODOS los del medio (percentiles
 * 15/85). margen > 0.08 = claramente.
 */
function separacion(pulsos: Pulso[], m: number): { fase: number; margen: number } {
  let mejor = { fase: 0, margen: -Infinity }
  for (const rasgo of RASGOS) {
    for (let fase = 0; fase < m; fase++) {
      const en: number[] = []
      const fuera: number[] = []
      pulsos.forEach((p, i) => {
        if (!p.golpe) return
        ;((i - fase) % m === 0 ? en : fuera).push(rasgo(p.golpe))
      })
      if (en.length < 4 || fuera.length < 4) continue
      const bajo = pct(en, 15)
      const alto = pct(fuera, 85)
      const margen = alto > 0 ? bajo / alto - 1 : 0
      if (margen > mejor.margen) mejor = { fase, margen }
    }
  }
  return mejor
}

const clara = (x: { margen: number }): boolean => x.margen > 0.08

/** La fase mas fuerte en promedio (sin separacion clara: donde caen los acentos). */
function faseFuerte(pulsos: Pulso[], m: number): number {
  let mejor = { fase: 0, media: -Infinity }
  for (let fase = 0; fase < m; fase++) {
    let suma = 0
    let n = 0
    pulsos.forEach((p, i) => {
      if (p.golpe && (i - fase) % m === 0) {
        suma += p.golpe.amplitud
        n++
      }
    })
    if (n && suma / n > mejor.media) mejor = { fase, media: suma / n }
  }
  return mejor.fase
}

/**
 * Cada cuantos pulsos del click cae el tiempo (la negra): 1, o 2/3/4 si el
 * click marca subdivisiones (corcheas, tresillos, semicorcheas) mas suaves
 * que los tiempos. Pista: el BPM del nombre de la cancion ("Coro - 115bpm").
 */
function nivelDelPulso(pulsos: Pulso[], periodo: number, bpmPista: number | null): { m: number; fase: number } {
  const bpmDe = (m: number): number => 60 / (periodo * m)
  if (bpmPista) {
    let mejor = { m: 1, error: Infinity }
    for (const m of [1, 2, 3, 4]) {
      const error = Math.abs(bpmDe(m) / bpmPista - 1)
      if (error < mejor.error) mejor = { m, error }
    }
    if (mejor.error < 0.18) {
      if (mejor.m === 1) return { m: 1, fase: 0 }
      const s = separacion(pulsos, mejor.m)
      return { m: mejor.m, fase: s.margen > 0.02 ? s.fase : faseFuerte(pulsos, mejor.m) }
    }
  }
  // un click de negras va de 40 a ~175 BPM: mas rapido, casi seguro son subdivisiones mas suaves
  if (bpmDe(1) <= 175) return { m: 1, fase: 0 }
  const s2 = separacion(pulsos, 2)
  if (clara(s2) && bpmDe(2) >= 45) {
    // corcheas; si todavia es muy rapido, semicorcheas (los tiempos, mas fuertes que las corcheas)
    if (bpmDe(2) > 175) {
      const s4 = separacion(pulsos, 4)
      if (clara(s4) && bpmDe(4) >= 45) return { m: 4, fase: s4.fase }
    }
    return { m: 2, fase: s2.fase }
  }
  // semicorcheas parejas (las corcheas no se distinguen), o tresillos
  if (bpmDe(1) > 240) {
    const s4 = separacion(pulsos, 4)
    if (clara(s4) && bpmDe(4) >= 45) return { m: 4, fase: s4.fase }
  }
  const s3 = separacion(pulsos, 3)
  if (clara(s3) && bpmDe(3) >= 45 && bpmDe(3) <= 175) return { m: 3, fase: s3.fase }
  // sin subdivisiones que se distingan: una cancion rapida de verdad (hasta ~200), o corcheas parejas
  if (bpmDe(1) <= 200) return { m: 1, fase: 0 }
  const m = bpmDe(2) <= 175 ? 2 : 4
  return { m, fase: faseFuerte(pulsos, m) }
}

/**
 * El "1" de cada compas: los tiempos que el click acentua (mas fuertes o mas
 * agudos que el resto, en dos grupos bien separados). null = no se distingue.
 */
function tiemposFuertes(tiempos: Pulso[]): { esUno: (g: Golpe) => boolean; compas: number } | null {
  const reales = tiempos.filter((p) => p.golpe).map((p) => p.golpe!)
  if (reales.length < 8) return null
  let mejor: { corte: number; rasgo: (g: Golpe) => number; separacion: number; fraccion: number } | null = null
  for (const rasgo of RASGOS) {
    const v = reales.map(rasgo).sort((a, b) => a - b)
    const n = v.length
    const media = v.reduce((a, b) => a + b, 0) / n
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - media) ** 2, 0) / n) || 1
    // dos grupos (Otsu): el corte que mas separa los de arriba de los de abajo
    let suma = 0
    const total = v.reduce((a, b) => a + b, 0)
    for (let k = 1; k < n; k++) {
      suma += v[k - 1]
      const mb = suma / k
      const ma = (total - suma) / (n - k)
      const fraccion = (n - k) / n
      if (fraccion < 0.1 || fraccion > 0.55) continue
      // los de arriba claramente arriba: en desvios y al menos un 12 % mas (no ruido de un click parejo)
      const separacion = (ma - mb) / sd
      if (mb <= 0 || ma / mb < 1.12) continue
      const dentro = Math.max(v[k - 1] - v[0], v[n - 1] - v[k]) || 1e-9
      const hueco = (v[k] - v[k - 1]) / dentro
      if (hueco < 0.35) continue
      if (!mejor || separacion > mejor.separacion) mejor = { corte: (v[k - 1] + v[k]) / 2, rasgo, separacion, fraccion }
    }
  }
  if (!mejor || mejor.separacion < 1.5) return null
  const { corte, rasgo } = mejor
  const esUno = (g: Golpe): boolean => rasgo(g) > corte
  // tiempos por compas: la distancia mas comun entre dos "1"
  const cuentas = new Map<number, number>()
  let ultimo = -1
  tiempos.forEach((p, i) => {
    if (!p.golpe || !esUno(p.golpe)) return
    if (ultimo >= 0) {
      const d = i - ultimo
      if (d >= 2 && d <= 12) cuentas.set(d, (cuentas.get(d) ?? 0) + 1)
    }
    ultimo = i
  })
  let compas = 0
  let veces = 0
  for (const [d, c] of cuentas) if (c > veces || (c === veces && d > compas)) [compas, veces] = [d, c]
  return compas >= 2 ? { esUno, compas } : null
}

/**
 * Tempo, compas y tiempos fuertes a partir de los golpes del click.
 * `duracionMs` extiende la grilla de compases hasta el final de la cancion;
 * `bpmPista` (el BPM del nombre, si lo tiene) ayuda a elegir el pulso cuando
 * el click marca subdivisiones.
 *
 * Con el acento claro, cada "1" acentuado abre un compas: un 2/4 o un 3/4
 * suelto (o un cambio de compas) no corre los que siguen, y los cambios de
 * tempo se siguen solos (son los golpes de verdad).
 */
export function calcularTempo(golpes: Golpe[], duracionMs: number, bpmPista: number | null = null): ResultadoTempo | null {
  if (golpes.length < 8) return null
  const iois = golpes.slice(1).map((g, i) => g.t - golpes[i].t)
  const periodo0 = mediana(iois.filter((d) => d < 2.5))
  if (!periodo0) return null

  const pulsos = rellenarHuecos(golpes, iois)
  // el tiempo (la negra): si el click marca corcheas, uno de cada dos pulsos
  let nivel = nivelDelPulso(pulsos, periodo0, bpmPista)
  const tiemposDe = (n: { m: number; fase: number }): Pulso[] => pulsos.filter((_, i) => i >= n.fase && (i - n.fase) % n.m === 0)
  let tiempos = tiemposDe(nivel)
  let fuertes = tiemposFuertes(tiempos)
  if (!bpmPista && nivel.m === 1 && fuertes && fuertes.compas >= 8 && fuertes.compas % 2 === 0 && 60 / (periodo0 * 2) >= 40) {
    // un "1" cada 8 pulsos que alternan fuerte/suave: corcheas de una cancion lenta (no un 8/4 rapido)
    const s2 = separacion(pulsos, 2)
    if (clara(s2)) {
      nivel = { m: 2, fase: s2.fase }
      tiempos = tiemposDe(nivel)
      fuertes = tiemposFuertes(tiempos)
    }
  }
  if (tiempos.length < 4) return null
  const periodos: number[] = []
  for (let i = 1; i < tiempos.length; i++) if (tiempos[i].golpe && tiempos[i - 1].golpe) periodos.push(tiempos[i].t - tiempos[i - 1].t)
  const periodo = mediana(periodos) || periodo0 * nivel.m

  const compas = fuertes?.compas ?? 4
  const inicios: number[] = []
  if (fuertes) {
    const uno = (i: number): boolean => !!tiempos[i]?.golpe && fuertes.esUno(tiempos[i].golpe!)
    let ultimo = -1
    for (let i = 0; i < tiempos.length; i++) {
      if (ultimo === -1) {
        if (uno(i)) {
          inicios.push(i)
          ultimo = i
        }
        continue
      }
      const d = i - ultimo
      if (uno(i) && d >= 2) {
        inicios.push(i)
        ultimo = i
      } else if (!uno(i) && d >= compas) {
        // sin acento donde tocaba: si enseguida viene uno, el compas es mas largo; si no, sigue la grilla
        const viene = [1, 2].some((k) => uno(i + k) && d + k <= compas + 2)
        if (!viene) {
          inicios.push(i)
          ultimo = i
        }
      }
    }
  } else {
    for (let i = 0; i < tiempos.length; i += compas) inicios.push(i)
  }
  if (inicios.length === 0) return null

  // antes del primer "1" y despues del ultimo golpe, compases del largo de los de al lado
  const compasesSeg = inicios.map((i) => tiempos[i].t)
  const largoAl = (k: number): number => (compasesSeg.length > 1 ? compasesSeg[k + 1] - compasesSeg[k] : periodo * compas)
  const antes: number[] = []
  const primerLargo = compasesSeg.length > 1 ? largoAl(0) : periodo * compas
  for (let t = compasesSeg[0] - primerLargo; t >= -0.001; t -= primerLargo) antes.unshift(Math.max(0, t))
  const ultimoLargo = compasesSeg.length > 1 ? largoAl(compasesSeg.length - 2) : periodo * compas
  let t = compasesSeg[compasesSeg.length - 1] + ultimoLargo
  while (t * 1000 < duracionMs) {
    compasesSeg.push(t)
    t += ultimoLargo
  }

  return {
    bpm: Math.round((60 / periodo) * 10) / 10,
    compas,
    compasesMs: [...antes, ...compasesSeg].map((s) => Math.round(s * 1000)),
    golpes: golpes.length,
    acentoClaro: !!fuertes
  }
}

/**
 * El BPM escrito en el nombre de la cancion ("Coritos-MSM-G-115.00bpm",
 * "Gracia Sublime - 98 BPM - A"): ayuda a elegir el pulso cuando el click
 * marca corcheas. null si no tiene (o no es un tempo creible).
 */
export function bpmDesdeNombre(nombre: string): number | null {
  const m = /(?:^|[^\d.,])(\d{2,3}(?:[.,]\d+)?)\s*bpm/i.exec(nombre)
  if (!m) return null
  const bpm = Number(m[1].replace(',', '.'))
  return bpm >= 40 && bpm <= 240 ? bpm : null
}

/** Compas mas cercano a `ms` (para "ajustar al compas"). */
export function compasMasCercano(compasesMs: number[], ms: number): number {
  let mejor = ms
  let dist = Infinity
  for (const c of compasesMs) {
    const d = Math.abs(c - ms)
    if (d < dist) {
      dist = d
      mejor = c
    }
    if (c > ms && d > dist) break
  }
  return mejor
}

/** Primer compas que empieza en `ms` o despues (tolerancia en ms). */
export function compasSiguiente(compasesMs: number[], ms: number, toleranciaMs = 0): number | null {
  for (const c of compasesMs) if (c >= ms - toleranciaMs) return c
  return null
}
