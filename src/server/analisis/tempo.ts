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

/** Nombres tipicos de la pista de click. */
export function pareceNombreDeClick(nombre: string): boolean {
  const n = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return /(^|[^a-z])(click|clic|clik|clk|metronomo|metronome|metro)([^a-z]|$)/.test(n)
}

/**
 * Tempo, compas y tiempos fuertes a partir de los golpes del click.
 * `duracionMs` extiende la grilla de compases hasta el final de la cancion.
 */
export function calcularTempo(golpes: Golpe[], duracionMs: number): ResultadoTempo | null {
  if (golpes.length < 8) return null
  const iois = golpes.slice(1).map((g, i) => g.t - golpes[i].t)
  const periodo = mediana(iois.filter((d) => d < 2.5))
  if (!periodo) return null

  // pulsos: los golpes, rellenando huecos (el click se corta en un break) con el mismo periodo
  const pulsos: { t: number; golpe: Golpe | null }[] = []
  for (let i = 0; i < golpes.length; i++) {
    pulsos.push({ t: golpes[i].t, golpe: golpes[i] })
    const sig = golpes[i + 1]
    if (sig) {
      const faltan = Math.round((sig.t - golpes[i].t) / periodo) - 1
      if (faltan > 0 && faltan < 64) {
        const paso = (sig.t - golpes[i].t) / (faltan + 1)
        for (let k = 1; k <= faltan; k++) pulsos.push({ t: golpes[i].t + paso * k, golpe: null })
      }
    }
  }

  // compas y fase: el acento (amplitud y/o brillo) que mejor separa un pulso de cada N
  let mejor = { compas: 4, fase: 0, contraste: 0 }
  const reales = pulsos.map((p, i) => ({ ...p, i })).filter((p) => p.golpe)
  const zscore = (vals: number[]): number[] => {
    const m = vals.reduce((a, b) => a + b, 0) / vals.length
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1
    return vals.map((v) => (v - m) / sd)
  }
  const zAmp = zscore(reales.map((p) => p.golpe!.amplitud))
  const zBri = zscore(reales.map((p) => p.golpe!.brillo))
  for (const compas of [4, 3, 6, 2]) {
    for (let fase = 0; fase < compas; fase++) {
      for (const z of [zAmp, zBri]) {
        let sumaA = 0
        let nA = 0
        let sumaB = 0
        let nB = 0
        reales.forEach((p, k) => {
          if ((p.i - fase) % compas === 0) {
            sumaA += z[k]
            nA++
          } else {
            sumaB += z[k]
            nB++
          }
        })
        if (nA < 3 || nB < 3) continue
        // contraste en desvios: el acento tiene que ser claro y parejo
        const contraste = sumaA / nA - sumaB / nB
        // a igual contraste gana el compas mas largo (4/4 antes que 2/4)
        if (contraste > mejor.contraste + 0.05) mejor = { compas, fase, contraste }
      }
    }
  }
  const acentoClaro = mejor.contraste > 1.2
  if (!acentoClaro) mejor = { compas: 4, fase: 0, contraste: 0 }

  // compases: cada `compas` pulsos desde la fase, extendidos hasta el final a tempo constante
  const periodoCompas = periodo * mejor.compas
  const compasesSeg: number[] = []
  for (let i = mejor.fase; i < pulsos.length; i += mejor.compas) compasesSeg.push(pulsos[i].t)
  const primero = compasesSeg[0]
  const antes: number[] = []
  for (let t = primero - periodoCompas; t >= -0.001; t -= periodoCompas) antes.unshift(Math.max(0, t))
  let t = compasesSeg[compasesSeg.length - 1] + periodoCompas
  while (t * 1000 < duracionMs) {
    compasesSeg.push(t)
    t += periodoCompas
  }

  return {
    bpm: Math.round((60 / periodo) * 10) / 10,
    compas: mejor.compas,
    compasesMs: [...antes, ...compasesSeg].map((s) => Math.round(s * 1000)),
    golpes: golpes.length,
    acentoClaro
  }
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
