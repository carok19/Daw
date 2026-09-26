import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client'
import { createServer, type AppServer } from './index'
import { rutaFfmpeg, leerInfoWav } from './audio'
import { nombrePistaDesdeArchivo } from './zip'
import { crearRar4, crearRar5 } from './__fixtures__/rar'
import dgram from 'node:dgram'
import dnsPacket from 'dns-packet'
import { responderMdns } from './descubrimiento'
import { decodePcmSegment, parseWavHeader } from '../shared/wav'
import { codificarMezcla, coeficientesPaneo, mezclaEfectiva, pistasClickYGuia, type CanalMezcla } from '../shared/mezcla'
import { fichaDesdeProyecto, interpretarFicha } from './ficha'
import { wav16 } from './__fixtures__/sintetico'
import { calcularSecciones, nuevoPlayback, posicionActualMs, seccionEn } from '../shared/playback'
import type {
  AjustesConexion,
  ClockSyncAck,
  DatosInvitacion,
  ComandoProgramado,
  DispositivoInfo,
  EstadoCompleto,
  MixerActualizadoPayload,
  Pista,
  Proyecto,
  ProyectoResumen,
  SetlistResumen
} from '../shared/types'

const TOKEN = 'token-de-prueba'

// ---------- helpers ----------

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function tmpDir(prefijo: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo))
}

/** Genera un archivo de audio con ffmpeg (tono). `canales`: 'mono' | 'dual' (estereo L==R) | 'estereo' (L != R). */
function generarAudio(destino: string, segundos: number, canales: 'mono' | 'dual' | 'estereo' = 'estereo'): void {
  const ffmpeg = rutaFfmpeg()
  assert.ok(ffmpeg, 'se necesita ffmpeg para los tests')
  const fuente =
    canales === 'estereo'
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`, '-f', 'lavfi', '-i', `sine=frequency=660:duration=${segundos}`, '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo']
      : canales === 'dual'
        ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`, '-ac', '2']
        : ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`, '-ac', '1']
  const r = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...fuente, destino])
  assert.equal(r.status, 0, r.stderr?.toString())
}

function crearZip(nombre: string, archivos: Record<string, string | Buffer>): string {
  const zip = new AdmZip()
  for (const [n, contenido] of Object.entries(archivos)) {
    zip.addFile(n, typeof contenido === 'string' ? fs.readFileSync(contenido) : contenido)
  }
  const destino = path.join(tmpDir('multitrack-zip-'), `${nombre}.zip`)
  zip.writeZip(destino)
  return destino
}

let audiosCache: { wav2s: string; wav4s: string; mp3Dual: string; wavEstereo: string } | null = null
function audiosDePrueba() {
  if (audiosCache) return audiosCache
  const dir = tmpDir('multitrack-audio-')
  audiosCache = {
    wav2s: path.join(dir, 'a.wav'),
    wav4s: path.join(dir, 'b.wav'),
    mp3Dual: path.join(dir, 'c.mp3'),
    wavEstereo: path.join(dir, 'd.wav')
  }
  generarAudio(audiosCache.wav2s, 2, 'mono')
  generarAudio(audiosCache.wav4s, 4, 'mono')
  generarAudio(audiosCache.mp3Dual, 2, 'dual')
  generarAudio(audiosCache.wavEstereo, 2, 'estereo')
  return audiosCache
}

interface Entorno {
  server: AppServer
  port: number
  appDir: string
  conectar(auth: Record<string, unknown>): Promise<ClientSocket>
  cerrar(): Promise<void>
}

async function entorno(
  t: { after(fn: () => Promise<void> | void): void },
  appDir = tmpDir('multitrack-test-'),
  extra: { dirExtras?: string } = {}
): Promise<Entorno> {
  process.env.MULTITRACK_APP_DIR = appDir
  const rendererDir = tmpDir('multitrack-renderer-')
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<html></html>')
  const server = createServer(rendererDir, { compuToken: TOKEN, analisisAutomatico: false, version: '9.9.9', ...extra })
  const port = await server.start(0)
  const sockets: ClientSocket[] = []
  let cerrado = false
  const env: Entorno = {
    server,
    port,
    appDir,
    async conectar(auth) {
      const s = ioClient(`http://localhost:${port}`, { auth, reconnection: false })
      sockets.push(s)
      await new Promise<void>((r, rej) => {
        s.once('connect', () => r())
        s.once('connect_error', rej)
      })
      return s
    },
    async cerrar() {
      if (cerrado) return
      cerrado = true
      for (const s of sockets) s.close()
      await server.close()
      fs.rmSync(rendererDir, { recursive: true, force: true })
    }
  }
  // aunque una asercion falle, el servidor y los sockets se cierran (sino el proceso de test queda colgado)
  t.after(() => env.cerrar())
  return env
}

const compuAuth = { origen: 'compu', token: TOKEN }

async function emitAck<T>(socket: ClientSocket, evento: string, payload: unknown, ms = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit(evento, payload, (err: unknown, res: T) => (err ? reject(err) : resolve(res)))
  })
}

function esperarEvento<T>(socket: ClientSocket, evento: string, filtro: (v: T) => boolean = () => true, ms = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(evento, handler)
      reject(new Error(`timeout esperando ${evento}`))
    }, ms)
    function handler(v: T): void {
      if (!filtro(v)) return
      clearTimeout(t)
      socket.off(evento, handler)
      resolve(v)
    }
    socket.on(evento, handler)
  })
}

async function cargarZip(compu: ClientSocket, zip: string): Promise<EstadoCompleto> {
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: zip }, 60000)
  assert.equal(r.ok, true, r.error)
  return emitAck<EstadoCompleto>(compu, 'state:request', {})
}

// ---------- tests ----------

test('nombres de pista: se quita el prefijo numerico de orden', () => {
  assert.equal(nombrePistaDesdeArchivo('01_Click'), 'Click')
  assert.equal(nombrePistaDesdeArchivo('02 - Guia'), 'Guia')
  assert.equal(nombrePistaDesdeArchivo('10.Bajo_DI'), 'Bajo DI')
  assert.equal(nombrePistaDesdeArchivo('Teclado_Pad'), 'Teclado Pad')
  assert.equal(nombrePistaDesdeArchivo('808'), '808')
})

test('tramos encadenados: comandos seguidos dentro del margen (loop de secciones cortas)', () => {
  let pb = nuevoPlayback(null, { estado: 'playing', positionMs: 0, referenceServerTime: 1000 }, 1000)
  // salto 1: emitido en t=2000, efectivo en t=3000 -> vuelve a 500
  pb = nuevoPlayback(pb, { estado: 'playing', positionMs: 500, referenceServerTime: 3000 }, 2000)
  // salto 2: emitido en t=2900, ANTES de que el 1 sea efectivo; efectivo en t=4400
  pb = nuevoPlayback(pb, { estado: 'playing', positionMs: 500, referenceServerTime: 4400 }, 2900)
  assert.equal(posicionActualMs(pb, 2950), 1950, 'hasta t=3000 sigue el tramo original')
  assert.equal(posicionActualMs(pb, 3500), 1000, 'entre 3000 y 4400 suena el salto 1')
  assert.equal(posicionActualMs(pb, 4500), 600, 'despues, el salto 2')
  // una pausa programada mientras suena: la posicion sigue avanzando hasta que se ejecuta
  const pausa = nuevoPlayback(pb, { estado: 'paused', positionMs: 1100, referenceServerTime: 6000 }, 5000)
  assert.equal(posicionActualMs(pausa, 5500), 1600)
  assert.equal(posicionActualMs(pausa, 7000), 1100)
  // arrancar desde parado no tiene tramo previo
  const desdeParado = nuevoPlayback({ estado: 'stopped', positionMs: 0, referenceServerTime: 0 }, { estado: 'playing', positionMs: 0, referenceServerTime: 9000 }, 8000)
  assert.equal(desdeParado.previo, undefined)
})

test('secciones a partir de marcadores', () => {
  const s = calcularSecciones(
    [
      { id: 'b', nombre: 'Coro', tiempoMs: 20000 },
      { id: 'a', nombre: 'Verso', tiempoMs: 5000 }
    ],
    60000
  )
  assert.deepEqual(s.map((x) => [x.nombre, x.inicioMs, x.finMs]), [['Inicio', 0, 5000], ['Verso', 5000, 20000], ['Coro', 20000, 60000]])
  assert.equal(seccionEn(s, 4990)?.nombre, 'Inicio')
  assert.equal(seccionEn(s, 5000)?.nombre, 'Verso')
  assert.equal(seccionEn(s, 59999)?.nombre, 'Coro')
})

test('flujo completo: importar (con MP3), mixer liviano, marcadores y sync de reproduccion', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const celular = await env.conectar({ origen: 'celular', deviceId: 'celular-prueba-1' })

  const ack = await emitAck<ClockSyncAck>(compu, 'clock:sync', {})
  assert.ok(typeof ack.tServer === 'number')

  const zip = crearZip('01_Cuan_Grande', {
    '01_Click.wav': a.wav2s,
    '02_Guia.mp3': a.mp3Dual,
    '03_Pad.wav': a.wavEstereo,
    'notas.txt': Buffer.from('no es audio'),
    '__MACOSX/._01_Click.wav': Buffer.from('basura')
  })
  const progresos: string[] = []
  compu.on('import:progreso', (p: { etapa: string }) => progresos.push(p.etapa))
  const celularVeZip = esperarEvento<EstadoCompleto>(celular, 'estado:actualizado')
  const estado = await cargarZip(compu, zip)
  assert.equal((await celularVeZip).tabs.length, 1)
  assert.ok(progresos.includes('convirtiendo') && progresos.includes('listo'))

  const proyecto = estado.proyectoActivo!
  assert.equal(proyecto.nombre, '01 Cuan Grande')
  assert.deepEqual(proyecto.pistas.map((p) => p.nombre), ['Click', 'Guia', 'Pad'])
  // todo queda en WAV (el MP3 tambien) y la duracion la calcula el servidor
  assert.ok(proyecto.pistas.every((p) => p.archivo.endsWith('.wav')))
  assert.ok(Math.abs(proyecto.duracionTotalMs - 2000) < 60, `duracion ${proyecto.duracionTotalMs}`)
  // colores distintos por orden
  assert.equal(new Set(proyecto.pistas.map((p) => p.color)).size, 3)
  // el MP3 "dual mono" se guarda en mono; el estereo real sigue estereo
  const dirProyecto = path.join(env.appDir, 'proyectos', proyecto.id)
  assert.equal(leerInfoWav(path.join(dirProyecto, proyecto.pistas[1].archivo)).numChannels, 1)
  assert.equal(leerInfoWav(path.join(dirProyecto, proyecto.pistas[2].archivo)).numChannels, 2)
  assert.equal(leerInfoWav(path.join(dirProyecto, proyecto.pistas[2].archivo)).bitsPerSample, 16)

  // el audio se sirve con soporte de Range (lo que usa el streaming de los celulares)
  const resp = await fetch(`http://localhost:${env.port}/media/${proyecto.id}/${proyecto.pistas[0].archivo}`, {
    headers: { Range: 'bytes=0-99' }
  })
  assert.equal(resp.status, 206)
  assert.equal((await resp.arrayBuffer()).byteLength, 100)

  // el celular no puede crear marcadores
  celular.emit('marker:create', { tiempoMs: 1000, nombre: 'Intento celular' })
  const rechazo = await esperarEvento<{ mensaje: string }>(celular, 'accion:rechazada')
  assert.match(rechazo.mensaje, /computadora/)

  const [trasMarcador] = await Promise.all([
    esperarEvento<EstadoCompleto>(celular, 'estado:actualizado'),
    compu.emit('marker:create', { tiempoMs: 500, nombre: 'Coro 1' })
  ])
  assert.equal(trasMarcador.proyectoActivo?.marcadores[0].nombre, 'Coro 1')

  // mixer: broadcast liviano con SOLO la pista que cambio
  const pistaId = proyecto.pistas[0].id
  const [mix] = await Promise.all([
    esperarEvento<MixerActualizadoPayload>(celular, 'mixer:actualizado'),
    compu.emit('mixer:update', { pistaId, patch: { volumen: 42, pan: -50, color: '#123456' } })
  ])
  assert.equal(mix.proyectoId, proyecto.id)
  assert.equal(mix.pista.volumen, 42)
  assert.equal(mix.pista.pan, -50)
  assert.equal(mix.pista.color, '#123456')

  // transporte: play programa a futuro (~1500ms, hay un celular) e incluye el estado autoritativo
  const antes = Date.now()
  const [cmdCompu, cmdCelular] = await Promise.all([
    esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'),
    esperarEvento<ComandoProgramado>(celular, 'playback:scheduled'),
    compu.emit('transport:play', {})
  ])
  assert.equal(cmdCompu.accion, 'play')
  assert.deepEqual(cmdCompu, cmdCelular)
  assert.equal(cmdCompu.playback.estado, 'playing')
  assert.ok(cmdCompu.executeAtServerTime - antes >= 1400 && cmdCompu.executeAtServerTime - antes <= 1700)

  // un salto mientras suena conserva el tramo previo (lo que realmente suena hasta el salto)
  const salto = await Promise.all([
    esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'),
    compu.emit('transport:seek', { positionMs: 1000 })
  ])
  assert.equal(salto[0].playback.previo?.estado, 'playing')

  // bloqueo: el celular no puede saltar marcadores
  await Promise.all([esperarEvento(celular, 'estado:actualizado'), compu.emit('lock:set', { locked: true })])
  celular.emit('marker:jump', { marcadorId: trasMarcador.proyectoActivo!.marcadores[0].id })
  const rechazo2 = await esperarEvento<{ mensaje: string }>(celular, 'accion:rechazada')
  assert.match(rechazo2.mensaje, /bloqueado/)

  await env.cerrar()
})

test('seguridad: sin token no se es "la compu", y los ids no permiten salir de la carpeta', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  // un celular que DICE ser la compu (sin el token correcto)
  const impostor = await env.conectar({ origen: 'compu', token: 'adivinando' })

  const victima = path.join(env.appDir, 'carpeta_victima')
  fs.mkdirSync(victima)
  fs.writeFileSync(path.join(victima, 'archivo.txt'), 'importante')

  const r1 = await emitAck<{ ok: boolean }>(impostor, 'projects:delete', { id: '../carpeta_victima' })
  assert.equal(r1.ok, false)
  // ni siquiera la compu verdadera puede usar un id que no sea UUID
  const r2 = await emitAck<{ ok: boolean }>(compu, 'projects:delete', { id: '../carpeta_victima' })
  assert.equal(r2.ok, false)
  assert.ok(fs.existsSync(path.join(victima, 'archivo.txt')), 'la carpeta de afuera no se toca')

  const r3 = await emitAck<{ ok: boolean; error?: string }>(impostor, 'project:load-from-zip', { filePath: '/etc/passwd' })
  assert.equal(r3.ok, false)
  const r4 = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: '/etc/passwd' })
  assert.equal(r4.ok, false)
  const r5 = await emitAck<{ ok: boolean }>(compu, 'projects:open', { id: '../../etc' })
  assert.equal(r5.ok, false)

  impostor.emit('mixer:update', { pistaId: 'x', patch: { volumen: 0 } })
  const rechazo = await esperarEvento<{ mensaje: string }>(impostor, 'accion:rechazada')
  assert.match(rechazo.mensaje, /computadora/)

  const lista = await emitAck<unknown>(compu, 'state:request', {})
  assert.ok(!JSON.stringify(lista).includes(TOKEN), 'el token nunca viaja en el estado')

  await env.cerrar()
})

test('zip sin audio o dañado no crea proyecto', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)

  const vacio = crearZip('vacio', { 'readme.txt': Buffer.from('nada de audio aca') })
  const res = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: vacio })
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /No se encontraron pistas/)

  const roto = path.join(tmpDir('multitrack-zip-'), 'roto.zip')
  fs.writeFileSync(roto, 'esto no es un zip')
  const res2 = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: roto })
  assert.equal(res2.ok, false)
  assert.match(res2.error ?? '', /zip/)

  // un "audio" corrupto adentro: error claro y nada a medias en disco
  const corrupto = crearZip('corrupto', { 'click.mp3': Buffer.from('no es un mp3 de verdad') })
  const res3 = await emitAck<{ ok: boolean; error?: string }>(compu, 'project:load-from-zip', { filePath: corrupto })
  assert.equal(res3.ok, false)
  assert.match(res3.error ?? '', /click/)

  const estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estado.tabs.length, 0)
  const lista = await emitAck<ProyectoResumen[]>(compu, 'projects:list', {})
  assert.equal(lista.length, 0)

  await env.cerrar()
})

test('canciones en .rar: RAR5, RAR4, en partes (eligiendo cualquier parte) y errores claros', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const a = audiosDePrueba()
  const dir = tmpDir('multitrack-rar-')
  const importar = (ruta: string): Promise<{ ok: boolean; error?: string }> => emitAck(compu, 'project:load-from-zip', { filePath: ruta }, 60000)
  const escribir = (nombre: string, datos: Buffer): string => {
    const ruta = path.join(dir, nombre)
    fs.writeFileSync(ruta, datos)
    return ruta
  }

  // RAR5 con subcarpeta, nombres con acentos, un MP3, marcadores en texto y basura de macOS
  const [rar5] = crearRar5([
    { nombre: 'Santo Santo/01 Click.wav', datos: fs.readFileSync(a.wav2s) },
    { nombre: 'Santo Santo/02 Guía.mp3', datos: fs.readFileSync(a.mp3Dual) },
    { nombre: 'Santo Santo/marcadores.txt', datos: Buffer.from('0:00.5 Intro\n0:01.2 Coro\n') },
    { nombre: '__MACOSX/Santo Santo/._01 Click.wav', datos: Buffer.from('basura') }
  ])
  let r = await importar(escribir('Santo_Santo.rar', rar5))
  assert.equal(r.ok, true, r.error)
  let e = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(e.proyectoActivo!.nombre, 'Santo Santo')
  assert.deepEqual(e.proyectoActivo!.pistas.map((p) => p.nombre), ['Click', 'Guía'])
  assert.deepEqual(e.proyectoActivo!.marcadores.map((m) => [m.nombre, m.tiempoMs, m.origen]), [['Intro', 500, 'archivo'], ['Coro', 1200, 'archivo']])
  const resp = await fetch(`http://localhost:${env.port}/media/${e.proyectoActivo!.id}/${e.proyectoActivo!.pistas[1].archivo}`)
  assert.equal(parseWavHeader(await resp.arrayBuffer()).bitsPerSample, 16, 'el MP3 del .rar quedó convertido a WAV')

  // RAR4 (el formato de WinRAR viejo)
  r = await importar(escribir('Viejo.rar', crearRar4([{ nombre: 'Viejo\\01 Bajo.wav', datos: fs.readFileSync(a.wav4s) }])))
  assert.equal(r.ok, true, r.error)
  e = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.deepEqual(e.proyectoActivo!.pistas.map((p) => p.nombre), ['Bajo'])
  assert.ok(Math.abs(e.proyectoActivo!.duracionTotalMs - 4000) < 50)

  // .rar en partes: se puede elegir cualquier parte, se arranca por la primera
  const partes = crearRar5(
    [
      { nombre: '01 Click.wav', datos: fs.readFileSync(a.wav2s) },
      { nombre: '02 Pad.wav', datos: fs.readFileSync(a.wav4s) }
    ],
    { bytesPorVolumen: 200_000 }
  )
  assert.ok(partes.length >= 3)
  partes.forEach((p, i) => escribir(`Rey de Reyes.part${i + 1}.rar`, p))
  r = await importar(path.join(dir, 'Rey de Reyes.part2.rar'))
  assert.equal(r.ok, true, r.error)
  e = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(e.proyectoActivo!.nombre, 'Rey de Reyes')
  assert.deepEqual(e.proyectoActivo!.pistas.map((p) => p.nombre), ['Click', 'Pad'])

  // errores: parte que falta, contraseña, dañado
  const incompleto = tmpDir('multitrack-rar-')
  fs.writeFileSync(path.join(incompleto, 'Mitad.part1.rar'), partes[0])
  fs.writeFileSync(path.join(incompleto, 'Mitad.part3.rar'), partes[2])
  r = await importar(path.join(incompleto, 'Mitad.part1.rar'))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Falta una parte/)
  r = await importar(escribir('Secreto.rar', crearRar5([{ nombre: 'click.wav', datos: fs.readFileSync(a.wav2s) }], { cifrado: true })[0]))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /contraseña/)
  r = await importar(escribir('Roto.rar', Buffer.from('Rar!\x1a\x07\x01\x00 esto no es un rar de verdad')))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /dañado|incompleto/)
  r = await importar(escribir('Solo texto.rar', crearRar5([{ nombre: 'leeme.txt', datos: Buffer.from('hola') }])[0]))
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /No se encontraron pistas/)

  const lista = await emitAck<ProyectoResumen[]>(compu, 'projects:list', {})
  assert.deepEqual(lista.map((p) => p.nombre).sort(), ['Rey de Reyes', 'Santo Santo', 'Viejo'])
  await env.cerrar()
})

test('código de la banda: sin el código un celular no entra (la compu sí); 5 intentos fallidos lo frenan', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const intentar = (auth: Record<string, unknown>): Promise<string> =>
    new Promise((res) => {
      const s = ioClient(`http://localhost:${env.port}`, { auth, reconnection: false })
      s.once('connect', () => {
        s.close()
        res('ok')
      })
      s.once('connect_error', (e: Error & { data?: { motivo?: string } }) => {
        s.close()
        res(e.data?.motivo ?? e.message)
      })
    })

  assert.equal(await intentar({ origen: 'celular' }), 'ok', 'sin código configurado, entra cualquiera')
  const mal = await emitAck<{ ok: boolean; error?: string }>(compu, 'ajustes:codigo', { codigo: '12a' })
  assert.equal(mal.ok, false)
  const r = await emitAck<{ ok: boolean; ajustes: AjustesConexion }>(compu, 'ajustes:codigo', { codigo: '12 34' })
  assert.equal(r.ajustes.codigoBanda, '1234')
  const info = (await (await fetch(`http://localhost:${env.port}/api/info`)).json()) as { requiereCodigo: boolean; app: string }
  assert.equal(info.requiereCodigo, true)
  assert.equal(info.app, 'multitrack-alabanza')

  assert.equal(await intentar({ origen: 'celular' }), 'codigo-requerido')
  assert.equal(await intentar({ origen: 'celular', codigo: '9999' }), 'codigo-incorrecto')
  // un celular que dice ser la compu sin el token es un celular: tambien necesita el codigo
  assert.equal(await intentar({ origen: 'compu', token: 'no' }), 'codigo-requerido')
  assert.equal(await intentar({ origen: 'celular', codigo: '1234' }), 'ok')

  // un celular con el codigo recibe lo necesario para invitar a otro
  const cel = await env.conectar({ origen: 'celular', codigo: '1234', deviceId: 'cel-inv' })
  const inv = await emitAck<DatosInvitacion>(cel, 'invitacion:datos', {})
  assert.equal(inv.codigo, '1234')
  assert.match(inv.url, new RegExp(`^http://.+:${env.port}$`))
  assert.match(inv.urlFija, /alabanza\.local/)
  cel.close()

  // adivinar probando: al quinto intento fallido queda frenado (aunque despues ponga el bueno)
  for (let i = 0; i < 4; i++) assert.equal(await intentar({ origen: 'celular', codigo: '0000' }), 'codigo-incorrecto')
  assert.equal(await intentar({ origen: 'celular', codigo: '0000' }), 'codigo-bloqueado')
  assert.equal(await intentar({ origen: 'celular', codigo: '1234' }), 'codigo-bloqueado')

  // la compu no necesita codigo; y sin codigo vuelven a entrar todos
  const compu2 = await env.conectar(compuAuth)
  await emitAck(compu2, 'ajustes:codigo', { codigo: null })
  assert.equal(await intentar({ origen: 'celular' }), 'ok')
  // el ajuste queda guardado
  const wifi = await emitAck<{ ok: boolean; ajustes: AjustesConexion }>(compu2, 'ajustes:wifi', { ssid: 'Alabanza 5G', clave: 'cantad;al"Señor' })
  assert.deepEqual(wifi.ajustes.wifi, { ssid: 'Alabanza 5G', clave: 'cantad;al"Señor' })
  const guardado = JSON.parse(fs.readFileSync(path.join(env.appDir, 'ajustes.json'), 'utf-8'))
  assert.equal(guardado.wifi.ssid, 'Alabanza 5G')
  await env.cerrar()
})

test('la compu se deja encontrar: alabanza.local (mDNS), búsqueda de la app Android (UDP), dirección corta y la app para bajar', async (t) => {
  const extras = tmpDir('multitrack-extras-')
  fs.writeFileSync(path.join(extras, 'alabanza.apk'), Buffer.from('PK apk de prueba'))
  const env = await entorno(t, tmpDir('multitrack-test-'), { dirExtras: extras })
  const puertoMdns = 40000 + Math.floor(Math.random() * 10000)
  const puertoUdp = puertoMdns + 1
  env.server.iniciarServicios(null, { puertoMdns, puertoUdp, puertoCorto: 0 })
  await esperar(300)

  // busqueda de la app Android: pregunta por UDP y la compu contesta con su IP, puerto e id
  const udp = dgram.createSocket('udp4')
  t.after(() => udp.close())
  const respuesta = new Promise<Record<string, unknown>>((res) => udp.once('message', (m) => res(JSON.parse(m.toString()))))
  udp.send('MULTITRACK-ALABANZA?', puertoUdp, '127.0.0.1')
  const r = await respuesta
  assert.equal(r.app, 'multitrack-alabanza')
  assert.equal(r.puerto, env.port)
  assert.equal(r.id, env.server.ajustes.idInstalacion)
  assert.equal(r.version, '9.9.9')

  // alabanza.local: una pregunta mDNS (directa) se contesta con la IP de la compu
  const q = dnsPacket.encode({ type: 'query', id: 7, questions: [{ name: 'alabanza.local', type: 'A' }] })
  const mdns = dgram.createSocket('udp4')
  t.after(() => mdns.close())
  const resp = new Promise<dnsPacket.Packet>((res) => mdns.once('message', (m) => res(dnsPacket.decode(m))))
  mdns.send(q, puertoMdns, '127.0.0.1')
  const a = (await resp).answers?.find((x) => x.type === 'A') as { name: string; data: string } | undefined
  assert.ok(a && a.name === 'alabanza.local' && /^\d+\.\d+\.\d+\.\d+$/.test(a.data), 'responde la IP')

  // el servicio que busca la app Android: PTR con SRV (puerto) y TXT (id)
  const r2 = responderMdns([{ name: '_multitrack._tcp.local', type: 'PTR' }], { nombre: 'Multitrack Alabanza · PC', puerto: 4848, id: 'abc', version: '1', requiereCodigo: true }, '192.168.1.35')!
  const srv = r2.additionals.find((x) => x.type === 'SRV') as { data: { port: number; target: string } }
  assert.equal(srv.data.port, 4848)
  assert.equal(srv.data.target, 'alabanza.local')
  assert.ok((r2.additionals.find((x) => x.type === 'TXT') as { data: string[] }).data.includes('id=abc'))
  assert.equal(responderMdns([{ name: 'otra.local', type: 'A' }], { nombre: 'x', puerto: 1, id: 'i', version: '1', requiereCodigo: false }, '1.2.3.4'), null)

  // direccion corta: el puerto 80 (aca, uno cualquiera) redirige al puerto real
  const corto = env.server.puertoCorto()
  assert.ok(corto, 'levanta la dirección corta')
  const red = await fetch(`http://127.0.0.1:${corto}/algo?x=1`, { redirect: 'manual' })
  assert.equal(red.status, 302)
  assert.equal(red.headers.get('location'), `http://127.0.0.1:${env.port}/algo?x=1`)

  // la app Android se baja de la compu
  const info = (await (await fetch(`http://localhost:${env.port}/api/info`)).json()) as { apk: boolean }
  assert.equal(info.apk, true)
  const apk = await fetch(`http://localhost:${env.port}/app/alabanza.apk`)
  assert.equal(apk.status, 200)
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive')
  await env.cerrar()
})

/** WAV estereo 16 bits con L y R constantes. */
function wavEstereoConstante(l: number, r: number, segundos: number, sr: number): Buffer {
  const frames = Math.round(segundos * sr)
  const data = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(l * 32767), i * 4)
    data.writeInt16LE(Math.round(r * 32767), i * 4 + 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

test('click y guía a la izquierda: se detectan por nombre, por el análisis o a mano; la banda va a la derecha 3 dB más baja', () => {
  const pista = (id: string, nombre: string, extra: Partial<Pista> = {}): Pista => ({
    id,
    nombre,
    archivo: `${id}.wav`,
    volumen: 100,
    pan: 30,
    mute: false,
    solo: false,
    color: '#ffffff',
    ...extra
  })
  const proyecto = {
    pistas: [
      pista('a', 'Click 120'),
      pista('b', 'Voz Guía'),
      pista('c', 'Metrónomo', { rol: 'normal' }), // marcada a mano como que no
      pista('d', 'Pista 7'), // es el click segun el analisis (por como suena)
      pista('e', 'Cues2'), // otra guia, marcada a mano
      pista('f', 'Bajo'),
      pista('g', 'Guitarra')
    ],
    tempo: { bpm: 120, compas: 4, compasesMs: [], clickPistaId: 'd', acentoClaro: true },
    analisis: { estado: 'listo' as const, fuente: null, guiaPistaId: null }
  }
  proyecto.pistas[4].rol = 'guia'
  const izq = pistasClickYGuia(proyecto)
  assert.deepEqual([...izq].sort(), ['a', 'b', 'd', 'e'])
  const m = new Map(mezclaEfectiva(proyecto.pistas, {}, izq).map((c) => [c.pistaId, c]))
  assert.equal(m.get('a')!.pan, -1)
  assert.equal(m.get('f')!.pan, 1)
  assert.equal(m.get('c')!.pan, 1)
  assert.ok(Math.abs(m.get('g')!.ganancia - Math.SQRT1_2) < 1e-9, 'la banda va 3 dB más baja (suena de un solo lado)')
  // sin la opcion: el paneo del director
  assert.equal(mezclaEfectiva(proyecto.pistas)[0].pan, 0.3)
  // la marca a mano se guarda en la ficha de la cancion
  const ficha = interpretarFicha(JSON.stringify(fichaDesdeProyecto({ ...proyecto, id: 'x', nombre: 'x', duracionTotalMs: 1000, marcadores: [] } as unknown as Proyecto)))!
  assert.equal(ficha.pistas.find((p) => p.nombre === 'Metrónomo')!.rol, 'normal')
  assert.equal(ficha.pistas.find((p) => p.nombre === 'Cues2')!.rol, 'guia')
  assert.equal(ficha.pistas.find((p) => p.nombre === 'Bajo')!.rol, undefined)
})

test('mezcla por celular: la compu arma UNA pista estéreo con la mezcla pedida (paneo, ganancias, otra frecuencia, límite)', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const zip = crearZip('Mezcla', {
    'Guia.wav': wav16(new Float32Array(5 * 44100).fill(0.25), 44100),
    'Pad.wav': wavEstereoConstante(0.2, -0.1, 5, 44100),
    'Bajo.wav': wav16(new Float32Array(5 * 22050).fill(0.1), 22050) // otra frecuencia: se remuestrea
  })
  const estado = await cargarZip(compu, zip)
  const p = estado.proyectoActivo!
  const id = (nombre: string): string => p.pistas.find((x) => x.nombre === nombre)!.id
  const base = `http://localhost:${env.port}/mezcla/${p.id}`

  async function pedir(indice: number, canales: CanalMezcla[], extra = ''): Promise<Response> {
    return fetch(`${base}/${indice}.wav?v=${p.revision ?? 0}&m=${codificarMezcla(canales)}${extra}`)
  }
  async function muestras(r: Response): Promise<{ L: Float32Array; R: Float32Array; sr: number }> {
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'audio/wav')
    const buf = await r.arrayBuffer()
    const info = parseWavHeader(buf)
    assert.equal(info.numChannels, 2)
    assert.equal(info.bitsPerSample, 16)
    const [L, R] = decodePcmSegment(info, buf.slice(info.dataOffset))
    return { L, R, sr: info.sampleRate }
  }

  const mezcla: CanalMezcla[] = [
    { pistaId: id('Guia'), ganancia: 1, pan: -1 }, // todo a la izquierda
    { pistaId: id('Pad'), ganancia: 0.5, pan: 0 },
    { pistaId: id('Bajo'), ganancia: 2, pan: 0.5 }
  ]
  const b = coeficientesPaneo(0.5, 1)
  const esperadoL = 0.25 + 0.5 * 0.2 + 2 * 0.1 * b.aLL
  const esperadoR = 0 + 0.5 * -0.1 + 2 * 0.1 * b.aRR
  const s0 = await muestras(await pedir(0, mezcla))
  assert.equal(s0.sr, 44100, 'la frecuencia de la mayoria')
  assert.equal(s0.L.length, 2 * 44100, 'segmentos de 2 s exactos')
  for (const i of [0, 1000, 44100, 88199]) {
    assert.ok(Math.abs(s0.L[i] - esperadoL) < 0.001, `L[${i}] = ${s0.L[i]} (esperado ${esperadoL})`)
    assert.ok(Math.abs(s0.R[i] - esperadoR) < 0.001, `R[${i}] = ${s0.R[i]} (esperado ${esperadoR})`)
  }

  // "Mi mezcla": una pista que no se pide no suena
  const sinGuia = await muestras(await pedir(1, mezcla.slice(1)))
  assert.ok(Math.abs(sinGuia.L[500] - (esperadoL - 0.25)) < 0.001)

  // pasarse de 0 dB no recorta duro: limitador suave entre 0,9 y 1
  const fuerte = await muestras(await pedir(0, [{ pistaId: id('Guia'), ganancia: 4, pan: -1 }, { pistaId: id('Pad'), ganancia: 2, pan: -1 }]))
  assert.ok(fuerte.L[100] > 0.9 && fuerte.L[100] < 1, `limitado: ${fuerte.L[100]}`)

  // final de la cancion: el ultimo segmento es mas corto y lo avisa; despues, 416
  const r2 = await pedir(2, mezcla)
  assert.equal(r2.headers.get('x-ultimo'), '1')
  assert.equal((await muestras(r2)).L.length, 44100)
  assert.equal((await pedir(1, mezcla)).headers.get('x-ultimo'), '0')
  assert.equal((await pedir(3, mezcla)).status, 416)

  // pedidos invalidos
  assert.equal((await fetch(`${base}/0.wav?v=${(p.revision ?? 0) + 1}&m=`)).status, 409, 'revision vieja')
  assert.equal((await fetch(`${base}/0.wav?v=${p.revision ?? 0}&m=cualquier-cosa`)).status, 400)
  assert.equal((await fetch(`${base}/x.wav?v=0&m=`)).status, 400)
  assert.equal((await fetch(`http://localhost:${env.port}/mezcla/${crypto.randomUUID()}/0.wav?v=0&m=`)).status, 404)
  // sin pistas pedidas: silencio (no error)
  const silencio = await muestras(await pedir(0, []))
  assert.equal(Math.max(...silencio.L.slice(0, 100)), 0)

  // los celulares con la misma mezcla comparten el segmento (se calcula una vez)
  const antes = env.server.mezclador.estadisticas()
  await Promise.all([pedir(1, mezcla), pedir(1, mezcla), pedir(1, mezcla)].map(async (r) => (await r).arrayBuffer()))
  const despues = env.server.mezclador.estadisticas()
  assert.equal(despues.mezclados, antes.mezclados, 'ya estaba en la cache')
  assert.equal(despues.aciertosCache - antes.aciertosCache, 3)
})

test('margen de sincronizacion: instantaneo sin celulares, completo apenas se conecta uno', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  await cargarZip(compu, crearZip('margen', { 'click.wav': a.wav4s }))

  const antesSolo = Date.now()
  const [cmdSolo] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  assert.ok(cmdSolo.executeAtServerTime - antesSolo < 200)

  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop')])

  await env.conectar({ origen: 'celular' })
  const antes = Date.now()
  const [cmd] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  const margen = cmd.executeAtServerTime - antes
  assert.ok(margen >= 1400 && margen <= 1700, `margen ${margen}`)

  await env.cerrar()
})

test('fin de cancion y repetir seccion los maneja el servidor', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const estado = await cargarZip(compu, crearZip('loop', { 'click.wav': a.wav4s }))
  assert.ok(Math.abs(estado.proyectoActivo!.duracionTotalMs - 4000) < 60)

  await Promise.all([esperarEvento(compu, 'estado:actualizado'), compu.emit('marker:create', { tiempoMs: 500, nombre: 'Verso' })])
  await Promise.all([esperarEvento(compu, 'estado:actualizado'), compu.emit('marker:create', { tiempoMs: 2000, nombre: 'Coro' })])
  await Promise.all([esperarEvento(compu, 'estado:actualizado'), compu.emit('loop:set', { activo: true })])

  // play desde 0.6s (seccion "Verso" 0.5s-2s): a los ~1.4s tiene que volver a 0.5s
  const [inicio] = await Promise.all([
    esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'),
    compu.emit('transport:play', { positionMs: 600 })
  ])
  const loop = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', (c) => c.accion === 'play', 4000)
  assert.equal(loop.positionMs, 500)
  const esperado = inicio.executeAtServerTime + (2000 - 600)
  assert.ok(Math.abs(loop.executeAtServerTime - esperado) < 5, `salto en ${loop.executeAtServerTime - esperado}ms del esperado`)
  assert.equal(loop.playback.previo?.estado, 'playing')

  // sin loop, sigue hasta el final y el servidor emite stop solo
  await Promise.all([esperarEvento(compu, 'estado:actualizado'), compu.emit('loop:set', { activo: false })])
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:seek', { positionMs: 3000 })])
  const stop = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', (c) => c.accion === 'stop', 3000)
  assert.equal(stop.playback.estado, 'stopped')
  assert.equal(stop.positionMs, 0)

  await env.cerrar()
})

test('saltos de sección: al terminar la sección la música sigue en la elegida, sin cortes; se cambia, se cancela o va ya', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  // 4 s: Inicio 0-1 s, Verso 1-2 s, Coro 2-3 s, Puente 3-4 s
  const estado0 = await cargarZip(compu, crearZip('saltos', { 'click.wav': a.wav4s, 'marcas.txt': Buffer.from('0:01 Verso\n0:02 Coro\n0:03 Puente\n') }))
  assert.deepEqual(estado0.proyectoActivo!.marcadores.map((m) => m.tiempoMs), [1000, 2000, 3000])
  const pendiente = (): Promise<EstadoCompleto> => esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => !!e.saltoPendiente)
  const sinPendiente = (): Promise<EstadoCompleto> => esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => !e.saltoPendiente)

  // parado: ir a una seccion es inmediato (no queda pendiente)
  const [seek] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('seccion:saltar', { posicionMs: 2000 })])
  assert.equal(seek.positionMs, 2000)

  // sonando desde 1.1 s (Verso): elegir Puente -> sigue el Verso hasta 2 s y ahi continua en 3 s
  const [inicio] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1100 })])
  await esperar(100)
  const [conSalto] = await Promise.all([pendiente(), compu.emit('seccion:saltar', { posicionMs: 3000 })])
  const salto = conSalto.saltoPendiente!
  assert.equal(salto.nombre, 'Puente')
  assert.equal(salto.limiteMs, 2000)
  assert.equal(salto.destinoMs, 3000)
  assert.ok(Math.abs(salto.tSalto - (inicio.executeAtServerTime + 900)) < 5, `limite a ${salto.tSalto - inicio.executeAtServerTime} ms del arranque`)
  const cmd = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', (c) => c.accion === 'play', 3000)
  assert.equal(cmd.positionMs, 3000)
  assert.equal(cmd.executeAtServerTime, salto.tSalto)
  // continuidad: justo antes del limite sigue el Verso, justo despues ya es el Puente
  assert.ok(Math.abs(posicionActualMs(cmd.playback, cmd.executeAtServerTime - 1) - 1999) <= 1)
  assert.ok(Math.abs(posicionActualMs(cmd.playback, cmd.executeAtServerTime + 1) - 3001) <= 1)

  // elegir otra mientras espera la reemplaza; "siguiente" es relativa a la elegida; Esc/cancelar la saca
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1050 })])
  let e = (await Promise.all([pendiente(), compu.emit('seccion:saltar', { posicionMs: 0 })]))[0]
  assert.equal(e.saltoPendiente!.nombre, 'Inicio')
  e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => x.saltoPendiente?.nombre === 'Verso'), compu.emit('seccion:saltar', { relativo: 1 })]))[0]
  assert.equal(e.saltoPendiente!.limiteMs, 2000)
  await Promise.all([sinPendiente(), compu.emit('salto:cancelar')])
  // sin salto pendiente, sigue de largo: el proximo comando es el stop del final (no un salto)
  const fin = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', () => true, 5000)
  assert.equal(fin.accion, 'stop')

  // una pausa cancela el salto pendiente
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1050 })])
  await Promise.all([pendiente(), compu.emit('seccion:saltar', { posicionMs: 3000 })])
  await Promise.all([sinPendiente(), compu.emit('transport:pause')])

  // modo "ya": salta enseguida
  await Promise.all([esperarEvento(compu, 'estado:actualizado', (x: EstadoCompleto) => x.modoSalto === 'inmediato'), compu.emit('salto:modo', { modo: 'inmediato' })])
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1050 })])
  await esperar(50)
  const t0 = Date.now()
  const [ya] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('seccion:saltar', { posicionMs: 3000 })])
  assert.equal(ya.positionMs, 3000)
  assert.ok(ya.executeAtServerTime - t0 < 200, 'sin celulares, "ya" es enseguida')

  await env.cerrar()
})

test('con tempo, todo cae en el "1": marcas corridas, click en la línea de tiempo y la vuelta del "repetir"', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  // marcas corridas unos ms del compas (como las marcadas antes de detectar el click, o las de un archivo)
  await cargarZip(compu, crearZip('pulso', { 'click.wav': a.wav4s, 'marcas.txt': Buffer.from('0:01.04 Verso\n0:02.03 Coro\n0:02.96 Puente\n') }))
  // 240 BPM 4/4: un compas por segundo
  env.server.state.getActiveTab()!.proyecto.tempo = { bpm: 240, compas: 4, compasesMs: [0, 1000, 2000, 3000], clickPistaId: null, acentoClaro: true }
  const conSalto = (): Promise<EstadoCompleto> => esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => !!e.saltoPendiente)

  // seccion: el limite y el destino se llevan al compas (2000 y 3000, no 2030 y 2960)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1100 })])
  await esperar(50)
  let e = (await Promise.all([conSalto(), compu.emit('seccion:saltar', { posicionMs: 2960 })]))[0]
  assert.deepEqual([e.saltoPendiente!.limiteMs, e.saltoPendiente!.destinoMs], [2000, 3000])
  const cmd = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', (c) => c.accion === 'play', 3000)
  assert.equal(cmd.positionMs, 3000)
  assert.ok(Math.abs(posicionActualMs(cmd.playback, cmd.executeAtServerTime - 1) - 1999) <= 1, 'corta justo en el compás')

  // click en la linea de tiempo sonando: en el proximo compas, al "1" mas cercano al punto elegido
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1100 })])
  await esperar(50)
  e = (await Promise.all([conSalto(), compu.emit('transport:seek', { positionMs: 3350 })]))[0]
  assert.deepEqual([e.saltoPendiente!.limiteMs, e.saltoPendiente!.destinoMs], [2000, 3000])
  assert.match(e.saltoPendiente!.nombre, /Puente · 0:03/)
  // con Shift (inmediato) va ya, al punto exacto
  const t0 = Date.now()
  const [ya] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:seek', { positionMs: 3350, inmediato: true })])
  assert.equal(ya.positionMs, 3350)
  assert.ok(ya.executeAtServerTime - t0 < 200)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:pause')])

  // "repetir" en una seccion corrida: la vuelta tambien va de compas a compas (2000 -> 1000)
  await Promise.all([esperarEvento(compu, 'estado:actualizado'), compu.emit('loop:set', { activo: true })])
  const [inicio] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1100 })])
  const vuelta = await esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', (c) => c.accion === 'play', 3000)
  assert.equal(vuelta.positionMs, 1000)
  assert.ok(Math.abs(vuelta.executeAtServerTime - (inicio.executeAtServerTime + 900)) < 5)
  compu.emit('transport:stop')
  await env.cerrar()
})

test('saltos de sección con celulares: el salto se manda con todo el margen de sync', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const celular = await env.conectar({ origen: 'celular', deviceId: 'cel-saltos', nombre: 'Bajo' })
  // 20 s con secciones cada 5 s
  const largo = path.join(tmpDir('multitrack-audio-'), 'largo.wav')
  generarAudio(largo, 20, 'mono')
  await cargarZip(compu, crearZip('largo', { 'click.wav': largo, 'marcas.txt': Buffer.from('0:05 Verso\n0:10 Coro\n0:15 Final\n') }))
  const [inicio] = await Promise.all([esperarEvento<ComandoProgramado>(celular, 'playback:scheduled'), celular.emit('transport:play', { positionMs: 0 })])
  // el celular (sin bloqueo) elige el Coro estando en "Inicio": salta al terminar Inicio (5 s)
  await esperar(200)
  celular.emit('seccion:saltar', { posicionMs: 10000 })
  const cmd = await esperarEvento<ComandoProgramado>(celular, 'playback:scheduled', (c) => c.positionMs === 10000, 8000)
  const llegada = Date.now()
  assert.equal(cmd.executeAtServerTime, inicio.executeAtServerTime + 5000)
  assert.ok(cmd.executeAtServerTime - llegada >= 1400, `llegó ${cmd.executeAtServerTime - llegada} ms antes del salto`)
  compu.emit('transport:stop')
  await env.cerrar()
})

test('agregar una canción mientras otra suena no la interrumpe', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const estado = await cargarZip(compu, crearZip('Sonando', { 'click.wav': a.wav4s }))
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  const detenidos: ComandoProgramado[] = []
  compu.on('playback:scheduled', (c: ComandoProgramado) => detenidos.push(c))
  const r = await emitAck<{ ok: boolean; activada?: boolean }>(compu, 'project:load-from-zip', { filePath: crearZip('Nueva', { 'click.wav': a.wav2s }) }, 60000)
  assert.equal(r.ok, true)
  assert.equal(r.activada, false)
  const despues = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(despues.activeTabId, estado.activeTabId, 'la que suena sigue activa')
  assert.equal(despues.playbackActivo?.estado, 'playing')
  assert.deepEqual(despues.tabs.map((x) => x.nombre), ['Sonando', 'Nueva'])
  assert.equal(detenidos.length, 0, 'no se emitió ningún stop')
})

test('cerrar la pestaña que suena (o borrar su cancion) corta el audio en todos', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const celular = await env.conectar({ origen: 'celular' })
  const estado = await cargarZip(compu, crearZip('unica', { 'click.wav': a.wav4s }))

  await Promise.all([esperarEvento(celular, 'playback:scheduled'), compu.emit('transport:play', {})])
  const [stop, nuevoEstado] = await Promise.all([
    esperarEvento<ComandoProgramado>(celular, 'playback:scheduled'),
    esperarEvento<EstadoCompleto>(celular, 'estado:actualizado'),
    compu.emit('tabs:close', { tabId: estado.activeTabId })
  ])
  assert.equal(stop.accion, 'stop')
  assert.ok(stop.executeAtServerTime <= Date.now() + 5, 'sin margen: corta ya')
  assert.equal(nuevoEstado.proyectoActivo, null)

  await env.cerrar()
})

test('dispositivos: id estable al reconectar, nombre propio y olvidar', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)

  const cel = await env.conectar({ origen: 'celular', deviceId: 'dispositivo-aaaa-1111' })
  // renombrar desde el celular
  const [trasRenombrar] = await Promise.all([
    esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado'),
    cel.emit('device:rename', { nombre: '  Batería  ' })
  ])
  const bateria = trasRenombrar.find((d) => d.origen === 'celular')!
  assert.equal(bateria.etiqueta, 'Batería')

  // reporte de drift + buffer + error
  const [conReporte] = await Promise.all([
    esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado'),
    cel.emit('sync:report', { driftMs: 12, buffer: 'critico', error: 'pista X' })
  ])
  const r = conReporte.find((d) => d.id === bateria.id)!
  assert.equal(r.driftMs, 12)
  assert.equal(r.buffer, 'critico')
  assert.equal(r.error, 'pista X')

  // se desconecta y vuelve: MISMA fila, mismo nombre, sin duplicados
  const [trasCaida] = await Promise.all([esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado'), cel.close()])
  assert.equal(trasCaida.find((d) => d.id === bateria.id)?.conectado, false)
  const [trasVolver] = await Promise.all([
    esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado', (l) => l.some((d) => d.id === bateria.id && d.conectado)),
    env.conectar({ origen: 'celular', deviceId: 'dispositivo-aaaa-1111' })
  ])
  assert.equal(trasVolver.filter((d) => d.origen === 'celular').length, 1)
  assert.equal(trasVolver.find((d) => d.id === bateria.id)?.etiqueta, 'Batería')

  // otro celular sin nombre -> "Celular 2"; al irse, la compu lo puede olvidar
  const otro = await env.conectar({ origen: 'celular', deviceId: 'dispositivo-bbbb-2222' })
  const [trasIrse] = await Promise.all([esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado'), otro.close()])
  const segundo = trasIrse.find((d) => d.etiqueta === 'Celular 2')
  assert.ok(segundo && !segundo.conectado, JSON.stringify(trasIrse))
  const [trasOlvidar] = await Promise.all([
    esperarEvento<DispositivoInfo[]>(compu, 'dispositivos:actualizado'),
    compu.emit('devices:forget', { id: segundo!.id })
  ])
  assert.equal(trasOlvidar.find((d) => d.id === segundo!.id), undefined)

  await env.cerrar()
})

test('sesion y setlists: las canciones abiertas vuelven al reabrir la app', async (t) => {
  const a = audiosDePrueba()
  const appDir = tmpDir('multitrack-test-')
  const env = await entorno(t, appDir)
  const compu = await env.conectar(compuAuth)
  await cargarZip(compu, crearZip('Primera', { 'click.wav': a.wav2s }))
  const estado = await cargarZip(compu, crearZip('Segunda', { 'click.wav': a.wav2s }))
  assert.deepEqual(estado.tabs.map((t) => t.nombre), ['Primera', 'Segunda'])

  // reordenar el setlist
  await Promise.all([
    esperarEvento(compu, 'estado:actualizado'),
    compu.emit('tabs:reorder', { orden: [estado.tabs[1].tabId, estado.tabs[0].tabId] })
  ])
  const guardado = await emitAck<{ ok: boolean }>(compu, 'setlists:save', { nombre: 'Domingo' })
  assert.equal(guardado.ok, true)
  await env.cerrar()

  // "reabrir la app": servidor nuevo sobre la misma carpeta
  const env2 = await entorno(t, appDir)
  await env2.server.restaurarSesion()
  const compu2 = await env2.conectar(compuAuth)
  const restaurado = await emitAck<EstadoCompleto>(compu2, 'state:request', {})
  assert.deepEqual(restaurado.tabs.map((t) => t.nombre), ['Segunda', 'Primera'])

  // abrir el setlist guardado reemplaza las pestanas
  await Promise.all([esperarEvento(compu2, 'estado:actualizado'), compu2.emit('tabs:close', { tabId: restaurado.tabs[0].tabId })])
  const setlists = await emitAck<SetlistResumen[]>(compu2, 'setlists:list', {})
  assert.equal(setlists[0].nombre, 'Domingo')
  assert.deepEqual(setlists[0].canciones, ['Segunda', 'Primera'])
  const abierto = await emitAck<{ ok: boolean }>(compu2, 'setlists:open', { id: setlists[0].id })
  assert.equal(abierto.ok, true)
  const trasAbrir = await emitAck<EstadoCompleto>(compu2, 'state:request', {})
  assert.deepEqual(trasAbrir.tabs.map((t) => t.nombre), ['Segunda', 'Primera'])
  assert.equal(trasAbrir.activeTabId, trasAbrir.tabs[0].tabId)

  await env2.cerrar()
})

test('migracion: una cancion vieja guardada con MP3 se convierte a WAV al abrirla', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t)
  const id = crypto.randomUUID()
  const dir = path.join(env.appDir, 'proyectos', id)
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true })
  fs.copyFileSync(a.mp3Dual, path.join(dir, 'audio', 'guia.mp3'))
  fs.writeFileSync(
    path.join(dir, 'proyecto.json'),
    JSON.stringify({
      id,
      nombre: 'Vieja',
      creadoEn: new Date().toISOString(),
      pistas: [{ id: crypto.randomUUID(), nombre: 'guia', archivo: 'audio/guia.mp3', volumen: 80, pan: 0, mute: false, solo: false }],
      marcadores: [],
      duracionTotalMs: 0
    })
  )
  const compu = await env.conectar(compuAuth)
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'projects:open', { id }, 30000)
  assert.equal(r.ok, true, r.error)
  const estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  const p = estado.proyectoActivo!
  assert.equal(p.pistas[0].archivo, 'audio/guia.wav')
  assert.ok(p.pistas[0].color)
  assert.ok(Math.abs(p.duracionTotalMs - 2000) < 80, `duracion ${p.duracionTotalMs}`)
  assert.ok(!fs.existsSync(path.join(dir, 'audio', 'guia.mp3')))

  await env.cerrar()
})
