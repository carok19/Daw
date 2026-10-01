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
import { aplicarPaneoAutomatico, codificarMezcla, coeficientesPaneo, mezclaEfectiva, type CanalMezcla } from '../shared/mezcla'
import { migrarProyecto } from './projects'
import { fichaDesdeProyecto, interpretarFicha } from './ficha'
import { Mezclador } from './mezclador'
import { armarLicencia, datosAFirmar, type DatosLicencia } from '../shared/licencia'
import { Licencias } from './licencia'
import { demoraEntre, pistasQueCambianDeTono } from './tono'
import { evaluarFirewall, type DatosFirewall } from './firewall'
import { compasesDeCuenta, golpeActual, golpesDeCuenta, LARGO_SONIDO_CUENTA_SEC, programarCuenta, suenaSuCuenta } from '../shared/cuenta'
import { detectarCuentaPropia } from './cuenta'
import { Voces } from './voces'
import { esAdaptadorVirtual } from './network'
import { normalizarTonalidad, pareceBateria, pareceVoz, tonalidadDesdeNombre, tonalidadEn, tonalidadOriginal, transponerTonalidad } from '../shared/tonalidad'
import { generarClick, wav16 } from './__fixtures__/sintetico'
import { candidatosDeSeccion, clavesDeArchivoDeVoz, planearAnuncio } from '../shared/anuncio'
import { bpmDeTramo, bpmDistintoEnSeccion, calcularSecciones, compasesQueFaltan, largoTipicoDeCompas, nuevoPlayback, posicionActualMs, seccionEn, textoQueFaltan } from '../shared/playback'
import { alinear, alineacionSegura, calcularHuella, huellaABytes, huellaDeBytes } from '../shared/huella'
import { ajusteDeVideo, objetivoVideo, proximoCorte } from '../shared/videoSync'
import { generarBanda } from './__fixtures__/banda'
import {
  compasYPulso,
  golpesDeColchon,
  largoDeCompas,
  nombreDeColchon,
  normalizarAjustesColchon,
  notaDelPad,
  padDeCancion,
  proximoCompas,
  proximoPulso
} from '../shared/colchon'
import type {
  AjustesConexion,
  ClockSyncAck,
  DatosInvitacion,
  DiagnosticoServidor,
  ComandoProgramado,
  EstadoLicencia,
  DispositivoInfo,
  EstadoCompleto,
  MixerActualizadoPayload,
  ProgresoTono,
  Pista,
  Proyecto,
  ProyectoResumen,
  DatosListas,
  ListaResumen
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
  extra: { dirExtras?: string; clavePublicaLicencias?: string | null; intervaloPingMs?: number } = {}
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
  assert.match(inv.urlFija, /airtracks\.local/)
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

test('la compu se deja encontrar: airtracks.local (y alabanza.local, el de antes) por mDNS, búsqueda de la app Android (UDP), dirección corta y la app para bajar', async (t) => {
  const extras = tmpDir('multitrack-extras-')
  fs.writeFileSync(path.join(extras, 'airtracks.apk'), Buffer.from('PK apk de prueba'))
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

  // airtracks.local (y alabanza.local, el nombre de antes): una pregunta mDNS (directa) se contesta con la IP de la compu
  const mdns = dgram.createSocket('udp4')
  t.after(() => mdns.close())
  for (const nombre of ['airtracks.local', 'alabanza.local']) {
    const q = dnsPacket.encode({ type: 'query', id: 7, questions: [{ name: nombre, type: 'A' }] })
    const resp = new Promise<dnsPacket.Packet>((res) => mdns.once('message', (m) => res(dnsPacket.decode(m))))
    mdns.send(q, puertoMdns, '127.0.0.1')
    const a = (await resp).answers?.find((x) => x.type === 'A') as { name: string; data: string } | undefined
    assert.ok(a && a.name === nombre && /^\d+\.\d+\.\d+\.\d+$/.test(a.data), `responde la IP a ${nombre}`)
  }

  // el servicio que busca la app Android: PTR con SRV (puerto) y TXT (id)
  const r2 = responderMdns([{ name: '_multitrack._tcp.local', type: 'PTR' }], { nombre: 'AirTracks · PC', puerto: 4848, id: 'abc', version: '1', requiereCodigo: true }, '192.168.1.35')!
  const srv = r2.additionals.find((x) => x.type === 'SRV') as { data: { port: number; target: string } }
  assert.equal(srv.data.port, 4848)
  assert.equal(srv.data.target, 'airtracks.local')
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
  const apk = await fetch(`http://localhost:${env.port}/app/airtracks.apk`)
  assert.equal(apk.status, 200)
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive')
  assert.match(apk.headers.get('content-disposition')!, /AirTracks\.apk/)
  // el enlace de antes del cambio de nombre sigue andando
  const vieja = await fetch(`http://localhost:${env.port}/app/alabanza.apk`)
  assert.equal(vieja.status, 200)
  assert.equal(vieja.url, `http://localhost:${env.port}/app/airtracks.apk`)
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

test('licencias: sin licencia hasta 2 celulares; la licencia (firmada, sin internet) habilita más, vence o se ata a una compu', async (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const clavePublica = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)).toString('base64url')
  const firmar = (d: Partial<DatosLicencia>): string => {
    const datos: DatosLicencia = { v: 1, id: crypto.randomUUID(), nombre: 'Iglesia Central', celulares: 3, emitida: '2026-01-10', ...d }
    const b64 = datosAFirmar(datos)
    return armarLicencia(b64, new Uint8Array(crypto.sign(null, Buffer.from(b64), privateKey)))
  }
  const env = await entorno(t, undefined, { clavePublicaLicencias: `# comentario\n${clavePublica}\n` })
  const compu = await env.conectar(compuAuth)
  const estado0 = await emitAck<EstadoLicencia>(compu, 'licencia:estado', {})
  assert.equal(estado0.configuradas, true)
  assert.equal(estado0.prueba, true)
  assert.match(estado0.equipo, /^EQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

  // version de prueba: 2 celulares; el tercero no entra (el que reconecta si)
  const cel = (id: string): Promise<ClientSocket> => env.conectar({ origen: 'celular', deviceId: id })
  const intentar = (id: string): Promise<{ motivo?: string; limite?: number; prueba?: boolean } | 'ok'> =>
    new Promise((resolve) => {
      const s = ioClient(`http://localhost:${env.port}`, { auth: { origen: 'celular', deviceId: id }, reconnection: false })
      s.once('connect', () => {
        s.close()
        resolve('ok')
      })
      s.once('connect_error', (e: Error & { data?: { motivo?: string; limite?: number; prueba?: boolean } }) => {
        s.close()
        assert.equal(e.message, 'licencia')
        resolve(e.data ?? {})
      })
    })
  const c1 = await cel('celular-numero-1')
  await cel('celular-numero-2')
  assert.deepEqual(await intentar('celular-numero-3'), { motivo: 'limite', limite: 2, prueba: true })
  c1.close()
  await esperar(150)
  assert.equal(await intentar('celular-numero-3'), 'ok', 'se libero un lugar')
  await cel('celular-numero-1')
  assert.equal(await intentar('celular-numero-1'), 'ok', 'el mismo celular reconectando no cuenta dos veces')

  // un celular no puede activar licencias
  const c2 = await env.conectar({ origen: 'celular', deviceId: 'celular-numero-2' })
  assert.equal((await emitAck<{ ok: boolean }>(c2, 'licencia:activar', { texto: firmar({}) })).ok, false)

  // licencias que no valen
  const activar = (texto: string): Promise<{ ok: boolean; error?: string; estado?: EstadoLicencia }> => emitAck(compu, 'licencia:activar', { texto })
  assert.match((await activar('hola')).error!, /no es una licencia/)
  const buena = firmar({ celulares: 3 })
  const [, datos, firma] = buena.split('.')
  const trucha = `LIC1.${Buffer.from(Buffer.from(datos, 'base64url').toString().replace('"celulares":3', '"celulares":0')).toString('base64url')}.${firma}`
  assert.match((await activar(trucha)).error!, /no es válida/, 'cambiar los datos rompe la firma')
  const { privateKey: otra } = crypto.generateKeyPairSync('ed25519')
  const b64 = datosAFirmar({ v: 1, id: 'x', nombre: 'Pirata', celulares: 0, emitida: '2026-01-01' })
  assert.match((await activar(armarLicencia(b64, new Uint8Array(crypto.sign(null, Buffer.from(b64), otra))))).error!, /no es válida/, 'firmada con otra clave')
  assert.match((await activar(firmar({ vence: '2020-12-31' }))).error!, /venció el 31\/12\/2020/)
  assert.match((await activar(firmar({ equipo: 'EQ-0000-0000-0000' }))).error!, /otra computadora/)

  // una buena (pegada de un chat: con espacios y saltos de linea), atada a esta compu y con 3 celulares
  const licencia = firmar({ celulares: 3, equipo: estado0.equipo, vence: '2099-01-01' })
  // (al sacar los espacios, "Gracias" queda pegado a la firma: no tiene que confundirla)
  const r = await activar(`Tu licencia:\n ${licencia.replace(/(.{40})/g, '$1\n')}\nGracias por la compra`)
  assert.equal(r.ok, true, r.error)
  assert.equal(fs.readFileSync(path.join(process.env.MULTITRACK_APP_DIR!, 'licencia.txt'), 'utf-8'), licencia, 'se guarda solo la licencia')
  assert.equal(r.estado!.activa, true)
  assert.equal(r.estado!.nombre, 'Iglesia Central')
  assert.equal(r.estado!.celulares, 3)
  assert.equal(await intentar('celular-numero-4'), 'ok', 'con 3 celulares entra el tercero')
  await cel('celular-numero-4')
  assert.deepEqual(await intentar('celular-numero-5'), { motivo: 'limite', limite: 3, prueba: false })

  // queda guardada (la app se abre de nuevo) y se puede quitar
  assert.equal(new Licencias(clavePublica).estado().activa, true)
  const q = await emitAck<{ ok: boolean; estado: EstadoLicencia }>(compu, 'licencia:quitar', {})
  assert.equal(q.estado.prueba, true)
  assert.equal(new Licencias(clavePublica).estado().activa, false)
  // sin clave publica (la version libre): sin limites
  assert.equal(new Licencias(null).limiteCelulares(), null)
  assert.equal(new Licencias('# todavia sin clave').estado().configuradas, false)
})

test('paneo por defecto: click y guía a la izquierda y la banda a la derecha (por nombre, por el análisis o marcadas); lo movido a mano se respeta', async (t) => {
  const pista = (id: string, nombre: string, extra: Partial<Pista> = {}): Pista => ({
    id,
    nombre,
    archivo: `${id}.wav`,
    volumen: 100,
    pan: 0,
    mute: false,
    solo: false,
    color: '#ffffff',
    ...extra
  })
  const cancion = () => ({
    pistas: [
      pista('a', 'Click 120'),
      pista('b', 'Voz Guía'),
      pista('c', 'Metrónomo', { rol: 'normal' }), // marcada como que no
      pista('d', 'Pista 7'), // es el click segun el analisis (por como suena)
      pista('e', 'Cues2', { rol: 'guia' }), // otra guia, marcada
      pista('f', 'Bajo'),
      pista('g', 'Guitarra')
    ],
    tempo: { bpm: 120, compas: 4, compasesMs: [], clickPistaId: 'd', acentoClaro: true },
    analisis: { estado: 'listo' as const, fuente: null, guiaPistaId: null }
  })
  const paneos = (p: { pistas: Pista[] }): Record<string, number> => Object.fromEntries(p.pistas.map((x) => [x.id, x.pan]))

  // cancion de antes, nadie toco el paneo (todo al centro): se acomoda
  const vieja = cancion()
  assert.equal(aplicarPaneoAutomatico(vieja), true)
  assert.deepEqual(paneos(vieja), { a: -100, b: -100, c: 100, d: -100, e: -100, f: 100, g: 100 })
  assert.ok(vieja.pistas.every((x) => x.panAutomatico === true))
  assert.equal(aplicarPaneoAutomatico(vieja), false, 'ya estaba')
  // el paneo es el del director, sin nada especial en la mezcla del celular
  const m = new Map(mezclaEfectiva(vieja.pistas).map((c) => [c.pistaId, c]))
  assert.equal(m.get('a')!.pan, -1)
  assert.equal(m.get('g')!.pan, 1)
  assert.equal(m.get('g')!.ganancia, 1)

  // cancion de antes con algun paneo puesto a mano: no se toca nada
  const tocada = cancion()
  tocada.pistas[5].pan = -30
  aplicarPaneoAutomatico(tocada)
  assert.deepEqual(paneos(tocada), { a: 0, b: 0, c: 0, d: 0, e: 0, f: -30, g: 0 })
  assert.ok(tocada.pistas.every((x) => x.panAutomatico === false))

  // la marca y el paneo se guardan en la ficha de la cancion
  const ficha = interpretarFicha(JSON.stringify(fichaDesdeProyecto({ ...vieja, id: 'x', nombre: 'x', duracionTotalMs: 1000, marcadores: [] } as unknown as Proyecto)))!
  const enFicha = (nombre: string) => ficha.pistas.find((p) => p.nombre === nombre)!
  assert.equal(enFicha('Metrónomo').rol, 'normal')
  assert.equal(enFicha('Cues2').rol, 'guia')
  assert.equal(enFicha('Bajo').rol, undefined)
  assert.equal(enFicha('Bajo').pan, 100)
  assert.equal(enFicha('Bajo').panAutomatico, true)

  // de punta a punta: al importar ya viene paneada; lo que se mueve a mano queda
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const silencio = wav16(new Float32Array(44100), 44100)
  const estado = await cargarZip(compu, crearZip('Paneo', { '01 Click.wav': silencio, '02 Guide.wav': silencio, '03 Bajo.wav': silencio, '04 Pad.wav': silencio }))
  const p = estado.proyectoActivo!
  const panDe = (nombre: string): number => env.server.state.getActiveTab()!.proyecto.pistas.find((x) => x.nombre === nombre)!.pan
  assert.deepEqual(
    p.pistas.map((x) => [x.nombre, x.pan]),
    [
      ['Click', -100],
      ['Guide', -100],
      ['Bajo', 100],
      ['Pad', 100]
    ]
  )
  const pad = p.pistas.find((x) => x.nombre === 'Pad')!
  compu.emit('mixer:update', { pistaId: pad.id, patch: { pan: 0 } })
  await esperar(150)
  assert.equal(panDe('Pad'), 0)
  assert.equal(env.server.state.getActiveTab()!.proyecto.pistas.find((x) => x.nombre === 'Pad')!.panAutomatico, false)
  // si la deteccion cambia (p.ej. el analisis encuentra el click en otra pista), lo movido a mano no se toca
  const proyecto = env.server.state.getActiveTab()!.proyecto
  proyecto.tempo = { bpm: 120, compas: 4, compasesMs: [], clickPistaId: pad.id, acentoClaro: true }
  aplicarPaneoAutomatico(proyecto)
  assert.equal(panDe('Pad'), 0)
  proyecto.tempo = { ...proyecto.tempo, clickPistaId: proyecto.pistas.find((x) => x.nombre === 'Bajo')!.id }
  aplicarPaneoAutomatico(proyecto)
  assert.equal(panDe('Bajo'), -100, 'la que sigue en automatico se reacomoda')

  // cancion guardada con una version anterior (sin la marca, todo al centro): al abrirla se acomoda y se guarda
  for (const x of proyecto.pistas) {
    delete x.panAutomatico
    x.pan = 0
  }
  proyecto.tempo = null
  await migrarProyecto(proyecto)
  assert.deepEqual(
    proyecto.pistas.map((x) => x.pan),
    [-100, -100, 100, 100]
  )
  const enDisco = JSON.parse(fs.readFileSync(path.join(process.env.MULTITRACK_APP_DIR!, 'proyectos', proyecto.id, 'proyecto.json'), 'utf-8')) as Proyecto
  assert.deepEqual(
    enDisco.pistas.map((x) => [x.pan, x.panAutomatico]),
    [
      [-100, true],
      [-100, true],
      [100, true],
      [100, true]
    ]
  )
  await env.cerrar()
})

/** Energia de `x` en la frecuencia `f` (Goertzel). */
/**
 * Cuan lejos (en cents) de `f` suena una pista hecha de notas separadas: el
 * pico del espectro en ±7 %, sumando cada nota por separado (sin fase: si se
 * mira la pista entera, las notas se anulan entre si y la medida engaña).
 */
function desafinacion(x: Float32Array, f: number, sr: number): number {
  const inicios: number[] = []
  let quieto = sr
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.15) {
      if (quieto > 0.05 * sr) inicios.push(i)
      quieto = 0
    } else quieto++
  }
  const w = Math.round(0.2 * sr)
  let mejor = 0
  let fm = f
  for (let g = f * 0.93; g <= f * 1.07; g += f * 0.0005) {
    let total = 0
    for (const i0 of inicios) {
      const a = i0 + Math.round(0.01 * sr)
      let re = 0
      let im = 0
      for (let i = 0; i < w && a + i < x.length; i++) {
        re += x[a + i] * Math.cos((2 * Math.PI * g * i) / sr)
        im -= x[a + i] * Math.sin((2 * Math.PI * g * i) / sr)
      }
      total += re * re + im * im
    }
    if (total > mejor) {
      mejor = total
      fm = g
    }
  }
  return Math.abs(1200 * Math.log2(fm / f))
}

function energiaEn(x: Float32Array, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr
  const c = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2
}

test('tono: tonalidad del nombre, qué pistas cambian y cómo se escribe', () => {
  assert.equal(tonalidadDesdeNombre('Gracia Sublime Es - 98 bpm - A'), 'A')
  assert.equal(tonalidadDesdeNombre('Digno (Bb)'), 'Bb')
  // la tonalidad antes del BPM (como vienen de algunas páginas de secuencias)
  assert.equal(tonalidadDesdeNombre('Coritos-MSM-G-115.00bpm'), 'G')
  assert.equal(tonalidadDesdeNombre('Fiesta En El Desierto-E-125BPM'), 'E')
  assert.equal(tonalidadDesdeNombre('Al Que Esta Sentado - F#m - 70 BPM'), 'F#m')
  assert.equal(tonalidadDesdeNombre('Tu Fidelidad 120 bpm'), null)
  assert.equal(tonalidadDesdeNombre('Oceans - Key of D'), 'D')
  assert.equal(tonalidadDesdeNombre('Way Maker - F#m'), 'F#m')
  assert.equal(tonalidadDesdeNombre('Santo - tono G'), 'G')
  assert.equal(tonalidadDesdeNombre('Abba Padre - A#'), 'Bb')
  assert.equal(tonalidadDesdeNombre('Rey de Reyes [Dbm]'), 'C#m')
  assert.equal(tonalidadDesdeNombre('Cuan Grande Es Él'), null)
  assert.equal(tonalidadDesdeNombre('Mi Dios es Grande'), null)
  assert.equal(tonalidadDesdeNombre('Alabanza 2'), null)
  assert.equal(normalizarTonalidad('a#'), 'Bb')
  assert.equal(normalizarTonalidad('gmin'), 'Gm')
  assert.equal(normalizarTonalidad('D menor'), 'Dm')
  assert.equal(normalizarTonalidad('H'), null)
  assert.equal(normalizarTonalidad(3), null)
  assert.equal(transponerTonalidad('A', 2), 'B')
  assert.equal(transponerTonalidad('Am', -1), 'G#m')
  assert.equal(transponerTonalidad('F#', 6), 'C')
  assert.equal(transponerTonalidad('Bb', -6), 'E')
  assert.equal(tonalidadOriginal({ nombre: 'Digno - A', tonalidad: 'C' }), 'C', 'la puesta a mano manda')

  assert.ok(pareceVoz('Coros') && pareceVoz('BGV 2') && pareceVoz('Voz Principal') && pareceVoz('Choir'))
  assert.ok(!pareceVoz('Guitarra') && !pareceVoz('Bajo'))
  assert.ok(pareceBateria('Drums') && pareceBateria('Batería') && pareceBateria('Kick In') && pareceBateria('OH L') && pareceBateria('Percusión'))
  assert.ok(!pareceBateria('Bajo') && !pareceBateria('Pad') && !pareceBateria('Hosanna'))
  const pista = (id: string, nombre: string, extra: Partial<Pista> = {}): Pista => ({ id, nombre, archivo: `${id}.wav`, volumen: 80, pan: 0, mute: false, solo: false, color: '#fff', ...extra })
  const p = {
    pistas: [pista('a', 'Click'), pista('b', 'Guía'), pista('c', 'Drums'), pista('d', 'Bajo'), pista('e', 'Coros'), pista('f', 'Pista 7'), pista('g', 'Metrónomo', { rol: 'normal' })],
    tempo: { bpm: 120, compas: 4, compasesMs: [], clickPistaId: 'f', acentoClaro: true }
  } as unknown as Proyecto
  assert.deepEqual(pistasQueCambianDeTono(p).map((x) => x.id), ['d', 'e', 'g'])
})

test('tono: la compu prepara las pistas en el tono nuevo (mismo largo, a tiempo con el click), el click y la batería quedan igual; se aplica al parar', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const sr = 44100
  const seg = 8
  // notas con ataque (para medir que sigan cayendo a tiempo)
  const notas = (f: number, armonicos: number): Float32Array => {
    const x = new Float32Array(seg * sr)
    for (let n = 0; n < 14; n++) {
      const i0 = Math.round((0.3 + n * 0.5 + (n % 3) * 0.07) * sr)
      for (let i = 0; i < sr * 0.45 && i0 + i < x.length; i++) {
        const tt = i / sr
        let v = 0
        for (let k = 1; k <= armonicos; k++) v += Math.sin(2 * Math.PI * f * k * tt) / k
        x[i0 + i] += 0.3 * Math.min(1, tt / 0.004) * Math.exp(-tt / 0.15) * v
      }
    }
    return x
  }
  const ruido = new Float32Array(seg * sr)
  for (let i = 0; i < ruido.length; i++) ruido[i] = (i % sr) < 3000 ? 0.3 * (Math.random() * 2 - 1) * Math.exp(-(i % sr) / 800) : 0
  const originales = { Click: wav16(notas(1000, 1), sr), Drums: wav16(ruido, sr), Bajo: wav16(notas(110, 3), sr), Coros: wav16(notas(220, 6), sr) }
  const estado = await cargarZip(
    compu,
    crearZip('Digno - 72 bpm - A', Object.fromEntries(Object.entries(originales).map(([n, b]) => [`${n}.wav`, b])))
  )
  const p = estado.proyectoActivo!
  assert.equal(tonalidadOriginal(p), 'A')
  const pista = (nombre: string): Pista => p.pistas.find((x) => x.nombre === nombre)!
  const media = async (nombre: string, revision: number): Promise<{ bytes: Buffer; x: Float32Array }> => {
    const r = await fetch(`http://localhost:${env.port}/media/${p.id}/${pista(nombre).archivo.split('/').map(encodeURIComponent).join('/')}?v=${revision}`)
    assert.equal(r.status, 200)
    const bytes = Buffer.from(await r.arrayBuffer())
    const info = parseWavHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const x = decodePcmSegment(info, bytes.buffer.slice(bytes.byteOffset + info.dataOffset, bytes.byteOffset + info.dataOffset + info.dataLength) as ArrayBuffer)[0]
    return { bytes, x }
  }
  const esperarTono = (n: number, ms = 90000): Promise<EstadoCompleto> =>
    esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => (e.proyectoActivo?.tonoAplicado ?? 0) === n, ms)

  // valores que no van
  for (const semitonos of [7, -7, 1.5, '2', null]) {
    const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos })
    assert.equal(r.ok, false, `semitonos ${String(semitonos)}`)
  }

  // +2: se prepara (sigue sonando el original) y cuando estan todas, pasa
  const revisionAntes = p.revision ?? 0
  const listo = esperarTono(2)
  const progresos: ProgresoTono[] = []
  compu.on('tono:progreso', (x: ProgresoTono) => progresos.push(x))
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: 2 })
  assert.equal(r.ok, true, r.error)
  const pedido = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(pedido.proyectoActivo!.tono, 2)
  assert.equal(pedido.proyectoActivo!.tonoAplicado ?? 0, 0, 'mientras se prepara suena el original')
  const e2 = (await listo).proyectoActivo!
  assert.equal(e2.revision, revisionAntes + 1, 'los dispositivos vuelven a cargar la cancion')
  assert.deepEqual([...e2.tonoPistas!].sort(), [pista('Bajo').id, pista('Coros').id].sort(), 'el click y la bateria no cambian')
  assert.ok(progresos.some((x) => x.semitonos === 2 && x.total === 2 && x.hechos === 2))

  // lo que sirve /media: el bajo y los coros, un tono mas arriba (110 -> 123,5 Hz), mismo largo y a tiempo
  const bajo = await media('Bajo', e2.revision!)
  const bajoOriginal = decodePcmSegment(parseWavHeader(originales.Bajo.buffer.slice(originales.Bajo.byteOffset) as ArrayBuffer), originales.Bajo.buffer.slice(originales.Bajo.byteOffset + 44, originales.Bajo.byteOffset + originales.Bajo.byteLength) as ArrayBuffer)[0]
  assert.equal(bajo.x.length, seg * sr, 'mismo largo exacto')
  const rms = (x: Float32Array): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
  assert.ok(Math.abs(20 * Math.log10(rms(bajo.x) / rms(bajoOriginal))) < 1, 'con el mismo volumen')
  assert.ok(energiaEn(bajo.x, 123.47, sr) > 5 * energiaEn(bajo.x, 110, sr), 'suena un tono mas arriba')
  // y afinado (la deteccion de ataques de fabrica de rubberband desafinaba hasta ~20 cents)
  assert.ok(desafinacion(bajo.x, 110 * 2 ** (2 / 12), sr) < 5, `afinado (${desafinacion(bajo.x, 110 * 2 ** (2 / 12), sr).toFixed(1)} cents)`)
  const corrimiento = demoraEntre(bajoOriginal, bajo.x, sr) * 1000
  assert.ok(Math.abs(corrimiento) < 1.5, `las notas siguen cayendo a tiempo (corrida ${corrimiento.toFixed(2)} ms)`)
  const coros = await media('Coros', e2.revision!)
  assert.equal(coros.x.length, seg * sr)
  assert.ok(energiaEn(coros.x, 246.94, sr) > 5 * energiaEn(coros.x, 220, sr), 'los coros tambien')
  const click = await media('Click', e2.revision!)
  assert.ok(click.bytes.subarray(44).equals(originales.Click.subarray(44)), 'el click es el mismo')
  const drums = await media('Drums', e2.revision!)
  assert.ok(drums.bytes.subarray(44).equals(originales.Drums.subarray(44)), 'la bateria es la misma')
  // la mezcla de los celulares usa las pistas transpuestas
  const canales = mezclaEfectiva(e2.pistas).map((c) => ({ ...c, ganancia: c.pistaId === pista('Bajo').id ? 1 : 0 }))
  const rm = await fetch(`http://localhost:${env.port}/mezcla/${p.id}/1.wav?v=${e2.revision}&m=${codificarMezcla(canales)}`)
  assert.equal(rm.status, 200)
  const bm = await rm.arrayBuffer()
  const im = parseWavHeader(bm)
  const [mL, mR] = decodePcmSegment(im, bm.slice(im.dataOffset))
  const mono = mL.map((v, i) => v + mR[i])
  assert.ok(energiaEn(mono, 123.47, sr) > 5 * energiaEn(mono, 110, sr), 'la mezcla del celular tambien suena en el tono nuevo')

  // sonando no se cambia
  compu.emit('transport:play', {})
  await esperar(100)
  const sonando = await emitAck<{ ok: boolean; error?: string }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: -3 })
  assert.equal(sonando.ok, false)
  assert.match(sonando.error ?? '', /Pará la música/)
  compu.emit('transport:stop', {})
  await esperar(100)

  // si le dan play mientras se prepara, el tono nuevo entra recien al parar
  const preparado = esperarEvento<ProgresoTono>(compu, 'tono:progreso', (x) => x.semitonos === -3 && x.total > 0 && x.hechos === x.total, 90000)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: -3 })).ok, true)
  compu.emit('transport:play', {})
  await preparado
  await esperar(1500)
  let ahora = (await emitAck<EstadoCompleto>(compu, 'state:request', {})).proyectoActivo!
  assert.equal(ahora.tonoAplicado, 2, 'sonando: sigue en el tono de antes')
  const menos3 = esperarTono(-3, 10000)
  compu.emit('transport:stop', {})
  ahora = (await menos3).proyectoActivo!
  assert.deepEqual(fs.readdirSync(path.join(env.appDir, 'proyectos', p.id, 'tono')), ['-3'], 'queda solo el ultimo tono')
  const bajoMenos3 = (await media('Bajo', ahora.revision!)).x
  assert.ok(energiaEn(bajoMenos3, 92.5, sr) > 5 * energiaEn(bajoMenos3, 110, sr), 'un tono y medio mas abajo')
  assert.ok(desafinacion(bajoMenos3, 110 * 2 ** (-3 / 12), sr) < 5, `afinado (${desafinacion(bajoMenos3, 110 * 2 ** (-3 / 12), sr).toFixed(1)} cents)`)

  // volver al original: enseguida, y se borran las pistas transpuestas
  const cero = esperarTono(0, 5000)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: 0 })).ok, true)
  ahora = (await cero).proyectoActivo!
  assert.deepEqual(ahora.tonoPistas, [])
  assert.equal(fs.existsSync(path.join(env.appDir, 'proyectos', p.id, 'tono')), false)
  assert.ok((await media('Bajo', ahora.revision!)).bytes.subarray(44).equals(originales.Bajo.subarray(44)))

  // tonalidad original a mano (y "la del nombre" otra vez)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:tonalidad', { proyectoId: p.id, tonalidad: 'bb' })).ok, true)
  assert.equal((await emitAck<EstadoCompleto>(compu, 'state:request', {})).proyectoActivo!.tonalidad, 'Bb')
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:tonalidad', { proyectoId: p.id, tonalidad: 'X' })).ok, false)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:tonalidad', { proyectoId: p.id, tonalidad: null })).ok, true)
  assert.equal((await emitAck<EstadoCompleto>(compu, 'state:request', {})).proyectoActivo!.tonalidad, undefined)

  // el tono y la tonalidad van en la ficha de la cancion
  const ficha = interpretarFicha(JSON.stringify(fichaDesdeProyecto({ ...ahora, tono: -2, tonalidad: 'G' })))!
  assert.equal(ficha.tono, -2)
  assert.equal(ficha.tonalidad, 'G')
  await env.cerrar()
})

test('velocidad: la compu prepara TODAS las pistas más rápido o más lento (mismo tono, a tiempo) y la canción pasa a ese tiempo', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const sr = 44100
  const seg = 8
  const golpes = Array.from({ length: 14 }, (_, n) => 0.3 + n * 0.5 + (n % 3) * 0.07)
  const notas = (f: number, armonicos: number): Float32Array => {
    const x = new Float32Array(seg * sr)
    for (const t0 of golpes) {
      const i0 = Math.round(t0 * sr)
      for (let i = 0; i < sr * 0.45 && i0 + i < x.length; i++) {
        const tt = i / sr
        let v = 0
        for (let k = 1; k <= armonicos; k++) v += Math.sin(2 * Math.PI * f * k * tt) / k
        x[i0 + i] += 0.3 * Math.min(1, tt / 0.004) * Math.exp(-tt / 0.15) * v
      }
    }
    return x
  }
  const originales = { Click: wav16(notas(1000, 1), sr), Guia: wav16(notas(300, 2), sr), Bajo: wav16(notas(110, 3), sr) }
  const estado = await cargarZip(
    compu,
    crearZip('Rapida - A', { ...Object.fromEntries(Object.entries(originales).map(([n, b]) => [`${n}.wav`, b])), 'marcas.txt': Buffer.from('0:02 Verso\n0:05 Coro\n') })
  )
  const p = estado.proyectoActivo!
  const tab = env.server.state.getActiveTab()!
  const pista = (nombre: string): Pista => p.pistas.find((x) => x.nombre === nombre)!
  tab.proyecto.tempo = { bpm: 120, compas: 4, compasesMs: [0, 2000, 4000, 6000], clickPistaId: pista('Click').id, acentoClaro: true }
  const media = async (nombre: string, revision: number): Promise<Float32Array> => {
    const r = await fetch(`http://localhost:${env.port}/media/${p.id}/${pista(nombre).archivo.split('/').map(encodeURIComponent).join('/')}?v=${revision}`).catch((e) => {
      throw new Error(`media ${nombre} r${revision}: ${e.cause?.code ?? e}`)
    })
    assert.equal(r.status, 200)
    const b = await r.arrayBuffer()
    const info = parseWavHeader(b)
    return decodePcmSegment(info, b.slice(info.dataOffset, info.dataOffset + info.dataLength))[0]
  }
  /** Donde arranca cada nota (lo que pasa de 0,15 despues de 50 ms por debajo). */
  const inicios = (x: Float32Array): number[] => {
    const res: number[] = []
    let quieto = sr
    for (let i = 0; i < x.length; i++) {
      if (Math.abs(x[i]) > 0.15) {
        if (quieto > 0.05 * sr) res.push(i / sr)
        quieto = 0
      } else quieto++
    }
    return res
  }
  const originalDe = (nombre: keyof typeof originales): Float32Array => {
    const b = originales[nombre]
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    const info = parseWavHeader(ab)
    return decodePcmSegment(info, ab.slice(info.dataOffset))[0]
  }
  /**
   * Cada nota arranca donde arrancaba en la original, pasado al tiempo nuevo.
   * (Se mide por donde la onda pasa un umbral: en una nota grave eso puede
   * saltar medio ciclo, 4,5 ms a 110 Hz; lo fino se mide en el click, 1 kHz.)
   */
  const aTiempo = (x: Float32Array, nombre: keyof typeof originales, v: number, que: string, tolMs = 1.5): void => {
    const antes = inicios(originalDe(nombre))
    const ahora = inicios(x)
    assert.equal(antes.length, golpes.length, `${que}: ${antes.length} notas en la original`)
    assert.equal(ahora.length, golpes.length, `${que}: ${ahora.length} notas`)
    const peor = Math.max(...ahora.map((t0, i) => Math.abs(t0 - antes[i] / v))) * 1000
    assert.ok(peor < tolMs, `${que}: las notas caen a tiempo a la velocidad nueva (peor: ${peor.toFixed(2)} ms; ${ahora.map((t0, i) => ((t0 - antes[i] / v) * 1000).toFixed(1)).join(" ")})`)
  }
  const tonoDe = (x: Float32Array, f: number): number => desafinacion(x, f, sr)
  const esperarVelocidad = (v: number, ms = 120000): Promise<EstadoCompleto> =>
    esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => (e.proyectoActivo?.velocidadAplicada ?? 1) === v, ms)

  // parada en el Coro, a los 5 s
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:seek', { positionMs: 5000 })])
  for (const velocidad of [1.3, 0.7, '1.1', null]) {
    const r = await emitAck<{ ok: boolean }>(compu, 'velocidad:cambiar', { proyectoId: p.id, velocidad })
    assert.equal(r.ok, false, `velocidad ${String(velocidad)}`)
  }

  // +10 %: se preparan todas (tambien el click y la guia) y la cancion pasa a ese tiempo
  const listo = esperarVelocidad(1.1)
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'velocidad:cambiar', { proyectoId: p.id, velocidad: 1.1 })
  assert.equal(r.ok, true, r.error)
  const e = await listo
  const pa = e.proyectoActivo!
  assert.deepEqual([...pa.tonoPistas!].sort(), p.pistas.map((x) => x.id).sort(), 'a otra velocidad cambian todas')
  assert.ok(Math.abs(pa.duracionTotalMs - 8000 / 1.1) <= 1, `duración ${pa.duracionTotalMs}`)
  assert.deepEqual(pa.marcadores.map((m) => m.tiempoMs), [Math.round(2000 / 1.1), Math.round(5000 / 1.1)], 'las secciones, en el tiempo nuevo')
  assert.ok(Math.abs(pa.tempo!.bpm - 132) < 1e-6)
  pa.tempo!.compasesMs.forEach((c, i) => assert.ok(Math.abs(c - (i * 2000) / 1.1) < 0.01))
  assert.ok(Math.abs(e.playbackActivo!.positionMs - 5000 / 1.1) <= 1, 'sigue parada en el mismo punto de la música')
  // (se baja todo antes de analizar: el analisis tarda y la conexion que queda abierta se cierra sola)
  const [bajo, click] = [await media('Bajo', pa.revision!), await media('Click', pa.revision!)]
  assert.equal(bajo.length, Math.round((seg * sr) / 1.1), 'el largo exacto a la velocidad nueva')
  assert.ok(tonoDe(bajo, 110) < 5, `en el mismo tono (${tonoDe(bajo, 110).toFixed(1)} cents)`)
  aTiempo(bajo, 'Bajo', 1.1, 'bajo', 6.5)
  aTiempo(click, 'Click', 1.1, 'click', 2.5)
  assert.ok(tonoDe(click, 1000) < 5, `el click no cambia de tono (${tonoDe(click, 1000).toFixed(1)} cents)`)
  // la ficha guarda los tiempos originales (y la velocidad elegida)
  const ficha = interpretarFicha(JSON.stringify(fichaDesdeProyecto(pa)))!
  assert.deepEqual(ficha.marcadores.map((m) => m.tiempoMs), [2000, 5000])
  assert.ok(Math.abs(ficha.tempo!.bpm - 120) < 1e-6)
  assert.ok(Math.abs(ficha.duracionTotalMs - 8000) <= 1)
  assert.equal(ficha.velocidad, 1.1)

  // con otro tono ademas: el bajo sube un tono, el click y la guia solo se estiran
  const conTono = esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => x.proyectoActivo?.tonoAplicado === 2, 120000)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: 2 })).ok, true)
  const pt = (await conTono).proyectoActivo!
  assert.equal(pt.velocidadAplicada, 1.1)
  assert.deepEqual(pt.marcadores.map((m) => m.tiempoMs), [Math.round(2000 / 1.1), Math.round(5000 / 1.1)], 'el tono no mueve los tiempos')
  assert.deepEqual(fs.readdirSync(path.join(env.appDir, 'proyectos', p.id, 'tono')), ['2v11000'])
  const [bajo2, guia] = [await media('Bajo', pt.revision!), await media('Guia', pt.revision!)]
  assert.ok(tonoDe(bajo2, 110 * 2 ** (2 / 12)) < 5, `el bajo un tono más arriba (${tonoDe(bajo2, 110 * 2 ** (2 / 12)).toFixed(1)} cents)`)
  aTiempo(bajo2, 'Bajo', 1.1, 'bajo con tono', 6.5)
  assert.ok(tonoDe(guia, 300) < 5, `la guía no cambia de tono (${tonoDe(guia, 300).toFixed(1)} cents)`)

  // de vuelta a la original (tono y velocidad): los tiempos vuelven y quedan las pistas de siempre
  const original = esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.proyectoActivo?.velocidadAplicada && (x.proyectoActivo?.tonoAplicado ?? 0) === 0, 10000)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'tono:cambiar', { proyectoId: p.id, semitonos: 0 })).ok, true)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'velocidad:cambiar', { proyectoId: p.id, velocidad: 1 })).ok, true)
  const e0 = await original
  const p0 = e0.proyectoActivo!
  assert.deepEqual(p0.marcadores.map((m) => m.tiempoMs), [2000, 5000])
  assert.ok(Math.abs(p0.tempo!.bpm - 120) < 1e-6)
  assert.ok(Math.abs(p0.duracionTotalMs - 8000) <= 1)
  assert.ok(Math.abs(e0.playbackActivo!.positionMs - 5000) <= 1)
  assert.equal(fs.existsSync(path.join(env.appDir, 'proyectos', p.id, 'tono')), false)
  assert.equal((await media('Bajo', p0.revision!)).length, seg * sr)
  await env.cerrar()
})

test('firewall de Windows: detecta cuando bloquea a los celulares en la red de ahora (red pública nueva)', () => {
  const perfiles = [
    { nombre: 'Domain', activo: 'True' },
    { nombre: 'Private', activo: 'True' },
    { nombre: 'Public', activo: 'True' }
  ]
  const casa = { nombre: 'WiFi Casa', interfaz: 'Wi-Fi', categoria: 'Private' }
  const iglesia = { nombre: 'Iglesia', interfaz: 'Wi-Fi', categoria: 'Public' }
  // lo que deja Windows al aceptar su aviso con "redes publicas" sin marcar: permitir en privadas, BLOQUEAR en publicas
  const delAviso = [
    { nombre: 'AirTracks Wireless Monitor', habilitada: 'True', accion: 'Allow', perfil: 'Private' },
    { nombre: 'AirTracks Wireless Monitor', habilitada: 'True', accion: 'Block', perfil: 'Public' }
  ]
  const d = (redes: DatosFirewall['redes'], reglas: DatosFirewall['reglas'], extra: Partial<DatosFirewall> = {}): DatosFirewall => ({
    redes,
    reglas,
    perfiles,
    legible: true,
    ...extra
  })

  assert.equal(evaluarFirewall(d([casa], delAviso)).estado, 'ok', 'en casa anda')
  const fuera = evaluarFirewall(d([iglesia], delAviso))
  assert.equal(fuera.estado, 'bloqueado', 'en otro lugar (red publica) no')
  assert.deepEqual(fuera.bloqueadas, [{ nombre: 'Iglesia', categoria: 'publica' }])
  // un bloqueo gana aunque haya un permiso para todas las redes (el del instalador)
  assert.equal(evaluarFirewall(d([iglesia], [...delAviso, { nombre: 'x', habilitada: 'True', accion: 'Allow', perfil: 'Any' }])).estado, 'bloqueado')
  // despues de "Permitir en todas las redes": una sola regla que permite en cualquiera
  const arreglado = [{ nombre: 'AirTracks Wireless Monitor', habilitada: 'True', accion: 'Allow', perfil: 'Any' }]
  assert.equal(evaluarFirewall(d([iglesia], arreglado)).estado, 'ok')
  assert.equal(evaluarFirewall(d([iglesia], [{ nombre: 'x', habilitada: 'True', accion: 'Allow', perfil: 'Private, Public' }])).estado, 'ok')
  // sin ninguna regla, Windows bloquea; un bloqueo deshabilitado no cuenta
  assert.equal(evaluarFirewall(d([iglesia], [])).estado, 'bloqueado')
  assert.equal(evaluarFirewall(d([iglesia], [{ ...delAviso[1], habilitada: 'False' }, ...arreglado])).estado, 'ok')
  // con el firewall apagado en las redes publicas no hay nada que bloquee
  assert.equal(evaluarFirewall(d([iglesia], delAviso, { perfiles: [perfiles[0], perfiles[1], { nombre: 'Public', activo: 'False' }] })).estado, 'ok')
  // las redes de adaptadores virtuales (Hyper-V, VPN) no cuentan: por ahi no entran los celulares
  const hyperv = { nombre: 'Red no identificada', interfaz: 'vEthernet (Default Switch)', categoria: 'Public' }
  assert.equal(evaluarFirewall(d([casa, hyperv], delAviso), esAdaptadorVirtual).estado, 'ok')
  // si no se pudo leer el firewall o no hay red, no se sabe (nunca una falsa alarma)
  assert.equal(evaluarFirewall(d([iglesia], [], { legible: false })).estado, 'desconocido')
  assert.equal(evaluarFirewall(d([], delAviso)).estado, 'desconocido')
})

test('cuenta: los golpes caen en la grilla de la canción (1 2 3 4, 1 2 3 4) y la música entra justo después', () => {
  // 120 BPM 4/4: compases de 2 s, el primero en 0
  const t44 = { compasesMs: [0, 2000, 4000, 6000, 8000], compas: 4 }
  const enUno = golpesDeCuenta(t44, 4000, 2)!
  assert.deepEqual(enUno.golpes.map((g) => g.n), [1, 2, 3, 4, 1, 2, 3, 4])
  assert.deepEqual(enUno.golpes.map((g) => g.ms), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500])
  assert.deepEqual(golpesDeCuenta(t44, 0, 1)!.golpes.map((g) => [g.ms, g.n]), [[-2000, 1], [-1500, 2], [-1000, 3], [-500, 4]])
  // reanudar a mitad de compas: la cuenta sigue el pulso de la cancion hasta ese punto ("3 4 1 2 3 4 1 2")
  const mitad = golpesDeCuenta(t44, 4750, 2)!
  assert.deepEqual(mitad.golpes.map((g) => g.n), [3, 4, 1, 2, 3, 4, 1, 2])
  assert.equal(mitad.golpes[mitad.golpes.length - 1].ms, 4500)
  // la cancion tiene una entrada antes del primer "1" (el click empieza a los 1,2 s): la cuenta termina en ese "1"
  const conEntrada = golpesDeCuenta({ compasesMs: [1200, 3200, 5200], compas: 4 }, 0, 2)!
  assert.deepEqual(conEntrada.golpes.map((g) => g.ms), [-2800, -2300, -1800, -1300, -800, -300, 200, 700])
  assert.deepEqual(conEntrada.golpes.map((g) => g.n), [1, 2, 3, 4, 1, 2, 3, 4])
  // 3/4 y 6/8
  assert.deepEqual(golpesDeCuenta({ compasesMs: [0, 1500, 3000], compas: 3 }, 3000, 2)!.golpes.map((g) => g.n), [1, 2, 3, 1, 2, 3])
  assert.equal(golpesDeCuenta({ compasesMs: [0, 3000, 6000], compas: 6 }, 3000, 1)!.golpes.length, 6)
  // sin tempo: sin cuenta
  assert.equal(golpesDeCuenta(null, 0, 2), null)
  assert.equal(golpesDeCuenta({ compasesMs: [0], compas: 4 }, 0, 2), null)

  // automatica: 1 compas (tambien en las lentas); lo elegido manda
  const tempo = (compasMs: number, cuentaPropia?: number) => ({ bpm: 1, compas: 4, compasesMs: [0, 1, 2, 3, 4].map((k) => k * compasMs), clickPistaId: null, acentoClaro: true, cuentaPropia })
  assert.equal(compasesDeCuenta({ tempo: tempo(2000) }, 0), 1)
  assert.equal(compasesDeCuenta({ tempo: tempo(4000) }, 0), 1, '60 BPM')
  assert.equal(compasesDeCuenta({ tempo: tempo(2000), cuenta: 0 }, 0), 0)
  assert.equal(compasesDeCuenta({ tempo: tempo(4000), cuenta: 2 }, 0), 2)
  assert.equal(compasesDeCuenta({ tempo: null, cuenta: 2 }, 0), 0, 'sin tempo no hay cuenta')
  // la cancion ya trae 2 compases de cuenta (la guia cuenta con la banda en silencio): desde el principio cuenta ella
  const propia = tempo(2000, 2)
  assert.equal(compasesDeCuenta({ tempo: propia }, 0), 0)
  assert.equal(compasesDeCuenta({ tempo: propia }, 2000), 0, 'desde adentro de su cuenta: queda un compas de ella')
  assert.equal(compasesDeCuenta({ tempo: propia }, 4000), 1, 'desde donde entra la banda, una seccion o una pausa: 1 compas del click')
  assert.equal(compasesDeCuenta({ tempo: propia }, 9000), 1)
  assert.equal(compasesDeCuenta({ tempo: propia, cuenta: 2 }, 0), 2, 'lo elegido manda')
  assert.equal(compasesDeCuenta({ tempo: { ...propia, compasesMs: [500, 2500, 4500, 6500] } }, 0), 0, 'con un silencio antes del primer compas')
  assert.equal(suenaSuCuenta(tempo(2000, 0), 0), false)
  assert.equal(suenaSuCuenta(tempo(2000), 0), false, 'sin revisar todavia: como si no trajera')

  // con horas: el primer golpe en `primerGolpe`, la musica 8 pulsos despues
  const p = programarCuenta(t44, 4000, 2, 100_000)!
  assert.equal(p.cuenta.golpes[0].t, 100_000)
  assert.equal(p.inicioMusica, 104_000)
  assert.equal(p.cuenta.golpes[7].t, 103_500)
  assert.equal(golpeActual(p.cuenta, 99_000), 0)
  assert.equal(golpeActual(p.cuenta, 100_010), 1)
  assert.equal(golpeActual(p.cuenta, 101_600), 4)
  assert.equal(golpeActual(p.cuenta, 103_900), 4)
  assert.equal(golpeActual(p.cuenta, 104_100), 0, 'ya entró la música')
})

test('cuenta: al dar play (parado o en pausa) la compu programa la cuenta con el sonido del click de la canción; se puede cambiar por canción', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const sr = 44100
  // click a 120 BPM 4/4 desde 0,5 s, con el "1" mas agudo y fuerte
  const click = generarClick(120, 4, 12)
  const estado = await cargarZip(compu, crearZip('Con cuenta', { 'Click.wav': wav16(click, sr), 'Bajo.wav': wav16(new Float32Array(12 * sr), sr) }))
  const p = env.server.state.getActiveTab()!.proyecto
  p.tempo = { bpm: 120, compas: 4, compasesMs: [500, 2500, 4500, 6500, 8500, 10500], clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }

  // el sonido de la cuenta: el "1" y un golpe comun, recortados del click (desde el ataque)
  const r = await fetch(`http://localhost:${env.port}/cuenta/${p.id}.wav?v=${p.revision ?? 0}`)
  assert.equal(r.status, 200)
  const buf = await r.arrayBuffer()
  const info = parseWavHeader(buf)
  const [x] = decodePcmSegment(info, buf.slice(info.dataOffset))
  const hueco = Math.round(LARGO_SONIDO_CUENTA_SEC * sr)
  assert.equal(x.length, 2 * hueco)
  const pico = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  assert.ok(pico(x.subarray(0, hueco)) > 0.8, 'el "1" (fuerte)')
  assert.ok(pico(x.subarray(hueco)) > 0.4 && pico(x.subarray(hueco)) < 0.7, 'un golpe comun')
  assert.ok(pico(x.subarray(0, Math.round(0.003 * sr))) > 0.3, 'empieza en el ataque (sin silencio antes)')
  assert.equal((await fetch(`http://localhost:${env.port}/cuenta/${crypto.randomUUID()}.wav`)).status, 404)

  // play desde parado: 1 compas de cuenta antes del comienzo (la cuenta termina en el primer "1", a los 0,5 s)
  const t0 = Date.now()
  const [cmd] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  const cuenta = cmd.playback.cuenta!
  assert.ok(cuenta, 'lleva cuenta')
  assert.deepEqual(cuenta.golpes.map((g) => g.n), [1, 2, 3, 4])
  assert.ok(cuenta.golpes[0].t >= t0, 'el primer golpe con el margen de sync')
  assert.equal(cmd.executeAtServerTime - cuenta.golpes[0].t, 1500, 'la musica (desde 0) entra 1,5 s despues: la cuenta termina en el "1" de los 0,5 s')
  assert.equal(cuenta.golpes[3].t - cmd.executeAtServerTime, 0)

  // en pausa y play otra vez: cuenta que llega justo al punto donde se paro
  await esperar(Math.max(0, cmd.executeAtServerTime - Date.now()) + 700)
  const [pausa] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:pause')])
  await esperar(100) // que la pausa llegue a su horario
  const [otra] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  assert.equal(otra.positionMs, pausa.positionMs)
  const ultimo = otra.playback.cuenta!.golpes[otra.playback.cuenta!.golpes.length - 1]
  assert.ok(ultimo.t < otra.executeAtServerTime && otra.executeAtServerTime - ultimo.t <= 500, 'el ultimo golpe, a menos de un pulso de la entrada')
  // sonando, un salto no lleva cuenta
  const [salto] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:seek', { positionMs: 8500, inmediato: true })])
  assert.equal(salto.playback.cuenta, undefined)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop')])

  // "Sin cuenta" en esta cancion: arranca como antes
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'cuenta:set', { proyectoId: p.id, cuenta: 0 })).ok, true)
  assert.equal((await emitAck<EstadoCompleto>(compu, 'state:request', {})).proyectoActivo!.cuenta, 0)
  const [sin] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  assert.equal(sin.playback.cuenta, undefined)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop')])
  // 2 compases; y de vuelta a automatica
  await esperar(100) // que el stop llegue a su horario
  await emitAck(compu, 'cuenta:set', { proyectoId: p.id, cuenta: 2 })
  const [dos] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  assert.deepEqual(dos.playback.cuenta!.golpes.map((g) => g.n), [1, 2, 3, 4, 1, 2, 3, 4], `desde ${dos.positionMs} (${dos.accion})`)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop')])
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'cuenta:set', { proyectoId: p.id, cuenta: 5 })).ok, false)
  await emitAck(compu, 'cuenta:set', { proyectoId: p.id, cuenta: null })
  assert.equal((await emitAck<EstadoCompleto>(compu, 'state:request', {})).proyectoActivo!.cuenta, undefined)
  // la eleccion va en la ficha de la cancion
  assert.equal(interpretarFicha(JSON.stringify(fichaDesdeProyecto({ ...p, cuenta: 1 })))!.cuenta, 1)
  void estado
  await env.cerrar()
})

test('compases que faltan: hasta el final de la sección (o hasta el salto elegido), contando el que suena', () => {
  const c = [0, 2000, 4000, 6000, 8000, 10000]
  const verso = { finMs: 8000 }
  assert.equal(compasesQueFaltan(c, verso, 0), 4)
  assert.equal(compasesQueFaltan(c, verso, 1990), 4)
  assert.equal(compasesQueFaltan(c, verso, 2000), 3)
  assert.equal(compasesQueFaltan(c, verso, 7990), 1, 'el último')
  // la marca de la seccion unos ms corrida del compas: igual
  assert.equal(compasesQueFaltan(c, { finMs: 8030 }, 6500), 1)
  assert.equal(compasesQueFaltan(c, { finMs: 7970 }, 6500), 1)
  // un salto elegido en el proximo compas: este es el ultimo; al final de la seccion, como sin salto
  assert.equal(compasesQueFaltan(c, verso, 2500, 4000), 1)
  assert.equal(compasesQueFaltan(c, verso, 2500, 8000), 3)
  // la ultima seccion, hasta el final de la cancion
  assert.equal(compasesQueFaltan(c, { finMs: 11000 }, 8200), 2)
  // sin tempo, o antes del primer compas (una entrada antes del "1"): no se sabe
  assert.equal(compasesQueFaltan(null, verso, 0), null)
  assert.equal(compasesQueFaltan([500, 2500, 4500], verso, 100), null)
  assert.deepEqual([textoQueFaltan(1), textoQueFaltan(3), textoQueFaltan(null)], ['último compás', 'faltan 3', null])
})

test('AirTracks Video: la huella encuentra dónde empieza la canción en su video, y no se confunde con otra grabación', () => {
  const seg = 120
  const { banda, voz } = generarBanda(seg, 7)
  /** el "lyric video": la misma grabacion (con la voz que la multitrack no tiene) corrida `desfase` s, mas bajo y con ruido */
  const video = (desfase: number, ganancia = 0.7): Float32Array => {
    const n0 = Math.round(desfase * 8000)
    const v = new Float32Array(Math.max(0, n0) + banda.length + 8000 * 3)
    let semilla = 99
    for (let i = 0; i < banda.length; i++) {
      const j = i + n0
      if (j >= 0 && j < v.length) v[j] += ganancia * (banda[i] + 1.5 * voz[i])
    }
    for (let i = 0; i < v.length; i++) v[i] += 0.01 * (((semilla = (semilla * 16807) % 2147483647) / 2147483647) * 2 - 1)
    return v
  }
  const cancion = huellaDeBytes(huellaABytes(calcularHuella(banda)))
  for (const desfase of [4.37, -2.5, 1.234]) {
    const a = alinear(cancion, huellaDeBytes(huellaABytes(calcularHuella(video(desfase, desfase === 1.234 ? 0.3 : 0.7)))))!
    assert.ok(Math.abs(a.desfaseMs - desfase * 1000) <= 20, `desfase ${a.desfaseMs} (esperado ${desfase * 1000})`)
    assert.equal(alineacionSegura(a), true, JSON.stringify(a))
  }
  // otra cancion (otro tempo), o la misma grabada de nuevo (un poco mas rapida): no se toma como buena
  for (const [semilla, bpm] of [
    [4242, 80],
    [7, 77.2]
  ]) {
    const otra = generarBanda(seg, semilla, bpm)
    const mezcla = otra.banda.map((x, i) => x + otra.voz[i])
    assert.equal(alineacionSegura(alinear(cancion, calcularHuella(mezcla))), false, `semilla ${semilla} a ${bpm}`)
  }
  // la huella en bytes: un byte por valor
  const h = calcularHuella(banda)
  assert.equal(huellaABytes(h).length, h.length)
  assert.ok(huellaDeBytes(huellaABytes(h)).every((x, i) => Math.abs(x - Math.min(h[i], 255 / 40)) <= 1 / 80 + 1e-6))
})

test('AirTracks Video: dónde tiene que estar el video (cuenta, sonando, velocidad, pausa, saltos y antes/después del video)', () => {
  const ahora = 100_000
  const sonando = { estado: 'playing' as const, positionMs: 10_000, referenceServerTime: ahora - 2000 }
  // parado: no se ve (Holyrics)
  assert.equal(objetivoVideo({ estado: 'stopped', positionMs: 0, referenceServerTime: 0 }, ahora, 1, 3000, 200).visible, false)
  assert.equal(objetivoVideo(null, ahora, 1, 3000, 200).visible, false)
  // sonando: 12 s de cancion + 3 s de placa = 15 s de video
  assert.deepEqual(objetivoVideo(sonando, ahora, 1, 3000, 200), { visible: true, corriendo: true, segundos: 15, velocidad: 1 })
  // a otra velocidad: el video corre a esa velocidad (la cancion sono 12 s a 1,1 = 13,2 s del original)
  const rapido = objetivoVideo(sonando, ahora, 1.1, 3000, 200)
  assert.ok(Math.abs(rapido.segundos - 16.2) < 1e-9 && rapido.velocidad === 1.1)
  // contando (la musica todavia no entro): quieto donde va a entrar
  assert.deepEqual(objetivoVideo({ estado: 'playing', positionMs: 0, referenceServerTime: ahora + 2000 }, ahora, 1, 3000, 200), { visible: true, corriendo: false, segundos: 3, velocidad: 1 })
  // en pausa: quieto donde quedo
  assert.deepEqual(objetivoVideo({ estado: 'paused', positionMs: 20_000, referenceServerTime: ahora - 10 }, ahora, 1, 3000, 200), { visible: true, corriendo: false, segundos: 23, velocidad: 1 })
  // la cancion empieza antes que el video: el primer cuadro, quieto; despues del final del video, no se ve
  assert.deepEqual(objetivoVideo({ ...sonando, positionMs: 0, referenceServerTime: ahora - 1000 }, ahora, 1, -5000, 200), { visible: true, corriendo: false, segundos: 0, velocidad: 1 })
  assert.equal(objetivoVideo({ ...sonando, positionMs: 198_000 }, ahora, 1, 3000, 200).visible, false)
  // salto ya programado (una seccion elegida): hasta su hora sigue lo de antes; el corte es a su punto
  const salto = { estado: 'playing' as const, positionMs: 60_000, referenceServerTime: ahora + 500, previo: sonando }
  assert.equal(objetivoVideo(salto, ahora, 1, 3000, 200).segundos, 15)
  assert.deepEqual(proximoCorte(salto, ahora, 1, 3000), { en: ahora + 500, segundos: 63 })
  assert.equal(proximoCorte(sonando, ahora, 1, 3000), null)
  assert.equal(proximoCorte({ estado: 'paused', positionMs: 0, referenceServerTime: ahora + 500, previo: sonando }, ahora, 1, 3000), null)
  // como se corrige: lejos salta, cerca se apura o frena apenas, muy cerca nada
  const obj = { visible: true, corriendo: true, segundos: 10, velocidad: 1 }
  assert.deepEqual(ajusteDeVideo(11, obj), { saltarA: 10, velocidad: 1 })
  assert.equal(ajusteDeVideo(10.01, obj).saltarA, null)
  assert.equal(ajusteDeVideo(10.01, obj).velocidad, 1)
  const atrasado = ajusteDeVideo(9.9, obj)
  assert.ok(atrasado.saltarA === null && atrasado.velocidad > 1 && atrasado.velocidad <= 1.08)
  assert.deepEqual(ajusteDeVideo(9.9, { ...obj, corriendo: false }), { saltarA: 10, velocidad: 1 })
})

test('AirTracks Video: entra como pantalla (no como celular), una sola, avisa qué canciones tiene y pide la huella', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const margenSolo = (await emitAck<DiagnosticoServidor>(compu, 'diagnostico:obtener', {})).arranque?.margenMs
  const video = await env.conectar({ origen: 'video', deviceId: 'pantalla-video-1', nombre: 'PC-DATA' })
  await esperar(150)
  const diag = await emitAck<DiagnosticoServidor>(compu, 'diagnostico:obtener', {})
  assert.equal(diag.arranque?.margenMs, margenSolo, 'no es un celular: el margen de arranque no cambia')
  const fila = diag.dispositivos.find((d) => d.origen === 'video')!
  assert.equal(fila.etiqueta, 'PC-DATA')
  assert.equal(diag.dispositivos.filter((d) => d.origen === 'celular').length, 0)
  // otra pantalla de video no entra (la misma reconectando, si)
  const intentar = (deviceId: string): Promise<string> =>
    new Promise((resolve) => {
      const s = ioClient(`http://localhost:${env.port}`, { auth: { origen: 'video', deviceId }, reconnection: false })
      s.once('connect', () => (s.close(), resolve('ok')))
      s.once('connect_error', (e: Error) => (s.close(), resolve(e.message)))
    })
  assert.equal(await intentar('pantalla-video-2'), 'video-ocupado')
  assert.equal(await intentar('pantalla-video-1'), 'ok')

  // que canciones tiene: la compu lo ve
  const a = audiosDePrueba()
  const estado = await cargarZip(compu, crearZip('Con video', { 'Click.wav': a.wav2s, 'Pad.wav': a.wavEstereo }))
  const id = estado.proyectoActivo!.id
  video.emit('video:estado', { nombre: 'PC-DATA', canciones: [id, '../no-es-un-id'] })
  const conVideo = await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => !!e.pantallaVideo?.conectada)
  assert.deepEqual(conVideo.pantallaVideo, { conectada: true, nombre: 'PC-DATA', canciones: [id] })

  // la huella de la cancion (sin el click), una vez; con la musica sonando, espera
  const r = await emitAck<{ estado: string; huella?: Uint8Array | Buffer; duracionMs?: number }>(video, 'video:huella', { proyectoId: id }, 60000)
  assert.equal(r.estado, 'lista')
  assert.ok(r.huella && r.huella.byteLength >= 150 * 12, `huella de ${r.huella?.byteLength} bytes`)
  const otra = (await cargarZip(compu, crearZip('Otra', { 'Pad.wav': a.wavEstereo }))).proyectoActivo!.id
  compu.emit('transport:play', {})
  await esperar(300)
  assert.equal((await emitAck<{ estado: string }>(video, 'video:huella', { proyectoId: otra })).estado, 'esperando', 'sonando no se calcula')
  // (la que ya esta guardada se da aunque suene)
  assert.equal((await emitAck<{ estado: string }>(video, 'video:huella', { proyectoId: id })).estado, 'lista')
  compu.emit('transport:stop')
  // un celular no la puede pedir
  const cel = await env.conectar({ origen: 'celular', deviceId: 'celular-sin-huella' })
  assert.equal((await emitAck<{ estado: string }>(cel, 'video:huella', { proyectoId: id })).estado, 'error')

  // se desconecta: la compu lo ve
  video.close()
  const sinVideo = await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => e.pantallaVideo?.conectada === false)
  assert.equal(sinVideo.pantallaVideo?.canciones.length, 1)
})

test('compases irregulares y cambios de tempo: la cuenta y el colchón siguen el compás típico; el BPM de la sección que suena', () => {
  // 4/4 a 120 (2000 ms), un 2/4 suelto (1000 ms) y sigue en 4/4
  const c = [0, 2000, 4000, 6000, 7000, 9000, 11000, 13000]
  assert.equal(largoTipicoDeCompas(c, 3), 2000, 'el 2/4 suelto no cambia el pulso')
  assert.equal(largoTipicoDeCompas(c, 4), 2000)
  assert.equal(largoDeCompas(c, 6000), 2000, 'el colchón que entra en el 2/4 va al tempo de la canción')
  // entrando justo en el 2/4: la cuenta es de 4 negras a 120, no al doble
  assert.deepEqual(golpesDeCuenta({ compasesMs: c, compas: 4 }, 6000, 1)!.golpes.map((g) => g.ms), [4000, 4500, 5000, 5500])
  // cambio de tempo: 4/4 a 120 y despues a 60 (4000 ms): desde ahi, el nuevo
  const cambio = [0, 2000, 4000, 6000, 10000, 14000, 18000]
  assert.equal(largoTipicoDeCompas(cambio, 4), 4000)
  assert.deepEqual(golpesDeCuenta({ compasesMs: cambio, compas: 4 }, 10000, 1)!.golpes.map((g) => g.ms), [6000, 7000, 8000, 9000])
  // BPM de cada parte (la mediana de sus compases)
  const tempo = { compasesMs: cambio, compas: 4, bpm: 120 }
  assert.equal(bpmDeTramo(tempo, 0, 6000), 120)
  assert.equal(bpmDeTramo(tempo, 6000, 18000), 60)
  assert.equal(bpmDistintoEnSeccion(tempo, { inicioMs: 0, finMs: 6000 }), null, 'la del tempo de la canción no se muestra aparte')
  assert.equal(bpmDistintoEnSeccion(tempo, { inicioMs: 6000, finMs: 18000 }), 60)
  // con un 2/4 suelto, la sección sigue en su tempo
  assert.equal(bpmDeTramo({ compasesMs: c, compas: 4 }, 0, 13000), 120)
  // una seccion mas corta que un compas: el del compas que la contiene
  assert.equal(bpmDeTramo(tempo, 10500, 11000), 60)
  assert.equal(bpmDeTramo(null, 0, 1000), null)
})

test('tono por sección: rige desde esa sección, se transpone con el tono, el pad del colchón lo sigue y se guarda en la ficha', async (t) => {
  const p = {
    nombre: 'Fiesta En El Desierto-D-125BPM',
    tonoAplicado: 0,
    marcadores: [
      { tiempoMs: 0, nombre: 'Verso' },
      { tiempoMs: 20000, nombre: 'Coro final', tonalidad: 'E' },
      { tiempoMs: 40000, nombre: 'Final' }
    ]
  }
  assert.equal(tonalidadEn(p, 0), 'D', 'antes: la del nombre')
  assert.equal(tonalidadEn(p, 19000), 'D')
  assert.equal(tonalidadEn(p, 20000), 'E')
  assert.equal(tonalidadEn(p, 45000), 'E', 'sigue hasta otra sección que diga otro')
  assert.equal(tonalidadEn({ ...p, tonoAplicado: -2 }, 25000), 'D', 'con el tono cambiado, transpuesto')
  assert.equal(padDeCancion(p, 25000), 'E')
  assert.equal(padDeCancion(p, 1000), 'D')
  assert.equal(padDeCancion(p), 'D')

  // se marca desde la compu (y se valida), y la ficha lo conserva
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const a = audiosDePrueba()
  await cargarZip(compu, crearZip('Con tono', { 'Click.wav': a.wav2s }))
  const conMarca = await Promise.all([
    esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => (e.proyectoActivo?.marcadores.length ?? 0) > 0),
    compu.emit('marker:create', { tiempoMs: 1000, nombre: 'Coro final' })
  ]).then(([e]) => e)
  const id = conMarca.proyectoActivo!.marcadores[0].id
  const cambio = (patch: unknown, filtro: (e: EstadoCompleto) => boolean): Promise<EstadoCompleto> =>
    Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', filtro), compu.emit('marker:update', { marcadorId: id, patch })]).then(([e]) => e)
  const conTono = await cambio({ tonalidad: 'f#m' }, (e) => !!e.proyectoActivo?.marcadores[0]?.tonalidad)
  assert.equal(conTono.proyectoActivo!.marcadores[0].tonalidad, 'F#m')
  assert.equal(conTono.proyectoActivo!.marcadores[0].origen, 'manual')
  const ficha = interpretarFicha(JSON.stringify(fichaDesdeProyecto(conTono.proyectoActivo!)))!
  assert.equal(ficha.marcadores[0].tonalidad, 'F#m')
  const invalido = await cambio({ tonalidad: 'X', nombre: 'Coro final 2' }, (e) => e.proyectoActivo?.marcadores[0]?.nombre === 'Coro final 2')
  assert.equal(invalido.proyectoActivo!.marcadores[0].tonalidad, 'F#m', 'un tono inválido no cambia nada')
  const sinTono = await cambio({ tonalidad: null }, (e) => !e.proyectoActivo?.marcadores[0]?.tonalidad)
  assert.equal(sinTono.proyectoActivo!.marcadores[0].tonalidad, undefined)
})

test('cuenta propia: se detecta cuando la canción ya cuenta (la guía o el click, con la banda en silencio) y cuántos compases', async () => {
  const sr = 44100
  const seg = 24
  const dir = tmpDir('multitrack-cuenta-propia-')
  // 120 BPM 4/4: compases de 2 s desde 0,5 s
  const compasesMs = Array.from({ length: 11 }, (_, k) => 500 + 2000 * k)
  const seno = (f: number, amp: number, desde: number, hasta = seg): Float32Array => {
    const x = new Float32Array(seg * sr)
    for (let i = Math.round(desde * sr); i < Math.min(x.length, hasta * sr); i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr)
    return x
  }
  // la guia: "1, 2, 3, 4" (golpecitos de voz en cada pulso) en los compases pedidos
  const guia = (compases: number[]): Float32Array => {
    const x = new Float32Array(seg * sr)
    for (const k of compases) {
      for (let b = 0; b < 4; b++) {
        const i0 = Math.round((0.5 + 2 * k + b * 0.5) * sr)
        for (let i = 0; i < 0.25 * sr; i++) x[i0 + i] = 0.4 * Math.sin((2 * Math.PI * 240 * i) / sr) * Math.sin((Math.PI * i) / (0.25 * sr))
      }
    }
    return x
  }
  const golpe = (x: Float32Array, t: number): Float32Array => {
    for (let i = 0; i < 0.15 * sr; i++) x[Math.round(t * sr) + i] += 0.8 * (Math.random() * 2 - 1) * Math.exp(-i / (0.03 * sr))
    return x
  }
  let n = 0
  const cancion = async (pistas: Record<string, Float32Array>): Promise<number> => {
    const d = path.join(dir, String(n++))
    fs.mkdirSync(d)
    const p = {
      id: crypto.randomUUID(),
      nombre: 'x',
      creadoEn: '',
      marcadores: [],
      duracionTotalMs: seg * 1000,
      pistas: Object.entries(pistas).map(([nombre, x]): Pista => {
        fs.writeFileSync(path.join(d, `${nombre}.wav`), wav16(x, sr))
        return { id: crypto.randomUUID(), nombre, archivo: `${nombre}.wav`, volumen: 80, pan: 0, mute: false, solo: false, color: '#fff' }
      }),
      tempo: { bpm: 120, compas: 4, compasesMs, clickPistaId: null, acentoClaro: true }
    } as Proyecto
    p.tempo!.clickPistaId = p.pistas[0].id
    return detectarCuentaPropia(d, p)
  }
  const click = generarClick(120, 4, seg)
  // la guia cuenta 2 compases y entra la banda
  assert.equal(await cancion({ Click: click, Guia: guia([0, 1]), Bajo: seno(110, 0.3, 4.5), Piano: seno(440, 0.2, 4.5) }), 2)
  // entra directo la instrumental (la guia anuncia la seccion encima)
  assert.equal(await cancion({ Click: click, Guia: guia([0]), Bajo: seno(110, 0.3, 0.5) }), 0)
  // un pad bajito de fondo durante la cuenta no la esconde (-30 dB)
  assert.equal(await cancion({ Click: click, Guia: guia([0]), Pad: seno(220, 0.3 * 10 ** (-30 / 20), 0), Bajo: seno(110, 0.3, 2.5) }), 1)
  // una entrada de bateria en el "4" de la cuenta tampoco
  assert.equal(await cancion({ Click: click, Guia: guia([0]), Bateria: golpe(seno(60, 0.3, 2.5), 2.05), Bajo: seno(110, 0.3, 2.5) }), 1)
  // sin guia: la cuenta es solo el click (la banda en silencio de verdad)
  assert.equal(await cancion({ Click: click, Bajo: seno(110, 0.3, 2.5) }), 1)
  // una intro suave (-12 dB) no es una cuenta
  const intro = seno(330, 0.3 * 10 ** (-12 / 20), 0.5, 4.5)
  const banda = seno(330, 0.3, 4.5)
  for (let i = 0; i < intro.length; i++) intro[i] += banda[i]
  assert.equal(await cancion({ Click: click, Teclado: intro }), 0)
  // un silencio largo (6 compases) tampoco
  assert.equal(await cancion({ Click: click, Guia: guia([0, 1, 2]), Bajo: seno(110, 0.3, 12.5) }), 0)
  // solo click y guia: no se puede saber
  assert.equal(await cancion({ Click: click, Guia: guia([0]) }), 0)
})

test('voces de fábrica: el programa trae las voces en español; un pack importado las reemplaza y al quitarlo vuelven', async () => {
  const fabrica = path.resolve('recursos/voces-es')
  const indiceAntes = fs.readFileSync(path.join(fabrica, 'indice.json'), 'utf-8')
  const base = tmpDir('multitrack-voces-fabrica-')
  const nueva = (): Voces => new Voces(path.join(base, 'voces'), fabrica, path.join(base, 'voces-fabrica.json'))
  const v = nueva()
  const info = v.info()!
  assert.deepEqual([info.idioma, info.activo, info.deFabrica, info.numeros], ['es', true, true, true])
  assert.ok(info.cantidad >= 50, `${info.cantidad} voces`)
  // las secciones de siempre y los numeros, recortadas a lo hablado
  for (const c of ['intro', 'verso', 'verso 1', 'verso 2', 'pre coro', 'coro', 'coro 2', 'puente', 'instrumental', 'interludio', 'final', 'repetir', '1', '2', '3', '4']) {
    const d = v.duracion(c)
    assert.ok(d !== null && d > 150 && d < 1500, `${c}: ${d} ms`)
  }
  // "Coro… 3, 4" en el ultimo compas antes del salto (120 BPM)
  const plan = planearAnuncio({ nombre: 'Coro 2', limiteMs: 8000, minInicioMs: 0, compasesMs: [0, 2000, 4000, 6000, 8000], pulsos: 4, duracion: (c) => v.duracion(c) })!
  assert.deepEqual(plan.partes.map((x) => x.clave), ['coro 2', '3', '4'])
  const audio = v.renderizar(plan)
  let pico = 0
  for (const x of audio) pico = Math.max(pico, Math.abs(x))
  assert.ok(pico > 0.1, `se escucha (${pico})`)
  // apagarlas queda recordado (sin tocar las del programa)
  v.activar(false)
  assert.equal(nueva().info()!.activo, false)
  assert.equal(nueva().duracion('coro'), null)
  v.activar(true)
  assert.equal(fs.readFileSync(path.join(fabrica, 'indice.json'), 'utf-8'), indiceAntes)
  // otro pack: se usa ese; al quitarlo vuelven las del programa
  const tono = (f: number): Buffer => {
    const x = new Float32Array(Math.round(0.5 * 48000))
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / 48000)
    return wav16(x, 48000)
  }
  const importado = await v.importar(crearZip('Mis voces', { 'Coro.wav': tono(500), 'Puente.wav': tono(600) }))
  assert.deepEqual([importado.deFabrica, importado.cantidad, importado.numeros], [false, 2, false])
  assert.equal(nueva().info()!.deFabrica, false)
  v.borrar()
  assert.equal(v.info()!.deFabrica, true)
  assert.equal(nueva().info()!.cantidad, info.cantidad)
})

test('Mi mezcla: mute y solo de cada músico (el solo del celular manda sobre el de la compu; el mute de la compu vale igual)', () => {
  const pista = (nombre: string, extra: Partial<Pista> = {}): Pista => ({
    id: crypto.randomUUID(),
    nombre,
    archivo: `${nombre}.wav`,
    volumen: 100,
    pan: 0,
    mute: false,
    solo: false,
    color: '#fff',
    ...extra
  })
  const click = pista('Click')
  const bajo = pista('Bajo')
  const piano = pista('Piano', { solo: true })
  const pad = pista('Pad', { mute: true })
  const pistas = [click, bajo, piano, pad]
  const suenan = (m: Parameters<typeof mezclaEfectiva>[1]): string[] =>
    mezclaEfectiva(pistas, m).map((c) => pistas.find((p) => p.id === c.pistaId)!.nombre)

  // sin nada en este celular: el solo de la compu (piano)
  assert.deepEqual(suenan({}), ['Piano'])
  // solo en el celular: se escucha lo que el musico puso en solo (el de la compu no cuenta aca)
  assert.deepEqual(suenan({ click: { ganancia: 1, mute: false, solo: true } }), ['Click'])
  assert.deepEqual(suenan({ click: { ganancia: 1, mute: false, solo: true }, bajo: { ganancia: 0.5, mute: false, solo: true } }), ['Click', 'Bajo'])
  // lo apagado en la compu sigue apagado aunque este en solo aca
  assert.deepEqual(suenan({ pad: { ganancia: 1, mute: false, solo: true } }), [])
  // mute y solo juntos en la misma pista: manda el mute
  assert.deepEqual(suenan({ click: { ganancia: 1, mute: true, solo: true }, bajo: { ganancia: 1, mute: false, solo: true } }), ['Bajo'])
  // sin solos en ningun lado: todo menos lo muteado (en la compu o aca)
  piano.solo = false
  assert.deepEqual(suenan({ bajo: { ganancia: 1, mute: true } }), ['Click', 'Piano'])
  // las ganancias del celular se mantienen con el solo
  const [c] = mezclaEfectiva(pistas, { bajo: { ganancia: 0.5, mute: false, solo: true } })
  assert.equal(c.pistaId, bajo.id)
  assert.equal(c.ganancia, 0.5)
})

test('voz del salto: nombres del pack, sinónimos y en qué pulso va cada voz', () => {
  // de que archivo sale cada nombre (el idioma adelante no cuenta; lo de entre parentesis, tambien vale)
  assert.deepEqual(clavesDeArchivoDeVoz('Spanish Guides/Song Sections/Spanish - Coro 2 (Chorus 2).wav'), ['coro 2', 'chorus 2'])
  assert.deepEqual(clavesDeArchivoDeVoz('Spanish - Baja Intensidad (Breakdown).wav'), ['baja intensidad', 'breakdown'])
  assert.deepEqual(clavesDeArchivoDeVoz('Spanish - 3.wav'), ['3'])
  assert.deepEqual(clavesDeArchivoDeVoz('mis voces/Pre-Coro.wav'), ['pre coro'])
  assert.deepEqual(clavesDeArchivoDeVoz('French Guide -  Bridge.wav'), ['bridge'])
  // lo que se busca para cada seccion, de lo mas exacto a lo mas general
  assert.deepEqual(candidatosDeSeccion('CORO 5 (x2)'), ['coro 5', 'coro'])
  assert.deepEqual(candidatosDeSeccion('Precoro'), ['precoro', 'pre coro'])
  assert.deepEqual(candidatosDeSeccion('Estribillo 2'), ['estribillo 2', 'coro 2', 'estribillo', 'coro'])
  assert.deepEqual(candidatosDeSeccion('Tag'), ['tag', 'repetir'])

  const pack: Record<string, number> = { coro: 500, puente: 450, instrumental: 1100, '2': 300, '3': 300, '4': 300 }
  const duracion = (c: string): number | null => pack[c] ?? null
  // 120 BPM 4/4 (compas de 2 s): "Coro" en el 1 del ultimo compas y "3, 4"
  const compases = [0, 2000, 4000, 6000]
  const plan = (nombre: string, limiteMs: number, minInicioMs = 0, extra: Partial<Parameters<typeof planearAnuncio>[0]> = {}) =>
    planearAnuncio({ nombre, limiteMs, minInicioMs, compasesMs: compases, pulsos: 4, duracion, ...extra })
  assert.deepEqual(plan('Coro', 6000), {
    desdeMs: 4000,
    hastaMs: 6000,
    partes: [
      { clave: 'coro', enMs: 4000 },
      { clave: '3', enMs: 5000 },
      { clave: '4', enMs: 5500 }
    ]
  })
  // un nombre largo que pisa el pulso 3: solo "4"
  assert.deepEqual(plan('Instrumental', 6000)!.partes.map((p) => `${p.clave}@${p.enMs}`), ['instrumental@4000', '4@5500'])
  // el salto esta tan cerca que el "1" ya paso: el nombre en el primer pulso que llega a tiempo
  const tarde = plan('Puente', 6000, 4300)!
  assert.deepEqual(tarde.partes.map((p) => `${p.clave}@${p.enMs}`), ['puente@4500', '3@5000', '4@5500'])
  assert.equal(tarde.desdeMs, 4500, 'la guia se calla desde la primera voz')
  // sin la voz de esa seccion: solo la cuenta (y la guia igual se calla: diria otra seccion)
  assert.deepEqual(plan('Rap', 6000)!.partes.map((p) => p.clave), ['3', '4'])
  // en 3/4: "2, 3"
  assert.deepEqual(plan('Coro', 6000, 0, { pulsos: 3 })!.partes.map((p) => p.clave), ['coro', '2', '3'])
  // sin tempo: el nombre termina justo antes del salto
  assert.deepEqual(plan('Coro', 6000, 0, { compasesMs: null })!.partes, [{ clave: 'coro', enMs: 5350 }])
  // sin voces (no se importo el pack) o sin lugar: nada
  assert.equal(plan('Coro', 6000, 0, { duracion: () => null }), null)
  assert.equal(plan('Coro', 6000, 5900), null)
})

test('voz del salto: se importa el pack (el español) y los celulares la reciben en su mezcla, con la guía callada', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  // un pack como los de verdad: varios idiomas, silencio antes de hablar, basura de macOS
  const tono = (f: number, seg: number, antes = 0, despues = 0.2, sr = 48000): Buffer => {
    const x = new Float32Array(Math.round((antes + seg + despues) * sr))
    for (let i = 0; i < seg * sr; i++) x[Math.round(antes * sr) + i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr)
    return wav16(x, sr)
  }
  const pack = crearZip('Voces', {
    'Guides/Spanish Guides/Song Sections/Spanish - Puente (Bridge).wav': tono(1000, 0.4, 0.1),
    'Guides/Spanish Guides/Song Sections/Spanish - Coro (Chorus).wav': tono(800, 0.4),
    'Guides/Spanish Guides/Song Sections/Spanish - 3.wav': tono(1500, 0.2),
    'Guides/Spanish Guides/Song Sections/Spanish - 4.wav': tono(1500, 0.2),
    'Guides/English Guides/English - Bridge.wav': tono(500, 0.4),
    '__MACOSX/Guides/Spanish Guides/._Spanish - 3.wav': Buffer.from('basura')
  })
  // las pistas de una cancion no son un pack de voces
  const noEsPack = await emitAck<{ ok: boolean; error?: string }>(compu, 'voces:importar', { filePath: crearZip('Cancion', { 'Click.wav': tono(1000, 0.1), 'Bajo.wav': tono(80, 0.5) }) })
  assert.equal(noEsPack.ok, false)
  assert.match(noEsPack.error!, /no parece un pack de voces/)
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'voces:importar', { filePath: pack }, 60000)
  assert.equal(r.ok, true, r.error)
  let estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.deepEqual(estado.voces, { idioma: 'es', activo: true, deFabrica: false, cantidad: 4, numeros: true, ejemplos: ['coro', 'puente'] })

  // la cancion: guia (300 Hz, a la izquierda), click y bajo mudos; 120 BPM 4/4 (compas de 2 s)
  const sr = 44100
  const seno = new Float32Array(16 * sr)
  for (let i = 0; i < seno.length; i++) seno[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / sr)
  const mudo = new Float32Array(16 * sr)
  await cargarZip(compu, crearZip('Saltos', { 'Guia.wav': wav16(seno, sr), 'Click.wav': wav16(mudo, sr), 'Bajo.wav': wav16(mudo, sr), 'marcas.txt': Buffer.from('0:04 Verso\n0:08 Coro\n0:12 Puente\n') }))
  const tab = env.server.state.getActiveTab()!
  const p = tab.proyecto
  p.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 9 }, (_, k) => k * 2000), clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }
  p.cuenta = 0
  const guia = p.pistas.find((x) => x.nombre === 'Guia')!

  // sonando en el Inicio, se elige el Puente: salta al terminar el Inicio (4 s); la voz, en el ultimo compas (2 a 4 s)
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', { positionMs: 1000 })])
  await esperar(50)
  estado = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => !!e.saltoPendiente), compu.emit('seccion:saltar', { posicionMs: 12000 })]))[0]
  const anuncio = estado.saltoPendiente!.anuncio!
  assert.ok(anuncio, 'el salto trae la voz')
  assert.deepEqual([anuncio.desdeMs, anuncio.hastaMs, anuncio.pistaId, anuncio.guiaPistaId], [2000, 4000, guia.id, guia.id])

  // el pedazo 1 (2 a 4 s) de la mezcla de un celular, con y sin la voz
  const canales = mezclaEfectiva(p.pistas)
  const base = `http://localhost:${env.port}/mezcla/${p.id}/1.wav?v=${p.revision ?? 0}&m=${codificarMezcla(canales)}`
  const leer = async (url: string): Promise<Float32Array[]> => {
    const bytes = await (await fetch(url)).arrayBuffer()
    const info = parseWavHeader(bytes)
    return decodePcmSegment(info, bytes.slice(info.dataOffset))
  }
  const rms = (x: Float32Array, desde: number, hasta: number): number => {
    let s = 0
    for (let i = Math.round(desde * sr); i < Math.round(hasta * sr); i++) s += x[i] * x[i]
    return Math.sqrt(s / (Math.round(hasta * sr) - Math.round(desde * sr)))
  }
  const primero = (x: Float32Array, desde: number): number => {
    for (let i = Math.round(desde * sr); i < x.length; i++) if (Math.abs(x[i]) > 0.05) return i / sr
    return -1
  }
  const [sinL] = await leer(base)
  assert.ok(rms(sinL, 0.45, 0.95) > 0.1, 'sin la voz se oye la guia')
  const [L, R] = await leer(`${base}&a=${anuncio.id}`)
  // la guia calla todo el compas; el "Puente" arranca justo en el 1 (sin el silencio que tenia el archivo),
  // el "3" y el "4" en sus pulsos; todo con el lado de la guia (izquierda)
  assert.ok(rms(L, 0.45, 0.95) < 0.003, `la guía se calla (rms ${rms(L, 0.45, 0.95)})`)
  assert.ok(primero(L, 0) < 0.002, `"Puente" en el 1 (${primero(L, 0)} s)`)
  assert.ok(Math.abs(primero(L, 0.6) - 1.0) < 0.002, `"3" en el pulso 3 (${primero(L, 0.6)} s)`)
  assert.ok(Math.abs(primero(L, 1.3) - 1.5) < 0.002, `"4" en el pulso 4 (${primero(L, 1.3)} s)`)
  assert.ok(Math.max(...R.map(Math.abs)) < 0.01, 'la voz va del lado de la guía')
  // la compu la baja entera (su audio suma la voz y calla la guia en ese compas)
  const wav = await (await fetch(`http://localhost:${env.port}/anuncio/${anuncio.id}.wav`)).arrayBuffer()
  assert.equal(parseWavHeader(wav).dataLength / 2, 2 * 48000)

  // con la guia muteada en esa mezcla, la voz tampoco suena
  const sinGuia = canales.filter((c) => c.pistaId !== guia.id)
  const [mudoL] = await leer(`http://localhost:${env.port}/mezcla/${p.id}/1.wav?v=${p.revision ?? 0}&m=${codificarMezcla(sinGuia)}&a=${anuncio.id}`)
  assert.ok(Math.max(...mudoL.map(Math.abs)) < 0.001)

  // voces apagadas: el salto va sin voz; sin pack, igual
  await emitAck(compu, 'voces:activar', { activo: false })
  estado = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (e) => e.saltoPendiente?.destinoMs === 8000), compu.emit('seccion:saltar', { posicionMs: 8000 })]))[0]
  assert.equal(estado.saltoPendiente!.anuncio, null)
  assert.equal(estado.voces!.activo, false)
  await emitAck(compu, 'voces:borrar', {})
  estado = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(estado.voces, null)
  compu.emit('transport:stop')
})

test('recorrido: la forma de onda de la canción (la banda, sin click ni guía), calculada una vez', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const sr = 44100
  // 20 s: la banda suave 10 s y fuerte los otros 10; el click y la guia suenan fuerte todo el tiempo (no cuentan)
  const banda = new Float32Array(20 * sr)
  for (let i = 0; i < banda.length; i++) banda[i] = (i < 10 * sr ? 0.05 : 0.5) * Math.sin((2 * Math.PI * 220 * i) / sr)
  const fuerte = new Float32Array(20 * sr)
  for (let i = 0; i < fuerte.length; i++) fuerte[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / sr)
  const estado = await cargarZip(compu, crearZip('Onda', { 'Click.wav': wav16(fuerte, sr), 'Guia.wav': wav16(fuerte, sr), 'Piano.wav': wav16(banda, sr) }))
  const p = estado.proyectoActivo!
  const url = `http://localhost:${env.port}/onda/${p.id}.json?v=${p.revision ?? 0}`
  const onda = (await (await fetch(url)).json()) as { revision: number; msPorPunto: number; puntos: number[] }
  assert.equal(onda.revision, p.revision ?? 0)
  assert.ok(onda.puntos.length >= 1000 && onda.puntos.length <= 1200, `${onda.puntos.length} puntos`)
  assert.ok(Math.abs(onda.puntos.length * onda.msPorPunto - p.duracionTotalMs) < onda.msPorPunto * 2)
  const promedio = (desde: number, hasta: number): number => {
    const x = onda.puntos.slice(Math.floor(desde / onda.msPorPunto), Math.floor(hasta / onda.msPorPunto))
    return x.reduce((a, b) => a + b, 0) / x.length
  }
  // se ve la forma de la cancion (no la del click)
  assert.ok(promedio(11000, 19000) > 95, `fuerte: ${promedio(11000, 19000)}`)
  assert.ok(promedio(1000, 9000) < 25, `suave: ${promedio(1000, 9000)}`)
  // queda guardada con la cancion: la proxima vez no se calcula
  const guardada = JSON.parse(fs.readFileSync(path.join(env.appDir, 'proyectos', p.id, 'onda.json'), 'utf-8'))
  assert.deepEqual(guardada.puntos, onda.puntos)
  assert.equal((await fetch(`http://localhost:${env.port}/onda/${crypto.randomUUID()}.json`)).status, 404)
})

test('mezcla en hilos de trabajo (igual al hilo principal) y lo más urgente primero', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const tono = (f: number, seg: number): Buffer => {
    const x = new Float32Array(seg * 44100)
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * f * i) / 44100)
    return wav16(x, 44100)
  }
  const estado = await cargarZip(compu, crearZip('Hilos', { 'Bajo.wav': tono(80, 20), 'Pad.wav': tono(330, 20), 'Guia.wav': tono(700, 20) }))
  const p = estado.proyectoActivo!
  const canales = mezclaEfectiva(p.pistas, { pad: { ganancia: 1.5, mute: false } })
  const texto = codificarMezcla(canales)
  const dir = (id: string): string => path.join(env.appDir, 'proyectos', id)

  // el del servidor usa hilos de trabajo: el resultado es identico, byte a byte, al del hilo principal
  assert.ok(env.server.mezclador.paralelo >= 1)
  const principal = new Mezclador(dir, () => 0, false)
  t.after(() => principal.cerrar())
  for (const i of [0, 3, 9]) {
    const a = await env.server.mezclador.segmento(p, i, canales, texto)
    const b = await principal.segmento(p, i, canales, texto)
    assert.ok(a && b && a.wav.equals(b.wav), `segmento ${i} distinto`)
  }

  // con todo ocupado, sale primero el que va a sonar antes (no el que se pidio primero)
  const orden: number[] = []
  const urgente = new Mezclador(dir, (_id, indice) => indice, false) // 2 a la vez, en el hilo principal
  t.after(() => urgente.cerrar())
  const pedidos = [9, 8, 7, 6, 5, 1, 0].map((i) => urgente.segmento(p, i, canales, `${texto}#${i}`).then(() => orden.push(i)))
  await Promise.all(pedidos)
  // los 2 primeros entran enseguida (9 y 8); del resto, primero el 0 y el 1
  assert.deepEqual(orden.slice(2, 4).sort(), [0, 1], `orden: ${orden.join(', ')}`)
  await env.cerrar()
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

test('margen adaptativo: con buen WiFi el play arranca en ~0,5 s; se adapta al celular más lento y vuelve a 1,5 s si una orden llega tarde', async (t) => {
  const a = audiosDePrueba()
  const env = await entorno(t, undefined, { intervaloPingMs: 40 })
  const compu = await env.conectar(compuAuth)
  await cargarZip(compu, crearZip('margen2', { 'click.wav': a.wav4s }))
  async function margenDePlay(): Promise<number> {
    const antes = Date.now()
    const [cmd] = await Promise.all([esperarEvento<ComandoProgramado>(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
    await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop')])
    return cmd.executeAtServerTime - antes
  }
  // un celular que contesta enseguida (como uno con buen WiFi)
  const rapido = await env.conectar({ origen: 'celular', deviceId: 'rapido' })
  rapido.on('sync:ping', (p: { t: number }) => rapido.emit('sync:pong', p))
  let m = await margenDePlay()
  assert.ok(m >= 1400, `recien conectado, margen completo (${m})`)
  await esperar(400) // unas cuantas mediciones
  m = await margenDePlay()
  assert.ok(m >= 440 && m < 600, `con buen WiFi, ~0,5 s (${m})`)
  // otro que tarda 300 ms en recibir las ordenes: manda el mas lento
  const lento = await env.conectar({ origen: 'celular', deviceId: 'lento' })
  lento.on('sync:ping', (p: { t: number }) => setTimeout(() => lento.emit('sync:pong', p), 300))
  await esperar(900)
  m = await margenDePlay()
  assert.ok(m >= 540 && m < 700, `se adapta al mas lento: ~300 + 250 (${m})`)
  // en el diagnostico
  const d = await emitAck<{ arranque: { margenMs: number; peorEntregaMs: number } }>(compu, 'diagnostico:obtener', {})
  assert.ok(d.arranque.peorEntregaMs >= 300 && d.arranque.peorEntregaMs < 450, JSON.stringify(d.arranque))
  // se fue el lento: vuelve a bajar
  lento.close()
  await esperar(150)
  m = await margenDePlay()
  assert.ok(m < 600, `sin el lento (${m})`)
  // a un celular una orden le llego sin tiempo: margen completo por un rato
  rapido.emit('sync:tarde', {})
  await esperar(100)
  m = await margenDePlay()
  assert.ok(m >= 1400, `despues de una orden tarde (${m})`)
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

test('listas por día: carpetas, la lista de arriba se guarda sola, editarla cambia las pestañas; al reabrir la app, sigue (si fue recién) o muestra las listas', async (t) => {
  const a = audiosDePrueba()
  const appDir = tmpDir('multitrack-test-')
  const env = await entorno(t, appDir)
  const compu = await env.conectar(compuAuth)
  for (const nombre of ['Primera', 'Segunda', 'Tercera']) await cargarZip(compu, crearZip(nombre, { 'click.wav': a.wav2s }))
  const idDe = (nombre: string): string => env.server.state.listaProyectos().find((p) => p.nombre === nombre)!.id
  const [A, B, C] = ['Primera', 'Segunda', 'Tercera'].map(idDe)
  const pestanas = async (): Promise<string[]> => (await emitAck<EstadoCompleto>(compu, 'state:request', {})).tabs.map((x) => x.nombre)
  const datos = (): Promise<DatosListas> => emitAck<DatosListas>(compu, 'listas:obtener', {})
  const lista = async (nombre: string): Promise<ListaResumen> => (await datos()).listas.find((l) => l.nombre === nombre)!

  // lo de arriba se guarda como la lista del sabado, en una carpeta nueva
  const [cambio, sab] = await Promise.all([
    esperarEvento(compu, 'listas:cambio'),
    emitAck<{ ok: boolean; id: string }>(compu, 'listas:crear', { nombre: 'Sábado 17/10 · 19 hs', carpeta: ' Congreso ', fecha: '2026-10-17', desdeActual: true })
  ])
  assert.ok(cambio && sab.ok)
  const e1 = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.deepEqual(e1.lista, { id: sab.id, nombre: 'Sábado 17/10 · 19 hs', carpeta: 'Congreso' })
  let d = await datos()
  assert.deepEqual(d.carpetas, ['Congreso'])
  assert.equal(d.activa, sab.id)
  assert.deepEqual((await lista('Sábado 17/10 · 19 hs')).canciones.map((c) => c.nombre), ['Primera', 'Segunda', 'Tercera'])
  assert.equal((await lista('Sábado 17/10 · 19 hs')).fecha, '2026-10-17')

  // lo que se cambia arriba (sacar, ordenar) queda guardado en la lista
  const tabB = e1.tabs.find((x) => x.nombre === 'Segunda')!
  await Promise.all([esperarEvento(compu, 'listas:cambio'), compu.emit('tabs:close', { tabId: tabB.tabId })])
  const e2 = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  await Promise.all([esperarEvento(compu, 'listas:cambio'), compu.emit('tabs:reorder', { orden: [e2.tabs[1].tabId, e2.tabs[0].tabId] })])
  assert.deepEqual((await lista('Sábado 17/10 · 19 hs')).canciones.map((c) => c.nombre), ['Tercera', 'Primera'])

  // otra lista en la misma carpeta (el nombre se escribio distinto), sin tocar lo de arriba; despues se usa
  const dom = await emitAck<{ ok: boolean; id: string }>(compu, 'listas:crear', { nombre: 'Domingo', carpeta: 'congreso', fecha: '2026-02-30', proyectos: [B, A, 'no-es-un-id'] })
  d = await datos()
  assert.deepEqual(d.carpetas, ['Congreso'])
  const domingo = d.listas.find((l) => l.id === dom.id)!
  assert.equal(domingo.carpeta, 'Congreso')
  assert.equal(domingo.fecha, null, 'fecha inválida: sin fecha')
  assert.deepEqual(await pestanas(), ['Tercera', 'Primera'])
  assert.deepEqual(await emitAck(compu, 'listas:usar', { id: dom.id }), { ok: true })
  assert.deepEqual(await pestanas(), ['Segunda', 'Primera'])
  assert.deepEqual((await lista('Sábado 17/10 · 19 hs')).canciones.map((c) => c.nombre), ['Tercera', 'Primera'], 'cambiar de lista no toca la anterior')

  // editar la lista que esta arriba (desde el editor) cambia las pestanas
  assert.deepEqual(await emitAck(compu, 'listas:guardar', { id: dom.id, nombre: 'Domingo 18/10', proyectos: [A, C] }), { ok: true })
  let e3 = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.deepEqual(e3.tabs.map((x) => x.nombre), ['Primera', 'Tercera'])
  assert.equal(e3.lista!.nombre, 'Domingo 18/10')
  // la que suena no se puede sacar
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:play', {})])
  const sonando = e3.proyectoActivo!.nombre
  const r = await emitAck<{ ok: boolean; error?: string }>(compu, 'listas:guardar', { id: dom.id, proyectos: [sonando === 'Primera' ? C : A] })
  assert.equal(r.ok, false)
  assert.match(r.error!, /está sonando/)
  assert.deepEqual(await pestanas(), ['Primera', 'Tercera'])
  await Promise.all([esperarEvento(compu, 'playback:scheduled'), compu.emit('transport:stop', {})])

  // carpetas: renombrar (se mueven sus listas), una vacia, borrar (las listas quedan sin carpeta)
  await emitAck(compu, 'carpetas:renombrar', { de: 'Congreso', a: 'Congreso Juvenil 2026' })
  await emitAck(compu, 'carpetas:crear', { nombre: 'Domingos' })
  d = await datos()
  assert.deepEqual(d.carpetas, ['Congreso Juvenil 2026', 'Domingos'])
  assert.ok(d.listas.every((l) => l.carpeta === 'Congreso Juvenil 2026'))
  assert.equal((await emitAck<EstadoCompleto>(compu, 'state:request', {})).lista!.carpeta, 'Congreso Juvenil 2026')
  await emitAck(compu, 'carpetas:borrar', { nombre: 'Domingos' })
  assert.deepEqual((await datos()).carpetas, ['Congreso Juvenil 2026'])

  // duplicar; borrar la lista de arriba deja las canciones sueltas
  const copia = await emitAck<{ ok: boolean; id: string }>(compu, 'listas:duplicar', { id: dom.id })
  assert.deepEqual((await datos()).listas.find((l) => l.id === copia.id)!.canciones.map((c) => c.nombre), ['Primera', 'Tercera'])
  await emitAck(compu, 'listas:borrar', { id: copia.id })
  assert.equal((await emitAck(compu, 'listas:usar', { id: sab.id }) as { ok: boolean }).ok, true)
  assert.deepEqual(await pestanas(), ['Tercera', 'Primera'])
  // un setlist guardado con una version anterior se ve como lista sin carpeta
  const viejo = crypto.randomUUID()
  fs.writeFileSync(path.join(appDir, 'setlists', `${viejo}.json`), JSON.stringify({ id: viejo, nombre: 'Viejo', creadoEn: '2025-01-01T00:00:00.000Z', proyectos: [C] }))
  const lv = (await datos()).listas.find((l) => l.id === viejo)!
  assert.deepEqual([lv.carpeta, lv.fecha, lv.canciones.map((c) => c.nombre)], ['', null, ['Tercera']])
  await env.cerrar()

  // reabrir la app recien (se corto a mitad del culto): todo vuelve como estaba, con su lista
  const env2 = await entorno(t, appDir)
  await env2.server.restaurarSesion()
  const compu2 = await env2.conectar(compuAuth)
  const e4 = await emitAck<EstadoCompleto>(compu2, 'state:request', {})
  assert.deepEqual(e4.tabs.map((x) => x.nombre), ['Tercera', 'Primera'])
  assert.equal(e4.lista!.id, sab.id)
  await env2.cerrar()

  // reabrirla despues de 3 horas: arranca sin canciones (pantalla de listas) y ofrece seguir donde quedo
  const rutaSesion = path.join(appDir, 'sesion.json')
  const sesion = JSON.parse(fs.readFileSync(rutaSesion, 'utf-8'))
  fs.writeFileSync(rutaSesion, JSON.stringify({ ...sesion, activo: 1, ultimaVez: Date.now() - 3 * 3600_000 }))
  const env3 = await entorno(t, appDir)
  await env3.server.restaurarSesion()
  const compu3 = await env3.conectar(compuAuth)
  assert.deepEqual((await emitAck<EstadoCompleto>(compu3, 'state:request', {})).tabs, [])
  const d3 = await emitAck<DatosListas>(compu3, 'listas:obtener', {})
  assert.deepEqual(d3.sesionAnterior, { lista: 'Sábado 17/10 · 19 hs', canciones: 2, actual: 2, nombreActual: 'Primera' })
  assert.deepEqual(await emitAck(compu3, 'sesion:seguir', {}), { ok: true })
  e3 = await emitAck<EstadoCompleto>(compu3, 'state:request', {})
  assert.deepEqual(e3.tabs.map((x) => x.nombre), ['Tercera', 'Primera'])
  assert.equal(e3.proyectoActivo!.nombre, 'Primera')
  assert.equal(e3.lista!.id, sab.id)
  assert.equal((await emitAck<DatosListas>(compu3, 'listas:obtener', {})).sesionAnterior, null)
  // los celulares no manejan listas
  const cel = await env3.conectar({ origen: 'celular', deviceId: 'cel-listas-1' })
  assert.equal(await emitAck(cel, 'listas:obtener', {}), null)
  assert.equal((await emitAck<{ ok: boolean }>(cel, 'listas:usar', { id: dom.id })).ok, false)
  await env3.cerrar()
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

// ---------- colchon: pad y click sin la banda ----------

test('colchón: la grilla del click, la nota del pad y los ajustes', () => {
  const c = { inicio: 10000, compasMs: 2000, pulsos: 4, hasta: null }
  assert.deepEqual(
    golpesDeColchon(c, 9000, 12100).map((g) => [g.t, g.n]),
    [
      [10000, 1],
      [10500, 2],
      [11000, 3],
      [11500, 4],
      [12000, 1]
    ]
  )
  // el golpe de `hasta` ya no: ahi entra la cancion con su propio click
  assert.deepEqual(golpesDeColchon({ ...c, hasta: 11000 }, 10400, 20000).map((g) => g.t), [10500])
  assert.equal(proximoCompas(c, 5000), 10000)
  assert.equal(proximoCompas(c, 10001), 12000)
  assert.equal(proximoCompas(c, 12000), 12000)
  assert.equal(proximoPulso(c, 10501), 11000)
  assert.deepEqual(compasYPulso(c, 13600), { compas: 2, pulso: 4 })
  assert.deepEqual(compasYPulso(c, 9000), { compas: 0, pulso: 0 })
  // la nota del pad: sin tercera, mayor o menor da igual; bemoles como sostenidos
  assert.deepEqual(['D', 'F#m', 'Bb', 'Ebm', 'H', ''].map(notaDelPad), ['D', 'F#', 'A#', 'D#', null, null])
  assert.equal(padDeCancion({ nombre: 'Canción', tonalidad: 'A', tonoAplicado: 2 }), 'B')
  assert.equal(padDeCancion({ nombre: 'Gracia Sublime - Gm' }), 'G')
  assert.equal(padDeCancion({ nombre: 'Sin tono' }), null)
  // el compas en ese punto de la cancion (el ultimo, el de antes)
  assert.equal(largoDeCompas([0, 2000, 4100], 2000), 2100)
  assert.equal(largoDeCompas([0, 2000, 4100], 4100), 2100)
  assert.deepEqual(normalizarAjustesColchon({ tonalidad: 'Bb', bpm: 70.4 }), { tonalidad: 'A#', bpm: 70, compas: 4, click: true, volumenPad: 80, volumenClick: 80 })
  assert.equal(normalizarAjustesColchon({ bpm: 500 }), null)
  assert.equal(normalizarAjustesColchon({ tonalidad: 'X' }), null)
  assert.equal(normalizarAjustesColchon({ tonalidad: null, click: false })!.tonalidad, null)
  assert.equal(nombreDeColchon({ tonalidad: 'D', bpm: 72, compas: 4, click: true, volumenPad: 80, volumenClick: 80 }), 'Colchón · D · 72 BPM')
})

test('colchón de la lista: se crea, empieza al dar play, cambia en vivo y se apaga despacio', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const r = await emitAck<{ ok: boolean; error?: string; id?: string }>(compu, 'colchon:crear', { ajustes: { tonalidad: 'E', bpm: 70, compas: 3, click: true } })
  assert.equal(r.ok, true, r.error)
  const resumen = (await emitAck<ProyectoResumen[]>(compu, 'projects:list', {})).find((p) => p.id === r.id)!
  assert.deepEqual([resumen.nombre, resumen.colchon, resumen.bpm, resumen.compas, resumen.cantidadPistas], ['Colchón · E · 70 BPM', true, 70, 3, 0])
  // a una lista, como cualquier cancion
  const lista = await emitAck<{ ok: boolean; id?: string }>(compu, 'listas:crear', { nombre: 'Domingo', proyectos: [r.id] })
  assert.equal(lista.ok, true)
  assert.equal((await emitAck<{ ok: boolean }>(compu, 'listas:usar', { id: lista.id })).ok, true)
  let e = await emitAck<EstadoCompleto>(compu, 'state:request', {})
  assert.equal(e.proyectoActivo!.id, r.id)
  assert.deepEqual(e.proyectoActivo!.colchon, { tonalidad: 'E', bpm: 70, compas: 3, click: true, volumenPad: 80, volumenClick: 80 })
  assert.equal(e.colchon, null)

  // play: arranca enseguida (sin cuenta), para todos a la misma hora; la "cancion" no se mueve
  const t0 = Date.now()
  e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !!x.colchon), compu.emit('transport:play', {})]))[0]
  const c = e.colchon!
  assert.equal(c.desdeCancion, false)
  assert.deepEqual([c.pad, c.pulsos, c.click, c.volumenPad, c.hasta], ['E', 3, true, 80, null])
  assert.ok(Math.abs(c.compasMs - (60000 / 70) * 3) < 0.01)
  assert.ok(c.inicio >= t0 && c.inicio - t0 < 300, `empieza a ${c.inicio - t0} ms`)
  assert.equal(e.playbackActivo!.estado, 'stopped')
  // play de nuevo: nada (ya suena)
  compu.emit('transport:play', {})
  await esperar(150)
  assert.equal(env.server.state.colchon!.id, c.id)

  // otro BPM sonando: desde un golpe de la grilla de antes, y queda guardado (con el nombre)
  e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !!x.colchon && Math.abs(x.colchon.compasMs - 2250) < 0.01), compu.emit('colchon:ajustar', { bpm: 80 })]))[0]
  assert.equal(e.colchon!.id, c.id)
  const pulsoViejo = c.compasMs / 3
  const k = (e.colchon!.inicio - c.inicio) / pulsoViejo
  assert.ok(Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1, `el cambio cae en un golpe (k = ${k})`)
  assert.equal(e.proyectoActivo!.colchon!.bpm, 80)
  assert.equal(e.proyectoActivo!.nombre, 'Colchón · E · 80 BPM')
  // el pad, en vivo
  e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => x.colchon?.pad === 'G'), compu.emit('colchon:ajustar', { tonalidad: 'G', volumenPad: 50 })]))[0]
  assert.equal(e.colchon!.volumenPad, 50)
  assert.equal(e.proyectoActivo!.colchon!.tonalidad, 'G')

  // pausa: el click para en el proximo golpe y el pad se apaga en 4 s; despues el colchon ya no esta
  e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => x.colchon?.hasta != null), compu.emit('transport:pause')]))[0]
  const hasta = e.colchon!.hasta!
  assert.equal(e.colchon!.salidaPadMs, 4000)
  const pulso = e.colchon!.compasMs / 3
  assert.ok(Math.abs(((hasta - e.colchon!.inicio) / pulso) % 1) < 1e-6, 'termina en un golpe')
  await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.colchon, 8000)
  assert.ok(Date.now() >= hasta + 4000)

  // no se puede crear con ajustes invalidos
  const mal = await emitAck<{ ok: boolean; error?: string }>(compu, 'colchon:crear', { ajustes: { bpm: 1000 } })
  assert.equal(mal.ok, false)
  await env.cerrar()
})

test('colchón dentro de la canción: en el próximo compás se va la banda, y vuelve en el "1" de la sección que se toque', async (t) => {
  const env = await entorno(t)
  const compu = await env.conectar(compuAuth)
  const largo = path.join(tmpDir('multitrack-audio-'), 'largo.wav')
  generarAudio(largo, 20, 'mono')
  await cargarZip(compu, crearZip('Colchon', { 'Click.wav': largo, 'marcas.txt': Buffer.from('0:04 Verso\n0:08 Coro\n0:12 Puente\n') }))
  const p = env.server.state.getActiveTab()!.proyecto
  // 120 BPM 4/4 (compas de 2 s), en A
  p.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 11 }, (_, k) => k * 2000), clickPistaId: p.pistas[0].id, acentoClaro: true }
  p.tonalidad = 'A'
  p.cuenta = 0
  const entrar = (): Promise<{ ok: boolean; error?: string }> => emitAck(compu, 'colchon:entrar', {})
  const estado = (): Promise<EstadoCompleto> => emitAck<EstadoCompleto>(compu, 'state:request', {})
  const play = (filtro: (c: ComandoProgramado) => boolean = (c) => c.accion === 'play'): Promise<ComandoProgramado> => esperarEvento<ComandoProgramado>(compu, 'playback:scheduled', filtro, 5000)

  // parado no hay colchon
  const parado = await entrar()
  assert.equal(parado.ok, false)
  assert.match(parado.error!, /sonando/)

  // sonando en 1 s: el colchon empieza en el "1" del proximo compas (2 s de la cancion)
  const [inicio] = await Promise.all([play(), compu.emit('transport:play', { positionMs: 1000 })])
  await esperar(100)
  assert.equal((await entrar()).ok, true)
  let c = (await estado()).colchon!
  assert.deepEqual([c.desdeCancion, c.pad, c.pulsos, c.compasMs, c.volumenClick, c.hasta], [true, 'A', 4, 2000, 100, null])
  assert.equal(c.inicio, inicio.executeAtServerTime + 1000)
  // la cancion se pausa (ya en silencio) al terminar ese compas
  const pausa = await play((x) => x.accion === 'pause')
  assert.equal(pausa.executeAtServerTime, c.inicio + 2000)
  assert.equal(pausa.positionMs, 4000)

  // tocar el Puente: vuelve en el proximo compas del colchon, en el Puente, sin cuenta
  const [vuelta] = await Promise.all([play(), compu.emit('seccion:saltar', { posicionMs: 12000 })])
  assert.equal(vuelta.positionMs, 12000)
  assert.equal(vuelta.playback.cuenta, undefined)
  assert.equal((vuelta.executeAtServerTime - c.inicio) % 2000, 0, 'en el "1"')
  c = (await estado()).colchon!
  assert.deepEqual([c.hasta, c.salidaPadMs], [vuelta.executeAtServerTime, 1500])
  // y cuando el pad termino de irse, ya no hay colchon
  await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.colchon, 6000)
  assert.ok(Date.now() >= vuelta.executeAtServerTime + 1500)

  // play en el colchon = seguir donde quedo la cancion (en el proximo compas)
  await entrar()
  const pausa2 = await play((x) => x.accion === 'pause')
  c = (await estado()).colchon!
  const [seguir] = await Promise.all([play(), compu.emit('transport:play', {})])
  assert.equal(seguir.positionMs, pausa2.positionMs)
  assert.equal((seguir.executeAtServerTime - c.inicio) % 2000, 0)
  await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.colchon, 6000)

  // elegido antes de que empiece: no hubo colchon, la cancion sigue (y el salto es uno comun)
  await Promise.all([play(), compu.emit('transport:play', { positionMs: 1000 })])
  await esperar(50)
  await entrar()
  const e = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.colchon && !!x.saltoPendiente), compu.emit('seccion:saltar', { posicionMs: 8000 })]))[0]
  assert.equal(e.saltoPendiente!.destinoMs, 8000)
  await Promise.all([play((x) => x.accion === 'pause'), compu.emit('transport:pause')])

  // "Terminar": el click para y el pad se va despacio; la cancion queda en pausa
  await Promise.all([play(), compu.emit('transport:play', { positionMs: 1000 })])
  await entrar()
  await play((x) => x.accion === 'pause')
  c = (await Promise.all([esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => x.colchon?.hasta != null), compu.emit('colchon:terminar')]))[0].colchon!
  assert.equal(c.salidaPadMs, 4000)
  assert.equal((await estado()).playbackActivo!.estado, 'paused')
  await esperarEvento<EstadoCompleto>(compu, 'estado:actualizado', (x) => !x.colchon, 8000)

  // sigue aunque se cambie de cancion; al dar play a la otra, acompana la cuenta y se va
  await Promise.all([play(), compu.emit('transport:play', { positionMs: 1000 })])
  await entrar()
  await play((x) => x.accion === 'pause')
  const otra = await cargarZip(compu, crearZip('Otra', { 'Click.wav': largo }))
  assert.equal(otra.proyectoActivo!.nombre, 'Otra')
  assert.ok(otra.colchon && otra.colchon.hasta === null, 'el colchon sigue')
  const p2 = env.server.state.getActiveTab()!.proyecto
  p2.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 11 }, (_, k) => k * 2000), clickPistaId: p2.pistas[0].id, acentoClaro: true }
  p2.cuenta = 1
  const [conCuenta] = await Promise.all([play(), compu.emit('transport:play', { positionMs: 0 })])
  c = (await estado()).colchon!
  const inicioCuenta = conCuenta.playback.cuenta!.golpes[0].t
  assert.equal(c.hasta, inicioCuenta, 'el click del colchon para cuando empieza la cuenta')
  assert.equal(c.salidaPadMs, conCuenta.executeAtServerTime - inicioCuenta + 1500, 'el pad acompaña la cuenta')
  compu.emit('transport:stop')
  await env.cerrar()
})

test('pads del colchón: uno por nota, en el tono (sin tercera) y sin corte en el loop', async (t) => {
  const env = await entorno(t)
  const sr = 22050
  const bajar = async (i: number | string): Promise<{ status: number; x: Float32Array | null }> => {
    const r = await fetch(`http://localhost:${env.port}/pad/${i}.wav`)
    if (r.status !== 200) return { status: r.status, x: null }
    const bytes = await r.arrayBuffer()
    const info = parseWavHeader(bytes)
    assert.deepEqual([info.sampleRate, info.numChannels], [sr, 1])
    return { status: 200, x: decodePcmSegment(info, bytes.slice(info.dataOffset))[0] }
  }
  // energia alrededor de una frecuencia (+-0,5 Hz: el coro y el vibrato la abren un poco), en 8 s
  const cerca = (x: Float32Array, f: number): number => {
    const tramo = x.subarray(0, 8 * sr)
    let total = 0
    for (let d = -0.5; d <= 0.5001; d += 0.125) total += energiaEn(tramo, f + d, sr)
    return total
  }
  const t0 = Date.now()
  const d = await bajar(2)
  const primera = Date.now() - t0
  assert.equal(d.status, 200)
  const x = d.x!
  assert.equal(x.length, 32 * sr)
  // D: raiz, quinta y octava; sin la tercera (ni mayor ni menor) ni las notas de al lado
  const re = 73.416
  const raiz = cerca(x, re)
  assert.ok(cerca(x, re * 1.5) > raiz * 0.05, 'la quinta')
  assert.ok(cerca(x, re * 2) > raiz * 0.05, 'la octava')
  for (const [nombre, f] of [
    ['D#', 77.78],
    ['E', 82.41],
    ['F (tercera menor)', 87.31],
    ['F# (tercera mayor)', 92.5]
  ] as const) {
    assert.ok(cerca(x, f) < raiz / 30, `${nombre}: ${cerca(x, f) / raiz}`)
  }
  // el loop empalma: el salto del final al principio es como el de dos muestras seguidas
  let tipico = 0
  for (let i = 1; i < x.length; i++) tipico += Math.abs(x[i] - x[i - 1])
  tipico /= x.length - 1
  assert.ok(Math.abs(x[0] - x[x.length - 1]) < 4 * tipico, `salto ${Math.abs(x[0] - x[x.length - 1])} vs ${tipico}`)
  let pico = 0
  for (const v of x) pico = Math.max(pico, Math.abs(v))
  assert.ok(pico > 0.6 && pico < 0.75, `pico ${pico}`)
  // la segunda vez ya esta hecho (queda en disco)
  const t1 = Date.now()
  await bajar(2)
  assert.ok(Date.now() - t1 < Math.max(300, primera / 2), `segunda vez ${Date.now() - t1} ms (primera ${primera} ms)`)
  assert.ok(fs.existsSync(path.join(env.appDir, 'pads')))
  // A: la raiz en 110 Hz (y no en La#)
  const a = (await bajar(9)).x!
  assert.ok(cerca(a, 110) > 30 * cerca(a, 116.54))
  assert.equal((await bajar(12)).status, 404)
  assert.equal((await bajar('x')).status, 404)
  await env.cerrar()
})
