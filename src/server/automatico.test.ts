import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { createServer, type AppServer } from './index'
import { ANUNCIOS, generarClick, inicioCompas, SR, SR_GUIA, textoDeFrase, wav16, zipConGuia } from './__fixtures__/sintetico'
import { crearRar5 } from './__fixtures__/rar'
import type { EstadoBiblioteca, EstadoCompleto, PedidoVoz, ProyectoResumen } from '../shared/types'

const TOKEN = 't'
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function entorno(t: { after(fn: () => unknown): void }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-auto-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const renderer = path.join(tmp, 'renderer')
  fs.mkdirSync(renderer)
  fs.writeFileSync(path.join(renderer, 'index.html'), '<html></html>')
  const server: AppServer = createServer(renderer, { compuToken: TOKEN })
  const port = await server.start(0)
  const compu: ClientSocket = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu', token: TOKEN }, reconnection: false })
  await new Promise<void>((r) => compu.once('connect', () => r()))
  t.after(async () => {
    compu.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const ack = <T>(ev: string, payload: unknown, ms = 60000): Promise<T> =>
    new Promise((res, rej) => compu.timeout(ms).emit(ev, payload, (err: unknown, r: T) => (err ? rej(err) : res(r))))
  return { tmp, server, port, compu, ack }
}

async function esperarQue<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, ms = 30000): Promise<T> {
  const fin = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > fin) throw new Error('timeout esperando condición')
    await esperar(100)
  }
}

test('al importar: tempo del click, frases de la guía, y secciones ubicadas en el compás', { timeout: 120000 }, async (t) => {
  const { tmp, port, compu, ack } = await entorno(t)
  const pedidos: PedidoVoz[][] = []
  compu.on('analisis:pedidos', (p: PedidoVoz[]) => pedidos.push(p))

  const r = await ack<{ ok: boolean; error?: string }>('project:load-from-zip', { filePath: zipConGuia(tmp, 'Con guia') })
  assert.equal(r.ok, true, r.error)

  // la compu recibe el pedido: frases recortadas de la guia
  const pedido = await esperarQue(() => pedidos.flat().find((p) => p.nombre === 'Con guia'))
  assert.equal(pedido.cues.length, ANUNCIOS.length)
  const estado = await ack<EstadoCompleto>('state:request', {})
  const tempo = estado.proyectoActivo!.tempo!
  assert.equal(tempo.compas, 4)
  assert.ok(Math.abs(tempo.bpm - 90) < 0.3, `bpm ${tempo.bpm}`)
  assert.equal(estado.proyectoActivo!.analisis?.estado, 'esperando-voz')

  // "Whisper falso": baja el audio de cada frase (como la compu real) y responde el texto del anuncio
  const textos = await Promise.all(
    pedido.cues.map(async (c) => {
      const resp = await fetch(`http://localhost:${port}/media/${pedido.proyectoId}/${c.archivo}`)
      assert.equal(resp.status, 200)
      const muestras = (await resp.arrayBuffer()).byteLength / 4
      assert.ok(muestras > SR_GUIA * 0.2, 'la frase tiene audio')
      const texto = textoDeFrase(c.finMs)
      assert.ok(texto, `frase inesperada que termina en ${c.finMs} ms`)
      return { n: c.n, texto }
    })
  )
  const cambio = new Promise<EstadoCompleto>((res) => compu.on('estado:actualizado', (e: EstadoCompleto) => e.proyectoActivo?.analisis?.estado === 'listo' && res(e)))
  compu.emit('analisis:textos', { proyectoId: pedido.proyectoId, textos })
  const final = await cambio
  const marcadores = final.proyectoActivo!.marcadores
  assert.deepEqual(
    marcadores.map((m) => m.nombre),
    ['Verso 1', 'Coro', 'Verso 2', 'Coro 2', 'Puente', 'Final']
  )
  ANUNCIOS.forEach(([, , compas], i) => {
    assert.ok(Math.abs(marcadores[i].tiempoMs - inicioCompas(compas) * 1000) <= 8, `${marcadores[i].nombre} en ${marcadores[i].tiempoMs}`)
    assert.equal(marcadores[i].origen, 'guia')
  })
  assert.equal(final.proyectoActivo!.analisis?.fuente, 'guia')
})

test('si el zip trae marcadores (archivo de texto), se usan esos y no hace falta la guía', { timeout: 60000 }, async (t) => {
  const { tmp, ack } = await entorno(t)
  const txt = Buffer.from('0:03 Intro\n0:10.5 Verse 1\n0:32 Chorus\n')
  const r = await ack<{ ok: boolean }>('project:load-from-zip', { filePath: zipConGuia(tmp, 'Con marcadores', { 'marcadores.txt': txt }) })
  assert.equal(r.ok, true)
  const e = await esperarQue(async () => {
    const s = await ack<EstadoCompleto>('state:request', {})
    return s.proyectoActivo?.analisis?.estado === 'listo' ? s : null
  })
  assert.deepEqual(
    e.proyectoActivo!.marcadores.map((m) => [m.nombre, m.tiempoMs, m.origen]),
    [
      ['Intro', 3000, 'archivo'],
      ['Verso 1', 10500, 'archivo'],
      ['Coro', 32000, 'archivo']
    ]
  )
  assert.equal(e.proyectoActivo!.analisis?.fuente, 'archivo')
  assert.ok(e.proyectoActivo!.tempo, 'el tempo se detecta igual')
})

test('biblioteca: importa sola, categorías por carpeta, mover, actualizar y no importar mientras suena', { timeout: 120000 }, async (t) => {
  const { tmp, server, compu, ack } = await entorno(t)
  const bib = path.join(tmp, 'Biblioteca')
  const estados: EstadoBiblioteca[] = []
  compu.on('biblioteca:estado', (e: EstadoBiblioteca) => estados.push(e))
  server.iniciarServicios(bib, { descubrimiento: false, puertoCorto: null })
  assert.ok(fs.existsSync(bib), 'crea la carpeta')

  const lista = (): Promise<ProyectoResumen[]> => ack<ProyectoResumen[]>('projects:list', {})

  // zip nuevo en una subcarpeta -> cancion con esa categoria
  fs.mkdirSync(path.join(bib, 'Adoración'))
  const zipPath = zipConGuia(tmp, 'Santo')
  fs.copyFileSync(zipPath, path.join(bib, 'Adoración', 'Santo.zip'))
  server.biblioteca.escanear()
  const cancion = await esperarQue(async () => (await lista()).find((p) => p.nombre === 'Santo'))
  assert.equal(cancion.categoria, 'Adoración')

  // se mueve de carpeta: cambia la categoria, no se reimporta
  fs.mkdirSync(path.join(bib, 'Navidad'))
  fs.renameSync(path.join(bib, 'Adoración', 'Santo.zip'), path.join(bib, 'Navidad', 'Santo.zip'))
  server.biblioteca.escanear()
  await esperarQue(async () => (await lista()).find((p) => p.id === cancion.id && p.categoria === 'Navidad'))
  assert.equal((await lista()).length, 1)

  // abrirla, marcar una seccion a mano y cambiar la mezcla; despues se actualiza el zip
  await ack('projects:open', { id: cancion.id })
  const abierta = await ack<EstadoCompleto>('state:request', {})
  const pad = abierta.proyectoActivo!.pistas.find((p) => p.nombre === 'Pad')!
  compu.emit('mixer:update', { pistaId: pad.id, patch: { volumen: 33 } })
  compu.emit('marker:create', { tiempoMs: 20000, nombre: 'Parte del pastor' })
  await esperar(600)

  // mientras suena NO importa: espera
  compu.emit('transport:play', {})
  await esperar(300)
  const nuevoZip = zipConGuia(tmp, 'Santo v2', { 'nota.txt': Buffer.from('v2') })
  fs.copyFileSync(nuevoZip, path.join(bib, 'Navidad', 'Santo.zip'))
  fs.utimesSync(path.join(bib, 'Navidad', 'Santo.zip'), new Date(), new Date(Date.now() + 5000))
  server.biblioteca.escanear()
  await esperarQue(() => estados.some((e) => e.esperandoSilencio), 10000)
  compu.emit('transport:stop')
  const actualizada = await esperarQue(async () => {
    const s = await ack<EstadoCompleto>('state:request', {})
    return (s.proyectoActivo?.revision ?? 0) >= 1 ? s : null
  }, 60000)
  const p = actualizada.proyectoActivo!
  assert.equal(p.id, cancion.id, 'misma canción (mismo lugar en los setlists)')
  assert.equal(p.pistas.find((x) => x.nombre === 'Pad')!.volumen, 33, 'la mezcla se conserva')
  assert.ok(p.marcadores.some((m) => m.nombre === 'Parte del pastor'), 'las secciones puestas a mano se conservan')

  // borrar la cancion: el zip queda en la carpeta pero no se vuelve a importar solo
  await ack('projects:delete', { id: cancion.id })
  server.biblioteca.escanear()
  await esperar(2500)
  server.biblioteca.escanear()
  await esperar(1500)
  assert.equal((await lista()).length, 0)
})

test('biblioteca con .rar: uno en partes se importa una sola vez, y al importar uno de afuera se copian todas sus partes', { timeout: 120000 }, async (t) => {
  const { tmp, server, ack } = await entorno(t)
  const bib = path.join(tmp, 'Biblioteca')
  server.iniciarServicios(bib, { descubrimiento: false, puertoCorto: null })
  const lista = (): Promise<ProyectoResumen[]> => ack<ProyectoResumen[]>('projects:list', {})
  const pistas = [
    { nombre: '01 Click.wav', datos: wav16(generarClick(90, 4, 6), SR) },
    { nombre: '02 Pad.wav', datos: wav16(new Float32Array(6 * SR).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR)), SR) }
  ]
  const partes = crearRar5(pistas, { bytesPorVolumen: 300_000 })
  assert.ok(partes.length >= 3)

  // en partes, dentro de una categoria: una sola cancion "Rey de Reyes"
  fs.mkdirSync(path.join(bib, 'Alabanza'))
  partes.forEach((b, i) => fs.writeFileSync(path.join(bib, 'Alabanza', `Rey de Reyes.part${i + 1}.rar`), b))
  // y un .rar comun
  fs.writeFileSync(path.join(bib, 'Alabanza', 'Digno.rar'), crearRar5(pistas)[0])
  server.biblioteca.escanear()
  await esperarQue(async () => ((await lista()).length === 2 ? true : null), 60000)
  const canciones = await lista()
  assert.deepEqual(canciones.map((c) => [c.nombre, c.categoria]).sort(), [['Digno', 'Alabanza'], ['Rey de Reyes', 'Alabanza']])
  assert.equal(server.biblioteca.estado().ultimoError, null)

  // importar desde otra carpeta uno en partes (eligiendo la ultima): se copian todas a la biblioteca, sin reimportar
  const afuera = path.join(tmp, 'Descargas')
  fs.mkdirSync(afuera)
  partes.forEach((b, i) => fs.writeFileSync(path.join(afuera, `Cuan Grande.part${i + 1}.rar`), b))
  const r = await ack<{ ok: boolean; error?: string }>('project:load-from-zip', { filePath: path.join(afuera, `Cuan Grande.part${partes.length}.rar`) })
  assert.equal(r.ok, true, r.error)
  const copiadas = fs.readdirSync(bib).filter((f) => f.startsWith('Cuan Grande') && f.endsWith('.rar')).sort()
  assert.deepEqual(copiadas, partes.map((_, i) => `Cuan Grande.part${i + 1}.rar`))
  server.biblioteca.escanear()
  await esperar(3000)
  server.biblioteca.escanear()
  await esperar(1500)
  assert.deepEqual((await lista()).map((c) => c.nombre).sort(), ['Cuan Grande', 'Digno', 'Rey de Reyes'])
})

test('ficha de la canción: en otra compu (o reinstalando) vuelve con sus secciones, mezcla y tempo, sin analizar', { timeout: 180000 }, async (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-ficha-'))
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }))
  const bib = path.join(raiz, 'Carpeta de canciones')
  fs.mkdirSync(path.join(bib, 'Adoración'), { recursive: true })
  fs.copyFileSync(zipConGuia(raiz, 'Santo'), path.join(bib, 'Adoración', 'Santo.zip'))
  const renderer = path.join(raiz, 'renderer')
  fs.mkdirSync(renderer)
  fs.writeFileSync(path.join(renderer, 'index.html'), '<html></html>')

  /** Una "compu": su propia carpeta de datos de la app, la misma carpeta de canciones. */
  async function compuNueva(nombre: string) {
    process.env.MULTITRACK_APP_DIR = path.join(raiz, nombre)
    const server: AppServer = createServer(renderer, { compuToken: TOKEN })
    const port = await server.start(0)
    const compu: ClientSocket = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu', token: TOKEN }, reconnection: false })
    await new Promise<void>((r) => compu.once('connect', () => r()))
    const pedidos: PedidoVoz[][] = []
    compu.on('analisis:pedidos', (p: PedidoVoz[]) => pedidos.push(p))
    const ack = <T>(ev: string, payload: unknown, ms = 60000): Promise<T> =>
      new Promise((res, rej) => compu.timeout(ms).emit(ev, payload, (err: unknown, r: T) => (err ? rej(err) : res(r))))
    server.iniciarServicios(bib, { descubrimiento: false, puertoCorto: null })
    const cerrar = async (): Promise<void> => {
      compu.close()
      await server.close()
    }
    return { server, compu, ack, pedidos, cerrar }
  }

  // ---- compu A: se importa, se analiza (guia) y el musico la acomoda ----
  const a = await compuNueva('compu-A')
  const pedido = await esperarQue(() => a.pedidos.flat().find((p) => p.nombre === 'Santo'), 60000)
  a.compu.emit('analisis:textos', { proyectoId: pedido.proyectoId, textos: pedido.cues.map((c) => ({ n: c.n, texto: textoDeFrase(c.finMs) })) })
  await esperarQue(async () => (await a.ack<ProyectoResumen[]>('projects:list', {})).find((p) => p.analisis === 'listo'))
  await a.ack('projects:open', { id: pedido.proyectoId })
  const abierta = (await a.ack<EstadoCompleto>('state:request', {})).proyectoActivo!
  const pad = abierta.pistas.find((p) => p.nombre === 'Pad')!
  a.compu.emit('mixer:update', { pistaId: pad.id, patch: { volumen: 33 } })
  a.compu.emit('marker:update', { marcadorId: abierta.marcadores[0].id, patch: { nombre: 'Verso 1 (suave)' } })
  const ficha = path.join(bib, 'Adoración', 'Santo.multitrack.json')
  const escrita = await esperarQue(() => {
    try {
      const f = JSON.parse(fs.readFileSync(ficha, 'utf-8'))
      return f.pistas.find((p: { nombre: string }) => p.nombre === 'Pad')?.volumen === 33 && f.marcadores[0]?.nombre === 'Verso 1 (suave)' ? f : null
    } catch {
      return null
    }
  }, 10000)
  assert.equal(escrita.seccionesEditadas, true)
  assert.equal(escrita.marcadores[0].origen, 'manual', 'la sección corregida a mano pasa a ser del usuario')
  assert.ok(Math.abs(escrita.tempo.bpm - 90) < 0.3)
  const enA = (await a.ack<EstadoCompleto>('state:request', {})).proyectoActivo!
  await a.cerrar()

  // ---- compu B (otra compu, o la app reinstalada): misma carpeta de canciones ----
  const b = await compuNueva('compu-B')
  const importada = await esperarQue(async () => (await b.ack<ProyectoResumen[]>('projects:list', {})).find((p) => p.nombre === 'Santo'), 60000)
  assert.equal(importada.id, enA.id, 'mismo id: los setlists que la nombran siguen andando')
  assert.equal(importada.analisis, 'listo', 'no se vuelve a analizar')
  assert.equal(importada.categoria, 'Adoración')
  await b.ack('projects:open', { id: importada.id })
  const enB = (await b.ack<EstadoCompleto>('state:request', {})).proyectoActivo!
  assert.deepEqual(
    enB.marcadores.map((m) => [m.nombre, m.tiempoMs]),
    enA.marcadores.map((m) => [m.nombre, m.tiempoMs])
  )
  assert.equal(enB.pistas.find((p) => p.nombre === 'Pad')!.volumen, 33)
  assert.deepEqual(enB.tempo?.compasesMs, enA.tempo?.compasesMs)
  await esperar(1500)
  assert.equal(b.pedidos.flat().length, 0, 'no se le pidió a nadie reconocer la guía de nuevo')

  // ---- el zip se actualiza: las secciones que el usuario acomodó quedan todas ----
  const nuevo = path.join(bib, 'Adoración', 'Santo.zip')
  fs.copyFileSync(zipConGuia(raiz, 'Santo v2', { 'nota.txt': Buffer.from('v2') }), nuevo)
  fs.utimesSync(nuevo, new Date(), new Date(Date.now() + 5000))
  b.server.biblioteca.escanear()
  const actualizada = await esperarQue(async () => {
    const e = await b.ack<EstadoCompleto>('state:request', {})
    return (e.proyectoActivo?.revision ?? 0) >= 1 ? e.proyectoActivo : null
  }, 60000)
  assert.deepEqual(
    actualizada.marcadores.map((m) => m.nombre),
    enA.marcadores.map((m) => m.nombre)
  )
  await esperar(2500)
  assert.deepEqual(
    (await b.ack<EstadoCompleto>('state:request', {})).proyectoActivo!.marcadores.map((m) => m.nombre),
    enA.marcadores.map((m) => m.nombre),
    'el análisis del audio nuevo no pisa las secciones del usuario'
  )
  await b.cerrar()
})

test('"Detectar secciones" reemplaza las existentes y el modelo de voz se informa si falta', { timeout: 60000 }, async (t) => {
  const { tmp, port, compu, ack } = await entorno(t)
  const modelo = await new Promise<{ estado: string }>((res) => {
    compu.once('modelo:estado', res)
    compu.disconnect().connect()
  })
  assert.equal(modelo.estado, 'falta')
  assert.equal((await fetch(`http://localhost:${port}/modelos/whisper-base/config.json`)).status, 404)

  await ack('project:load-from-zip', { filePath: zipConGuia(tmp, 'Detectar', { 'm.txt': Buffer.from('0:05 Intro\n0:20 Coro\n') }) })
  const e = await esperarQue(async () => {
    const s = await ack<EstadoCompleto>('state:request', {})
    return s.proyectoActivo?.analisis?.estado === 'listo' ? s : null
  })
  const id = e.proyectoActivo!.id
  const pedidos = new Promise<PedidoVoz[]>((res) => compu.on('analisis:pedidos', (p: PedidoVoz[]) => p.length && res(p)))
  compu.emit('analisis:detectar', { proyectoId: id })
  const [pedido] = await pedidos
  compu.emit('analisis:textos', { proyectoId: id, textos: pedido.cues.map((c) => ({ n: c.n, texto: c.n === 0 ? 'Coro' : '' })) })
  const final = await esperarQue(async () => {
    const s = await ack<EstadoCompleto>('state:request', {})
    return s.proyectoActivo?.analisis?.fuente === 'guia' ? s : null
  })
  assert.deepEqual(final.proyectoActivo!.marcadores.map((m) => m.nombre), ['Coro'])
})
