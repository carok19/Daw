import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodificarMono } from './decodificar'
import { bpmDesdeNombre, calcularTempo, detectarGolpes, puntajeClick, PUNTAJE_MIN_CLICK, SR_ANALISIS, pareceNombreDeClick } from './tempo'
import { detectarFrases, pareceNombreDeGuia, SR_VOZ } from './guia'
import { anunciosDesdeFrases, esCuenta, faseDesdeAnuncios, interpretarSeccion, seccionesDesdeFrases, nombreDeMarcadorArchivo } from './secciones'
import { marcadoresDeMidi, marcadoresDeTexto, marcadoresDeWav } from './archivos'

import { armarGuia, generarClick, SR, wav16 } from '../__fixtures__/sintetico'

/** "Bateria": bombo con cola larga + hi-hat en corcheas (regular, pero sin silencios). */
function generarBateria(bpm: number, segundos: number): Float32Array {
  const x = new Float32Array(Math.round(segundos * SR))
  const periodo = 60 / bpm
  let semilla = 1
  const ruido = (): number => ((semilla = (semilla * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let k = 0; k * periodo < segundos; k++) {
    const i0 = Math.round((0.5 + k * periodo) * SR)
    for (let i = 0; i < 0.35 * SR && i0 + i < x.length; i++) x[i0 + i] += 0.7 * Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / (0.12 * SR))
    for (const sub of [0, 0.5]) {
      const j0 = Math.round((0.5 + (k + sub) * periodo) * SR)
      for (let i = 0; i < 0.12 * SR && j0 + i < x.length; i++) x[j0 + i] += 0.25 * ruido() * Math.exp(-i / (0.04 * SR))
    }
  }
  return x
}

async function porFfmpeg(x: Float32Array, sr: number): Promise<Float32Array> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'analisis-')), 'x.wav')
  fs.writeFileSync(tmp, wav16(x, sr))
  const y = await decodificarMono(tmp, SR_ANALISIS)
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  return y
}

test('tempo: click 4/4 a 90 BPM con acento', async () => {
  const x = await porFfmpeg(generarClick(90, 4, 60), SR)
  const { golpes, silencio } = await detectarGolpes(x)
  assert.ok(puntajeClick(golpes, silencio) >= PUNTAJE_MIN_CLICK, 'debería reconocerse como click')
  const t = calcularTempo(golpes, 60000)!
  assert.equal(t.compas, 4)
  assert.ok(t.acentoClaro)
  assert.ok(Math.abs(t.bpm - 90) < 0.3, `bpm ${t.bpm}`)
  // el primer compas arranca en 0.5 s y cada compas dura 4 * 60/90 = 2.667 s
  const esperado = [500, 3167, 5833, 8500]
  for (let i = 0; i < esperado.length; i++) assert.ok(Math.abs(t.compasesMs[i] - esperado[i]) <= 6, `compás ${i}: ${t.compasesMs[i]}`)
  assert.ok(t.compasesMs[t.compasesMs.length - 1] > 57000, 'la grilla llega hasta el final')
})

test('tempo: 3/4 a 72 BPM, y sin acento se asume 4/4 desde el primer golpe', async () => {
  const x = await porFfmpeg(generarClick(72, 3, 40, true, 1.0), SR)
  const t = calcularTempo((await detectarGolpes(x)).golpes, 40000)!
  assert.equal(t.compas, 3)
  assert.ok(Math.abs(t.bpm - 72) < 0.3)
  assert.ok(Math.abs(t.compasesMs.find((c) => c >= 900)! - 1000) <= 6)

  const sinAcento = await porFfmpeg(generarClick(120, 4, 30, false, 0.25), SR)
  const t2 = calcularTempo((await detectarGolpes(sinAcento)).golpes, 30000)!
  assert.equal(t2.acentoClaro, false)
  assert.equal(t2.compas, 4)
  assert.ok(Math.abs(t2.compasesMs.find((c) => c >= 200)! - 250) <= 6)
})

/**
 * Click compas por compas ([bpm, tiempos] de cada uno, desde 0,5 s), con `sub`
 * golpes por tiempo (2 = corcheas) mas suaves. Devuelve la señal y donde cae cada "1" (ms).
 */
function clickPorCompases(compases: [number, number][], sub = 1): { x: Float32Array; unos: number[] } {
  let t = 0.5
  const golpes: { t: number; a: number; f: number }[] = []
  const unos: number[] = []
  for (const [bpm, tiempos] of compases) {
    unos.push(Math.round(t * 1000))
    for (let k = 0; k < tiempos; k++) {
      for (let s = 0; s < sub; s++) {
        const uno = k === 0 && s === 0
        golpes.push({ t: t + (s * 60) / bpm / sub, a: s > 0 ? 0.3 : uno ? 0.9 : 0.55, f: uno ? 1600 : 1000 })
      }
      t += 60 / bpm
    }
  }
  const x = new Float32Array(Math.ceil((t + 1) * SR_ANALISIS))
  for (const g of golpes) {
    const i0 = Math.round(g.t * SR_ANALISIS)
    for (let i = 0; i < 0.03 * SR_ANALISIS && i0 + i < x.length; i++)
      x[i0 + i] += g.a * Math.sin((2 * Math.PI * g.f * i) / SR_ANALISIS) * Math.exp(-i / (0.006 * SR_ANALISIS))
  }
  return { x, unos }
}

/** Cuantos "1" de verdad no tienen un compas de la grilla a menos de 30 ms, y compases de mas en el medio. */
function errores(compasesMs: number[], unos: number[]): { corridos: number; deMas: number } {
  const corridos = unos.filter((u) => !compasesMs.some((c) => Math.abs(c - u) <= 30)).length
  const deMas = compasesMs.filter((c) => c > unos[0] - 30 && c < unos[unos.length - 1] + 30).length - unos.length
  return { corridos, deMas }
}

test('tempo: click que marca corcheas (o semicorcheas) -> el tempo de la negra, no el doble', async () => {
  const rep = (n: number, bpm: number, tiempos = 4): [number, number][] => Array.from({ length: n }, () => [bpm, tiempos])
  const casos: { nombre: string; compases: [number, number][]; sub: number; pista?: number; bpm: number }[] = [
    { nombre: 'corcheas a 140', compases: rep(24, 140), sub: 2, bpm: 140 },
    { nombre: 'corcheas a 70 (lenta)', compases: rep(16, 70), sub: 2, bpm: 70 },
    { nombre: 'semicorcheas a 100', compases: rep(16, 100), sub: 4, bpm: 100 },
    { nombre: 'corcheas a 125 con el BPM en el nombre', compases: rep(24, 125), sub: 2, pista: 125, bpm: 125 },
    { nombre: 'negras rápidas a 180 (no son corcheas)', compases: rep(24, 180), sub: 1, bpm: 180 }
  ]
  for (const c of casos) {
    const { x, unos } = clickPorCompases(c.compases, c.sub)
    const t = calcularTempo((await detectarGolpes(x)).golpes, (x.length / SR_ANALISIS) * 1000, c.pista ?? null)!
    assert.ok(Math.abs(t.bpm - c.bpm) < 1, `${c.nombre}: bpm ${t.bpm}`)
    assert.equal(t.compas, 4, c.nombre)
    assert.deepEqual(errores(t.compasesMs, unos), { corridos: 0, deMas: 0 }, c.nombre)
  }
})

test('tempo: un 2/4 o 3/4 suelto, y los cambios de tempo, no corren los "1" que siguen', async () => {
  const rep = (n: number, bpm: number, tiempos = 4): [number, number][] => Array.from({ length: n }, () => [bpm, tiempos])
  const casos: { nombre: string; compases: [number, number][]; sub?: number }[] = [
    { nombre: 'un 2/4 en el medio', compases: [...rep(12, 75), [75, 2], ...rep(12, 75)] },
    { nombre: 'un 3/4 y un 2/4', compases: [...rep(8, 120), [120, 3], ...rep(8, 120), [120, 2], ...rep(6, 120)] },
    { nombre: '72 -> 84 BPM', compases: [...rep(12, 72), ...rep(16, 84)] },
    { nombre: 'parte lenta en una canción rápida (136 -> 68 -> 136)', compases: [...rep(10, 136), ...rep(8, 68), ...rep(10, 136)] },
    { nombre: 'corcheas con un 2/4 suelto', compases: [...rep(10, 140), [140, 2], ...rep(10, 140)], sub: 2 }
  ]
  for (const c of casos) {
    const { x, unos } = clickPorCompases(c.compases, c.sub ?? 1)
    const t = calcularTempo((await detectarGolpes(x)).golpes, (x.length / SR_ANALISIS) * 1000)!
    assert.ok(t.acentoClaro, c.nombre)
    assert.deepEqual(errores(t.compasesMs, unos), { corridos: 0, deMas: 0 }, c.nombre)
  }
})

test('BPM desde el nombre de la canción', () => {
  assert.equal(bpmDesdeNombre('Coritos-MSM-G-115.00bpm'), 115)
  assert.equal(bpmDesdeNombre('Fiesta En El Desierto-E-125BPM'), 125)
  assert.equal(bpmDesdeNombre('Gracia Sublime Es - 98 bpm - A'), 98)
  assert.equal(bpmDesdeNombre('Digno (Bb)'), null)
  assert.equal(bpmDesdeNombre('Canción 2024'), null)
  assert.equal(bpmDesdeNombre('Algo 999 bpm'), null)
})

test('click por cómo suena: una batería o un pad no se confunden con el click', async () => {
  const click = await detectarGolpes(await porFfmpeg(generarClick(100, 4, 40), SR))
  const bateria = await detectarGolpes(await porFfmpeg(generarBateria(100, 40), SR))
  const pad = new Float32Array(40 * SR).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR))
  const padG = await detectarGolpes(await porFfmpeg(pad, SR))
  const pc = puntajeClick(click.golpes, click.silencio)
  const pb = puntajeClick(bateria.golpes, bateria.silencio)
  const pp = puntajeClick(padG.golpes, padG.silencio)
  assert.ok(pc >= PUNTAJE_MIN_CLICK, `click ${pc}`)
  assert.ok(pb < PUNTAJE_MIN_CLICK, `batería ${pb}`)
  assert.ok(pp < PUNTAJE_MIN_CLICK, `pad ${pp}`)
  assert.ok(pareceNombreDeClick('01_Click') && pareceNombreDeClick('Metrónomo') && pareceNombreDeClick('CLICK TRACK'))
  assert.ok(!pareceNombreDeClick('Clicktastic Synth') && !pareceNombreDeClick('Guía'))
  assert.ok(pareceNombreDeGuia('Guía') && pareceNombreDeGuia('02 Guide') && pareceNombreDeGuia('Cues') && !pareceNombreDeGuia('Guitarra'))
})

test('guía: se recortan las frases habladas (una por anuncio, el conteo palabra por palabra)', async () => {
  const anuncios: [string, number][] = [
    ['uno', 0.2],
    ['dos', 0.867],
    ['tres', 1.533],
    ['cuatro', 2.2],
    ['verso-uno', 4.8],
    ['coro', 15.7],
    ['puente', 26.4]
  ]
  const frases = await detectarFrases(armarGuia(anuncios, 32))
  assert.equal(frases.length, anuncios.length, JSON.stringify(frases))
  frases.forEach((f, i) => assert.ok(Math.abs(f.inicioMs - anuncios[i][1] * 1000) < 80, `frase ${i} en ${f.inicioMs}`))
})

test('secciones: interpretar anuncios y ubicarlos en el compás siguiente', () => {
  assert.deepEqual(interpretarSeccion('Verso uno.'), { tipo: 'Verso', numero: 1 })
  assert.deepEqual(interpretarSeccion('¡Coro!'), { tipo: 'Coro', numero: null })
  assert.deepEqual(interpretarSeccion('Pre coro'), { tipo: 'Pre-coro', numero: null })
  assert.deepEqual(interpretarSeccion('berso dos'), { tipo: 'Verso', numero: 2 })
  assert.deepEqual(interpretarSeccion('Vamos al puente'), { tipo: 'Puente', numero: null })
  assert.deepEqual(interpretarSeccion('Chorus 2'), { tipo: 'Coro', numero: 2 })
  assert.equal(interpretarSeccion('uno, dos, tres, cuatro'), null)
  assert.equal(interpretarSeccion('Subtítulos por la comunidad de Amara.org'), null)
  assert.equal(interpretarSeccion('solo voces'), null)
  assert.equal(nombreDeMarcadorArchivo('PRE-CHORUS'), 'Pre-coro')
  assert.equal(nombreDeMarcadorArchivo('Parte del pastor'), 'Parte del pastor')

  const compases = Array.from({ length: 30 }, (_, i) => 500 + i * 2667)
  const secciones = seccionesDesdeFrases(
    [
      { inicioMs: 200, finMs: 500, texto: 'uno' },
      { inicioMs: 4800, finMs: 5500, texto: 'Verso uno' }, // compás siguiente: 5834
      { inicioMs: 15700, finMs: 16030, texto: 'Coro' }, // 16502
      { inicioMs: 26400, finMs: 26860, texto: 'Coro' }, // 27170 -> "Coro 2"
      { inicioMs: 37000, finMs: 37500, texto: 'Final' } // 37838
    ],
    compases,
    60000
  )
  assert.deepEqual(secciones, [
    { nombre: 'Verso 1', tiempoMs: 5834 },
    { nombre: 'Coro', tiempoMs: 16502 },
    { nombre: 'Coro 2', tiempoMs: 27170 },
    { nombre: 'Final', tiempoMs: 37838 }
  ])

  // la guia dice "Verso" dos veces antes del mismo compas (o la frase se corto en dos): es el primer verso, no "Verso 2"
  const repetido = seccionesDesdeFrases(
    [
      { inicioMs: 3500, finMs: 3900, texto: 'Verso' },
      { inicioMs: 4800, finMs: 5500, texto: 'verso' },
      { inicioMs: 15700, finMs: 16030, texto: 'Coro' },
      { inicioMs: 26400, finMs: 26860, texto: 'Verso' }
    ],
    compases,
    60000
  )
  assert.deepEqual(
    repetido.map((x) => x.nombre),
    ['Verso 1', 'Coro', 'Verso 2']
  )
})

test('secciones: si la guía cuenta después del nombre ("Coro… tres, cuatro"), la sección empieza después de la cuenta', () => {
  assert.equal(esCuenta('tres, cuatro'), true)
  assert.equal(esCuenta('1, 2, 3, 4'), true)
  assert.equal(esCuenta('One, two, three, four!'), true)
  assert.equal(esCuenta('Coro'), false)
  assert.equal(esCuenta('y'), false)
  // 90 BPM 4/4: compas de 2667 ms, pulso de 667 ms; compases en 500, 3167, 5834, 8501...
  const compases = Array.from({ length: 30 }, (_, i) => 500 + i * 2667)
  const secciones = seccionesDesdeFrases(
    [
      // "Verso uno" al principio del compas 1 y la cuenta completa en el compas 2 -> empieza en el compas 3
      { inicioMs: 3200, finMs: 3900, texto: 'Verso uno' },
      { inicioMs: 5850, finMs: 8300, texto: 'uno, dos, tres, cuatro' },
      // "Coro" en el pulso 1 del compas 6 y "tres, cuatro" en los pulsos 3-4 -> compas 7
      { inicioMs: 16510, finMs: 17000, texto: 'Coro' },
      { inicioMs: 17850, finMs: 18900, texto: 'tres, cuatro' },
      // sin cuenta: el compas siguiente al final de la voz
      { inicioMs: 25900, finMs: 26600, texto: 'Puente' }
    ],
    compases,
    80000
  )
  assert.deepEqual(secciones, [
    { nombre: 'Verso 1', tiempoMs: compases[3] },
    { nombre: 'Coro', tiempoMs: compases[7] },
    { nombre: 'Puente', tiempoMs: compases[10] }
  ])
})

test('click sin acento: el "1" del compás se deduce de dónde termina de anunciar la guía', () => {
  // compases reales en 500 + k*2667; el analisis del click (sin acento) los conto un pulso tarde
  const reales = Array.from({ length: 30 }, (_, i) => 500 + i * 2667)
  const pulso = 2667 / 4
  const corridos = reales.map((c) => Math.round(c + pulso))
  const frases = [4, 10, 16, 22].map((k, i) => ({ inicioMs: reales[k] - 900, finMs: reales[k] - 250, texto: ['Verso uno', 'Coro', 'Verso dos', 'Puente'][i] }))
  const anuncios = anunciosDesdeFrases(frases)
  const corregidos = faseDesdeAnuncios(corridos, 4, anuncios)!
  assert.ok(corregidos, 'se corrige la fase')
  for (const k of [4, 10, 16, 22]) assert.ok(corregidos.some((c) => Math.abs(c - reales[k]) <= 1), `compas ${k}`)
  assert.deepEqual(
    seccionesDesdeFrases(frases, corregidos, 80000).map((s) => s.tiempoMs),
    [4, 10, 16, 22].map((k) => reales[k])
  )
  // si ya estaba bien, no se toca; y con un solo anuncio no se arriesga
  assert.equal(faseDesdeAnuncios(reales, 4, anuncios), null)
  assert.equal(faseDesdeAnuncios(corridos, 4, anuncios.slice(0, 1)), null)
})

test('marcadores en archivos: WAV (cue/labl), MIDI y texto', () => {
  // WAV con chunk "cue " + LIST/adtl/labl
  const cue = Buffer.alloc(4 + 2 * 24)
  cue.writeUInt32LE(2, 0)
  ;[
    [1, 44100 * 5],
    [2, 44100 * 20]
  ].forEach(([id, muestra], i) => {
    cue.writeUInt32LE(id, 4 + i * 24)
    cue.write('data', 4 + i * 24 + 8)
    cue.writeUInt32LE(muestra, 4 + i * 24 + 20)
  })
  const labl = (id: number, texto: string): Buffer => {
    const t = Buffer.from(texto + '\0')
    const b = Buffer.alloc(12 + t.length + (t.length % 2))
    b.write('labl', 0)
    b.writeUInt32LE(4 + t.length, 4)
    b.writeUInt32LE(id, 8)
    t.copy(b, 12)
    return b
  }
  const adtl = Buffer.concat([Buffer.from('adtl'), labl(1, 'Verse 1'), labl(2, 'Chorus')])
  const chunk = (id: string, datos: Buffer): Buffer => {
    const h = Buffer.alloc(8)
    h.write(id, 0)
    h.writeUInt32LE(datos.length, 4)
    return Buffer.concat([h, datos, datos.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const wav = wav16(new Float32Array(100), 44100, [chunk('cue ', cue), chunk('LIST', adtl)])
  assert.deepEqual(marcadoresDeWav(wav), [
    { nombre: 'Verse 1', tiempoMs: 5000 },
    { nombre: 'Chorus', tiempoMs: 20000 }
  ])

  // MIDI: 480 ticks por negra, tempo 120 (500000 us), marcadores en el compás 2 y 5 (4/4)
  const evento = (delta: number[], bytes: number[]): number[] => [...delta, ...bytes]
  const texto = (s: string): number[] => [...Buffer.from(s)]
  const pista = [
    ...evento([0], [0xff, 0x51, 3, 0x07, 0xa1, 0x20]),
    ...evento([0x8f, 0x00], [0xff, 0x06, 5, ...texto('Intro')]), // delta 1920 en longitud variable
    ...evento([0xad, 0x00], [0xff, 0x06, 4, ...texto('Coro')]), // delta 5760
    ...evento([0], [0xff, 0x2f, 0])
  ]
  const mthd = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0])
  const mtrk = Buffer.concat([Buffer.from('MTrk'), Buffer.from([0, 0, 0, pista.length]), Buffer.from(pista)])
  assert.deepEqual(marcadoresDeMidi(Buffer.concat([mthd, mtrk])), [
    { nombre: 'Intro', tiempoMs: 2000 },
    { nombre: 'Coro', tiempoMs: 8000 }
  ])

  assert.deepEqual(marcadoresDeTexto('0.000000\t0.000000\tIntro\n12.5\t12.5\tVerso 1\n'), [
    { nombre: 'Intro', tiempoMs: 0 },
    { nombre: 'Verso 1', tiempoMs: 12500 }
  ])
  assert.deepEqual(marcadoresDeTexto('0:00 Intro\n1:05 - Coro\nPuente 2:10.5\n'), [
    { nombre: 'Intro', tiempoMs: 0 },
    { nombre: 'Coro', tiempoMs: 65000 },
    { nombre: 'Puente', tiempoMs: 130500 }
  ])
  assert.deepEqual(marcadoresDeTexto('#,Name,Start,End,Length\nM1,Intro,0:00.000,,\nM2,Chorus,1:02.250,,'), [
    { nombre: 'Intro', tiempoMs: 0 },
    { nombre: 'Chorus', tiempoMs: 62250 }
  ])
})
