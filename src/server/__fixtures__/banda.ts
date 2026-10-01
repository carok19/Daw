/**
 * "Banda" sintetica para las pruebas de AirTracks Video: bateria (con algo
 * de variacion, como una de verdad), acordes que cambian cada 2 compases y
 * una "voz" aparte (la del video con la letra, que la multitrack puede no
 * tener). Siempre igual para la misma semilla.
 */
export function generarBanda(seg: number, semilla: number, bpm = 76, sr = 8000): { banda: Float32Array; voz: Float32Array } {
  let s = semilla
  const r = (): number => (s = (s * 16807) % 2147483647) / 2147483647
  const n = Math.round(seg * sr)
  const banda = new Float32Array(n)
  const voz = new Float32Array(n)
  const tiempo = 60 / bpm
  const notas = [0, 5, 7, 3, 8, 10]
  for (let k = 0; k * tiempo < seg; k++) {
    const i0 = Math.round((k * tiempo + (r() - 0.5) * 0.01) * sr)
    const bombo = k % 2 === 0 || r() < 0.15
    for (let i = 0; i < 0.25 * sr && i0 + i < n; i++) {
      if (i0 + i < 0) continue
      const t = i / sr
      banda[i0 + i] += bombo ? 0.6 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.08) : 0.3 * (r() * 2 - 1) * Math.exp(-t / 0.05)
      banda[i0 + i] += 0.08 * (r() * 2 - 1) * Math.exp(-t / 0.01)
    }
  }
  for (let c = 0; c * tiempo * 8 < seg; c++) {
    const raiz = 110 * 2 ** (notas[Math.floor(r() * notas.length)] / 12)
    const i0 = Math.round(c * tiempo * 8 * sr)
    for (let i = 0; i < tiempo * 8 * sr && i0 + i < n; i++) {
      const t = i / sr
      const env = Math.min(1, t / 0.05) * Math.exp(-t / 3)
      banda[i0 + i] += 0.15 * env * (Math.sin(2 * Math.PI * raiz * t) + Math.sin(2 * Math.PI * raiz * 1.5 * t) + 0.5 * Math.sin(2 * Math.PI * raiz * 2.52 * t))
    }
  }
  let t = 2
  while (t < seg - 1) {
    const largo = 0.15 + r() * 0.4
    const f = 220 + r() * 220
    const i0 = Math.round(t * sr)
    for (let i = 0; i < largo * sr && i0 + i < n; i++) {
      const tt = i / sr
      voz[i0 + i] += 0.25 * Math.sin((Math.PI * tt) / largo) * Math.sin(2 * Math.PI * f * tt + 3 * Math.sin(2 * Math.PI * 5 * tt))
    }
    t += largo + (r() < 0.2 ? 1 + r() * 2 : 0.05 + r() * 0.2)
  }
  return { banda, voz }
}
