/**
 * AirTracks Video de punta a punta: el servidor real, el programa del
 * proyector real (Electron 22, el de Windows 7) y una cancion con su "lyric
 * video" de la misma grabacion (con 3 s de placa al principio y una voz que
 * la multitrack no tiene). Comprueba que:
 *  - se alinea solo (encuentra los 3 s),
 *  - el video sigue la cancion: arranca, salta de seccion, pausa y se va al parar,
 *  - la pantalla de video no cuenta como celular: el margen de arranque y el
 *    tope de la licencia no cambian, y si se cae, nadie se entera.
 *
 *   npm run test:video   (en Linux, dentro de xvfb-run)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { createServer, type AppServer } from '../server'
import { rutaFfmpeg } from '../server/audio'
import { generarClick, wav16 } from '../server/__fixtures__/sintetico'
import { generarBanda } from '../server/__fixtures__/banda'
import { posicionActualMs } from '../shared/playback'
import type { DiagnosticoServidor, EstadoCompleto, ProyectoResumen } from '../shared/types'
import type { ApiVideo, EstadoApp } from '../video/tipos'

const RAIZ = path.resolve(__dirname, '../..')
const ELECTRON_22 = path.join(RAIZ, 'video/node_modules/electron/dist/electron')
const TOKEN = 'e2e-video'
const SEG = 60
const PLACA_SEG = 3
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function esperarQue<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30000, que = 'condición'): Promise<T> {
  const fin = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > fin) throw new Error(`timeout esperando ${que}`)
    await esperar(150)
  }
}

/** 44,1 kHz a partir de la banda de 8 kHz (sin filtros: alcanza para la prueba). */
function a44k(x: Float32Array): Float32Array {
  const y = new Float32Array(Math.round((x.length * 44100) / 8000))
  for (let i = 0; i < y.length; i++) y[i] = x[Math.min(x.length - 1, Math.floor((i * 8000) / 44100))]
  return y
}

test('AirTracks Video: un video dejado en la carpeta se vincula y se alinea solo, sigue la canción (play, salto, pausa, stop), no toca a los celulares y la carpeta pasa a otra compu ya alineada', { timeout: 240000, skip: !fs.existsSync(ELECTRON_22) && 'falta Electron 22 (cd video && npm install)' }, async (t) => {
  const ffmpeg = rutaFfmpeg()!
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airtracks-video-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const renderer = path.join(tmp, 'renderer')
  fs.mkdirSync(renderer)
  fs.writeFileSync(path.join(renderer, 'index.html'), '<html></html>')
  const server: AppServer = createServer(renderer, { compuToken: TOKEN })
  const port = await server.start(0)
  const url = `http://127.0.0.1:${port}`
  const compu: ClientSocket = ioClient(url, { auth: { origen: 'compu', token: TOKEN }, reconnection: false })
  await new Promise<void>((r) => compu.once('connect', () => r()))
  const ack = <T>(ev: string, payload: unknown, ms = 60000): Promise<T> =>
    new Promise((res, rej) => compu.timeout(ms).emit(ev, payload, (err: unknown, r: T) => (err ? rej(err) : res(r))))
  let app: ElectronApplication | null = null
  let celular: ClientSocket | null = null
  t.after(async () => {
    await app?.close().catch(() => undefined)
    celular?.close()
    compu.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ---- la cancion: click + bateria/acordes (la multitrack, sin la voz) ----
  const { banda, voz } = generarBanda(SEG, 7)

  const zip = new AdmZip()
  zip.addFile('01 Click.wav', wav16(generarClick(76, 4, SEG), 44100))
  zip.addFile('02 Banda.wav', wav16(a44k(banda), 44100))
  const rutaZip = path.join(tmp, 'Gracia Sublime.zip')
  zip.writeZip(rutaZip)
  assert.equal((await ack<{ ok: boolean; error?: string }>('project:load-from-zip', { filePath: rutaZip })).ok, true)
  const proyecto = (await ack<EstadoCompleto>('state:request', {})).proyectoActivo!
  compu.emit('marker:create', { tiempoMs: 30000, nombre: 'Coro' })

  // ---- el "lyric video": 3 s de placa y despues la misma grabacion, con voz ----
  const audioVideo = new Float32Array((SEG + PLACA_SEG) * 8000)
  for (let i = 0; i < banda.length; i++) audioVideo[i + PLACA_SEG * 8000] = 0.6 * (banda[i] + 1.5 * voz[i])
  const wavVideo = path.join(tmp, 'audio-video.wav')
  fs.writeFileSync(wavVideo, wav16(a44k(audioVideo), 44100))
  const video = path.join(tmp, 'Gracia Sublime (Lyric Video).webm')
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-i', wavVideo, '-shortest', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', video])
  assert.equal(r.status, 0, r.stderr?.toString())

  // ---- un celular conectado (el que no se tiene que enterar) ----
  celular = ioClient(url, { auth: { origen: 'celular', deviceId: 'celular-video-prueba-1' }, reconnection: false })
  await new Promise<void>((res) => celular!.once('connect', () => res()))
  await esperar(500)
  const margenAntes = (await ack<DiagnosticoServidor>("diagnostico:obtener", {})).arranque?.margenMs

  // ---- AirTracks Video (Electron 22) ----
  app = await electron.launch({
    executablePath: ELECTRON_22,
    args: ['--no-sandbox', path.join(RAIZ, 'video')],
    env: { ...process.env, AIRTRACKS_VIDEO_DIR: path.join(tmp, 'video-datos'), AIRTRACKS_SERVIDOR: url }
  })
  const ventanas = async (): Promise<{ control: Page; pantalla: Page }> => {
    const ws = app!.windows()
    const control = ws.find((w) => w.url().includes('control.html'))
    const pantalla = ws.find((w) => w.url().includes('pantalla.html'))
    return control && pantalla ? { control, pantalla } : (null as never)
  }
  const { control, pantalla } = await esperarQue(async () => {
    const ws = app!.windows()
    return ws.some((w) => w.url().includes('control.html')) && ws.some((w) => w.url().includes('pantalla.html')) ? ventanas() : null
  }, 30000, 'las ventanas de AirTracks Video')
  const errores: string[] = []
  for (const p of [control, pantalla]) p.on('pageerror', (e) => errores.push(e.message))
  const estadoApp = (): Promise<EstadoApp> => control.evaluate(() => (window as unknown as { airtracksVideo: ApiVideo }).airtracksVideo.estado())
  await esperarQue(async () => (await estadoApp()).conexion.estado === 'conectado', 30000, 'que se conecte')
  assert.ok(!(await estadoApp()).conexion.desactualizado, 'esta version de AirTracks sabe de videos')

  // no cuenta como celular: el margen de arranque es el mismo y en la lista figura como pantalla de video
  const diag = await ack<DiagnosticoServidor>('diagnostico:obtener', {})
  assert.equal(diag.arranque?.margenMs, margenAntes, 'la pantalla de video no cambia el margen de arranque de los celulares')
  assert.ok(diag.dispositivos.some((d) => d.origen === 'video' && d.conectado))
  assert.equal(diag.dispositivos.filter((d) => d.origen === 'celular' && d.conectado).length, 1)

  // ---- el video se deja en la carpeta de videos: se vincula solo con la cancion del mismo nombre y se alinea ----
  const canciones = await control.evaluate(() => (window as unknown as { airtracksVideo: ApiVideo }).airtracksVideo.canciones())
  assert.ok(canciones.some((c: ProyectoResumen) => c.id === proyecto.id), 've las canciones de AirTracks')
  const carpeta = path.join(tmp, 'video-datos', 'AirTracks Video')
  const alAbrir = await estadoApp()
  assert.equal(alAbrir.carpeta, carpeta)
  assert.equal(alAbrir.carpetaConfirmada, false, 'la primera vez pregunta dónde guardar los videos')
  const captura = async (p: Page, nombre: string): Promise<void> => {
    if (process.env.E2E_CAPTURAS) await p.screenshot({ path: path.join(process.env.E2E_CAPTURAS, `${nombre}.png`) })
  }
  await captura(control, 'video-primera-vez')
  await control.getByRole('button', { name: 'Usar esta carpeta' }).click()
  await esperarQue(async () => (await estadoApp()).carpetaConfirmada, 5000, 'que se confirme la carpeta')
  fs.copyFileSync(video, path.join(carpeta, path.basename(video)))
  const alineado = await esperarQue(
    async () => (await estadoApp()).videos.find((v) => v.proyectoId === proyecto.id && (v.estado === 'listo' || v.estado === 'revisar' || v.estado === 'error')),
    90000,
    'que se vincule y se alinee'
  )
  assert.equal(alineado.estado, 'listo', `${alineado.estado}: ${alineado.mensaje ?? ''} ${JSON.stringify(alineado.alineacion)}`)
  assert.ok(Math.abs(alineado.desfaseMs! - PLACA_SEG * 1000) <= 40, `desfase ${alineado.desfaseMs}`)
  assert.equal(alineado.archivo, path.basename(video))
  assert.deepEqual((await estadoApp()).sueltos, [])
  await captura(control, 'video-alineado')
  // al lado del video, su ficha con la cancion y la alineacion
  const ficha = path.join(carpeta, 'Gracia Sublime (Lyric Video).airtracks-video.json')
  assert.equal(JSON.parse(fs.readFileSync(ficha, 'utf-8')).desfaseMs, alineado.desfaseMs)
  // la compu de AirTracks sabe que esta cancion tiene video
  await esperarQue(async () => (await ack<EstadoCompleto>('state:request', {})).pantallaVideo?.canciones.includes(proyecto.id), 10000, 'el aviso a la compu')

  // proyector: la unica pantalla que hay (en la iglesia, la del proyector)
  await control.evaluate(async () => {
    const api = (window as unknown as { airtracksVideo: ApiVideo }).airtracksVideo
    const e = await api.estado()
    api.elegirPantalla(e.pantallas[0].id)
  })

  const visible = (): Promise<boolean> =>
    app!.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('proyector'))?.isVisible())
  /** diferencia entre el video y donde tiene que estar (s), medida en el mismo instante */
  const diferencia = async (): Promise<{ dif: number; paused: boolean }> => {
    const e = await ack<EstadoCompleto>('state:request', {})
    const medido = await pantalla.evaluate(() => {
      const v = document.querySelector('video.activo') as HTMLVideoElement
      return { t: v.currentTime, paused: v.paused, ahora: Date.now() }
    })
    const esperado = posicionActualMs(e.playbackActivo!, medido.ahora) / 1000 + alineado.desfaseMs! / 1000
    return { dif: medido.t - esperado, paused: medido.paused }
  }

  assert.equal(await visible(), false, 'parado: no tapa a Holyrics')

  // ---- play: el video aparece y va con la cancion ----
  compu.emit('transport:play', {})
  await esperarQue(visible, 15000, 'que aparezca el video (quieto mientras se cuenta)')
  // despues de la cuenta, 2,5 s de musica
  const arranque = (await ack<EstadoCompleto>('state:request', {})).playbackActivo!.referenceServerTime
  await esperar(Math.max(0, arranque - Date.now()) + 2500)
  const enPlay = await diferencia()
  assert.equal(enPlay.paused, false)
  assert.ok(Math.abs(enPlay.dif) < 0.12, `video corrido ${enPlay.dif.toFixed(3)} s`)

  // ---- salto de seccion: el video salta al mismo punto ----
  /** espera a que la ultima orden llegue a su hora (el margen de arranque de los celulares) y `ms` mas */
  const trasLaOrden = async (ms: number): Promise<void> => {
    await esperar(300)
    const ref = (await ack<EstadoCompleto>('state:request', {})).playbackActivo!.referenceServerTime
    await esperar(Math.max(0, ref - Date.now()) + ms)
  }
  compu.emit('seccion:saltar', { posicionMs: 30000, inmediato: true })
  await trasLaOrden(1500)
  const trasSalto = await diferencia()
  assert.ok(Math.abs(trasSalto.dif) < 0.12, `después del salto, corrido ${trasSalto.dif.toFixed(3)} s`)

  // ---- pausa: quieto en el punto justo ----
  compu.emit('transport:pause')
  await trasLaOrden(800)
  const enPausa = await diferencia()
  assert.equal(enPausa.paused, true)
  assert.ok(Math.abs(enPausa.dif) < 0.06, `en pausa, corrido ${enPausa.dif.toFixed(3)} s`)

  console.log(`video vs canción: sonando ${(enPlay.dif * 1000).toFixed(0)} ms · tras el salto ${(trasSalto.dif * 1000).toFixed(0)} ms · en pausa ${(enPausa.dif * 1000).toFixed(0)} ms`)

  // ---- stop: se va (vuelve a verse Holyrics) ----
  compu.emit('transport:stop')
  await esperarQue(async () => !(await visible()), 5000, 'que se esconda')

  // ---- si el programa del video se cae, la reproduccion de los celulares sigue igual ----
  compu.emit('transport:play', {})
  await esperar(1500)
  await app.close()
  app = null
  await esperar(800)
  const sigue = await ack<EstadoCompleto>('state:request', {})
  assert.equal(sigue.playbackActivo?.estado, 'playing')
  assert.equal(sigue.pantallaVideo?.conectada, false)
  assert.equal((await ack<DiagnosticoServidor>('diagnostico:obtener', {})).arranque?.margenMs, margenAntes)
  assert.ok(celular.connected, 'el celular sigue conectado')
  assert.deepEqual(errores, [])
  compu.emit('transport:stop')

  // ---- otra compu del data: se copia la carpeta de videos y aparece todo ya alineado ----
  // (en esta AirTracks la cancion tiene otro id, como si se hubiera importado de nuevo: se encuentra por el nombre)
  const otra = path.join(tmp, 'otra-compu', 'Videos de la iglesia')
  fs.cpSync(carpeta, otra, { recursive: true })
  const fichaOtra = path.join(otra, path.basename(ficha))
  fs.writeFileSync(fichaOtra, JSON.stringify({ ...JSON.parse(fs.readFileSync(fichaOtra, 'utf-8')), proyectoId: 'id-de-la-otra-compu' }))
  const datosOtra = path.join(tmp, 'otra-compu', 'datos')
  app = await electron.launch({
    executablePath: ELECTRON_22,
    args: ['--no-sandbox', path.join(RAIZ, 'video')],
    env: { ...process.env, AIRTRACKS_VIDEO_DIR: datosOtra, AIRTRACKS_VIDEO_CARPETA: otra, AIRTRACKS_SERVIDOR: url }
  })
  const control2 = await esperarQue<Page>(async () => app!.windows().find((w) => w.url().includes('control.html')) ?? null, 30000, 'la ventana en la otra compu')
  const errores2: string[] = []
  control2.on('pageerror', (e) => errores2.push(e.message))
  const estado2 = (): Promise<EstadoApp> => control2.evaluate(() => (window as unknown as { airtracksVideo: ApiVideo }).airtracksVideo.estado())
  const copiado = await esperarQue(async () => (await estado2()).videos.find((v) => v.proyectoId === proyecto.id) ?? null, 30000, 'el video de la carpeta copiada')
  assert.equal(copiado.estado, 'listo')
  assert.equal(copiado.desfaseMs, alineado.desfaseMs, 'con la misma alineación')
  assert.equal(fs.readdirSync(path.join(datosOtra, 'huellas')).length, 0, 'sin volver a procesar el video')
  assert.equal(JSON.parse(fs.readFileSync(fichaOtra, 'utf-8')).proyectoId, proyecto.id, 'la ficha queda con la canción de esta AirTracks')
  await esperarQue(async () => (await ack<EstadoCompleto>('state:request', {})).pantallaVideo?.canciones.includes(proyecto.id), 10000, 'el aviso a la compu')

  // ---- agregar un video desde afuera: se copia a la carpeta con el nombre de la cancion (reemplaza al que habia) ----
  const agregado = await control2.evaluate(
    ([ruta, id, nombre]) => (window as unknown as { airtracksVideo: ApiVideo }).airtracksVideo.agregarVideo(ruta, id, nombre),
    [video, proyecto.id, proyecto.nombre] as const
  )
  assert.ok(!('error' in agregado), JSON.stringify(agregado))
  assert.equal(agregado.archivo, 'Gracia Sublime.webm')
  assert.ok(fs.existsSync(path.join(otra, 'Gracia Sublime.webm')) && fs.existsSync(path.join(otra, 'Gracia Sublime.airtracks-video.json')))
  assert.ok(!fs.existsSync(path.join(otra, path.basename(video))) && !fs.existsSync(fichaOtra), 'el anterior se fue')
  const realineado = await esperarQue(
    async () => (await estado2()).videos.find((v) => v.proyectoId === proyecto.id && v.archivo === 'Gracia Sublime.webm' && v.estado !== 'alineando') ?? null,
    90000,
    'que se alinee el nuevo'
  )
  assert.equal(realineado.estado, 'listo')
  assert.ok(Math.abs(realineado.desfaseMs! - PLACA_SEG * 1000) <= 40, `desfase ${realineado.desfaseMs}`)
  assert.deepEqual((await estado2()).sueltos, [])
  assert.deepEqual(errores2, [])
})
