import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { createServer } from './index'
import type { EstadoCompleto, ClockSyncAck, ComandoProgramado } from '../shared/types'

function crearZipDePrueba(): string {
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
  const tmp = path.join(os.tmpdir(), `test-song-${Date.now()}.zip`)
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
