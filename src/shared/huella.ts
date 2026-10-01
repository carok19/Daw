/**
 * Huella del audio y alineacion de un video con su cancion (AirTracks Video).
 *
 * El video con la letra y la multitrack son la misma grabacion: lo que cambia
 * es donde empieza cada uno (el video puede tener una placa con el titulo, la
 * multitrack un silencio o una cuenta). Para encontrar ese corrimiento sin
 * mandar audio por la red, cada lado resume su audio en una "huella": cada
 * 10 ms, cuanto sube la energia en 12 bandas (los ataques de la bateria, las
 * silabas, los acordes). Dos huellas de la misma grabacion se parecen aunque
 * a la multitrack le falte la voz o este mas fuerte; se comparan corriendo una
 * sobre la otra (correlacion, con FFT) y el corrimiento donde mas coinciden es
 * el bueno.
 *
 * La huella de la cancion la calcula la compu principal (de sus pistas, sin
 * el click ni la guia) cuando no suena nada; la del video, la compu del data.
 */

/** Frecuencia de muestreo del audio para la huella. */
export const SR_HUELLA = 8000
/** Un cuadro de la huella: 10 ms. */
export const HOP_HUELLA = 80
export const MS_POR_CUADRO = (HOP_HUELLA / SR_HUELLA) * 1000
/** Centro de cada banda (Hz): 12 bandas de 80 Hz a 3,4 kHz (cada una, un poco mas de media octava). */
const CENTROS = Array.from({ length: 12 }, (_, i) => Math.round(80 * (3400 / 80) ** (i / 11)))
export const BANDAS_HUELLA = CENTROS.length

/** Filtro pasabanda (biquad RBJ, Q ~ 1) aplicado a toda la señal. */
function pasabanda(x: Float32Array, f0: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * f0) / sr
  const alfa = Math.sin(w0) / (2 * 2.5)
  const a0 = 1 + alfa
  const b0 = alfa / a0
  const b2 = -alfa / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - alfa) / a0
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

/** Una banda de la huella (ver calcularHuella), escrita en `h`. */
function bandaDeHuella(x: Float32Array, b: number, h: Float32Array): void {
  const cuadros = Math.floor(x.length / HOP_HUELLA)
  const y = pasabanda(x, CENTROS[b], SR_HUELLA)
  // energia en ventanas de 30 ms cada 10 ms (se solapan: un ataque que cae entre dos
  // cuadros no se parte en dos, y dos audios corridos medio cuadro se siguen pareciendo)
  const cuadro = new Float64Array(cuadros)
  for (let c = 0; c < cuadros; c++) {
    let s = 0
    for (let i = c * HOP_HUELLA; i < (c + 1) * HOP_HUELLA; i++) s += y[i] * y[i]
    cuadro[c] = s
  }
  const energia = new Float64Array(cuadros)
  let total = 0
  for (let c = 0; c < cuadros; c++) {
    energia[c] = ((c > 0 ? cuadro[c - 1] : cuadro[c]) + cuadro[c] + (c + 1 < cuadros ? cuadro[c + 1] : cuadro[c])) / (3 * HOP_HUELLA)
    total += energia[c]
  }
  // piso: el silencio (o el ruido de fondo) no cuenta como ataques
  const piso = (total / Math.max(1, cuadros)) * 1e-3 + 1e-12
  const subida = new Float64Array(cuadros)
  let anterior = Math.log(energia[0] + piso)
  for (let c = 0; c < cuadros; c++) {
    const actual = Math.log(energia[c] + piso)
    subida[c] = Math.max(0, actual - anterior)
    anterior = actual
  }
  for (let c = 0; c < cuadros; c++) {
    h[c * BANDAS_HUELLA + b] = 0.25 * (subida[c - 1] ?? 0) + 0.5 * subida[c] + 0.25 * (subida[c + 1] ?? 0)
  }
}

/**
 * Huella de una señal mono a SR_HUELLA: por cuadro de 10 ms y por banda,
 * cuanto subio la energia (en escala logaritmica) respecto del cuadro
 * anterior, suavizado. Intercalada: [c0b0, c0b1, ..., c0b11, c1b0, ...].
 */
export function calcularHuella(x: Float32Array): Float32Array {
  const h = new Float32Array(Math.floor(x.length / HOP_HUELLA) * BANDAS_HUELLA)
  for (let b = 0; b < BANDAS_HUELLA; b++) bandaDeHuella(x, b, h)
  return h
}

/** La misma huella, de a una banda, cediendo entre una y otra (el servidor no se traba). */
export async function calcularHuellaDeAPoco(x: Float32Array, ceder: () => Promise<void>): Promise<Float32Array> {
  const h = new Float32Array(Math.floor(x.length / HOP_HUELLA) * BANDAS_HUELLA)
  for (let b = 0; b < BANDAS_HUELLA; b++) {
    bandaDeHuella(x, b, h)
    await ceder()
  }
  return h
}

/** FFT compleja en el lugar (radix 2; `re.length` potencia de 2). `inversa` sin dividir por n. */
function fft(re: Float64Array, im: Float64Array, inversa = false): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let largo = 2; largo <= n; largo <<= 1) {
    const ang = ((inversa ? 2 : -2) * Math.PI) / largo
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += largo) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < largo / 2; k++) {
        const a = i + k
        const b = a + largo / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** Una banda de la huella, centrada y con desvio 1 (asi pesan igual todas). */
function banda(h: Float32Array, b: number): Float64Array {
  const n = Math.floor(h.length / BANDAS_HUELLA)
  const v = new Float64Array(n)
  let media = 0
  for (let c = 0; c < n; c++) media += v[c] = h[c * BANDAS_HUELLA + b]
  media /= n || 1
  let varianza = 0
  for (let c = 0; c < n; c++) varianza += (v[c] -= media) ** 2
  const sd = Math.sqrt(varianza / (n || 1)) || 1
  for (let c = 0; c < n; c++) v[c] /= sd
  return v
}

export interface Alineacion {
  /** tiempo del video = tiempo de la cancion (a velocidad original) + desfaseMs */
  desfaseMs: number
  /** que tan claro sobresale el mejor corrimiento (desvios sobre el resto) */
  confianza: number
  /**
   * cuanto mas alto es el mejor corrimiento que el segundo (lejos del primero):
   * en una cancion con un ritmo parejo, correrla un compas tambien "coincide"
   * bastante; la misma grabacion coincide en todo y se despega
   */
  ventaja: number
  /** fraccion de la cancion (tramos de 15 s con sonido) que coincide con el video en ese corrimiento (0-1) */
  coincide: number
}

/**
 * Para tomar la alineacion automatica como buena (si no, se ajusta a mano):
 * el corrimiento sobresale claro y coincide en casi toda la cancion. Otra
 * grabacion (en vivo, otro tempo) o un video editado no pasan.
 */
export function alineacionSegura(a: Alineacion | null): boolean {
  return !!a && a.confianza >= CONFIANZA_MINIMA && a.coincide >= 0.6
}
export const CONFIANZA_MINIMA = 9

/**
 * Busca donde cae la cancion dentro del video. `maxDesfaseMs`: cuanto se
 * puede correr como mucho (para cada lado). null = huellas vacias.
 */
export function alinear(cancion: Float32Array, video: Float32Array, maxDesfaseMs = 180000): Alineacion | null {
  const na = Math.floor(cancion.length / BANDAS_HUELLA)
  const nv = Math.floor(video.length / BANDAS_HUELLA)
  if (na < 100 || nv < 100) return null
  let n = 1
  while (n < na + nv) n <<= 1
  const suma = new Float64Array(n)
  for (let b = 0; b < BANDAS_HUELLA; b++) {
    const ar = new Float64Array(n)
    const ai = new Float64Array(n)
    const vr = new Float64Array(n)
    const vi = new Float64Array(n)
    ar.set(banda(cancion, b))
    vr.set(banda(video, b))
    fft(ar, ai)
    fft(vr, vi)
    // correlacion: conj(A) * V -> en el indice L, cuanto coincide la cancion corrida L cuadros en el video
    for (let k = 0; k < n; k++) {
      const r = ar[k] * vr[k] + ai[k] * vi[k]
      const i = ar[k] * vi[k] - ai[k] * vr[k]
      ar[k] = r
      ai[k] = i
    }
    fft(ar, ai, true)
    for (let k = 0; k < n; k++) suma[k] += ar[k] / n
  }
  const maxL = Math.min(Math.round(maxDesfaseMs / MS_POR_CUADRO), n / 2 - 1)
  const valor = (L: number): number => suma[L >= 0 ? L : n + L]
  let mejor = 0
  let mejorV = -Infinity
  let s = 0
  let s2 = 0
  let cuenta = 0
  for (let L = -Math.min(maxL, na - 1); L <= Math.min(maxL, nv - 1); L++) {
    const v = valor(L)
    s += v
    s2 += v * v
    cuenta++
    if (v > mejorV) {
      mejorV = v
      mejor = L
    }
  }
  const media = s / cuenta
  const sd = Math.sqrt(Math.max(1e-12, s2 / cuenta - media * media))
  // el segundo mejor, a mas de 60 ms del primero
  let segundo = -Infinity
  for (let L = -Math.min(maxL, na - 1); L <= Math.min(maxL, nv - 1); L++) if (Math.abs(L - mejor) > 6) segundo = Math.max(segundo, valor(L))
  // entre cuadros: el vertice de la parabola que pasa por el pico y sus vecinos
  const y0 = valor(mejor - 1)
  const y2 = valor(mejor + 1)
  const den = y0 - 2 * mejorV + y2
  const fino = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0
  return {
    desfaseMs: Math.round((mejor + fino) * MS_POR_CUADRO),
    confianza: Math.round(((mejorV - media) / sd) * 10) / 10,
    ventaja: Math.round(((mejorV - media) / Math.max(1e-9, segundo - media)) * 100) / 100,
    coincide: coincidencia(cancion, video, mejor)
  }
}

/**
 * En que fraccion de la cancion el video coincide en el corrimiento `L`
 * (cuadros): por tramos de 15 s con sonido, el mejor corrimiento local
 * (±1 s) tiene que caer a menos de 40 ms del global.
 */
function coincidencia(cancion: Float32Array, video: Float32Array, L: number): number {
  const na = Math.floor(cancion.length / BANDAS_HUELLA)
  const nv = Math.floor(video.length / BANDAS_HUELLA)
  const tramo = 1500
  const radio = 100
  let conSonido = 0
  let bien = 0
  for (let t0 = 0; t0 + tramo <= na; t0 += tramo) {
    let energia = 0
    for (let c = t0; c < t0 + tramo; c++) for (let b = 0; b < BANDAS_HUELLA; b++) energia += cancion[c * BANDAS_HUELLA + b]
    if (energia < tramo * 0.02) continue // silencio: no dice nada
    conSonido++
    let mejor = -Infinity
    let mejorD = 0
    for (let d = -radio; d <= radio; d++) {
      let v = 0
      for (let c = t0; c < t0 + tramo; c++) {
        const cv = c + L + d
        if (cv < 0 || cv >= nv) continue
        for (let b = 0; b < BANDAS_HUELLA; b++) v += cancion[c * BANDAS_HUELLA + b] * video[cv * BANDAS_HUELLA + b]
      }
      if (v > mejor) {
        mejor = v
        mejorD = d
      }
    }
    if (Math.abs(mejorD) * MS_POR_CUADRO <= 40) bien++
  }
  return conSonido ? Math.round((bien / conSonido) * 100) / 100 : 0
}

/** Escala de la huella en bytes (cada valor, en pasos de 1/40). */
const ESCALA_BYTES = 40

/** Huella <-> bytes, un byte por valor (para mandarla por la red o guardarla: ~1 KB por segundo). */
export function huellaABytes(h: Float32Array): Uint8Array {
  const b = new Uint8Array(h.length)
  for (let i = 0; i < h.length; i++) b[i] = Math.max(0, Math.min(255, Math.round(h[i] * ESCALA_BYTES)))
  return b
}

export function huellaDeBytes(b: ArrayBuffer | Uint8Array): Float32Array {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  const h = new Float32Array(u.length - (u.length % BANDAS_HUELLA))
  for (let i = 0; i < h.length; i++) h[i] = u[i] / ESCALA_BYTES
  return h
}
