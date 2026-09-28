import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { createServer } from './index'
import type { EstadoCompleto, ClockSyncAck, ComandoProgramado, DispositivoInfo } from '../shared/types'

function crearZipDePrueba(etiqueta = ''): string {
  const zip = new AdmZip()
  // wav header minimo valido (44 bytes, 0 frames) alcanza para probar el flujo de import
  const wavVacio = Buffer.from(
    'RIFF' + '\x24\x00\x00\x00' + 'WAVEfmt ' + '\x10\x00\x00\x00' + '\x01\x00\x01\x00' +
      '\x44\xac\x00\x00' + '\x88\x58\x01\x00' + '\x02\x00\x10\x00' + 'data' + '\x00\x00\x00\x00',
    'binary'
  )
  zip.addFile('voz_guia.wav', wavVacio)
  zip.addFile('click.wav', wavVacio)
  zip.addFile('notas.txt', Buffer.from('no es audio'))
  zip.addFile('__MACOSX/._voz_guia.wav', wavVacio)
  const sufijo = etiqueta ? `${etiqueta}-` : ''
  const tmp = path.join(os.tmpdir(), `test-song-${sufijo}${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
  zip.writeZip(tmp)
  return tmp
}

async function emitAck<T>(socket: ClientSocket, evento: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(evento, payload, (err: unknown, res: T) => (err ? reject(err) : resolve(res)))
  })
}

test('flujo completo: cargar zip, mixer, marcadores y sync de reproduccion', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir

  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')

  const server = createServer(rendererDirFake)
  const port = await server.start(0)

  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  const celular = ioClient(`http://localhost:${port}`, { auth: { origen: 'celular' } })
  await Promise.all([
    new Promise<void>((r) => compu.on('connect', r)),
    new Promise<void>((r) => celular.on('connect', r))
  ])

  // clock sync basico
  const ack = await emitAck<ClockSyncAck>(compu, 'clock:sync', {})
  assert.ok(typeof ack.tServer === 'number')

  // sin proyectos al inicio
  const estadoInicial = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estadoInicial.tabs.length, 0)

  // cargar zip: solo filtra audio real (2 pistas), ignora .txt y basura de macOS
  // (el listener del celular se registra ANTES de emitir, para no perder el broadcast
  // que dispara el servidor ademas de la respuesta directa por ack)
  const zipPath = crearZipDePrueba()
  const celularVeZip = new Promise<EstadoCompleto>((resolve) => celular.once('estado:actualizado', resolve))
  const resZip = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: zipPath })
  assert.equal(resZip.ok, true)
  assert.equal((await celularVeZip).tabs.length, 1)

  const estado1 = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estado1.tabs.length, 1)
  assert.equal(estado1.proyectoActivo?.pistas.length, 2)
  assert.deepEqual(
    estado1.proyectoActivo?.pistas.map((p) => p.nombre).sort(),
    ['click', 'voz guia']
  )

  // el celular no puede crear marcadores
  celular.emit('marker:create', { tiempoMs: 1000, nombre: 'Intento celular' })
  const rechazo = await new Promise<{ mensaje: string }>((resolve) => celular.once('accion:rechazada', resolve))
  assert.match(rechazo.mensaje, /computadora/)

  // la compu si puede (se espera tambien la copia del celular para no dejarla
  // pendiente y que "contamine" el siguiente listener 'once' de la prueba)
  const [estadoTrasMarcador] = await Promise.all([
    new Promise<EstadoCompleto>((resolve) => compu.once('estado:actualizado', resolve)),
    new Promise<EstadoCompleto>((resolve) => celular.once('estado:actualizado', resolve)),
    compu.emit('marker:create', { tiempoMs: 5000, nombre: 'Coro 1' })
  ])
  assert.equal(estadoTrasMarcador.proyectoActivo?.marcadores.length, 1)
  assert.equal(estadoTrasMarcador.proyectoActivo?.marcadores[0].nombre, 'Coro 1')

  // mixer: actualizar volumen/pan se refleja para todos (celular tambien lo recibe)
  const pistaId = estadoTrasMarcador.proyectoActivo!.pistas[0].id
  const [, estadoCelular] = await Promise.all([
    new Promise((resolve) => compu.once('estado:actualizado', resolve)),
    new Promise<EstadoCompleto>((resolve) => celular.once('estado:actualizado', resolve)),
    compu.emit('mixer:update', { pistaId, patch: { volumen: 42, pan: -50 } })
  ])
  const pistaActualizada = estadoCelular.proyectoActivo?.pistas.find((p) => p.id === pistaId)
  assert.equal(pistaActualizada?.volumen, 42)
  assert.equal(pistaActualizada?.pan, -50)

  // transporte: play programa una accion a futuro (~1500ms) para todos los clientes
  const antes = Date.now()
  const [cmdCompu, cmdCelular] = await Promise.all([
    new Promise<ComandoProgramado>((resolve) => compu.once('playback:scheduled', resolve)),
    new Promise<ComandoProgramado>((resolve) => celular.once('playback:scheduled', resolve)),
    compu.emit('transport:play', {})
  ])
  assert.equal(cmdCompu.accion, 'play')
  assert.deepEqual(cmdCompu, cmdCelular)
  assert.ok(cmdCompu.executeAtServerTime - antes >= 1400 && cmdCompu.executeAtServerTime - antes <= 1700)

  // bloqueo: con lock activado, el celular no puede saltar marcadores
  await Promise.all([
    new Promise((resolve) => compu.once('estado:actualizado', resolve)),
    new Promise((resolve) => celular.once('estado:actualizado', resolve)),
    compu.emit('lock:set', { locked: true })
  ])
  celular.emit('marker:jump', { marcadorId: estadoTrasMarcador.proyectoActivo!.marcadores[0].id })
  const rechazo2 = await new Promise<{ mensaje: string }>((resolve) => celular.once('accion:rechazada', resolve))
  assert.match(rechazo2.mensaje, /bloqueado/)

  compu.close()
  celular.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
  fs.rmSync(zipPath, { force: true })
})

test('zip sin audio no crea proyecto', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')

  const server = createServer(rendererDirFake)
  const port = await server.start(0)
  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  await new Promise<void>((r) => compu.on('connect', r))

  const zip = new AdmZip()
  zip.addFile('readme.txt', Buffer.from('nada de audio aca'))
  const tmp = path.join(os.tmpdir(), `test-song-vacio-${Date.now()}.zip`)
  zip.writeZip(tmp)

  const res = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: tmp })
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /No se encontraron pistas/)

  const estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estado.tabs.length, 0)

  compu.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
  fs.rmSync(tmp, { force: true })
})

/** Zip como los que exporta MoiMoi: un WAV por instrumento + moimoi.json con partes y orden. */
function crearZipMoiMoi(): Buffer {
  const zip = new AdmZip()
  const wavVacio = Buffer.from(
    'RIFF' + '\x24\x00\x00\x00' + 'WAVEfmt ' + '\x10\x00\x00\x00' + '\x01\x00\x01\x00' +
      '\x44\xac\x00\x00' + '\x88\x58\x01\x00' + '\x02\x00\x10\x00' + 'data' + '\x00\x00\x00\x00',
    'binary'
  )
  for (const nombre of ['Voz.wav', 'Bateria.wav', 'Click.wav', 'Guia.wav']) zip.addFile(nombre, wavVacio)
  const manifiesto = {
    formato: 'moimoi-multitrack',
    version: 1,
    cancion: { titulo: 'Canción de prueba', artista: 'Banda', duracionMs: 136900 },
    pistas: [
      { archivo: 'Click.wav', nombre: 'Click', volumen: 70 },
      { archivo: 'Guia.wav', nombre: 'Guía', volumen: 75 },
      { archivo: 'Voz.wav', nombre: 'Voz' },
      { archivo: 'Bateria.wav', nombre: 'Batería', volumen: 999, pan: -30 }
    ],
    marcadores: [
      { nombre: 'Coro 1', tiempoMs: 29300, color: '#ff5d8f' },
      { nombre: 'Intro', tiempoMs: 0 },
      { nombre: 'Verso 1', tiempoMs: 10100, color: 'rojo' },
      { nombre: '', tiempoMs: 5000 }
    ]
  }
  zip.addFile('moimoi.json', Buffer.from(JSON.stringify(manifiesto), 'utf-8'))
  return zip.toBuffer()
}

test('zip de MoiMoi: orden, nombres y volumenes de pistas + partes como marcadores', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')
  const server = createServer(rendererDirFake)
  const port = await server.start(0)
  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  await new Promise<void>((r) => compu.on('connect', r))

  const tmp = path.join(os.tmpdir(), `Cancion de prueba (en F)-${Date.now()}.zip`)
  fs.writeFileSync(tmp, crearZipMoiMoi())
  const res = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: tmp })
  assert.equal(res.ok, true)
  const estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  const proyecto = estado.proyectoActivo!
  assert.deepEqual(proyecto.pistas.map((p) => p.nombre), ['Click', 'Guía', 'Voz', 'Batería'])
  assert.deepEqual(proyecto.pistas.map((p) => p.volumen), [70, 75, 80, 100])
  assert.equal(proyecto.pistas[3].pan, -30)
  assert.deepEqual(proyecto.marcadores.map((m) => [m.nombre, m.tiempoMs]), [['Intro', 0], ['Verso 1', 10100], ['Coro 1', 29300]])
  assert.equal(proyecto.marcadores[2].color, '#ff5d8f')
  assert.equal(proyecto.marcadores[1].color, undefined)
  assert.equal(proyecto.duracionTotalMs, 136900)

  compu.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
  fs.rmSync(tmp, { force: true })
})

test('importar por la red (POST /api/importar) abre la cancion en una pestana', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')
  const server = createServer(rendererDirFake)
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const compu = ioClient(base, { auth: { origen: 'compu' } })
  await new Promise<void>((r) => compu.on('connect', r))

  type RespuestaImportar = { ok: boolean; error?: string; nombre?: string; pistas?: number; marcadores?: number; activada?: boolean }
  const info = (await fetch(`${base}/api/info`).then((r) => r.json())) as { app: string; importar: boolean }
  assert.equal(info.app, 'multitrack-alabanza')
  assert.equal(info.importar, true)

  const preflight = await fetch(`${base}/api/importar`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')

  const vistoPorCompu = new Promise<EstadoCompleto>((resolve) => compu.once('estado:actualizado', resolve))
  const res = await fetch(`${base}/api/importar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'X-Nombre-Archivo': encodeURIComponent('Banda - Canción de prueba (en F).zip') },
    body: crearZipMoiMoi()
  })
  const body = (await res.json()) as RespuestaImportar
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.nombre, 'Banda - Canción de prueba (en F)')
  assert.equal(body.pistas, 4)
  assert.equal(body.marcadores, 3)
  const estado = await vistoPorCompu
  assert.equal(estado.tabs.length, 1)
  assert.equal(estado.proyectoActivo?.nombre, 'Banda - Canción de prueba (en F)')
  assert.equal(estado.proyectoActivo?.marcadores.length, 3)

  // Mientras suena una cancion, la que llega se agrega sin cambiar la pestana activa.
  const activa = estado.activeTabId
  await Promise.all([
    new Promise((resolve) => compu.once('playback:scheduled', resolve)),
    compu.emit('transport:play', {})
  ])
  const res2 = await fetch(`${base}/api/importar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'X-Nombre-Archivo': 'Otra.zip' },
    body: crearZipMoiMoi()
  })
  assert.equal(((await res2.json()) as RespuestaImportar).activada, false)
  const estado2 = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estado2.tabs.length, 2)
  assert.equal(estado2.activeTabId, activa)

  // Sin audio: error claro y no se abre nada.
  const vacio = new AdmZip()
  vacio.addFile('leeme.txt', Buffer.from('sin audio'))
  const res3 = await fetch(`${base}/api/importar`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: vacio.toBuffer() })
  assert.equal(res3.status, 400)
  assert.match(((await res3.json()) as RespuestaImportar).error ?? '', /No se encontraron pistas/)

  compu.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
})

test('margen de sincronizacion: instantaneo sin celulares, completo apenas se conecta uno', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')

  const server = createServer(rendererDirFake)
  const port = await server.start(0)

  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  await new Promise<void>((r) => compu.on('connect', r))

  const zipPath = crearZipDePrueba()
  await emitAck<{ ok: boolean }>(compu, 'project:load-from-zip', { filePath: zipPath })

  // sin celulares conectados: el "play" se programa casi de inmediato
  const antesSolo = Date.now()
  const cmdSolo = await new Promise<ComandoProgramado>((resolve) => {
    compu.once('playback:scheduled', resolve)
    compu.emit('transport:play', {})
  })
  const margenSolo = cmdSolo.executeAtServerTime - antesSolo
  assert.ok(margenSolo < 200, `esperaba un margen chico sin celulares, dio ${margenSolo}ms`)

  await new Promise((resolve) => {
    compu.once('playback:scheduled', resolve)
    compu.emit('transport:stop')
  })

  // se conecta un celular: ahora el margen vuelve a ser el completo (~1.5s)
  const celular = ioClient(`http://localhost:${port}`, { auth: { origen: 'celular' } })
  await new Promise<void>((r) => celular.on('connect', r))

  const antesConCelular = Date.now()
  const cmdConCelular = await new Promise<ComandoProgramado>((resolve) => {
    compu.once('playback:scheduled', resolve)
    compu.emit('transport:play', {})
  })
  const margenConCelular = cmdConCelular.executeAtServerTime - antesConCelular
  assert.ok(
    margenConCelular >= 1400 && margenConCelular <= 1700,
    `esperaba ~1500ms con un celular conectado, dio ${margenConCelular}ms`
  )

  compu.close()
  celular.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
  fs.rmSync(zipPath, { force: true })
})

test('registro de dispositivos: etiquetas, sync:report y desconexion queda visible', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')

  const server = createServer(rendererDirFake)
  const port = await server.start(0)

  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  const listaAlConectarCompu = new Promise<DispositivoInfo[]>((resolve) => compu.once('dispositivos:actualizado', resolve))
  await new Promise<void>((r) => compu.on('connect', r))
  const listaCompu = await listaAlConectarCompu
  assert.equal(listaCompu.length, 1)
  assert.equal(listaCompu[0].origen, 'compu')
  assert.equal(listaCompu[0].etiqueta, 'Computadora')
  assert.equal(listaCompu[0].conectado, true)

  const celular1 = ioClient(`http://localhost:${port}`, { auth: { origen: 'celular' } })
  const [listaTrasCelular1] = await Promise.all([
    new Promise<DispositivoInfo[]>((resolve) => compu.once('dispositivos:actualizado', resolve)),
    new Promise<void>((r) => celular1.on('connect', r))
  ])
  assert.equal(listaTrasCelular1.length, 2)
  const celular1Info = listaTrasCelular1.find((d) => d.origen === 'celular')
  assert.equal(celular1Info?.etiqueta, 'Celular 1')

  const celular2 = ioClient(`http://localhost:${port}`, { auth: { origen: 'celular' } })
  const [listaTrasCelular2] = await Promise.all([
    new Promise<DispositivoInfo[]>((resolve) => compu.once('dispositivos:actualizado', resolve)),
    new Promise<void>((r) => celular2.on('connect', r))
  ])
  const celular2Info = listaTrasCelular2.find((d) => d.etiqueta === 'Celular 2')
  assert.ok(celular2Info, 'esperaba que el segundo celular se etiquete "Celular 2"')

  // sync:report actualiza el drift de ESE dispositivo y se ve en el broadcast
  const listaConDrift = await new Promise<DispositivoInfo[]>((resolve) => {
    compu.once('dispositivos:actualizado', resolve)
    celular1.emit('sync:report', { driftMs: 42 })
  })
  const celular1ConDrift = listaConDrift.find((d) => d.etiqueta === 'Celular 1')
  assert.equal(celular1ConDrift?.driftMs, 42)

  // desconectar no lo borra de la lista: queda marcado, para que el operador lo note
  const listaTrasDesconexion = await new Promise<DispositivoInfo[]>((resolve) => {
    compu.once('dispositivos:actualizado', resolve)
    celular1.close()
  })
  assert.equal(listaTrasDesconexion.length, 3)
  const celular1Desconectado = listaTrasDesconexion.find((d) => d.etiqueta === 'Celular 1')
  assert.equal(celular1Desconectado?.conectado, false)

  compu.close()
  celular2.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
})

test('protocolo de precarga: proyectos de todas las pestanas + preparacion:reportar', async () => {
  const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-test-'))
  process.env.MULTITRACK_APP_DIR = tmpAppDir
  const rendererDirFake = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-renderer-'))
  fs.writeFileSync(path.join(rendererDirFake, 'index.html'), '<html></html>')

  const server = createServer(rendererDirFake)
  const port = await server.start(0)

  const compu = ioClient(`http://localhost:${port}`, { auth: { origen: 'compu' } })
  const celular = ioClient(`http://localhost:${port}`, { auth: { origen: 'celular' } })
  await Promise.all([
    new Promise<void>((r) => compu.on('connect', r)),
    new Promise<void>((r) => celular.on('connect', r))
  ])

  const zipA = crearZipDePrueba('A')
  const zipB = crearZipDePrueba('B')
  await emitAck<{ ok: boolean }>(compu, 'project:load-from-zip', { filePath: zipA })
  await emitAck<{ ok: boolean }>(compu, 'project:load-from-zip', { filePath: zipB })

  const estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  // dos pestanas abiertas, la B (cargada despues) es la activa
  assert.equal(estado.tabs.length, 2)
  assert.equal(estado.proyectos.length, 2)
  // `proyectos` viaja en el MISMO orden/indice que `tabs`: el primero es la
  // pestana NO activa (A), el segundo es la activa (B) — no solo esta ultima.
  assert.notEqual(estado.proyectos[0].id, estado.proyectoActivo?.id)
  assert.equal(estado.proyectos[1].id, estado.proyectoActivo?.id)
  assert.equal(estado.tabs[0].tabId === estado.activeTabId, false)
  assert.equal(estado.tabs[1].tabId === estado.activeTabId, true)
  // la pestana inactiva (A) tambien trae sus pistas completas, no solo nombre/id
  assert.ok(estado.proyectos[0].pistas.length > 0, 'se esperaban pistas completas para la pestana no activa')

  // el celular reporta que ya tiene lista la cancion A (la "anterior", no la activa)
  const proyectoAId = estado.proyectos[0].id
  const listaConPreparacion = await new Promise<DispositivoInfo[]>((resolve) => {
    compu.once('dispositivos:actualizado', resolve)
    celular.emit('preparacion:reportar', { proyectoId: proyectoAId, estado: 'listo' })
  })
  const celularInfo = listaConPreparacion.find((d) => d.origen === 'celular')
  const prepReportada = celularInfo?.preparaciones.find((p) => p.proyectoId === proyectoAId)
  assert.equal(prepReportada?.estado, 'listo')

  compu.close()
  celular.close()
  server.httpServer.close()
  fs.rmSync(tmpAppDir, { recursive: true, force: true })
  fs.rmSync(rendererDirFake, { recursive: true, force: true })
  fs.rmSync(zipA, { force: true })
  fs.rmSync(zipB, { force: true })
})
