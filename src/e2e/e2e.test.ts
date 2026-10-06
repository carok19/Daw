/**
 * Prueba de punta a punta: servidor real + interfaz real (build de Vite) en
 * Chromium, con una "compu" (Electron simulado con el token verdadero) y dos
 * celulares. Genera canciones de prueba con ffmpeg.
 *
 *   npx playwright install chromium   (una sola vez)
 *   npm run test:e2e
 *
 * Con `?debug` los celulares exponen el motor de audio (window.__mt) para
 * medir el desfase real contra el reloj del servidor.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import AdmZip from 'adm-zip'
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer, type AppServer } from '../server'
import { rutaFfmpeg } from '../server/audio'
import { buildEstadoCompleto } from '../server/estado'
import { ANUNCIOS, generarClick, inicioCompas, SR, wav16, zipConGuia } from '../server/__fixtures__/sintetico'
import { crearRar5 } from '../server/__fixtures__/rar'
import { verificarLicencia } from '../server/licencia'
import { deBase64Url } from '../shared/licencia'
import { SEGMENTO_SEC } from '../shared/mezcla'
import { posicionActualMs } from '../shared/playback'
import type { DispositivoInfo } from '../shared/types'

const RENDERER = path.resolve(__dirname, '../renderer')
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Cancion de prueba comprimida (.zip, o .rar como las que se bajan de internet). */
function generarZip(dir: string, nombre: string, pistas: [string, number][], segundos: number, ext: 'wav' | 'mp3', formato: 'zip' | 'rar' = 'zip'): string {
  const ffmpeg = rutaFfmpeg()
  assert.ok(ffmpeg, 'hace falta ffmpeg')
  const archivos: { nombre: string; datos: Buffer }[] = []
  for (const [pista, freq] of pistas) {
    const archivo = path.join(dir, `${pista}.${ext}`)
    const r: SpawnSyncReturns<Buffer> = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${segundos}`, '-ac', '2', archivo])
    assert.equal(r.status, 0, r.stderr?.toString())
    archivos.push({ nombre: path.basename(archivo), datos: fs.readFileSync(archivo) })
  }
  const destino = path.join(dir, `${nombre}.${formato}`)
  if (formato === 'rar') fs.writeFileSync(destino, crearRar5(archivos)[0])
  else {
    const zip = new AdmZip()
    for (const a of archivos) zip.addFile(a.nombre, a.datos)
    zip.writeZip(destino)
  }
  return destino
}

/** Cuenta los AudioBufferSourceNode que estan sonando (para saber si un dispositivo suena). */
function espiaAudio(): void {
  const w = globalThis as unknown as { __vivas: number; AudioBufferSourceNode: { prototype: Record<string, unknown> } }
  w.__vivas = 0
  const P = w.AudioBufferSourceNode.prototype as unknown as {
    start: (...a: unknown[]) => void
    stop: (...a: unknown[]) => void
  }
  const start = P.start
  const stop = P.stop
  P.start = function (this: { __viva?: boolean; addEventListener: (e: string, f: () => void) => void }, ...a: unknown[]) {
    if (!this.__viva) {
      this.__viva = true
      w.__vivas++
      this.addEventListener('ended', () => {
        if (this.__viva) {
          this.__viva = false
          w.__vivas--
        }
      })
    }
    return start.apply(this, a)
  }
  P.stop = function (this: { __viva?: boolean }, ...a: unknown[]) {
    if (this.__viva) {
      this.__viva = false
      w.__vivas--
    }
    return stop.apply(this, a)
  }
}

const vivas = (p: Page): Promise<number> => p.evaluate(() => (globalThis as unknown as { __vivas: number }).__vivas)

/** Desfase (ms) entre lo que suena en el celular y lo que el servidor dice que deberia sonar. */
function desfase(p: Page): Promise<number | null> {
  return p.evaluate(() => {
    type Pb = { estado: string; positionMs: number; referenceServerTime: number; previo?: Pb }
    const mt = (globalThis as unknown as {
      __mt: {
        engineRef: { current: { posicionRealMs(): number | null } | null }
        socketRef: { current: { serverNow(): number } }
        estadoRef: { current: { playbackActivo: Pb | null } | null }
      }
    }).__mt
    const real = mt.engineRef.current?.posicionRealMs() ?? null
    let pb = mt.estadoRef.current?.playbackActivo ?? null
    if (real === null || !pb) return null
    const now = mt.socketRef.current.serverNow()
    while (pb.previo && now < pb.referenceServerTime) pb = pb.previo
    const esperado = pb.estado === 'playing' && now > pb.referenceServerTime ? pb.positionMs + now - pb.referenceServerTime : pb.positionMs
    return Math.round(real - esperado)
  })
}

/**
 * Sync de los celulares contra el reloj del servidor (y por lo tanto entre ellos):
 *  - nunca cerca del resync duro (150 ms);
 *  - todos juntos a menos de 20 ms, y si alguno se corrio, vuelve solo en un tiempo acotado.
 * En Chromium headless (4 nucleos compartidos con el servidor y los otros navegadores) el dispositivo de
 * audio falso a veces se atrasa de golpe 20-90 ms, como un corte de audio en un celular real: se mide
 * (con la posicion que de verdad suena, incluso a mitad de una correccion) que el monitor de drift lo
 * detecte y lo absorba con el ajuste de velocidad inaudible.
 */
async function enSync(celulares: Page[], contexto: string, convergerMs = 25000): Promise<void> {
  const fin = Date.now() + convergerMs
  for (;;) {
    const d = await Promise.all(celulares.map((c) => desfase(c)))
    if (d.some((x) => x === null)) {
      // justo en un salto/vuelta del loop (el nuevo arranque esta programado un instante despues)
      assert.ok(Date.now() < fin, `${contexto}: un celular no suena`)
      await esperar(100)
      continue
    }
    const v = d as number[]
    assert.ok(v.every((x) => Math.abs(x) < 150), `${contexto}: desfase fuera de control ${v.join(' / ')} ms`)
    if (v.every((x) => Math.abs(x) < 20)) return
    assert.ok(Date.now() < fin, `${contexto}: no volvió a sync (${v.join(' / ')} ms)`)
    await esperar(250)
  }
}

/** Con E2E_CAPTURAS=<carpeta>, guarda como se ve la pantalla (para revisar el diseño). */
async function captura(p: Page, nombre: string): Promise<void> {
  const dir = process.env.E2E_CAPTURAS
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  await p.screenshot({ path: path.join(dir, `${nombre}.png`) })
}

/** La compu: la vista de la cancion con las secciones (tarjetas) o la de la mezcla (el mixer). */
async function vistaCompu(compu: Page, vista: 'Secciones' | 'Mezcla'): Promise<void> {
  const tab = compu.getByRole('tab', { name: new RegExp(`^${vista}`) })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/** El celular: la pantalla de la cancion (recorrido y secciones) o "Mi mezcla". */
async function vistaCelular(cel: Page, vista: 'Canción' | 'Mi mezcla'): Promise<void> {
  const tab = cel.getByRole('tab', { name: vista })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/** Cuantas secciones ve un celular (las tarjetas de la pantalla de la cancion) y si se pueden tocar. */
async function seccionesEnCelular(cel: Page): Promise<{ cantidad: number; deshabilitadas: boolean }> {
  await vistaCelular(cel, 'Canción')
  // (las secciones: sin la de "Terminar", la ultima del director)
  const tarjetas = cel.locator('.m-vista-cancion .m-marcador:not(.terminar)')
  const cantidad = await tarjetas.count()
  const deshabilitadas = cantidad > 0 && (await tarjetas.first().isDisabled())
  return { cantidad, deshabilitadas }
}

/**
 * Un celular de la banda que ya eligio su rol (director, salvo que se pida
 * otro; null = como recien instalado: pregunta "¿Que haces en la banda?").
 */
async function contextoCelular(browser: Browser, dispositivo: (typeof devices)[string], rol: string | null = 'director'): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...dispositivo })
  if (rol) {
    await ctx.addInitScript((r: string) => {
      try {
        if (!localStorage.getItem('multitrack:rol')) localStorage.setItem('multitrack:rol', JSON.stringify(r))
      } catch {
        // sin almacenamiento
      }
    }, rol)
  }
  return ctx
}

/** Deslizar el dedo (eventos tactiles reales de Chromium: el navegador decide si scrollea). */
async function deslizar(cel: Page, desde: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const cdp = await cel.context().newCDPSession(cel)
  const punto = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: punto(desde.x, desde.y) })
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: punto(desde.x + (dx * i) / 10, desde.y + (dy * i) / 10) })
    await esperar(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test('e2e: compu + 2 celulares', { timeout: 5 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-e2e-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const zipWav = generarZip(tmp, 'Cuan Grande Es El', [['01_Click', 1000], ['02_Guia', 660], ['03_Bajo', 82], ['04_Pad', 330]], 40, 'wav')
  const zipMp3 = generarZip(tmp, 'Rey de Reyes', [['Click', 900], ['Guia', 550], ['Bajo', 110]], 25, 'mp3', 'rar')

  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e' })
  const port = await server.start(0)
  const biblioteca = path.join(tmp, 'Biblioteca')
  server.iniciarServicios(biblioteca, { descubrimiento: false, puertoCorto: null })
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ---- compu (ventana de Electron simulada con el token verdadero) ----
  const ctxCompu: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  // lo que "entiende" el reconocedor de voz falso en cada frase de la guia (el Whisper real no se baja en las pruebas)
  const frases: [number, string][] = ANUNCIOS.map(([, texto, compas]) => [inicioCompas(compas) * 1000 - 250, texto])
  await ctxCompu.addInitScript((tabla: [number, string][]) => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown; __asrFalso: unknown; __asrLlamadas: number }
    g.__zip = null
    g.electronAPI = {
      isElectron: true,
      compuToken: 'e2e',
      pickZipFile: async () => g.__zip,
      getConnectionInfo: async () => ({ url: 'http://192.168.0.10:4848', ip: '192.168.0.10', port: 4848 }),
      elegirCarpeta: async () => null,
      abrirCarpeta: async () => {}
    }
    g.__asrLlamadas = 0
    g.__asrFalso = async (audio: Float32Array, info: { finMs: number }) => {
      g.__asrLlamadas++
      if (!(audio instanceof Float32Array) || audio.length < 1600) throw new Error('frase sin audio')
      return tabla.find(([fin]) => Math.abs(fin - info.finMs) < 200)?.[1] ?? ''
    }
  }, frases)
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)

  async function importar(zip: string): Promise<void> {
    await compu.evaluate((z) => ((globalThis as unknown as { __zip: string }).__zip = z), zip)
    if (!(await compu.locator('.modal').isVisible())) {
      const vacio = compu.getByRole('button', { name: /Importar o abrir canción/ })
      if (await vacio.isVisible()) await vacio.click()
      else await compu.locator('.boton-nueva').click()
    }
    await compu.getByRole('button', { name: /Importar \.zip/ }).click()
    await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  }

  await t.test('importar un .zip con WAV y un .rar con MP3 (se convierten, colores distintos, nombres limpios)', async () => {
    await importar(zipWav)
    await importar(zipMp3)
    assert.deepEqual(await compu.locator('.setlist-nombre').allTextContents(), ['Cuan Grande Es El', 'Rey de Reyes'])
    assert.equal(await compu.locator('.cancion-titulo').textContent(), 'Rey de Reyes')
    await compu.locator('.setlist-tab').nth(0).click()
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Cuan Grande Es El')
    await vistaCompu(compu, 'Mezcla')
    assert.deepEqual(await compu.locator('.canal-nombre').allTextContents(), ['Click', 'Guia', 'Bajo', 'Pad'])
    const colores = await compu.locator('.canal').evaluateAll((els) => els.map((e) => getComputedStyle(e).getPropertyValue('--color-pista')))
    assert.equal(new Set(colores).size, colores.length)
  })

  // ---- celulares ----
  const celulares: Page[] = []
  for (const dispositivo of [devices['Pixel 7'], devices['iPhone 13']]) {
    const ctx = await contextoCelular(browser, dispositivo)
    ctx.setDefaultTimeout(15000)
    await ctx.addInitScript(espiaAudio)
    const p = await ctx.newPage()
    await p.goto(`${base}/?debug`)
    await p.getByRole('button', { name: /Tocá para empezar/ }).click()
    celulares.push(p)
  }

  await t.test('la compu ve los celulares con el audio activado', async () => {
    await compu.locator('.chip-dispositivos').click()
    await compu.waitForFunction(() => (document.querySelector('.modal .lista')?.textContent ?? '').match(/Listo/g)?.length === 2)
    await compu.keyboard.press('Escape')
  })

  await t.test('Espacio (aun con foco en un fader) reproduce y los celulares suenan en sync', async () => {
    await vistaCompu(compu, 'Mezcla')
    await compu.locator('.fader').first().click()
    await compu.keyboard.press('Space')
    await esperar(6000)
    for (const cel of celulares) assert.ok((await vivas(cel)) > 0, 'un celular no suena')
    await enSync(celulares, 'al arrancar')
  })

  await t.test('secciones: marcar con M, borrar y deshacer; los celulares las ven', async () => {
    for (let i = 0; i < 3; i++) {
      await compu.keyboard.press('m')
      await esperar(1200)
    }
    await vistaCompu(compu, 'Secciones')
    // las 3 marcadas y, primero, "Inicio" (el comienzo de la cancion: no se renombra ni se borra)
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-tarjeta').length === 4)
    const inicio = compu.locator('.seccion-tarjeta').first()
    assert.match((await inicio.textContent()) ?? '', /Inicio/)
    await inicio.hover()
    assert.equal(await inicio.getByRole('button', { name: /Borrar/ }).count(), 0)
    const fila = compu.locator('.seccion-tarjeta').nth(2)
    await fila.hover()
    await fila.getByRole('button', { name: /Borrar/ }).click()
    await compu.getByRole('button', { name: 'Deshacer' }).click()
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-tarjeta').length === 4)
    assert.equal((await seccionesEnCelular(celulares[0])).cantidad, 4)
    assert.equal(await celulares[0].locator('.m-vista-cancion .m-marcador').first().getAttribute('aria-label'), 'Inicio: volver al principio de la canción')
  })

  await t.test('saltos y repetir sección: los celulares entran en sync sin cortes', async () => {
    // secciones de 8s para medir varias vueltas del loop (se ubican directo en el servidor)
    const tab = server.state.getActiveTab()!
    const ids = tab.proyecto.marcadores.map((m) => m.id) // (actualizarMarcador reordena el array)
    ids.forEach((id, i) => server.state.actualizarMarcador(tab.tabId, id, { tiempoMs: 8000 * (i + 1) }))
    server.transporte.reprogramarTimers()
    server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))
    await esperar(2500) // los celulares precargan el comienzo de cada seccion
    // con Shift el salto es inmediato (sin esperar el final de la seccion)
    for (const tecla of ['2', '1']) {
      await compu.keyboard.press(`Shift+${tecla}`)
      await esperar(3500)
      await enSync(celulares, `tras saltar a la sección ${tecla}`)
    }
    await compu.keyboard.press('l')
    // 12 s de loop (secciones de 8 s): cada vuelta los celulares vuelven a entrar en sync
    const finLoop = Date.now() + 12000
    while (Date.now() < finLoop) {
      await esperar(1000)
      await enSync(celulares, 'en el loop')
    }
    assert.match((await compu.locator('.seccion-pill').textContent()) ?? '', /Sección 1/)
    await compu.keyboard.press('l')
  })

  await t.test('elegir una sección sonando: la actual termina y sigue la elegida, sin cortes, en todos', async () => {
    await esperar(1600) // que el "repetir" apagado se asiente
    await compu.keyboard.press('3')
    // queda pendiente: se ve en la compu y en los celulares
    await compu.waitForSelector('.salto-pendiente')
    assert.match((await compu.locator('.salto-pendiente').textContent()) ?? '', /Sección 3/)
    for (const cel of celulares) await cel.waitForSelector('.m-salto')
    const salto = server.state.saltoPendiente!
    assert.equal(salto.destinoMs, 24000)
    const secciones = server.state.getActiveTab()!.proyecto.marcadores.map((m) => m.tiempoMs)
    assert.ok(secciones.includes(salto.limiteMs), `salta en el final de una sección (${salto.limiteMs})`)
    // hasta el limite sigue sonando la seccion actual
    await esperar(Math.max(0, salto.tSalto - Date.now() - 400))
    assert.match((await compu.locator('.seccion-pill').textContent()) ?? '', /Sección 1|Sección 2/)
    await esperar(1500)
    assert.match((await compu.locator('.seccion-pill').textContent()) ?? '', /Sección 3/)
    assert.equal(await compu.locator('.salto-pendiente').count(), 0)
    for (const cel of celulares) {
      // el corte se hizo sobre la linea de tiempo del propio audio del celular (empalme parejo)
      const empalme = await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { ultimoEmpalmeMs: number | null } } } } }).__mt.engineRef.current.diagnostico().ultimoEmpalmeMs)
      assert.ok(empalme !== null && Math.abs(empalme) < 60, `empalme del salto: ${empalme}`)
      assert.ok((await vivas(cel)) > 0, 'sin cortes: el celular siguió sonando')
      const esperando = await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { esperando: boolean } } } } }).__mt.engineRef.current.diagnostico().esperando)
      assert.equal(esperando, false, 'el celular tenía listo el comienzo de la sección')
    }
    await enSync(celulares, 'después del salto en el límite')

    // Esc cancela un salto pendiente
    await compu.keyboard.press('1')
    await compu.waitForSelector('.salto-pendiente')
    await compu.keyboard.press('Escape')
    await compu.waitForSelector('.salto-pendiente', { state: 'detached' })
    assert.equal(server.state.saltoPendiente, null)
  })

  await t.test('celular: la mezcla está a la vista; deslizar para scrollear no mueve los faders', async () => {
    const cel = celulares[0]
    await vistaCelular(cel, 'Mi mezcla')
    const fader = cel.locator('.m-canal').nth(1).locator('.fader-tactil') // [0] es el volumen general
    await fader.scrollIntoViewIfNeeded()
    const valor = async (): Promise<number> => Number(await fader.getAttribute('aria-valuenow'))
    assert.equal(await valor(), 100)
    const caja = (await fader.boundingBox())!
    const centro = { x: caja.x + caja.width / 2, y: caja.y + caja.height / 2 }
    // dedo que arranca sobre el fader y va para arriba: scrollea, el volumen no cambia
    await deslizar(cel, centro, 4, -160)
    await esperar(300)
    assert.equal(await valor(), 100, 'scrollear sobre el fader no tiene que cambiar el volumen')
    // de costado: si
    const caja2 = (await fader.boundingBox())!
    await deslizar(cel, { x: caja2.x + caja2.width / 2, y: caja2.y + caja2.height / 2 }, caja2.width * 0.25, 3)
    await esperar(300)
    assert.ok((await valor()) > 120, `deslizar de costado sube el volumen (quedó en ${await valor()})`)
    // un toque suelto no cambia nada; doble toque vuelve a "igual que la compu"
    const caja3 = (await fader.boundingBox())!
    const punto = { x: caja3.x + caja3.width * 0.1, y: caja3.y + caja3.height / 2 }
    await cel.touchscreen.tap(punto.x, punto.y)
    await esperar(500)
    assert.ok((await valor()) > 120, 'un toque suelto no mueve el fader')
    await cel.touchscreen.tap(punto.x, punto.y)
    await esperar(80)
    await cel.touchscreen.tap(punto.x, punto.y)
    await esperar(300)
    assert.equal(await valor(), 100, 'doble toque vuelve a 100%')

    // volumen del celular: se puede subir por encima de 100 % (hasta 200 %, +6 dB, con limitador)
    const general = cel.locator('.m-canal-general .fader-tactil')
    await general.scrollIntoViewIfNeeded()
    assert.equal(await general.getAttribute('aria-valuemax'), '200')
    const cg = (await general.boundingBox())!
    await deslizar(cel, { x: cg.x + cg.width / 2, y: cg.y + cg.height / 2 }, cg.width * 0.45, 2)
    await esperar(400)
    const vol = Number(await general.getAttribute('aria-valuenow'))
    assert.ok(vol > 150, `se sube por encima de 100 % (quedó en ${vol})`)
    await cel.getByText(/suena más fuerte que lo normal/).waitFor()
    const ganancia = await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { masterGain: GainNode } } } }).__mt.engineRef.current.masterGain.gain.value)
    assert.ok(Math.abs(ganancia - 10 ** ((((vol - 100) / 100) * 6) / 20)) < 0.05, `ganancia ${ganancia} para ${vol}%`)
    // vuelve a 100 % con doble toque
    const cg2 = (await general.boundingBox())!
    const p2 = { x: cg2.x + cg2.width * 0.2, y: cg2.y + cg2.height / 2 }
    await cel.touchscreen.tap(p2.x, p2.y)
    await esperar(80)
    await cel.touchscreen.tap(p2.x, p2.y)
    await esperar(300)
    assert.equal(await general.getAttribute('aria-valuenow'), '100')
  })

  await t.test('bloqueo: los celulares no pueden controlar', async () => {
    await compu.getByRole('switch', { name: /Celulares/ }).click()
    await celulares[0].waitForSelector('.m-barra-bloqueado')
    assert.ok((await seccionesEnCelular(celulares[0])).deshabilitadas)
    await compu.getByRole('switch', { name: /Celulares/ }).click()
    await celulares[0].waitForSelector('.m-barra .m-play')
  })

  await t.test('celular que pierde la conexión mientras se pausa: al volver se alinea', async () => {
    const cel = celulares[1]
    await cel.evaluate(() => (globalThis as unknown as { __mt: { socketRef: { current: { socket: { disconnect(): void } } } } }).__mt.socketRef.current.socket.disconnect())
    await compu.keyboard.press('Space') // pausa mientras el celular no esta
    await esperar(2500)
    assert.ok((await vivas(cel)) > 0, 'el celular desconectado sigue sonando (todavia no se entero)')
    await cel.evaluate(() => (globalThis as unknown as { __mt: { socketRef: { current: { socket: { connect(): void } } } } }).__mt.socketRef.current.socket.connect())
    await esperar(2500)
    assert.equal(await vivas(cel), 0, 'al reconectar tenia que quedar en pausa como los demas')
  })

  await t.test('cambiar de canción con otra sonando pide confirmación', async () => {
    await compu.keyboard.press('Space')
    await esperar(2000)
    await compu.keyboard.press('PageDown')
    await compu.getByRole('button', { name: 'Cancelar' }).click()
    assert.equal(await compu.locator('.cancion-titulo').textContent(), 'Cuan Grande Es El')
    await compu.keyboard.press('PageDown')
    await compu.getByRole('button', { name: /Pasar a Rey de Reyes/ }).click()
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Rey de Reyes')
  })

  await t.test('canción MP3: suena en los celulares sin errores', async () => {
    await esperar(800)
    await compu.keyboard.press('Space')
    await esperar(5000)
    for (const cel of celulares) assert.ok((await vivas(cel)) > 0, 'el MP3 no suena')
    assert.equal(await celulares[0].locator('.m-alerta').count(), 0)
  })

  await t.test('cerrar la canción que suena pide confirmación y corta el audio en todos', async () => {
    await compu.locator('.setlist-tab.activo').hover()
    await compu.locator('.setlist-tab.activo .setlist-cerrar').click()
    await compu.getByRole('button', { name: 'Cortar y quitar' }).click()
    await esperar(1000)
    for (const cel of celulares) assert.equal(await vivas(cel), 0)
    assert.deepEqual(await compu.locator('.setlist-nombre').allTextContents(), ['Cuan Grande Es El'])
  })

  await t.test('biblioteca: un zip copiado en una subcarpeta se importa solo (categoría y BPM)', async () => {
    fs.mkdirSync(path.join(biblioteca, 'Adoración'), { recursive: true })
    fs.copyFileSync(zipConGuia(tmp, 'Santo Santo'), path.join(biblioteca, 'Adoración', 'Santo Santo.zip'))
    await compu.locator('.boton-nueva').click()
    assert.match((await compu.locator('.biblioteca-ruta').textContent()) ?? '', /Biblioteca$/)
    const fila = compu.locator('.lista-fila', { hasText: 'Santo Santo' })
    await fila.waitFor({ timeout: 60000 })
    // el tempo sale del click apenas se importa (la lista se refresca sola)
    await compu.waitForFunction(
      () => Array.from(document.querySelectorAll('.lista-fila')).some((f) => /Santo Santo/.test(f.textContent ?? '') && /90 BPM 4\/4/.test(f.textContent ?? '')),
      null,
      { timeout: 60000 }
    )
    await compu.getByRole('tab', { name: /Adoración/ }).click()
    assert.deepEqual(await compu.locator('.lista-titulo').allTextContents(), ['Santo Santo'])
    await compu.getByRole('tab', { name: /Todas/ }).click()
    await compu.getByRole('button', { name: 'A–Z' }).click()
    assert.deepEqual(await compu.locator('.lista-titulo').allTextContents(), ['Cuan Grande Es El', 'Rey de Reyes', 'Santo Santo'])
    await fila.getByRole('button', { name: /Agregar/ }).click()
    await compu.waitForSelector('.modal', { state: 'detached' })
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Santo Santo')
  })

  await t.test('secciones automáticas por la voz guía, en el "1" del compás', async () => {
    await vistaCompu(compu, 'Secciones')
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-tarjeta').length === 7, null, { timeout: 60000 })
    assert.deepEqual(await compu.locator('.seccion-nombre').allTextContents(), ['Inicio', 'Verso 1', 'Coro', 'Verso 2', 'Coro 2', 'Puente', 'Final'])
    assert.equal(await compu.locator('.seccion-origen').count(), 6)
    assert.match((await compu.locator('.analisis-linea').textContent()) ?? '', /voz guía/)
    assert.match((await compu.locator('.chip-tempo').textContent()) ?? '', /90 BPM · 4\/4/)
    const santo = server.state.getActiveTab()!.proyecto
    santo.marcadores.forEach((m, i) =>
      assert.ok(Math.abs(m.tiempoMs - inicioCompas(ANUNCIOS[i][2]) * 1000) <= 8, `${m.nombre} en ${m.tiempoMs} ms: fuera del compás`)
    )
    for (const cel of celulares) assert.equal((await seccionesEnCelular(cel)).cantidad, 7)

    // arrastrar una seccion en la linea de tiempo: cae en el "1" del compas mas cercano; con Alt, queda libre
    const compases = santo.tempo!.compasesMs
    const coroId = santo.marcadores[1].id
    const tiempoDelCoro = (): number => server.state.getActiveTab()!.proyecto.marcadores.find((m) => m.id === coroId)!.tiempoMs
    async function arrastrarCoro(deltaMs: number, alt: boolean): Promise<void> {
      const linea = (await compu.locator('.timeline').boundingBox())!
      const marca = (await compu.locator('.timeline-marca').nth(1).boundingBox())!
      const x = marca.x + marca.width / 2
      const y = marca.y + marca.height / 2
      const antes = tiempoDelCoro()
      if (alt) await compu.keyboard.down('Alt')
      await compu.mouse.move(x, y)
      await compu.mouse.down()
      await compu.mouse.move(x + (deltaMs / santo.duracionTotalMs) * linea.width, y, { steps: 6 })
      await compu.mouse.up()
      if (alt) await compu.keyboard.up('Alt')
      for (let i = 0; i < 50 && tiempoDelCoro() === antes; i++) await esperar(50)
      // y que la pantalla ya lo muestre ahi (el proximo arrastre agarra la marca donde se ve)
      await compu.waitForFunction(
        ([ms, dur]) => Math.abs(parseFloat((document.querySelectorAll('.timeline-marca')[1] as HTMLElement).style.left) - (ms / dur) * 100) < 0.01,
        [tiempoDelCoro(), santo.duracionTotalMs] as const
      )
    }
    await arrastrarCoro(2000, false)
    assert.equal(tiempoDelCoro(), compases[7], 'no quedó en el compás')
    await arrastrarCoro(-700, true)
    const libre = tiempoDelCoro()
    assert.ok(Math.abs(libre - (compases[7] - 700)) < 150 && !compases.includes(libre), `con Alt tenía que quedar libre: ${libre}`)
  })

  await t.test('los celulares precargan la siguiente canción: al pasar, arranca sin esperar la red', async () => {
    const santoId = server.state.getActiveTab()!.proyecto.id
    // despues del cambio, ningun celular tendria que volver a pedir lo precargado: los 2 primeros segmentos
    // de la mezcla que le arma la compu
    let cambio = false
    const repetidos: string[] = []
    for (const cel of celulares) {
      cel.on('request', (r) => {
        if (!cambio || !r.url().includes(`/mezcla/${santoId}/`)) return
        const indice = Number(/\/(\d+)\.wav/.exec(r.url())?.[1] ?? -1)
        if (indice < 2) repetidos.push(r.url())
      })
    }
    await compu.keyboard.press('Enter') // al principio: la precarga es desde donde va a arrancar
    await compu.locator('.setlist-tab').nth(0).click()
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Cuan Grande Es El')
    type Diag = { precarga: { proyectoId: string; pistas: number[] } | null; pistas: { seg: number[]; cues: number }[] }
    const diagnostico = (cel: Page): Promise<Diag> =>
      cel.evaluate(
        () => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): Diag } } } }).__mt.engineRef.current.diagnostico()
      )
    for (const cel of celulares) {
      await cel.waitForFunction(
        (id) => {
          const d = (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): Diag } } } }).__mt.engineRef.current.diagnostico()
          return d.precarga?.proyectoId === id && d.precarga.pistas.every((n) => n >= 2)
        },
        santoId,
        { timeout: 20000 }
      )
    }
    cambio = true
    await compu.locator('.setlist-tab').nth(1).click()
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Santo Santo')
    for (const cel of celulares) {
      await cel.waitForFunction(
        (id) => (globalThis as unknown as { __mt: { engineRef: { current: { proyectoIdCargado: string } } } }).__mt.engineRef.current.proyectoIdCargado === id,
        santoId
      )
      const d = await diagnostico(cel)
      assert.ok(d.pistas.every((p) => p.seg.includes(0) && p.seg.includes(1)), `sin el principio listo: ${JSON.stringify(d.pistas)}`)
    }
    await compu.keyboard.press('Space')
    await esperar(4000)
    for (const cel of celulares) assert.ok((await vivas(cel)) > 0, 'no suena')
    await enSync(celulares, 'canción precargada')
    await compu.keyboard.press('Space')
    assert.deepEqual(repetidos, [], 'se volvió a bajar lo que ya estaba precargado')
  })

  await t.test('nadie tocó la mezcla del celular 2: nunca tuvo que cambiar de mezcla', async () => {
    const d = await celulares[1].evaluate(
      () => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { cambiosMezcla: number } } } } }).__mt.engineRef.current.diagnostico().cambiosMezcla
    )
    assert.equal(d, 0)
  })

  await t.test('el audio que sale del celular está donde el motor cree: con corrección fina, cambio de mezcla y salto', async () => {
    // cancion de prueba: "Posicion" codifica en cada muestra en que segundo de la cancion esta (diente de sierra de 8 s),
    // mas un click (tempo) y una pista muda (para cambiar la mezcla sin cambiar lo que suena)
    const SEG = 40
    const sierra = new Float32Array(SEG * SR)
    for (let i = 0; i < sierra.length; i++) sierra[i] = (((i / SR) % 8) / 8) * 0.9
    const zip = path.join(tmp, 'Posicion.zip')
    const z = new AdmZip()
    z.addFile('Posicion.wav', wav16(sierra, SR))
    z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
    z.addFile('Pad.wav', wav16(new Float32Array(SEG * SR), SR))
    z.writeZip(zip)
    await importar(zip)
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Posicion')
    const tab = server.state.getActiveTab()!
    for (let i = 0; i < 100 && !tab.proyecto.tempo; i++) await esperar(200)
    assert.ok(tab.proyecto.tempo, 'se detecto el tempo del click')
    tab.proyecto.cuenta = 0 // aca se mide donde esta el audio: arranca sin la cuenta (ver la prueba de la cuenta)
    server.state.crearMarcador(tab.tabId, 20000, 'Salto')
    server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))

    const cel = celulares[0]
    const pedidosMedia: string[] = []
    cel.on('request', (r) => {
      if (r.url().includes('/media/') && !r.url().includes('/analisis/')) pedidosMedia.push(r.url())
    })
    // en este celular, sin el click (sus golpes taparian la posicion)
    await vistaCelular(cel, 'Mi mezcla')
    await cel.getByRole('button', { name: 'Mute de Click en este celular' }).click()
    await compu.keyboard.press('Space')
    await esperar(4000)

    type Muestra = [number, number, number | null]
    await cel.evaluate(async () => {
      const g = globalThis as unknown as {
        __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode; posicionNodoEn(t: number): number | null } } }
        __muestras: Muestra[]
        __grabador: AudioWorkletNode
      }
      const engine = g.__mt.engineRef.current
      const codigo = `registerProcessor('grabador', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = [] }
        process(inputs) {
          const x = inputs[0] && inputs[0][1]
          if (x) this.lote.push([currentTime, x[0]])
          if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      // la posicion que calcula el motor se consulta enseguida (guarda unos segundos de historia)
      nodo.port.onmessage = (e: MessageEvent<[number, number][]>) => {
        for (const [t, v] of e.data) g.__muestras.push([t, v, engine.posicionNodoEn(t)])
      }
      engine.masterGain.connect(nodo)
      g.__grabador = nodo
    })
    const diag = (): Promise<{ tramos: { rate: number }[]; clave: string; clavesProgramadas: string[]; modo: string }> =>
      cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): never } } } }).__mt.engineRef.current.diagnostico())
    assert.equal((await diag()).modo, 'mezcla', 'el celular pide la mezcla hecha por la compu')

    await esperar(2000)
    // 1) correccion fina forzada: 30 ms (tramos a otra velocidad)
    await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { corregirDriftSuave(ms: number): void } } } }).__mt.engineRef.current.corregirDriftSuave(30))
    await esperar(1500)
    assert.ok((await diag()).tramos.some((tr) => tr.rate !== 1), 'la corrección se aplica en tramos con otra velocidad')
    await esperar(2500)
    // 2) cambio de mezcla desde la compu (la pista muda: cambia la mezcla, no lo que suena)
    const pad = tab.proyecto.pistas.find((p) => p.nombre === 'Pad')!
    const claveAntes = (await diag()).clave
    const pista = server.state.actualizarMixer(tab.tabId, pad.id, { volumen: 30 })!
    server.io.emit('mixer:actualizado', { proyectoId: tab.proyecto.id, pista })
    await cel.waitForFunction(
      (antes) => {
        const d = (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { clave: string; clavesProgramadas: string[] } } } } }).__mt.engineRef.current.diagnostico()
        return d.clave !== antes && d.clavesProgramadas.length > 0 && d.clavesProgramadas.every((c) => c === d.clave)
      },
      claveAntes,
      { timeout: 5000 }
    )
    await esperar(1500)
    // 3) salto inmediato a la seccion
    await compu.keyboard.press('Shift+1')
    await esperar(3000)
    // 4) despues de un corte, vuelve a entrar en el "1" del proximo compas (sin salto de posicion)
    const tResync = await cel.evaluate(() => {
      const e = (globalThis as unknown as { __mt: { engineRef: { current: { onResyncCb(): void; ctx: AudioContext } } } }).__mt.engineRef.current
      const t = e.ctx.currentTime
      e.onResyncCb()
      return t
    })
    await esperar(2500)
    // el primer tramo programado despues del pedido (arranca a mitad de segmento: donde cae el compas)
    const todos = (await diag()).tramos as unknown as { ini: number; pos: number; dur: number }[]
    const nuevos = todos.filter((tr) => tr.ini > tResync && Math.abs(tr.pos / SEGMENTO_SEC - Math.round(tr.pos / SEGMENTO_SEC)) > 1e-6)
    const reentrada = nuevos.length ? nuevos[0].pos * 1000 : NaN
    assert.ok(
      tab.proyecto.tempo!.compasesMs.some((c) => Math.abs(c - reentrada) < 1),
      `la reentrada (${reentrada?.toFixed(1)} ms) no cae en un compás · pedido en ${tResync.toFixed(3)} · tramos ${JSON.stringify(todos)} · compases ${JSON.stringify(tab.proyecto.tempo!.compasesMs.slice(8, 14))}`
    )
    // 5) cambio de mezcla con un salto por hacer (los 1,5 s de margen): el salto igual se hace, en todos lados
    await compu.keyboard.press('Shift+1')
    await esperar(150)
    const pista2 = server.state.actualizarMixer(tab.tabId, pad.id, { volumen: 60 })!
    server.io.emit('mixer:actualizado', { proyectoId: tab.proyecto.id, pista: pista2 })
    await esperar(3500)

    const muestras = (await cel.evaluate(() => {
      const g = globalThis as unknown as { __muestras: Muestra[]; __grabador: AudioWorkletNode }
      g.__grabador.disconnect()
      g.__grabador.port.onmessage = null
      return g.__muestras
    })) as Muestra[]
    await compu.keyboard.press('Space')

    if (process.env.E2E_VOLCADO) fs.writeFileSync(process.env.E2E_VOLCADO, JSON.stringify({ muestras, vol: tab.proyecto.pistas.find((p) => p.nombre === 'Posicion')!.volumen }))
    const vol = tab.proyecto.pistas.find((p) => p.nombre === 'Posicion')!.volumen / 100
    // fader (curva cuadratica), paneo por defecto de la banda (una pista mono toda a la derecha: se graba ese canal)
    // y los dos pasos por 16 bits (x32767 / 32768)
    const escala = 0.9 * vol * vol * (32767 / 32768) ** 2
    const bloque = 128 / (await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext } } } }).__mt.engineRef.current.ctx.sampleRate))
    const difs: number[] = []
    let saltos = 0
    let anterior: number | null = null
    for (let i = 20; i < muestras.length - 1; i++) {
      const [t, v, p] = muestras[i]
      if (p === null) continue
      if (anterior !== null && Math.abs(p - anterior) > 0.5) saltos++
      anterior = p
      // el dispositivo de audio falso de Chromium sin pantalla a veces repite o saltea la hora de un bloque: esos no se miden
      if (Math.abs(t - muestras[i - 1][0] - bloque) > 1e-6 || Math.abs(muestras[i + 1][0] - t - bloque) > 1e-6) continue
      const enCiclo = p % 8
      if (enCiclo < 0.02 || enCiclo > 7.98) continue // cerca del salto del diente de sierra
      const real = (v / escala) * 8
      let d = real - enCiclo
      if (d > 4) d -= 8
      if (d < -4) d += 8
      difs.push(d * 1000)
    }
    assert.ok(difs.length > 3000, `pocas muestras: ${difs.length}`)
    assert.equal(saltos, 2, 'los dos saltos de sección se ven en la posición (el segundo, con un cambio de mezcla en el medio)')
    const peor = Math.max(...difs.map(Math.abs))
    assert.ok(peor < 1.5, `el audio real se separa de la posición calculada: ${peor.toFixed(2)} ms`)
    assert.deepEqual(pedidosMedia, [], 'el celular no baja pistas sueltas')
  })

  await t.test('paneo por defecto: click en L y la banda en R, sin tocar nada; lo que se mueve en la compu queda', async () => {
    const cel = celulares[1]
    const tab = server.state.getActiveTab()!
    const id = (nombre: string): string => tab.proyecto.pistas.find((p) => p.nombre === nombre)!.id
    // paneo (en centesimos) que el celular le pide a la compu para cada pista
    const paneos = async (): Promise<Record<string, number>> => {
      const clave = await cel.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { clave: string } } } } }).__mt.engineRef.current.diagnostico().clave)
      return Object.fromEntries(clave.split('.').filter(Boolean).map((c) => [c.split('_')[0], Number(c.split('_')[2])]))
    }
    async function esperarPaneos(esperado: Record<string, number>): Promise<void> {
      for (let i = 0; i < 40; i++) {
        const p = await paneos()
        if (Object.entries(esperado).every(([k, v]) => p[k] === v)) return
        await esperar(150)
      }
      assert.deepEqual(await paneos(), esperado)
    }
    // en la compu se ve en los paneos de la mezcla (el click, por su nombre; la banda a la derecha)
    await vistaCompu(compu, 'Mezcla')
    const paneoEnCompu = async (i: number): Promise<string> => (await compu.locator('.canal').nth(i).getByRole('slider', { name: 'Paneo' }).getAttribute('aria-valuenow'))!
    assert.deepEqual(
      await compu.locator('.canal-nombre').allTextContents(),
      tab.proyecto.pistas.map((p) => p.nombre)
    )
    for (const [i, p] of tab.proyecto.pistas.entries()) assert.equal(await paneoEnCompu(i), p.nombre === 'Click' ? '-100' : '100', p.nombre)
    // y es lo que suena en los celulares (el celular 2 no tiene nada en "Mi mezcla")
    await esperarPaneos({ [id('Click')]: -100, [id('Posicion')]: 100 })
    assert.equal(await cel.getByText(/Click y guía a la izquierda/).count(), 0, 'sin interruptor en el celular')
    assert.equal(await compu.getByRole('button', { name: /click o guía/ }).count(), 0, 'sin orejita en la compu')

    // doble click en el paneo del Click: al centro, y queda asi
    const i = tab.proyecto.pistas.findIndex((p) => p.nombre === 'Click')
    await compu.locator('.canal').nth(i).getByRole('slider', { name: 'Paneo' }).dblclick()
    await esperarPaneos({ [id('Click')]: 0, [id('Posicion')]: 100 })
    assert.equal(tab.proyecto.pistas[i].panAutomatico, false)
  })

  await t.test('WiFi lento (3 Mbps): con la mezcla de la compu suena sin cortes; con 8 pistas sueltas no alcanza', async (tt) => {
    // cancion "pesada": 8 pistas estereo (L != R, no se pasan a mono) = 11 Mbps con pistas sueltas, 1,4 con la mezcla
    const SEG = 24
    const z = new AdmZip()
    for (let k = 0; k < 8; k++) {
      const frames = SEG * SR
      const data = Buffer.alloc(frames * 4)
      for (let i = 0; i < frames; i++) {
        data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * (200 + 40 * k) * i) / SR)), i * 4)
        data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * (300 + 55 * k) * i) / SR)), i * 4 + 2)
      }
      const h = Buffer.alloc(44)
      h.write('RIFF', 0)
      h.writeUInt32LE(36 + data.length, 4)
      h.write('WAVE', 8)
      h.write('fmt ', 12)
      h.writeUInt32LE(16, 16)
      h.writeUInt16LE(1, 20)
      h.writeUInt16LE(2, 22)
      h.writeUInt32LE(SR, 24)
      h.writeUInt32LE(SR * 4, 28)
      h.writeUInt16LE(4, 32)
      h.writeUInt16LE(16, 34)
      h.write('data', 36)
      h.writeUInt32LE(data.length, 40)
      z.addFile(`Pista ${k + 1}.wav`, Buffer.concat([h, data]))
    }
    const zip = path.join(tmp, 'Ocho Pistas.zip')
    z.writeZip(zip)
    await importar(zip)
    await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Ocho Pistas')

    type Resumen = { cortes: number; colchonSeg: number; mbpsNecesarios: number; mbpsCapacidad: number | null }
    async function probar(modo: 'mezcla' | 'pistas'): Promise<{ r: Resumen; sono: boolean; ctx: BrowserContext; p: Page }> {
      const ctx = await contextoCelular(browser, devices['Pixel 7'])
      ctx.setDefaultTimeout(15000)
      await ctx.addInitScript(espiaAudio)
      const p = await ctx.newPage()
      await p.goto(`${base}/?debug&modo=${modo}`)
      await p.getByRole('button', { name: /Tocá para empezar/ }).click()
      const cdp = await ctx.newCDPSession(p)
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (3e6 / 8) | 0, uploadThroughput: (1e6 / 8) | 0 })
      await compu.keyboard.press('Enter') // al principio
      await esperar(1500)
      await compu.keyboard.press('Space')
      let sono = false
      for (let i = 0; i < 32; i++) {
        await esperar(500)
        if ((await vivas(p)) > 0) sono = true
      }
      const r = await p.evaluate(
        () => (globalThis as unknown as { __mt: { engineRef: { current: { resumenDiagnostico(): Resumen } } } }).__mt.engineRef.current.resumenDiagnostico()
      )
      await compu.keyboard.press('Space')
      await esperar(800)
      return { r, sono, ctx, p }
    }

    const conMezcla = await probar('mezcla')
    assert.ok(conMezcla.sono, 'con la mezcla de la compu suena')
    assert.equal(conMezcla.r.cortes, 0, `con la mezcla no se corta: ${JSON.stringify(conMezcla.r)}`)
    assert.ok(conMezcla.r.mbpsNecesarios < 1.6, `una sola pista estéreo: ${conMezcla.r.mbpsNecesarios} Mbps`)
    assert.ok(conMezcla.r.mbpsCapacidad !== null && conMezcla.r.mbpsCapacidad < 4, `mide el WiFi limitado: ${conMezcla.r.mbpsCapacidad}`)

    // la compu ve el diagnostico de ese celular y copia el informe para mandar por chat
    await ctxCompu.grantPermissions(['clipboard-read', 'clipboard-write'])
    await compu.locator('.chip-dispositivos').click()
    await compu
      .waitForFunction(() => /WiFi .* Mbps \(usa 1,4\) · colchón \d+ s · sin cortes/.test(document.querySelector('.modal .lista')?.textContent ?? ''))
      .catch(async (e: Error) => {
        throw new Error(`${e.message} · la lista dice: ${await compu.locator('.modal .lista').textContent()}`)
      })
    await compu.getByRole('button', { name: /Copiar diagnóstico/ }).click()
    await compu.getByRole('button', { name: 'Copiado' }).waitFor()
    const informe = await compu.evaluate(() => navigator.clipboard.readText())
    assert.match(informe, /Diagnóstico AirTracks Wireless Monitor/)
    assert.match(informe, /Canción: Ocho Pistas · 8 pistas/)
    assert.match(informe, /modo mezcla de la compu · usa 1,41 Mbps/)
    await compu.keyboard.press('Escape')
    await conMezcla.ctx.close()

    // lo mismo con las 8 pistas sueltas (como era antes): el WiFi no alcanza
    const sueltas = await probar('pistas')
    tt.diagnostic(`mezcla: ${JSON.stringify(conMezcla.r)} · sonó: ${conMezcla.sono}`)
    tt.diagnostic(`pistas sueltas: ${JSON.stringify(sueltas.r)} · sonó: ${sueltas.sono}`)
    assert.ok(sueltas.r.mbpsNecesarios > 10, `8 pistas estéreo: ${sueltas.r.mbpsNecesarios} Mbps`)
    assert.ok(sueltas.r.cortes > 0 || !sueltas.sono, `con pistas sueltas tendría que cortarse: ${JSON.stringify(sueltas.r)}`)
    await sueltas.ctx.close()
  })

  await t.test('código de la banda e invitar: el que llega tarde entra con el enlace de un compañero', async () => {
    // la compu pone un codigo y el WiFi desde "Conectar celulares"
    await compu.locator('.chip-dispositivos').click()
    const tarjetaCodigo = compu.locator('.conexion-tarjeta', { hasText: 'Código de la banda' })
    await tarjetaCodigo.getByRole('button', { name: 'Pedir un código' }).click()
    await compu.getByLabel(/Código de la banda \(4 a 8/).fill('4821')
    await tarjetaCodigo.getByRole('button', { name: 'Guardar' }).click()
    await compu.waitForSelector('.conexion-codigo')
    assert.equal(await compu.locator('.conexion-codigo').textContent(), '4821')
    const tarjetaWifi = compu.locator('.conexion-tarjeta', { hasText: 'WiFi para invitar' })
    await compu.getByLabel('Nombre de la red WiFi').fill('Iglesia Central')
    await compu.getByLabel('Clave del WiFi').fill('alaba;nza')
    await tarjetaWifi.getByRole('button', { name: 'Guardar' }).click()
    // el QR de la compu ya lleva el codigo, y la hoja para imprimir tiene el QR del WiFi y el de la app
    await compu.waitForFunction(() => /\/#codigo=4821$/.test(document.querySelector('.modal .qr')?.getAttribute('data-enlace') ?? ''))
    await compu.waitForFunction(() => document.querySelectorAll('.hoja-impresa img').length === 2)
    assert.match((await compu.locator('.hoja-impresa').textContent()) ?? '', /Iglesia Central.*alaba;nza.*4821/s)
    assert.equal(await compu.locator('.hoja-impresa').isVisible(), false, 'la hoja solo aparece al imprimir')
    await compu.keyboard.press('Escape')

    // los que ya estaban conectados siguen (no se corta nada en vivo)
    await esperar(500)
    for (const cel of celulares) assert.equal(await cel.locator('.pantalla-codigo').count(), 0)

    // un celular nuevo: le pide el codigo; uno mal avisa; el bueno entra y queda guardado
    const ctxNuevo = await contextoCelular(browser, devices['Pixel 7'])
    ctxNuevo.setDefaultTimeout(15000)
    const nuevo = await ctxNuevo.newPage()
    await nuevo.goto(base)
    await nuevo.waitForSelector('.pantalla-codigo')
    await nuevo.getByRole('textbox', { name: 'Código de la banda' }).fill('1111')
    await nuevo.getByRole('button', { name: 'Entrar' }).click()
    await nuevo.getByText('Ese código no es').waitFor()
    await nuevo.getByRole('textbox', { name: 'Código de la banda' }).fill('4821')
    await nuevo.getByRole('button', { name: 'Entrar' }).click()
    await nuevo.waitForSelector('.pantalla-codigo', { state: 'detached' })
    await nuevo.reload()
    await nuevo.getByRole('button', { name: /Tocá para empezar/ }).waitFor()
    await esperar(500)
    assert.equal(await nuevo.locator('.pantalla-codigo').count(), 0, 'al volver a abrir no lo pide de nuevo')
    // en Android (sin la app en la compu) le explica como tenerla a mano
    await nuevo.getByRole('button', { name: /La próxima vez sin escanear/ }).click()
    await nuevo.getByText(/Agregar a la pantalla principal/).waitFor()

    // invitar desde un celular que ya esta: QR del WiFi y de la app (con el codigo) y WhatsApp
    const cel = celulares[1]
    await cel.getByRole('button', { name: 'Invitar a alguien' }).click()
    await cel.waitForFunction(() => document.querySelectorAll('.hoja img.invitar-qr').length === 2)
    const enlace = (await cel.locator('.hoja img[data-enlace]').getAttribute('data-enlace'))!
    assert.match(enlace, /^http:\/\/[^/]+:\d+\/#codigo=4821$/)
    assert.match((await cel.locator('.hoja').textContent()) ?? '', /Iglesia Central.*alaba;nza.*4821/s)
    const whatsapp = (await cel.getByRole('link', { name: /WhatsApp/ }).getAttribute('href'))!
    const mensaje = decodeURIComponent(whatsapp.replace('https://wa.me/?text=', ''))
    assert.match(mensaje, /Iglesia Central/)
    assert.ok(mensaje.includes(enlace), `el mensaje lleva el enlace: ${mensaje}`)
    await cel.getByRole('button', { name: 'Cerrar' }).click()

    // el que llega tarde abre ese enlace: entra sin escribir nada y el codigo no queda a la vista
    const ctxTarde = await contextoCelular(browser, devices['iPhone 13'])
    ctxTarde.setDefaultTimeout(15000)
    const tarde = await ctxTarde.newPage()
    await tarde.goto(`${base}/${new URL(enlace).hash}`)
    await tarde.getByRole('button', { name: /Tocá para empezar/ }).waitFor()
    await tarde.waitForFunction(() => /Conectado a la computadora/.test(document.querySelector('.activar')?.textContent ?? ''))
    assert.equal(await tarde.locator('.pantalla-codigo').count(), 0)
    assert.equal(new URL(tarde.url()).hash, '')
    // iPhone: como dejarla en la pantalla de inicio
    await tarde.getByRole('button', { name: /La próxima vez sin escanear/ }).click()
    await tarde.getByText(/Agregar a inicio/).waitFor()

    // sin codigo, vuelve a entrar cualquiera
    await compu.locator('.chip-dispositivos').click()
    await compu.getByRole('button', { name: 'Quitar el código' }).click()
    await compu.waitForSelector('.conexion-codigo', { state: 'detached' })
    await compu.keyboard.press('Escape')
    await ctxNuevo.close()
    await ctxTarde.close()
  })

  await t.test('dentro de la app Android (puente simulado): arranca solo y guarda todo en la app', async () => {
    const ctxApp = await contextoCelular(browser, devices['Pixel 7'])
    ctxApp.setDefaultTimeout(15000)
    await ctxApp.addInitScript(espiaAudio)
    // lo que expone WebActivity.java como window.AlabanzaApp (las prefs en un objeto que sobrevive a recargas)
    await ctxApp.addInitScript(() => {
      const g = globalThis as unknown as { AlabanzaApp: unknown; __app: { prefs: Record<string, string>; llamadas: string[] }; sessionStorage: Storage }
      const guardadas = g.sessionStorage.getItem('app-prefs')
      g.__app = { prefs: guardadas ? JSON.parse(guardadas) : {}, llamadas: [] }
      const persistir = (): void => g.sessionStorage.setItem('app-prefs', JSON.stringify(g.__app.prefs))
      g.AlabanzaApp = {
        leerPref: (clave: string) => g.__app.prefs[clave] ?? null,
        guardarPref: (clave: string, valor: string) => {
          g.__app.prefs[clave] = valor
          persistir()
        },
        cambiarCompu: () => g.__app.llamadas.push('cambiarCompu'),
        compartir: (texto: string) => g.__app.llamadas.push(`compartir:${texto}`),
        conexion: (c: boolean) => g.__app.llamadas.push(`conexion:${c}`)
      }
    })
    const app = await ctxApp.newPage()
    await app.goto(base)
    type App = { prefs: Record<string, string>; llamadas: string[] }
    const estadoApp = (): Promise<App> => app.evaluate(() => (globalThis as unknown as { __app: App }).__app)
    // sin "Tocá para empezar": el audio arranca solo (la app lo permite) y la compu lo ve listo
    await app.waitForFunction(() => (globalThis as unknown as { __app: App }).__app.llamadas.includes('conexion:true'))
    await esperar(2000)
    assert.equal(await app.locator('.activar').count(), 0, 'en la app no hace falta tocar para empezar')
    // las preferencias quedan en la app (sobreviven a que la compu cambie de IP)
    await app.getByRole('button', { name: 'Ajustes' }).click()
    await app.locator('.hoja-fila input').first().fill('Batería')
    await app.getByRole('button', { name: 'Guardar' }).click()
    const prefs = (await estadoApp()).prefs
    assert.equal(JSON.parse(prefs['nombre']), 'Batería')
    assert.match(JSON.parse(prefs['device-id']), /^[0-9a-f]{24}$/)
    // "elegir otra computadora" le pide a la app volver a la busqueda
    await app.getByRole('button', { name: 'Elegir otra computadora' }).click()
    assert.ok((await estadoApp()).llamadas.includes('cambiarCompu'))
    await app.getByRole('button', { name: 'Cerrar' }).click()
    // invitar usa el "Compartir" de Android
    await app.getByRole('button', { name: 'Invitar a alguien' }).click()
    await app.getByRole('button', { name: 'Compartir' }).click()
    assert.ok((await estadoApp()).llamadas.some((l) => l.startsWith('compartir:Para escuchar la pista')))
    await app.getByRole('button', { name: 'Cerrar' }).click()
    // con el localStorage borrado (otra IP = otro origen) sigue siendo el mismo celular, con su nombre
    const id = prefs['device-id']
    await app.evaluate(() => localStorage.clear())
    await app.reload()
    await app.waitForFunction(() => (globalThis as unknown as { __app: App }).__app.llamadas.includes('conexion:true'))
    assert.equal((await estadoApp()).prefs['device-id'], id)
    assert.equal(await app.locator('.m-conexion strong').textContent(), 'Batería')
    await compu.locator('.chip-dispositivos').click()
    await compu.waitForFunction(() => /Batería/.test(document.querySelector('.modal .lista')?.textContent ?? ''))
    await compu.keyboard.press('Escape')
    await ctxApp.close()
  })

  await t.test('sin errores de JavaScript en la compu', () => {
    assert.deepEqual(errores, [])
  })
})

test('licencias: el generador (sin internet) hace licencias que la app acepta; sin licencia, el 3er celular espera', { timeout: 3 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-licencias-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const browser: Browser = await chromium.launch()
  let server: AppServer | null = null
  t.after(async () => {
    await browser.close()
    await server?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ---- el vendedor: claves nuevas en el generador (un .html abierto desde el disco) ----
  const ctxGen = await browser.newContext({ acceptDownloads: true })
  ctxGen.setDefaultTimeout(15000)
  const gen = await ctxGen.newPage()
  const erroresGen: string[] = []
  gen.on('pageerror', (e) => erroresGen.push(e.message))
  await gen.goto(pathToFileURL(path.resolve(__dirname, '../../herramientas/generador-licencias.html')).href)
  const [bajada] = await Promise.all([gen.waitForEvent('download'), gen.locator('#btn-crear-claves').click()])
  const archivoClaves = path.join(tmp, 'claves.json')
  await bajada.saveAs(archivoClaves)
  const claves = JSON.parse(fs.readFileSync(archivoClaves, 'utf-8')) as { privada: string; publica: string }
  const publica = (await gen.locator('#clave-publica').textContent())!.trim()
  assert.equal(publica, claves.publica)
  assert.equal(deBase64Url(publica)?.length, 32)

  // ---- la app con esa clave publica: version de prueba ----
  server = createServer(RENDERER, { compuToken: 'e2e', clavePublicaLicencias: `# clave del vendedor\n${publica}\n` })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
      isElectron: true,
      compuToken: 'e2e',
      pickZipFile: async () => null,
      getConnectionInfo: async () => ({ url: 'http://192.168.0.10:4848', ip: '192.168.0.10', port: 4848 }),
      elegirCarpeta: async () => null,
      abrirCarpeta: async () => {}
    }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  await compu.locator('.chip-licencia').waitFor()
  assert.match((await compu.locator('.chip-licencia').getAttribute('title'))!, /hasta 2 celulares/)

  const celulares: Page[] = []
  for (let i = 0; i < 3; i++) {
    const ctx = await contextoCelular(browser, devices['Pixel 7'])
    ctx.setDefaultTimeout(15000)
    const p = await ctx.newPage()
    await p.goto(base)
    if (i < 2) await p.getByRole('button', { name: /Tocá para empezar/ }).waitFor()
    celulares.push(p)
  }
  const tercero = celulares[2]

  await t.test('sin licencia: el tercer celular ve "No hay más lugar" y la compu se entera', async () => {
    await tercero.getByRole('heading', { name: 'No hay más lugar' }).waitFor()
    assert.match((await tercero.locator('.pantalla-codigo').textContent())!, /versión de prueba permite 2 celulares/)
    await compu.locator('.aviso', { hasText: 'Un celular no pudo entrar' }).waitFor()
  })

  let equipo = ''
  await t.test('una licencia para otra compu no sirve; el archivo .licencia para esta sí', async () => {
    await compu.locator('.chip-licencia').click()
    equipo = (await compu.locator('.licencia-equipo code').textContent())!.trim()
    assert.match(equipo, /^EQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

    async function crear(nombre: string, celulares: string, equipoLic: string): Promise<string> {
      await gen.locator('#f-nombre').fill(nombre)
      await gen.locator('#f-celulares').selectOption(celulares)
      await gen.locator('#f-vence').selectOption('1a')
      await gen.locator('#f-equipo').fill(equipoLic)
      await gen.locator('#btn-crear-licencia').click()
      await gen.waitForFunction((n) => (document.getElementById('verif-resultado')?.textContent ?? '').includes(n), nombre)
      return gen.locator('#licencia-texto').inputValue()
    }
    // para otra compu (escrito a mano, en minusculas y con espacios)
    const ajena = await crear('Otra Iglesia', '10', 'eq 0000 1111 2222')
    await compu.locator('#texto-licencia').fill(`Tu licencia:\n${ajena}\nGracias`)
    await compu.getByRole('button', { name: 'Activar' }).click()
    await compu.locator('.licencia .error-texto', { hasText: 'otra computadora (EQ-0000-1111-2222)' }).waitFor()

    // para esta, como archivo .licencia
    const texto = await crear('Iglesia Vida Nueva', '5', equipo.toLowerCase())
    const v = verificarLicencia(texto, deBase64Url(publica)!, equipo)
    assert.ok(v.ok, 'la app acepta la licencia del generador')
    if (v.ok) {
      assert.equal(v.datos.nombre, 'Iglesia Vida Nueva')
      assert.equal(v.datos.celulares, 5)
      assert.equal(v.datos.equipo, equipo)
      assert.match(v.datos.vence!, /^\d{4}-\d{2}-\d{2}$/)
    }
    const [archivoLic] = await Promise.all([gen.waitForEvent('download'), gen.locator('#btn-bajar-licencia').click()])
    assert.equal(archivoLic.suggestedFilename(), 'Iglesia-Vida-Nueva.licencia')
    const rutaLic = path.join(tmp, 'Iglesia-Vida-Nueva.licencia')
    await archivoLic.saveAs(rutaLic)
    await compu.locator('.licencia input[type=file]').setInputFiles(rutaLic)
    await compu.locator('.licencia-estado.activa', { hasText: 'Iglesia Vida Nueva' }).waitFor()
    assert.match((await compu.locator('.licencia-estado').textContent())!, /Hasta 5 celulares.*solo en esta computadora/)
    await compu.keyboard.press('Escape')
    await compu.locator('.chip-licencia').waitFor({ state: 'detached' })
  })

  await t.test('con la licencia, el tercer celular entra solo (sin tocar nada)', async () => {
    // reintenta solo cada 8 s
    await tercero.getByRole('heading', { name: 'No hay más lugar' }).waitFor({ state: 'detached', timeout: 15000 })
    await compu.locator('.chip-dispositivos').click()
    await compu.waitForFunction(() => /3 celulares conectados\s*\(máximo 5\)/.test(document.querySelector('.modal')?.textContent ?? ''))
    await compu.keyboard.press('Escape')
  })

  await t.test('generador: comprueba licencias (propias, cambiadas) y vuelve a abrir las claves del archivo', async () => {
    const buena = await gen.locator('#licencia-texto').inputValue()
    await gen.locator('#comprobar-texto').fill(buena)
    await gen.locator('#comprobar-resultado', { hasText: '✓ Firmada por vos' }).waitFor()
    const [, datos, firma] = buena.split('.')
    const cambiada = `LIC1.${Buffer.from(Buffer.from(datos, 'base64url').toString().replace('"celulares":5', '"celulares":0')).toString('base64url')}.${firma}`
    await gen.locator('#comprobar-texto').fill(cambiada)
    await gen.locator('#comprobar-resultado', { hasText: '✗ No la firmaste' }).waitFor()
    assert.equal(await gen.locator('#historial tr').count(), 2)

    await gen.reload()
    assert.equal(await gen.locator('#btn-crear-licencia').isDisabled(), true, 'sin claves no se puede crear')
    await gen.locator('#archivo-claves').setInputFiles(archivoClaves)
    await gen.locator('#con-claves').waitFor()
    assert.equal((await gen.locator('#clave-publica').textContent())!.trim(), publica)
    assert.deepEqual(erroresGen, [])
    assert.deepEqual(errores, [])
  })
})

test('listas por día: al abrir aparecen las listas; se arma la del sábado en una carpeta, se usa, y lo de arriba se guarda solo', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-listas-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const zips = ['Primera', 'Segunda', 'Tercera'].map((n, i) => generarZip(tmp, n, [['Click', 900 + i * 50], ['Bajo', 90 + i * 10]], 6, 'wav'))
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = {
      isElectron: true,
      compuToken: 'e2e',
      pickZipFile: async () => g.__zip,
      getConnectionInfo: async () => ({ url: 'http://192.168.0.10:4848', ip: '192.168.0.10', port: 4848 }),
      elegirCarpeta: async () => null,
      abrirCarpeta: async () => {}
    }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  const pestanas = (): Promise<string[]> => compu.locator('.setlist-nombre').allTextContents()

  await t.test('al abrir (sin canciones) aparecen las listas, no una canción', async () => {
    await compu.getByRole('heading', { name: 'Todas las listas' }).waitFor()
    assert.equal(await compu.locator('.chip-lista').textContent(), 'Listas')
  })

  await t.test('canciones sueltas: se importan desde las listas y quedan arriba', async () => {
    for (const zip of zips) {
      await compu.evaluate((z) => ((globalThis as unknown as { __zip: string }).__zip = z), zip)
      const vacio = compu.getByRole('button', { name: /Importar o abrir canción/ })
      if (await vacio.isVisible()) await vacio.click()
      else await compu.locator('.boton-nueva').click()
      await compu.getByRole('button', { name: /Importar \.zip/ }).click()
      await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
    }
    assert.deepEqual(await pestanas(), ['Primera', 'Segunda', 'Tercera'])
    assert.equal(await compu.locator('.cancion-titulo').count(), 1, 'con canciones arriba se ve el escenario')
  })

  await t.test('se arma la lista del sábado en una carpeta nueva (sin tocar lo de arriba)', async () => {
    await compu.locator('.chip-lista').click()
    await compu.getByRole('button', { name: 'Nueva carpeta' }).click()
    await compu.getByLabel('Nombre de la carpeta nueva').fill('Congreso')
    await compu.getByLabel('Nombre de la carpeta nueva').press('Enter')
    await compu.getByRole('heading', { name: 'Congreso' }).waitFor()
    await compu.getByRole('button', { name: 'Nueva lista' }).first().click()
    await compu.getByLabel('Nombre de la lista').fill('Sábado · 19 hs')
    assert.equal(await compu.getByLabel('Carpeta de la lista').inputValue(), 'Congreso')
    await compu.getByRole('button', { name: 'Sumar Tercera a la lista' }).click()
    await compu.getByRole('button', { name: 'Sumar Primera a la lista' }).click()
    await compu.getByRole('button', { name: 'Bajar Tercera' }).click()
    await compu.waitForFunction(() => Array.from(document.querySelectorAll('.lista-orden .lista-titulo'), (e) => e.textContent).join() === 'Primera,Tercera')
    await esperar(900) // el nombre se guarda medio segundo despues de escribir
    assert.deepEqual(await pestanas(), ['Primera', 'Segunda', 'Tercera'], 'armar una lista no cambia lo de arriba')
    // usarla: lo de arriba eran canciones sueltas, pide confirmar
    await compu.locator('.lista-editor-pie').getByRole('button', { name: 'Usar esta lista' }).click()
    await compu.locator('.modal').getByRole('button', { name: 'Usar esta lista' }).click()
    await compu.waitForFunction(() => Array.from(document.querySelectorAll('.setlist-nombre'), (e) => e.textContent).join() === 'Primera,Tercera')
    assert.equal(await compu.locator('.chip-lista').textContent(), 'Sábado · 19 hs')
    assert.match((await compu.locator('.chip-lista').getAttribute('title'))!, /Congreso/)
    assert.equal(await compu.locator('.cancion-titulo').textContent(), 'Primera')
  })

  await t.test('el celular ve el nombre de la lista y su orden', async () => {
    const ctx = await contextoCelular(browser, devices['Pixel 7'])
    ctx.setDefaultTimeout(15000)
    const cel = await ctx.newPage()
    await cel.goto(base)
    await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
    await cel.getByRole('button', { name: 'Canciones del setlist' }).click()
    await cel.getByRole('heading', { name: /Canciones · Sábado · 19 hs/ }).waitFor()
    assert.deepEqual(await cel.locator('.m-canciones-nombre').allTextContents(), ['Primera', 'Tercera'])
    await ctx.close()
  })

  await t.test('lo que se cambia arriba se guarda solo en la lista; editar la lista de arriba cambia las canciones de arriba', async () => {
    // sumar "Segunda" con "+ Canción"
    await compu.locator('.boton-nueva').click()
    await compu.locator('.modal .lista-fila', { hasText: 'Segunda' }).getByRole('button', { name: /Agregar/ }).click()
    await compu.waitForSelector('.modal', { state: 'detached' })
    assert.deepEqual(await pestanas(), ['Primera', 'Tercera', 'Segunda'])
    await compu.locator('.chip-lista').click()
    const tarjeta = compu.locator('.tarjeta-lista', { hasText: 'Sábado · 19 hs' })
    await tarjeta.filter({ hasText: '3 canciones' }).waitFor()
    assert.match((await tarjeta.textContent())!, /HOY.*ARRIBA/)
    // editar la de arriba: sacar "Tercera"
    await tarjeta.getByRole('button', { name: 'Editar' }).click()
    await compu.getByRole('button', { name: 'Sacar Tercera de la lista' }).click()
    await compu.waitForFunction(() => Array.from(document.querySelectorAll('.setlist-nombre'), (e) => e.textContent).join() === 'Primera,Segunda')
    await compu.getByRole('button', { name: 'Listo' }).click()
    await compu.locator('.tarjeta-lista', { hasText: 'Sábado · 19 hs' }).filter({ hasText: '2 canciones' }).waitFor()
    // volver al escenario desde el chip ("Agregar" deja activa la cancion sumada)
    await compu.locator('.chip-lista').click()
    assert.equal(await compu.locator('.cancion-titulo').textContent(), 'Segunda')
    assert.deepEqual(errores, [])
  })
})

test('cambiar de canción y pausa → play: la compu (con sonido) y los celulares arrancan juntos (audio real)', { timeout: 4 * 60 * 1000 }, async (t) => {
  // cada dispositivo graba lo que de verdad sale (AudioWorklet) y se compara contra los otros a la misma hora:
  // la pista "Posicion" (diente de sierra de 8 s) dice en cada muestra en que punto de la cancion esta
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-arranque-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  // los comandos de reproduccion que manda la compu (para saber que tiene que sonar a cada hora)
  type Cmd = { executeAtServerTime: number; playback: { estado: string; positionMs: number; referenceServerTime: number } }
  const cmds: Cmd[] = []
  const emitir = server.io.emit.bind(server.io)
  server.io.emit = ((ev: string, ...args: unknown[]) => {
    if (ev === 'playback:scheduled') cmds.push(args[0] as Cmd)
    return emitir(ev, ...args)
  }) as typeof server.io.emit

  const SEG = 40
  const sierra = new Float32Array(SEG * SR)
  for (let i = 0; i < sierra.length; i++) sierra[i] = (((i / SR) % 8) / 8) * 0.9
  const zips = ['Cancion A', 'Cancion B'].map((nombre) => {
    const z = new AdmZip()
    z.addFile('Posicion.wav', wav16(sierra, SR))
    z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
    z.addFile('Pad.wav', wav16(new Float32Array(SEG * SR), SR))
    const zip = path.join(tmp, `${nombre}.zip`)
    z.writeZip(zip)
    return zip
  })

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    localStorage.setItem('multitrack:sonido-compu', 'true')
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  await compu.goto(`${base}/?debug`)
  for (const zip of zips) {
    await compu.evaluate((z) => ((globalThis as unknown as { __zip: string }).__zip = z), zip)
    const vacio = compu.getByRole('button', { name: /Importar o abrir canción/ })
    if (await vacio.isVisible()) await vacio.click()
    else await compu.locator('.boton-nueva').click()
    await compu.getByRole('button', { name: /Importar \.zip/ }).click()
    await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  }
  await compu.locator('.setlist-tab').nth(0).click()
  await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Cancion A')

  const dispositivos: { nombre: string; p: Page }[] = [{ nombre: 'compu', p: compu }]
  for (const [i, d] of [devices['Pixel 7'], devices['iPhone 13']].entries()) {
    const ctx = await contextoCelular(browser, d)
    ctx.setDefaultTimeout(15000)
    const p = await ctx.newPage()
    await p.goto(`${base}/?debug`)
    await p.getByRole('button', { name: /Tocá para empezar/ }).click()
    dispositivos.push({ nombre: `celular ${i + 1}`, p })
  }
  for (const { p } of dispositivos) {
    await p.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
    await p.evaluate(async () => {
      const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode } } }; __muestras: [number, number][] }
      const engine = g.__mt.engineRef.current
      // canal derecho: ahi va la banda ("Posicion"); el click va a la izquierda
      const codigo = `registerProcessor('grabador', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = [] }
        process(inputs) {
          const x = inputs[0] && inputs[0][1]
          if (x) this.lote.push([currentTime, x[0]])
          if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      nodo.port.onmessage = (e: MessageEvent<[number, number][]>) => {
        // a que hora (reloj de esta compu) sale por el parlante cada bloque grabado
        const ts = engine.ctx.getOutputTimestamp()
        const base = performance.timeOrigin + (ts.performanceTime ?? 0) - (ts.contextTime ?? 0) * 1000
        for (const [tc, v] of e.data) g.__muestras.push([base + tc * 1000, v])
      }
      engine.masterGain.connect(nodo)
    })
  }

  // se mide el ARRANQUE: los primeros 600 ms desde que tiene que empezar a sonar
  const fases: { nombre: string; desde: number; hasta: number }[] = []
  async function medir(nombre: string, ms: number): Promise<void> {
    // (se llama justo despues del play: es el ultimo comando de reproduccion)
    const inicio = cmds.filter((c) => c.playback.estado === 'playing').pop()!.executeAtServerTime
    await esperar(ms)
    fases.push({ nombre, desde: inicio + 50, hasta: inicio + 650 })
  }
  // calentamiento (no se mide): en Chromium sin pantalla el audio falso a veces se atrasa de golpe 20 ms
  // justo al arrancar, con las tres ventanas bajando y decodificando a la vez
  server.transporte.play()
  await esperar(4000)
  server.transporte.pause()
  await esperar(2000)
  // cambio de cancion (en pausa) y play
  await compu.locator('.setlist-tab').nth(1).click()
  await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Cancion B')
  await esperar(2500)
  server.transporte.play()
  await medir('play después de cambiar de canción', 6000)
  server.transporte.pause()
  await esperar(2000)
  server.transporte.play()
  await medir('pausa → play', 6000)
  // cambio de cancion con la musica sonando (la compu pide confirmar) y play enseguida
  await compu.locator('.setlist-tab').nth(0).click()
  await compu.locator('.modal').getByRole('button', { name: /Pasar a Cancion A/ }).click()
  await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Cancion A')
  await esperar(1000)
  server.transporte.play()
  await medir('cambio con la música sonando y play', 6000)
  server.transporte.stop()

  // desfase de cada dispositivo contra lo que tiene que sonar a esa hora; entre ellos es lo que se escucha
  const medianas: Record<string, Record<string, number>> = {}
  const volcado: Record<string, unknown> = { cmds, fases }
  for (const { nombre, p } of dispositivos) {
    const muestras = (await p.evaluate(() => (globalThis as unknown as { __muestras: [number, number][] }).__muestras)) as [number, number][]
    volcado[nombre] = muestras
    const escala = Math.max(...muestras.map((m) => m[1]))
    for (const f of fases) {
      const difs: number[] = []
      for (const [w, v] of muestras) {
        if (w < f.desde || w > f.hasta || v < 0.002 * escala) continue
        const c = cmds.filter((x) => x.executeAtServerTime <= w).pop()
        if (!c || c.playback.estado !== 'playing') continue
        const enCiclo = ((c.playback.positionMs + w - c.playback.referenceServerTime) / 1000) % 8
        if (enCiclo < 0.05 || enCiclo > 7.95) continue
        let d = (v / escala) * 8 - enCiclo
        if (d > 4) d -= 8
        if (d < -4) d += 8
        difs.push(d * 1000)
      }
      assert.ok(difs.length > 100, `${nombre} en "${f.nombre}": casi no sonó (${difs.length})`)
      // el audio falso de Chromium sin pantalla a veces se atrasa de golpe ~20 ms (como un corte): si pasa
      // justo en la ventana medida, esa medicion no dice nada del arranque y se descarta
      const primeros = difs.slice(0, 20).sort((a, b) => a - b)
      const ultimos = difs.slice(-20).sort((a, b) => a - b)
      const salto = Math.abs(primeros[10] - ultimos[10]) > 6
      difs.sort((a, b) => a - b)
      ;(medianas[f.nombre] ??= {})[nombre] = salto ? NaN : difs[Math.floor(difs.length / 2)]
    }
  }
  if (process.env.E2E_VOLCADO_ARRANQUE) fs.writeFileSync(process.env.E2E_VOLCADO_ARRANQUE, JSON.stringify(volcado))
  const validas = Object.entries(medianas).filter(([, m]) => Object.values(m).every((x) => !Number.isNaN(x)))
  assert.ok(validas.length >= 2, `muy pocas mediciones limpias: ${JSON.stringify(medianas)}`)
  for (const [f, m] of validas) {
    const v = Object.values(m)
    const separacion = Math.max(...v) - Math.min(...v)
    assert.ok(
      separacion < 5,
      `"${f}": los dispositivos no arrancaron juntos (${Object.entries(m)
        .map(([d, x]) => `${d} ${x.toFixed(1)} ms`)
        .join(' · ')})`
    )
  }
})

test('tono: − / + en la compu prepara la canción en el tono nuevo; los celulares lo ven y siguen en sync', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-tono-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const zip = generarZip(tmp, 'Digno - A', [['Click', 900], ['Bajo', 110], ['Pad', 220]], 20, 'wav')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  await compu.evaluate((z) => ((globalThis as unknown as { __zip: string }).__zip = z), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  await compu.waitForFunction(() => document.querySelector('.cancion-titulo')?.textContent === 'Digno - A')

  const ctxCel = await contextoCelular(browser, devices['Pixel 7'])
  ctxCel.setDefaultTimeout(15000)
  await ctxCel.addInitScript(espiaAudio)
  const cel = await ctxCel.newPage()
  cel.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
  await cel.goto(`${base}/?debug`)
  await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
  const tonoCelular = (): Promise<string | null> => cel.locator('.m-barra-tono').textContent()

  await t.test('la tonalidad sale del nombre de la canción', async () => {
    const chip = compu.getByTestId('control-tono')
    assert.equal(await chip.getByLabel('Tonalidad original').locator('option:checked').textContent(), 'A')
    await cel.waitForFunction(() => document.querySelector('.m-barra-tono')?.textContent === 'A')
  })

  await t.test('+ + : la compu prepara las pistas y la canción pasa a B (+2)', async () => {
    const chip = compu.getByTestId('control-tono')
    await chip.getByRole('button', { name: 'Subir medio tono' }).click()
    await chip.getByRole('button', { name: 'Subir medio tono' }).click()
    await compu.waitForFunction(() => document.querySelector('.tono-destino')?.textContent?.replace(/\s+/g, ' ').trim() === '→ B +2')
    // mientras se prepara se ve el progreso; despues desaparece
    await compu.waitForSelector('.tono-progreso', { timeout: 10000 })
    await compu.waitForSelector('.tono-progreso', { state: 'detached', timeout: 90000 })
    await cel.waitForFunction(() => document.querySelector('.m-barra-tono')?.textContent === 'B+2', null, { timeout: 15000 })
    const p = server.state.getActiveTab()!.proyecto
    assert.equal(p.tonoAplicado, 2)
    assert.equal(p.tonoPistas!.length, 2, 'el bajo y el pad (el click no)')
  })

  await t.test('suena en sync en el tono nuevo; sonando, el tono no se puede tocar', async () => {
    await compu.getByRole('button', { name: 'Reproducir' }).click()
    await enSync([cel], 'tras cambiar el tono')
    assert.ok((await vivas(cel)) > 0, 'el celular suena')
    const chip = compu.getByTestId('control-tono')
    assert.equal(await chip.getByRole('button', { name: 'Subir medio tono' }).isDisabled(), true)
    assert.equal(await chip.getByRole('button', { name: 'Bajar medio tono' }).isDisabled(), true)
    await compu.getByRole('button', { name: 'Stop' }).click()
  })

  await t.test('tocar "→ B +2" vuelve al tono original', async () => {
    await compu.locator('.tono-destino').click()
    await compu.waitForSelector('.tono-destino', { state: 'detached' })
    await cel.waitForFunction(() => document.querySelector('.m-barra-tono')?.textContent === 'A')
    assert.equal(server.state.getActiveTab()!.proyecto.tonoAplicado, 0)
  })

  await t.test('velocidad: + en el BPM prepara todas las pistas; la canción pasa a ese tiempo y los celulares siguen en sync', async () => {
    const tab = server.state.getActiveTab()!
    const p = tab.proyecto
    const durOriginal = p.duracionTotalMs
    p.tempo = { bpm: 100, compas: 4, compasesMs: Array.from({ length: 9 }, (_, k) => k * 2400), clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }
    server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))
    const chip = compu.getByTestId('control-velocidad')
    await chip.waitFor()
    for (let i = 0; i < 4; i++) await chip.getByRole('button', { name: 'Más rápido' }).click()
    await compu.waitForFunction(() => document.querySelector('[data-testid=control-velocidad] .velocidad-bpm')?.textContent === '104 BPM')
    await compu.waitForSelector('[data-testid=control-velocidad] .tono-progreso', { timeout: 10000 })
    await compu.waitForSelector('[data-testid=control-velocidad] .tono-progreso', { state: 'detached', timeout: 120000 })
    assert.equal(p.velocidadAplicada, 1.04)
    assert.equal(p.tonoPistas!.length, 3, 'a otra velocidad cambian todas (también el click)')
    assert.ok(Math.abs(p.duracionTotalMs - durOriginal / 1.04) <= 1)
    assert.ok(Math.abs(p.tempo!.bpm - 104) < 1e-6)
    assert.match((await chip.textContent()) ?? '', /104 BPM\s*\+4 %/)
    assert.equal(await chip.getByRole('button', { name: 'Volver a la velocidad original (100 BPM)' }).count(), 1)
    await cel.waitForFunction(() => Array.from(document.querySelectorAll('.m-barra-tono')).some((e) => e.textContent === '104 BPM'))
    // suena en sync a la velocidad nueva
    await compu.getByRole('button', { name: 'Reproducir' }).click()
    await enSync([cel], 'tras cambiar la velocidad')
    assert.ok((await vivas(cel)) > 0, 'el celular suena')
    assert.equal(await chip.getByRole('button', { name: 'Más rápido' }).isDisabled(), true, 'sonando no se cambia')
    await compu.getByRole('button', { name: 'Stop' }).click()
    // tocar "+4 %" vuelve a la original
    await chip.locator('.tono-destino').click()
    await compu.waitForFunction(() => document.querySelector('[data-testid=control-velocidad] .velocidad-bpm')?.textContent === '100 BPM')
    await compu.waitForFunction(() => !document.querySelector('[data-testid=control-velocidad] .tono-progreso'), null, { timeout: 15000 })
    assert.equal(p.velocidadAplicada, undefined)
    assert.ok(Math.abs(p.duracionTotalMs - durOriginal) <= 1)
  })

  await t.test('la tonalidad original se puede corregir a mano', async () => {
    await compu.getByLabel('Tonalidad original').selectOption('G')
    await cel.waitForFunction(() => document.querySelector('.m-barra-tono')?.textContent === 'G')
    assert.equal(await tonoCelular(), 'G')
    await compu.getByLabel('Tonalidad original').selectOption('')
    await cel.waitForFunction(() => document.querySelector('.m-barra-tono')?.textContent === 'A')
    assert.deepEqual(errores, [])
  })
})

test('firewall de Windows: en una red pública bloqueada la compu avisa y "Permitir en todas las redes" lo arregla', { timeout: 2 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-firewall-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const browser: Browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctx.setDefaultTimeout(15000)
  // la parte de Windows (PowerShell) simulada: la red "Iglesia" es publica y la app esta bloqueada ahi
  await ctx.addInitScript(() => {
    const bloqueado = { estado: 'bloqueado', redes: [{ nombre: 'Iglesia', categoria: 'publica' }], bloqueadas: [{ nombre: 'Iglesia', categoria: 'publica' }] }
    const ok = { ...bloqueado, estado: 'ok', bloqueadas: [] }
    const g = globalThis as unknown as { __permisos: number; electronAPI: unknown }
    g.__permisos = 0
    let actual: unknown = bloqueado
    g.electronAPI = {
      isElectron: true,
      compuToken: 'e2e',
      pickZipFile: async () => null,
      getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }),
      firewall: {
        estado: async () => actual,
        revisar: async () => actual,
        permitir: async () => {
          g.__permisos++
          await new Promise((r) => setTimeout(r, 300)) // lo que tarda Windows en preguntar
          actual = ok
          return { resultado: 'ok', estado: ok }
        },
        alCambiar: () => () => undefined
      }
    }
  })
  const compu = await ctx.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(`http://localhost:${port}`)

  await t.test('apenas abre, avisa que los celulares no van a encontrar la compu', async () => {
    await compu.locator('.aviso', { hasText: 'Windows bloquea AirTracks en esta red (“Iglesia”)' }).waitFor()
    assert.match((await compu.locator('.chip-dispositivos').getAttribute('title'))!, /Windows bloquea/)
  })

  await t.test('en Celulares: el aviso con la red y el botón; permitir lo arregla', async () => {
    await compu.locator('.chip-dispositivos').click()
    const aviso = compu.locator('.aviso-firewall')
    await aviso.waitFor()
    assert.match((await aviso.textContent())!, /bloquea AirTracks en “Iglesia” \(red pública\)/)
    await aviso.getByRole('button', { name: 'Permitir en todas las redes' }).click()
    await compu.locator('.aviso-firewall.ok', { hasText: 'Windows ya deja entrar a los celulares' }).waitFor()
    assert.equal(await compu.evaluate(() => (globalThis as unknown as { __permisos: number }).__permisos), 1)
    assert.doesNotMatch((await compu.locator('.chip-dispositivos').getAttribute('title'))!, /Windows bloquea/)
    // la ayuda "¿no encuentran la compu?" dice como esta el firewall
    await compu.locator('.conexion-no-aparece summary').click()
    assert.match((await compu.locator('.conexion-no-aparece').textContent())!, /deja entrar a los celulares en esta red/)
    assert.deepEqual(errores, [])
  })
})

test('cuenta: al dar play suena "1 2 3 4, 1 2 3 4" a la vez en la compu y el celular, y la canción entra justo después (audio real)', { timeout: 3 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-cuenta-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  type Cmd = { executeAtServerTime: number; playback: { estado: string; referenceServerTime: number; cuenta?: { golpes: { t: number; n: number }[] } } }
  const cmds: Cmd[] = []
  const emitir = server.io.emit.bind(server.io)
  server.io.emit = ((ev: string, ...args: unknown[]) => {
    if (ev === 'playback:scheduled') cmds.push(args[0] as Cmd)
    return emitir(ev, ...args)
  }) as typeof server.io.emit

  // "Posicion" (la banda, a la derecha): sube de 0 a 0,9 en 8 s; el click (a la izquierda) a 120 BPM desde 0,5 s
  const SEG = 20
  const sierra = new Float32Array(SEG * SR)
  for (let i = 0; i < sierra.length; i++) sierra[i] = 0.05 + (((i / SR) % 8) / 8) * 0.85
  const z = new AdmZip()
  z.addFile('Posicion.wav', wav16(sierra, SR))
  z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
  const zip = path.join(tmp, 'Con cuenta.zip')
  z.writeZip(zip)

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    localStorage.setItem('multitrack:sonido-compu', 'true')
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(`${base}/?debug`)
  await compu.evaluate((zz) => ((globalThis as unknown as { __zip: string }).__zip = zz), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  // el tempo del click (como lo deja el analisis): compases de 2 s desde 0,5 s
  const p = server.state.getActiveTab()!.proyecto
  p.tempo = {
    bpm: 120,
    compas: 4,
    compasesMs: Array.from({ length: 9 }, (_, k) => 500 + 2000 * k),
    clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id,
    acentoClaro: true
  }
  server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))
  await compu.getByLabel('Cuenta antes de la canción').waitFor()
  // por defecto no hay cuenta; aca se eligen 2 compases (suena solo desde el principio)
  assert.equal(await compu.getByLabel('Cuenta antes de la canción').inputValue(), '')
  await compu.getByLabel('Cuenta antes de la canción').selectOption('2')
  await compu.waitForFunction(() => (document.querySelector('.chip-cuenta') as HTMLSelectElement | null)?.value === '2')

  const ctxCel = await contextoCelular(browser, devices['Pixel 7'])
  ctxCel.setDefaultTimeout(15000)
  const cel = await ctxCel.newPage()
  cel.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
  await cel.goto(`${base}/?debug`)
  await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
  const dispositivos = [
    { nombre: 'compu', p: compu },
    { nombre: 'celular', p: cel }
  ]
  for (const { p: pg } of dispositivos) {
    await pg.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
    // se graba lo que sale: por bloque, el pico del canal izquierdo (click y cuenta) y el derecho (la banda)
    await pg.evaluate(async () => {
      const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode } } }; __muestras: [number, number, number][] }
      const engine = g.__mt.engineRef.current
      const codigo = `registerProcessor('grabador-cuenta', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = [] }
        process(inputs) {
          const [L, R] = inputs[0] || []
          if (L && R) {
            let pico = 0
            for (let i = 0; i < L.length; i++) pico = Math.max(pico, Math.abs(L[i]))
            this.lote.push([currentTime, pico, R[0]])
          }
          if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador-cuenta', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      nodo.port.onmessage = (e: MessageEvent<[number, number, number][]>) => {
        const ts = engine.ctx.getOutputTimestamp()
        const base = performance.timeOrigin + (ts.performanceTime ?? 0) - (ts.contextTime ?? 0) * 1000
        for (const [tc, l, r] of e.data) g.__muestras.push([base + tc * 1000, l, r])
      }
      engine.masterGain.connect(nodo)
    })
  }
  await esperar(3000) // que todos tengan listo el comienzo y el sonido de la cuenta

  await t.test('suenan los 8 golpes en los dos, juntos y a tiempo; la canción entra en el "1"', async () => {
    const vistos = new Set<string>()
    const mirar = setInterval(() => {
      void cel.locator('.m-contando').textContent().then((x) => x && vistos.add(`cel ${x.trim()}`), () => undefined)
      void compu.locator('.reloj-contando .reloj-grande').textContent().then((x) => x && vistos.add(`compu ${x.trim()}`), () => undefined)
    }, 100)
    /** Un play con cuenta: cuanto antes (-) o despues (+) de su hora sono cada golpe y la entrada de la banda, en cada dispositivo. */
    async function tocar(): Promise<Record<string, number[]>> {
      for (const { p: pg } of dispositivos) await pg.evaluate(() => ((globalThis as unknown as { __muestras: unknown[] }).__muestras = []))
      await compu.getByRole('button', { name: 'Reproducir' }).click()
      await esperar(300)
      const cmd = cmds.filter((c) => c.playback.estado === 'playing').pop()!
      const golpes = cmd.playback.cuenta!.golpes
      assert.equal(golpes.length, 8)
      await esperar(cmd.executeAtServerTime - Date.now() + 2500)
      await compu.getByRole('button', { name: 'Stop' }).click()
      const entradas: Record<string, number[]> = {}
      for (const { nombre, p: pg } of dispositivos) {
        const m = (await pg.evaluate(() => (globalThis as unknown as { __muestras: [number, number, number][] }).__muestras)) as [number, number, number][]
        // cada golpe de la cuenta: el primer bloque que sube de golpe cerca de su hora
        const ataques: number[] = []
        for (const g of golpes) {
          const cerca = m.filter(([w]) => w > g.t - 60 && w < g.t + 60)
          const pico = Math.max(...cerca.map((x) => x[1]))
          assert.ok(pico > 0.05, `${nombre}: no sonó el golpe ${g.n} (pico ${pico.toFixed(3)})`)
          ataques.push(cerca.find((x) => x[1] >= pico * 0.5)![0] - g.t)
        }
        // antes de la cuenta y durante, la banda no suena; entra en la hora de la musica
        const antes = m.filter(([w]) => w > golpes[0].t - 200 && w < cmd.executeAtServerTime - 30)
        assert.ok(antes.length > 50 && antes.every((x) => Math.abs(x[2]) < 0.01), `${nombre}: la banda sonó durante la cuenta`)
        const entra = m.find(([w, , r]) => w > cmd.executeAtServerTime - 30 && Math.abs(r) > 0.02)
        assert.ok(entra, `${nombre}: la banda no entró`)
        ataques.push(entra![0] - cmd.executeAtServerTime)
        entradas[nombre] = ataques
      }
      await esperar(1000)
      return entradas
    }
    // el audio falso de Chromium sin pantalla a veces se atrasa de golpe ~20 ms (como un corte): una medicion
    // donde a un dispositivo se le corrieron los golpes entre si no dice nada de la sincronizacion; se repite
    let entradas: Record<string, number[]> | null = null
    const descartadas: string[] = []
    // (tambien una medicion donde un dispositivo quedo corrido entero respecto del otro: el reloj estimado del
    // celular falso a veces se va unos ms un rato; la exigencia final es la misma)
    const mediana = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
    for (let intento = 0; intento < 4 && !entradas; intento++) {
      const e = await tocar()
      const salto =
        Object.values(e).some((v) => Math.max(...v.slice(0, 8)) - Math.min(...v.slice(0, 8)) > 5) ||
        Math.abs(mediana(e.compu) - mediana(e.celular)) > 8 ||
        // un golpe suelto corrido entre los dos (el audio falso en una maquina cargada): se vuelve a medir
        e.compu.some((a, i) => Math.abs(a - e.celular[i]) >= 5)
      if (salto) descartadas.push(JSON.stringify(e, (_k, v) => (typeof v === 'number' ? Math.round(v) : v)))
      else entradas = e
    }
    clearInterval(mirar)
    assert.ok(entradas, `todas las mediciones con saltos del audio falso: ${descartadas.join(' | ')}`)
    assert.ok(vistos.has('cel Cuenta 1') && vistos.has('cel Cuenta 4'), `el celular muestra la cuenta (${[...vistos].join(', ')})`)
    assert.ok(vistos.has('compu 1') && vistos.has('compu 3'), `la compu muestra la cuenta (${[...vistos].join(', ')})`)
    if (process.env.E2E_VERBOSE) console.log('cuenta (ms contra la hora pedida):', JSON.stringify(entradas, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)))
    // entre dispositivos (lo que se escucha): cada golpe y la entrada, a menos de 5 ms; contra la hora pedida, a menos de 15
    for (let i = 0; i < 9; i++) {
      const a = entradas!.compu[i]
      const b = entradas!.celular[i]
      assert.ok(Math.abs(a - b) < 5, `${i < 8 ? `golpe ${i + 1}` : 'entrada de la banda'}: compu ${a.toFixed(1)} ms · celular ${b.toFixed(1)} ms`)
      assert.ok(Math.abs(a) < 15 && Math.abs(b) < 15, `${i < 8 ? `golpe ${i + 1}` : 'entrada'} corrido: compu ${a.toFixed(1)} · celular ${b.toFixed(1)}`)
    }
  })

  await t.test('"Sin cuenta" en esta canción: arranca directo', async () => {
    await compu.getByLabel('Cuenta antes de la canción').selectOption('')
    await compu.waitForFunction(() => (document.querySelector('.chip-cuenta') as HTMLSelectElement | null)?.value === '')
    await esperar(300)
    await compu.getByRole('button', { name: 'Reproducir' }).click()
    await esperar(300)
    assert.equal(cmds.filter((c) => c.playback.estado === 'playing').pop()!.playback.cuenta, undefined)
    await compu.getByRole('button', { name: 'Stop' }).click()
    assert.deepEqual(errores, [])
  })
})

test('Android con el navegador: "Abrir en la app" lleva a la app con la misma dirección (y el código); sin la app, ofrece bajarla', { timeout: 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-abrir-app-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const extras = path.join(tmp, 'extras')
  fs.mkdirSync(extras)
  fs.writeFileSync(path.join(extras, 'airtracks.apk'), 'apk de prueba')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false, dirExtras: extras })
  const port = await server.start(0)
  const browser: Browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const ctx = await contextoCelular(browser, devices['Pixel 7'])
  ctx.setDefaultTimeout(15000)
  const cel = await ctx.newPage()
  await cel.goto(`http://localhost:${port}/?c=1234`)
  const link = cel.getByRole('link', { name: /Abrir en la app/ })
  await link.waitFor()
  const href = (await link.getAttribute('href'))!
  assert.ok(href.startsWith(`intent://localhost:${port}/?c=1234#Intent;scheme=airtracks;package=com.multitrack.alabanza;`), href)
  assert.match(decodeURIComponent(href), new RegExp(`S\\.browser_fallback_url=http://localhost:${port}/\\?c=1234#sin-app;end$`))
  // Chrome vuelve con #sin-app si no esta instalada: se ofrece bajarla
  await cel.goto(`http://localhost:${port}/?c=1234#sin-app`)
  await cel.reload()
  await cel.getByText('Parece que no tenés la app AirTracks').waitFor()
  assert.equal(await cel.getByRole('link', { name: /Bajar la app para Android/ }).first().getAttribute('href'), '/app/airtracks.apk')
  // en un iPhone no aparece
  const ctxIos = await contextoCelular(browser, devices['iPhone 13'])
  const ios = await ctxIos.newPage()
  await ios.goto(`http://localhost:${port}/`)
  await ios.getByRole('button', { name: /Tocá para empezar/ }).waitFor()
  assert.equal(await ios.getByRole('link', { name: /Abrir en la app/ }).count(), 0)
})

test('mute desde la compu y mute/solo en el celular: esa pista deja de escucharse enseguida (audio real, WiFi normal y cargado)', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-mute-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  // "Seno" (a la izquierda) es lo que se mutea; "Banda" (a la derecha) sigue sonando
  const SEG = 150
  const seno = new Float32Array(SEG * SR)
  const banda = new Float32Array(SEG * SR)
  for (let i = 0; i < seno.length; i++) {
    seno[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / SR)
    banda[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)
  }
  const z = new AdmZip()
  z.addFile('Seno.wav', wav16(seno, SR))
  z.addFile('Banda.wav', wav16(banda, SR))
  const zip = path.join(tmp, 'Mute.zip')
  z.writeZip(zip)
  const compuSock = (await import('socket.io-client')).io(base, { auth: { origen: 'compu', token: 'e2e' } })
  t.after(() => void compuSock.close())
  await new Promise<void>((r) => compuSock.once('connect', () => r()))
  await new Promise((r) => compuSock.emit('project:load-from-zip', { filePath: zip }, r))
  const p = server.state.getActiveTab()!.proyecto
  const idSeno = p.pistas.find((x) => x.nombre === 'Seno')!.id
  const idBanda = p.pistas.find((x) => x.nombre === 'Banda')!.id
  server.state.actualizarMixer(server.state.getActiveTab()!.tabId, idSeno, { pan: -100 })
  server.state.actualizarMixer(server.state.getActiveTab()!.tabId, idBanda, { pan: 100 })
  server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))

  const ctx = await contextoCelular(browser, devices['Pixel 7'])
  ctx.setDefaultTimeout(15000)
  const cel = await ctx.newPage()
  await cel.goto(`${base}/?debug`)
  await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
  await cel.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
  await cel.evaluate(async () => {
    const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode } } }; __muestras: [number, number][] }
    const engine = g.__mt.engineRef.current
    const codigo = `registerProcessor('grabador-mute', class extends AudioWorkletProcessor {
      constructor() { super(); this.lote = [] }
      process(inputs) {
        const L = inputs[0] && inputs[0][0]
        if (L) { let pico = 0; for (let i = 0; i < L.length; i++) pico = Math.max(pico, Math.abs(L[i])); this.lote.push([currentTime, pico]) }
        if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
        return true
      }
    })`
    await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
    const nodo = new AudioWorkletNode(engine.ctx, 'grabador-mute', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
    g.__muestras = []
    nodo.port.onmessage = (e: MessageEvent<[number, number][]>) => {
      const ts = engine.ctx.getOutputTimestamp()
      const b = performance.timeOrigin + (ts.performanceTime ?? 0) - (ts.contextTime ?? 0) * 1000
      for (const [tc, v] of e.data) g.__muestras.push([b + tc * 1000, v])
    }
    engine.masterGain.connect(nodo)
  })
  compuSock.emit('transport:play', {})
  await esperar(6000)

  /** Mutea (o desmutea) el seno y mide cuanto tarda en escucharse en el celular. De entrada, como lo hace la compu. */
  async function medir(mute: boolean, espera: number, accion = (): unknown => compuSock.emit('mixer:update', { pistaId: idSeno, patch: { mute } })): Promise<number> {
    await cel.evaluate(() => ((globalThis as unknown as { __muestras: unknown[] }).__muestras = []))
    // distintos momentos del pedazo de 2 s que suena (al final es lo mas dificil)
    await esperar(espera)
    const t0 = Date.now()
    await accion()
    await esperar(4000)
    const m = (await cel.evaluate(() => (globalThis as unknown as { __muestras: [number, number][] }).__muestras)) as [number, number][]
    const cambiado = ([, v]: [number, number]): boolean => (mute ? v < 0.02 : v > 0.1)
    const cambio = m.find((x) => x[0] > t0 && cambiado(x))
    assert.ok(cambio, `${mute ? 'mute' : 'desmute'}: no cambió en 4 s`)
    // y queda asi: no vuelve un rato a como estaba (un pedazo de la mezcla vieja)
    const vuelta = m.find((x) => x[0] > cambio![0] + 40 && !cambiado(x))
    assert.ok(!vuelta, `${mute ? 'mute' : 'desmute'}: cambió a los ${Math.round(cambio![0] - t0)} ms y volvió a los ${Math.round((vuelta?.[0] ?? 0) - t0)} ms`)
    return cambio![0] - t0
  }
  const esperas = [300, 800, 1300, 1800, 550, 1050, 1550, 2050]
  const normal: number[] = []
  for (const [k, e] of esperas.entries()) normal.push(await medir(k % 2 === 0, e))
  // WiFi cargado: 6 Mbps y 30 ms de demora
  const cdp = await ctx.newCDPSession(cel)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: (6e6 / 8) | 0, uploadThroughput: (2e6 / 8) | 0 })
  await esperar(3000)
  const cargado: number[] = []
  for (const [k, e] of esperas.entries()) cargado.push(await medir(k % 2 === 0, e))
  console.log('demora del mute en el celular (ms) · WiFi normal:', normal.map(Math.round).join(', '), '· WiFi cargado:', cargado.map(Math.round).join(', '))

  // "Mi mezcla" en el celular: M silencia el seno; S en la banda lo deja afuera (solo en este celular)
  const boton = (nombre: string) => cel.getByRole('button', { name: nombre })
  await vistaCelular(cel, 'Mi mezcla')
  const personal = [
    await medir(true, 300, () => boton('Mute de Seno en este celular').click()),
    await medir(false, 800, () => boton('Mute de Seno en este celular').click()),
    await medir(true, 300, () => boton('Solo de Banda en este celular').click()),
    await medir(false, 800, () => boton('Solo de Seno en este celular').click())
  ]
  assert.equal(await boton('Solo de Banda en este celular').getAttribute('aria-pressed'), 'true')
  assert.equal(await boton('Solo de Seno en este celular').getAttribute('aria-pressed'), 'true')
  console.log('Mi mezcla (M/S en el celular, WiFi cargado) (ms):', personal.map(Math.round).join(', '))
  compuSock.emit('transport:stop', {})
  assert.ok(Math.max(...normal) < 600, `WiFi normal: ${normal.map(Math.round).join(', ')} ms`)
  // con la red cargada: casi siempre ~0,6 s; un mute justo al final de un pedazo espera al siguiente (hasta ~1,3 s)
  const promedio = cargado.reduce((a, b) => a + b, 0) / cargado.length
  assert.ok(Math.max(...cargado) < 1500 && promedio < 1000, `WiFi cargado: ${cargado.map(Math.round).join(', ')} ms`)
  assert.ok(Math.max(...personal) < 1500, `Mi mezcla: ${personal.map(Math.round).join(', ')} ms`)
})

test('voz del salto con audio real: en el último compás se calla la guía y se cuenta a tiempo (celular y compu)', { timeout: 3 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-voz-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const tono = (f: number, seg: number, amp: number, sr = SR): Float32Array => {
    const x = new Float32Array(Math.round(seg * sr))
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr)
    return x
  }
  // pack de voces: "Puente" (con silencio antes de hablar), "3" y "4"
  const conSilencio = (x: Float32Array, antes: number): Float32Array => {
    const y = new Float32Array(x.length + Math.round(antes * 48000) + 9600)
    y.set(x, Math.round(antes * 48000))
    return y
  }
  const pack = new AdmZip()
  pack.addFile('Spanish Guides/Spanish - Puente (Bridge).wav', wav16(conSilencio(tono(1000, 0.4, 0.5, 48000), 0.1), 48000))
  pack.addFile('Spanish Guides/Spanish - 3.wav', wav16(conSilencio(tono(1500, 0.2, 0.5, 48000), 0), 48000))
  pack.addFile('Spanish Guides/Spanish - 4.wav', wav16(conSilencio(tono(1500, 0.2, 0.5, 48000), 0), 48000))
  const zipPack = path.join(tmp, 'Voces.zip')
  pack.writeZip(zipPack)
  // la cancion: la guia suena todo el tiempo (izquierda), la banda a la derecha; 120 BPM 4/4
  const z = new AdmZip()
  z.addFile('Guia.wav', wav16(tono(300, 20, 0.3), SR))
  z.addFile('Click.wav', wav16(new Float32Array(20 * SR), SR))
  z.addFile('Banda.wav', wav16(tono(220, 20, 0.3), SR))
  z.addFile('marcas.txt', Buffer.from('0:04 Verso\n0:08 Coro\n0:12 Puente\n'))
  const zip = path.join(tmp, 'Voz.zip')
  z.writeZip(zip)
  const compuSock = (await import('socket.io-client')).io(base, { auth: { origen: 'compu', token: 'e2e' } })
  t.after(() => void compuSock.close())
  await new Promise<void>((r) => compuSock.once('connect', () => r()))
  const importado = await new Promise<{ ok: boolean; error?: string }>((r) => compuSock.emit('voces:importar', { filePath: zipPack }, r))
  assert.equal(importado.ok, true, importado.error)
  await new Promise((r) => compuSock.emit('project:load-from-zip', { filePath: zip }, r))
  const tab = server.state.getActiveTab()!
  const p = tab.proyecto
  p.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 11 }, (_, k) => k * 2000), clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }
  p.cuenta = 0
  server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))

  // un celular con la mezcla de la compu y otro con las pistas sueltas (como suena la compu)
  const paginas: Page[] = []
  for (const modo of ['', '&modo=pistas']) {
    const ctx = await contextoCelular(browser, devices['Pixel 7'])
    ctx.setDefaultTimeout(15000)
    const cel = await ctx.newPage()
    await cel.goto(`${base}/?debug${modo}`)
    await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
    await cel.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
    // se graba el oido izquierdo (guia y voz) con la posicion de la cancion de cada pedacito
    await cel.evaluate(async () => {
      const g = globalThis as unknown as {
        __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode; posicionNodoEn(t: number): number | null } } }
        __muestras: [number, number][]
      }
      const engine = g.__mt.engineRef.current
      const codigo = `registerProcessor('grabador-voz', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = [] }
        process(inputs) {
          const L = inputs[0] && inputs[0][0]
          if (L) { let pico = 0; for (let i = 0; i < L.length; i++) pico = Math.max(pico, Math.abs(L[i])); this.lote.push([currentTime, pico]) }
          if (this.lote.length >= 4) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador-voz', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      nodo.port.onmessage = (e: MessageEvent<[number, number][]>) => {
        for (const [tc, v] of e.data) {
          const pos = engine.posicionNodoEn(tc)
          if (pos !== null) g.__muestras.push([pos, v])
        }
      }
      engine.masterGain.connect(nodo)
    })
    paginas.push(cel)
  }

  // sonando en el Inicio, se elige el Puente: salta al terminar el Inicio (4 s); la voz va en el ultimo compas (2 a 4 s)
  compuSock.emit('transport:play', { positionMs: 0 })
  await esperar(2200)
  const antes = buildEstadoCompleto(server.state).playbackActivo!
  assert.equal(antes.estado, 'playing')
  compuSock.emit('seccion:saltar', { posicionMs: 12000 })
  await esperar(500)
  const anuncio = server.state.saltoPendiente?.anuncio
  assert.ok(anuncio, 'el salto trae la voz')
  assert.deepEqual([anuncio.desdeMs, anuncio.hastaMs], [2000, 4000])
  await esperar(4500)
  compuSock.emit('transport:stop', {})

  for (const [k, cel] of paginas.entries()) {
    const quien = k === 0 ? 'celular (mezcla de la compu)' : 'pistas sueltas (como la compu)'
    const m = (await cel.evaluate(() => (globalThis as unknown as { __muestras: [number, number][] }).__muestras)) as [number, number][]
    const pico = (desde: number, hasta: number): number => Math.max(0, ...m.filter(([pos]) => pos >= desde && pos < hasta).map(([, v]) => v))
    // antes del ultimo compas se oye la guia; en el hueco entre "Puente" y "3", nada (la guia se calla)
    assert.ok(pico(1.2, 1.95) > 0.1, `${quien}: la guía suena antes (${pico(1.2, 1.95)})`)
    assert.ok(pico(2.5, 2.95) < 0.02, `${quien}: la guía se calla en el compás del aviso (${pico(2.5, 2.95)})`)
    // "Puente" en el 1, tan fuerte como la guia (la voz se iguala a ella), y el "3" justo en su pulso (a 3 s de la cancion)
    const guia = pico(1.2, 1.95)
    const voz = pico(2.0, 2.35)
    assert.ok(voz > guia * 0.75 && voz < guia * 1.33, `${quien}: "Puente" al nivel de la guía (${voz.toFixed(3)} vs ${guia.toFixed(3)})`)
    const tres = m.find(([pos, v]) => pos >= 2.95 && pos < 3.3 && v > 0.05)
    assert.ok(tres, `${quien}: suena el "3"`)
    assert.ok(Math.abs(tres[0] - 3.0) < 0.006, `${quien}: el "3" a los ${tres[0].toFixed(4)} s de la canción (debía ser 3,000)`)
    // el "4" suena aunque la orden del salto ya llego (la voz sigue hasta el salto)
    const cuatro = m.find(([pos, v]) => pos >= 3.3 && pos < 3.8 && v > 0.05)
    assert.ok(cuatro && Math.abs(cuatro[0] - 3.5) < 0.006, `${quien}: el "4" a los ${cuatro?.[0].toFixed(4)} s (debía ser 3,500)`)
    // salta al Puente (12 s) y la guia vuelve
    assert.ok(pico(12.2, 13.5) > 0.1, `${quien}: después del salto vuelve la guía (${pico(12.2, 13.5)})`)
    console.log(`voz del salto · ${quien}: "3" a ${(tres[0] * 1000).toFixed(1)} ms (debía 3000), guía en el compás ${pico(2.5, 2.95).toFixed(4)}`)
  }
})

test('colchón con audio real: la banda se va en el compás, el click sigue sin saltos, entra el pad y la canción vuelve en el "1" (compu y celular)', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-colchon-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  // (con las voces que trae el programa, como en la app instalada)
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false, dirVocesDeFabrica: path.resolve(__dirname, '../../recursos/voces-es') })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  // el pad de Re ya hecho (la primera vez la compu tarda un segundo en sintetizarlo)
  assert.equal((await fetch(`${base}/pad/2.wav`)).status, 200)

  // la banda: un tono agudo (3 kHz) a la derecha, facil de separar del pad (grave); el click a 120 BPM desde 0,5 s
  const SEG = 30
  const banda = new Float32Array(SEG * SR)
  for (let i = 0; i < banda.length; i++) banda[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR)
  const z = new AdmZip()
  z.addFile('Banda.wav', wav16(banda, SR))
  z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
  z.addFile('marcas.txt', Buffer.from('0:08.5 Coro\n0:16.5 Puente\n'))
  const zip = path.join(tmp, 'Adoración - D.zip')
  z.writeZip(zip)

  type Cmd = { accion: string; positionMs: number; executeAtServerTime: number }
  const cmds: Cmd[] = []
  const emitir = server.io.emit.bind(server.io)
  server.io.emit = ((ev: string, ...args: unknown[]) => {
    if (ev === 'playback:scheduled') cmds.push(args[0] as Cmd)
    return emitir(ev, ...args)
  }) as typeof server.io.emit

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    localStorage.setItem('multitrack:sonido-compu', 'true')
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(`${base}/?debug`)
  await compu.evaluate((zz) => ((globalThis as unknown as { __zip: string }).__zip = zz), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  const p = server.state.getActiveTab()!.proyecto
  p.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 15 }, (_, k) => 500 + 2000 * k), clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }
  p.cuenta = 0
  server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))
  // las voces que avisan el salto ya vienen con el programa, en español (sin importar nada): en ⚙ Ajustes
  await vistaCompu(compu, 'Secciones')
  assert.equal(await compu.locator('.secciones-herramientas .voz-salto').count(), 0, 'la barra de secciones queda limpia')
  await compu.getByRole('button', { name: 'Ajustes', exact: true }).click()
  await compu.locator('.voz-salto', { hasText: 'voces del programa en español' }).waitFor()
  assert.equal(await compu.getByRole('button', { name: 'Quitar este pack de voces' }).count(), 0)
  // y el pad del colchon: el de la app, y se pueden importar los propios
  await compu.locator('.voz-salto', { hasText: 'Pad del colchón: el de AirTracks' }).getByRole('button', { name: 'Importar mis pads…' }).waitFor()
  await captura(compu, 'ajustes-voz-y-pads')
  await compu.keyboard.press('Escape')
  await compu.locator('.modal').waitFor({ state: 'detached' })

  const ctxCel = await contextoCelular(browser, devices['Pixel 7'])
  ctxCel.setDefaultTimeout(15000)
  const cel = await ctxCel.newPage()
  cel.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
  await cel.goto(`${base}/?debug`)
  await cel.getByRole('button', { name: /Tocá para empezar/ }).click()
  const dispositivos = [
    { nombre: 'compu', p: compu },
    { nombre: 'celular', p: cel }
  ]
  for (const { p: pg } of dispositivos) {
    await pg.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
    // lo que sale, por bloque: el pico del oido izquierdo (el click), y del derecho lo agudo (la banda) y lo grave (el pad)
    await pg.evaluate(async () => {
      const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode } } }; __muestras: number[][] }
      const engine = g.__mt.engineRef.current
      const codigo = `registerProcessor('grabador-colchon', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = []; this.r1 = 0; this.r2 = 0; this.a = 0; this.b = 0; this.k = 1 - Math.exp(-2 * Math.PI * 250 / sampleRate) }
        process(inputs) {
          const [L, R] = inputs[0] || []
          if (L && R) {
            let pl = 0, agudo = 0, grave = 0
            for (let i = 0; i < L.length; i++) {
              pl = Math.max(pl, Math.abs(L[i]))
              const d2 = R[i] - 2 * this.r1 + this.r2
              this.r2 = this.r1; this.r1 = R[i]
              agudo = Math.max(agudo, Math.abs(d2))
              this.a += this.k * (R[i] - this.a); this.b += this.k * (this.a - this.b)
              grave = Math.max(grave, Math.abs(this.b))
            }
            this.lote.push([currentTime, pl, agudo, grave])
          }
          if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador-colchon', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      nodo.port.onmessage = (e: MessageEvent<number[][]>) => {
        const ts = engine.ctx.getOutputTimestamp()
        const base = performance.timeOrigin + (ts.performanceTime ?? 0) - (ts.contextTime ?? 0) * 1000
        for (const [tc, l, agudo, grave] of e.data) g.__muestras.push([base + tc * 1000, l, agudo, grave])
      }
      engine.masterGain.connect(nodo)
    })
  }
  await esperar(3000)

  // play; a los 3 s, "Colchón" desde el celular (botón de abajo); a los 4 s de colchon, el celular toca el Puente
  await compu.getByRole('button', { name: 'Reproducir' }).click()
  await esperar(400)
  const t0 = cmds.filter((c) => c.accion === 'play').pop()!.executeAtServerTime
  await esperar(t0 + 3000 - Date.now())
  // los compases que faltan para que termine la seccion (Inicio: compases desde 0,5 s hasta el Coro a los 8,5 s)
  assert.match((await cel.locator('.m-faltan').textContent())!, /^[23]compases$/)
  assert.match((await compu.locator('.faltan-compases').textContent())!, /^faltan [23]$/)
  const boton = compu.getByRole('button', { name: 'Colchón' })
  const botonCelular = cel.getByRole('button', { name: 'Colchón' })
  await botonCelular.click()
  await compu.waitForFunction(() => document.querySelector('.banner-colchon') !== null)
  // (el celular recibe el estado a la par de la compu, pero lo dibuja a su ritmo)
  await cel.waitForFunction(() => document.querySelector('button[aria-label="Colchón"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 3000 })
  const c = server.state.colchon!
  assert.ok(c && c.desdeCancion, 'hay colchón')
  assert.equal(c.pad, 'D', 'el pad, en el tono de la canción')
  assert.equal((c.inicio - t0 - 500) % 2000, 0, 'empieza en el "1" de un compás')
  assert.match((await compu.locator('.banner-colchon').textContent())!, /Colchón · D · 120 BPM/)
  assert.equal(await boton.getAttribute('aria-pressed'), 'true')
  await cel.locator('.m-colchon').waitFor()
  assert.match((await cel.locator('.m-colchon').textContent())!, /La banda (paró|se va al terminar la sección).*Tocá una sección para volver/)
  assert.ok(c.padDesde! < c.inicio - 1000, 'el pad entra antes, por debajo de la banda')
  await captura(compu, 'colchon-cancion-compu')
  await captura(cel, 'colchon-cancion-celular')
  // Mi mezcla del celular: el pad aparece para ajustarlo
  await vistaCelular(cel, 'Mi mezcla')
  await cel.getByRole('button', { name: 'Mute de Pad en este celular' }).waitFor()
  await captura(cel, 'colchon-mi-mezcla-celular')
  await vistaCelular(cel, 'Canción')

  await esperar(c.inicio + 6000 - Date.now())
  await cel.locator('.m-vista-cancion .m-marcador', { hasText: 'Puente' }).click()
  await esperar(500)
  const vuelta = cmds.filter((x) => x.accion === 'play').pop()!
  assert.equal(vuelta.positionMs, 16500, 'vuelve en el Puente')
  const hasta = vuelta.executeAtServerTime
  assert.equal((hasta - c.inicio) % 2000, 0, 'en el "1" de un compás del colchón')
  assert.equal(server.state.colchon?.hasta, hasta)
  await esperar(hasta + 3000 - Date.now())
  await compu.getByRole('button', { name: 'Stop' }).click()
  await cel.locator('.m-colchon').waitFor({ state: 'detached' })

  const pausa = cmds.find((x) => x.accion === 'pause' && x.executeAtServerTime > c.inicio)!
  assert.equal(pausa.executeAtServerTime, c.inicio + 2000, 'la canción se pausa al terminar el compás en que se va la banda')

  const resultados: Record<string, Map<number, number>> = {}
  for (const { nombre, p: pg } of dispositivos) {
    const m = (await pg.evaluate(() => (globalThis as unknown as { __muestras: number[][] }).__muestras)) as number[][]
    const tramo = (a: number, b: number): number[][] => m.filter(([w]) => w >= a && w < b)
    const max = (a: number, b: number, i: number): number => Math.max(0, ...tramo(a, b).map((x) => x[i]))
    // el click: cada golpe (cancion, colchon y cancion otra vez, todos en la misma grilla) a tiempo, y nada en el
    // medio. El audio falso de Chromium, con la maquina cargada, a veces se corta un instante: se tolera un
    // golpe raro por dispositivo (un error de verdad corre o saca muchos)
    const ataques = new Map<number, number>()
    const raros: string[] = []
    for (let tg = t0 + 1000; tg < hasta + 2500; tg += 500) {
      const cerca = tramo(tg - 60, tg + 60)
      const pico = Math.max(0, ...cerca.map((x) => x[1]))
      if (!(pico > 0.1)) {
        raros.push(`falta el golpe de ${tg - t0} ms (pico ${pico.toFixed(3)})`)
        continue
      }
      const ataque = cerca.find((x) => x[1] >= pico * 0.5)![0] - tg
      if (Math.abs(ataque) >= 20) raros.push(`golpe de ${tg - t0} ms corrido ${ataque.toFixed(1)} ms`)
      else ataques.set(tg, ataque)
      const entre = max(tg + 70, tg + 430, 1)
      if (entre >= 0.25 * pico) raros.push(`golpe de más después de ${tg - t0} ms (${entre.toFixed(3)} vs ${pico.toFixed(3)})`)
    }
    assert.ok(raros.length <= 1, `${nombre}: ${raros.join('; ')} (colchón ${c.inicio - t0}..${hasta - t0})`)
    resultados[nombre] = ataques
    // la banda: suena hasta el colchon, se va en ese compas, no suena en el colchon y vuelve en el "1"
    const bandaAntes = max(t0 + 500, c.inicio - 50, 2)
    assert.ok(bandaAntes > 0.02, `${nombre}: la banda antes (${bandaAntes})`)
    assert.ok(max(c.inicio + 2100, hasta - 50, 2) < bandaAntes * 0.05, `${nombre}: la banda sonó en el colchón (${max(c.inicio + 2100, hasta - 50, 2)})`)
    assert.ok(max(c.inicio + 900, c.inicio + 1100, 2) < bandaAntes * 0.75, `${nombre}: la banda no se estaba yendo a mitad del compás`)
    assert.ok(max(hasta + 100, hasta + 2000, 2) > bandaAntes * 0.8, `${nombre}: la banda no volvió`)
    // el pad: no antes de entrar; entra por debajo de la banda y cuando la banda se va ya esta entero
    // (no se oye que arranca); en el colchon si (grave, a la derecha); despues de volver se va enseguida
    const padAntes = max(t0 + 500, c.padDesde! - 50, 3)
    const pad = max(c.inicio + 4000, hasta - 50, 3)
    assert.ok(pad > 0.05 && pad > 10 * padAntes, `${nombre}: el pad (${pad.toFixed(3)}; antes ${padAntes.toFixed(3)})`)
    // (el pad "ondula" despacio, por el coro: se mira un compas entero)
    const padAlIrseLaBanda = max(c.inicio - 2000, c.inicio, 3)
    assert.ok(padAlIrseLaBanda > pad * 0.25, `${nombre}: el pad ya está sonando cuando se va la banda (${padAlIrseLaBanda.toFixed(3)} de ${pad.toFixed(3)})`)
    assert.ok(max(hasta + 1800, hasta + 2500, 3) < pad * 0.1, `${nombre}: el pad no se fue al volver`)
  }
  const verGolpes = (r: Record<string, Map<number, number>>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v.values()].map((x) => Math.round(x * 10) / 10)])))
  if (process.env.E2E_VERBOSE) console.log('colchón, golpes (ms contra la hora pedida):', verGolpes(resultados))
  // compu y celular juntos. El audio falso de Chromium a veces se corre ~10 ms un par de segundos (en cada
  // dispositivo por su lado, como un corte): se tolera un tramo asi, no un desfase que se mantenga
  const juntos = [...resultados.compu]
    .filter(([tg]) => resultados.celular.has(tg))
    .map(([tg, a]) => Math.abs(a - resultados.celular.get(tg)!))
    .sort((a, b) => a - b)
  const detalle = verGolpes(resultados)
  assert.ok(juntos[Math.floor(juntos.length * 0.8)] < 6, `compu y celular a destiempo: ${juntos[Math.floor(juntos.length * 0.8)].toFixed(1)} ms (${detalle})`)
  assert.ok(juntos[juntos.length - 1] < 25, `compu y celular a destiempo en algún golpe: ${juntos[juntos.length - 1].toFixed(1)} ms (${detalle})`)
  assert.deepEqual(errores, [])
})

test('colchón de la lista con audio real: Empezar suena en todos (click a la izquierda, pad a la derecha) y al dar play a la canción acompaña la cuenta y se va', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-colchon-lista-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  assert.equal((await fetch(`${base}/pad/7.wav`)).status, 200) // el pad de Sol, ya hecho

  // la cancion que sigue: solo el click (120 BPM desde 0,5 s)
  const z = new AdmZip()
  z.addFile('Click.wav', wav16(generarClick(120, 4, 20), SR))
  const zip = path.join(tmp, 'Siguiente.zip')
  z.writeZip(zip)
  const sock = (await import('socket.io-client')).io(base, { auth: { origen: 'compu', token: 'e2e' } })
  t.after(() => void sock.close())
  await new Promise<void>((r) => sock.once('connect', () => r()))
  const ack = <T,>(ev: string, payload: unknown): Promise<T> => new Promise((r) => sock.emit(ev, payload, r))
  const colchon = await ack<{ ok: boolean; id: string }>('colchon:crear', { ajustes: { tonalidad: 'G', bpm: 90, compas: 4, click: true } })
  assert.equal(colchon.ok, true)
  await ack('project:load-from-zip', { filePath: zip })
  const cancion = server.state.getActiveTab()!.proyecto
  cancion.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 10 }, (_, k) => 500 + 2000 * k), clickPistaId: cancion.pistas[0].id, acentoClaro: true }
  cancion.cuenta = 1
  const lista = await ack<{ ok: boolean; id: string }>('listas:crear', { nombre: 'Culto', proyectos: [colchon.id, cancion.id] })
  assert.equal((await ack<{ ok: boolean }>('listas:usar', { id: lista.id })).ok, true)

  type Cmd = { accion: string; executeAtServerTime: number; playback: { cuenta?: { golpes: { t: number; n: number }[] } } }
  const cmds: Cmd[] = []
  const emitir = server.io.emit.bind(server.io)
  server.io.emit = ((ev: string, ...args: unknown[]) => {
    if (ev === 'playback:scheduled') cmds.push(args[0] as Cmd)
    return emitir(ev, ...args)
  }) as typeof server.io.emit

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    localStorage.setItem('multitrack:sonido-compu', 'true')
    ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => null, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(`${base}/?debug`)
  const ctxCel = await contextoCelular(browser, devices['Pixel 7'])
  ctxCel.setDefaultTimeout(15000)
  const cel = await ctxCel.newPage()
  cel.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
  await cel.goto(`${base}/?debug`)
  await cel.getByRole('button', { name: /Tocá para empezar/ }).click()

  // arriba, el colchon: en la compu su pantalla (tono, BPM) y en el celular la suya, con el pad y el click en "Mi mezcla"
  await compu.locator('.pantalla-colchon').waitFor()
  assert.match((await compu.locator('.colchon-grande').textContent())!, /G.*90 BPM · 4\/4/)
  await cel.locator('.m-vista-colchon').waitFor()
  await vistaCelular(cel, 'Mi mezcla')
  await cel.getByRole('button', { name: 'Mute de Click en este celular' }).waitFor()
  await cel.getByRole('button', { name: 'Mute de Pad en este celular' }).waitFor()
  await vistaCelular(cel, 'Canción')

  const dispositivos = [
    { nombre: 'compu', p: compu },
    { nombre: 'celular', p: cel }
  ]
  for (const { p: pg } of dispositivos) {
    await pg.waitForFunction(() => !!(globalThis as unknown as { __mt?: { engineRef: { current: unknown } } }).__mt?.engineRef.current)
    await pg.evaluate(async () => {
      const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode } } }; __muestras: number[][] }
      const engine = g.__mt.engineRef.current
      const codigo = `registerProcessor('grabador-colchon-lista', class extends AudioWorkletProcessor {
        constructor() { super(); this.lote = []; this.a = 0; this.b = 0; this.k = 1 - Math.exp(-2 * Math.PI * 250 / sampleRate) }
        process(inputs) {
          const [L, R] = inputs[0] || []
          if (L && R) {
            let pl = 0, pr = 0, grave = 0
            for (let i = 0; i < L.length; i++) {
              pl = Math.max(pl, Math.abs(L[i])); pr = Math.max(pr, Math.abs(R[i]))
              this.a += this.k * (R[i] - this.a); this.b += this.k * (this.a - this.b)
              grave = Math.max(grave, Math.abs(this.b))
            }
            this.lote.push([currentTime, pl, pr, grave])
          }
          if (this.lote.length >= 8) { this.port.postMessage(this.lote); this.lote = [] }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      const nodo = new AudioWorkletNode(engine.ctx, 'grabador-colchon-lista', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
      g.__muestras = []
      nodo.port.onmessage = (e: MessageEvent<number[][]>) => {
        const ts = engine.ctx.getOutputTimestamp()
        const base = performance.timeOrigin + (ts.performanceTime ?? 0) - (ts.contextTime ?? 0) * 1000
        for (const row of e.data) g.__muestras.push([base + row[0] * 1000, row[1], row[2], row[3]])
      }
      engine.masterGain.connect(nodo)
    })
  }
  await esperar(1500)

  await captura(compu, 'colchon-lista-compu-parado')
  await compu.getByRole('button', { name: 'Empezar' }).click()
  await compu.getByRole('button', { name: 'Terminar' }).waitFor()
  const c = server.state.colchon!
  assert.ok(c && !c.desdeCancion && c.pad === 'G')
  await cel.locator('.m-vista-colchon .pulso-colchon').waitFor()
  await esperar(700)
  await captura(compu, 'colchon-lista-compu-sonando')
  await captura(cel, 'colchon-lista-celular-sonando')
  await esperar(c.inicio + 6000 - Date.now())
  // a la canción que sigue (el colchón sigue sonando) y play: 1 compás de cuenta
  await compu.keyboard.press('PageDown')
  await compu.getByRole('button', { name: 'Reproducir' }).waitFor()
  await compu.locator('.banner-colchon').waitFor()
  await captura(compu, 'colchon-lista-compu-otra-cancion')
  await compu.getByRole('button', { name: 'Reproducir' }).click()
  await esperar(500)
  const play = cmds.filter((x) => x.accion === 'play').pop()!
  const golpesCuenta = play.playback.cuenta!.golpes
  const hasta = server.state.colchon!.hasta!
  assert.equal(hasta, golpesCuenta[0].t, 'el click del colchón para donde empieza la cuenta')
  await esperar(play.executeAtServerTime + 3000 - Date.now())
  await compu.getByRole('button', { name: 'Stop' }).click()

  const pulso = 60000 / 90
  for (const { nombre, p: pg } of dispositivos) {
    const m = (await pg.evaluate(() => (globalThis as unknown as { __muestras: number[][] }).__muestras)) as number[][]
    const tramo = (a: number, b: number): number[][] => m.filter(([w]) => w >= a && w < b)
    const max = (a: number, b: number, i: number): number => Math.max(0, ...tramo(a, b).map((x) => x[i]))
    // el click del colchon, a la izquierda y a tiempo (se tolera un golpe raro por un corte del audio falso)
    const raros: string[] = []
    for (let tg = c.inicio + pulso; tg < hasta - 100; tg += pulso) {
      const cerca = tramo(tg - 60, tg + 60)
      const pico = Math.max(0, ...cerca.map((x) => x[1]))
      if (!(pico > 0.05)) {
        raros.push(`falta el golpe del colchón de ${Math.round(tg - c.inicio)} ms (${pico.toFixed(3)})`)
        continue
      }
      const ataque = cerca.find((x) => x[1] >= pico * 0.5)![0] - tg
      if (Math.abs(ataque) >= 20) raros.push(`golpe del colchón de ${Math.round(tg - c.inicio)} ms corrido ${ataque.toFixed(1)} ms`)
    }
    assert.ok(raros.length <= 1, `${nombre}: ${raros.join('; ')}`)
    const pad = max(c.inicio + 3500, hasta - 50, 3)
    assert.ok(pad > 0.05, `${nombre}: el pad (${pad.toFixed(3)})`)
    // desde la cuenta, solo los golpes de la cuenta (otro tempo): los del colchon ya no
    for (let tg = hasta + pulso; tg < play.executeAtServerTime - 60; tg += pulso) {
      if (golpesCuenta.some((g) => Math.abs(g.t - tg) < 120)) continue
      assert.ok(max(tg - 30, tg + 30, 1) < 0.02, `${nombre}: sonó un golpe del colchón durante la cuenta (${Math.round(tg - hasta)} ms)`)
    }
    for (const g of golpesCuenta) assert.ok(max(g.t - 40, g.t + 60, 1) > 0.05, `${nombre}: falta el golpe ${g.n} de la cuenta`)
    // el pad acompaña la cuenta, bajando, y se va al entrar la cancion
    assert.ok(max(hasta + 200, hasta + 600, 3) > pad * 0.4, `${nombre}: el pad se cortó de golpe`)
    assert.ok(max(play.executeAtServerTime + 1700, play.executeAtServerTime + 2500, 3) < pad * 0.1, `${nombre}: el pad no se fue`)
  }
  await cel.locator('.m-colchon').waitFor({ state: 'detached' })
  assert.equal(server.state.colchon, null)
  assert.deepEqual(errores, [])
})

/**
 * Graba lo que sale del motor de un celular (con ?debug) durante `segundos`:
 * las muestras de cada lado. `final`: lo que va al parlante (con el talkback
 * y la musica atenuada); si no, la mezcla antes del atenuador.
 */
async function grabarSalida(pg: Page, segundos: number, final = false): Promise<{ sr: number; L: number[]; R: number[] }> {
  return pg.evaluate(async ([seg, alFinal]) => {
    const g = globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; masterGain: GainNode; salidaFinal: AudioNode } } }; __grabadorCrudo?: boolean }
    const engine = g.__mt.engineRef.current
    const desde: AudioNode = alFinal ? engine.salidaFinal : engine.masterGain
    if (!g.__grabadorCrudo) {
      const codigo = `registerProcessor('grabador-crudo', class extends AudioWorkletProcessor {
        constructor() { super(); this.faltan = 0; this.L = []; this.R = []; this.port.onmessage = (e) => { this.faltan = e.data; this.L = []; this.R = [] } }
        process(inputs) {
          const [L, R] = inputs[0] || []
          if (this.faltan > 0 && L && R) {
            this.L.push(...L); this.R.push(...R); this.faltan -= L.length
            if (this.faltan <= 0) this.port.postMessage({ L: this.L, R: this.R })
          }
          return true
        }
      })`
      await engine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' })))
      g.__grabadorCrudo = true
    }
    const nodo = new AudioWorkletNode(engine.ctx, 'grabador-crudo', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
    desde.connect(nodo)
    const datos = await new Promise<{ L: number[]; R: number[] }>((resolve) => {
      nodo.port.onmessage = (e: MessageEvent<{ L: number[]; R: number[] }>) => resolve(e.data)
      nodo.port.postMessage(Math.round((seg as number) * engine.ctx.sampleRate))
    })
    desde.disconnect(nodo)
    return { sr: engine.ctx.sampleRate, ...datos }
  }, [segundos, final] as const)
}

/**
 * Amplitud (aprox. la mitad de la de un seno) de la frecuencia `f` en `x`
 * (Goertzel). Se mira un poco alrededor (±0,6 %): mientras corrige el sync,
 * el celular toca un 0,4 % mas rapido o mas lento y el seno se corre.
 */
function amplitudEn(x: number[], f: number, sr: number): number {
  let mejor = 0
  for (let k = -6; k <= 6; k++) {
    const c = 2 * Math.cos((2 * Math.PI * f * (1 + k * 0.001)) / sr)
    let s1 = 0
    let s2 = 0
    for (const v of x) {
      const s0 = v + c * s1 - s2
      s2 = s1
      s1 = s0
    }
    mejor = Math.max(mejor, Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length)
  }
  return mejor
}

test('roles: cada celular elige lo suyo; la consola recibe la banda sola y en estéreo (audio real), la maneja el director y se cambia desde la compu', { timeout: 4 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-roles-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  // cada pista en su frecuencia: guia 2500 Hz, bajo 110 Hz, teclas 440 Hz; el click (1000/1600 Hz) a 120 BPM
  const SEG = 40
  const seno = (f: number, a: number): Float32Array => {
    const x = new Float32Array(SEG * SR)
    for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / SR)
    return x
  }
  const z = new AdmZip()
  z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
  z.addFile('Guia.wav', wav16(seno(2500, 0.3), SR))
  z.addFile('Bajo.wav', wav16(seno(110, 0.3), SR))
  z.addFile('Teclas.wav', wav16(seno(440, 0.2), SR))
  z.addFile('marcas.txt', Buffer.from('0:04.5 Verso\n0:12.5 Coro\n0:20.5 Final\n'))
  const zip = path.join(tmp, 'Roles.zip')
  z.writeZip(zip)

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  await compu.evaluate((zz) => ((globalThis as unknown as { __zip: string }).__zip = zz), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  const p = server.state.getActiveTab()!.proyecto
  p.tempo = { bpm: 120, compas: 4, compasesMs: Array.from({ length: 19 }, (_, k) => 500 + 2000 * k), clickPistaId: p.pistas.find((x) => x.nombre === 'Click')!.id, acentoClaro: true }
  server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))

  /** Un celular recien instalado: pregunta "¿Que haces en la banda?" y el toque elige y arranca. */
  const mezclasPedidas = new Map<Page, string[]>()
  async function celularNuevo(boton: RegExp): Promise<Page> {
    const ctx = await contextoCelular(browser, devices['Pixel 7'], null)
    ctx.setDefaultTimeout(15000)
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
    const pedidas: string[] = []
    mezclasPedidas.set(pg, pedidas)
    pg.on('request', (r) => r.url().includes('/mezcla/') && pedidas.push(r.url()))
    await pg.goto(`${base}/?debug`)
    await pg.getByRole('heading', { name: '¿Qué hacés en la banda?' }).waitFor()
    assert.equal(await pg.getByRole('button', { name: /Tocá para empezar/ }).count(), 0, 'primero se elige el rol')
    await pg.getByRole('button', { name: boton }).click()
    return pg
  }
  const director = await celularNuevo(/Dirijo/)
  const consola = await celularNuevo(/Consola/)
  const musico = await celularNuevo(/Toco/)
  const multimedia = await celularNuevo(/Pantallas/)
  const fila = (pg: Page): Promise<DispositivoInfo | undefined> =>
    pg.evaluate(() => localStorage.getItem('multitrack:device-id')).then((id) => server.devices.listar().find((d) => d.id === `celular:${JSON.parse(id!)}`))
  const rolDe = async (pg: Page): Promise<string | null | undefined> => (await fila(pg))?.rol

  await t.test('el toque en el rol ya arranca: cada uno ve lo suyo y la compu sabe quién es quién', async () => {
    await director.locator('.m-barra .m-play').waitFor()
    await consola.getByRole('heading', { name: 'A la consola' }).waitFor()
    await musico.locator('.m-vista-cancion').waitFor()
    await multimedia.locator('.mm-ahora').waitFor()
    for (const pg of [director, consola, musico]) await pg.waitForFunction(() => !document.querySelector('.activar') && !document.querySelector('.roles'))
    assert.deepEqual([await rolDe(director), await rolDe(consola), await rolDe(musico), await rolDe(multimedia)], ['director', 'sonido', 'musico', 'multimedia'])
    assert.equal((await fila(multimedia))!.audio, false, 'multimedia no baja audio')
    // el musico mira las secciones (no las toca) y no tiene el transporte
    assert.ok(await musico.locator('.m-vista-cancion .m-marcador').first().isDisabled())
    assert.equal(await musico.locator('.m-barra').count(), 0)
    // la compu: el chip de la consola dice cual es
    const etiqueta = (await fila(consola))!.etiqueta
    await compu.waitForFunction((e) => document.querySelector('.chip-consola')?.textContent?.includes(e), etiqueta)
  })

  await t.test('solo el director maneja la canción (el servidor rechaza al músico)', async () => {
    const rechazo = musico.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const s = (globalThis as unknown as { __mt: { socketRef: { current: { socket: { once(ev: string, cb: (p: { mensaje: string }) => void): void; emit(ev: string, p: unknown): void } } } } }).__mt.socketRef.current.socket
          s.once('accion:rechazada', (pl) => resolve(pl.mensaje))
          s.emit('transport:play', {})
        })
    )
    assert.match(await rechazo, /director/)
    assert.equal(server.state.getActiveTab()!.playback.estado, 'stopped')
    await director.getByRole('button', { name: 'Reproducir' }).click()
    await esperar(5000)
    assert.equal(server.state.getActiveTab()!.playback.estado, 'playing')
  })

  const medir = async (pg: Page): Promise<Record<string, [number, number]>> => {
    // lo que queda por sonar ya es la mezcla de ahora (despues de un cambio)
    await pg.waitForFunction(
      () => {
        const e = (globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; claveMezcla: string; claveDeseada: string; tramos: { inicioCtx: number; duracionCtx: number; clave: string }[] } } } }).__mt.engineRef.current
        const porSonar = e.tramos.filter((tr) => tr.inicioCtx + tr.duracionCtx > e.ctx.currentTime + 0.05)
        return e.claveMezcla === e.claveDeseada && porSonar.length > 0 && porSonar.every((tr) => tr.clave.startsWith(e.claveMezcla))
      },
      undefined,
      { timeout: 8000, polling: 50 }
    )
    const { sr, L, R } = await grabarSalida(pg, 1.5)
    const par = (f: number): [number, number] => [amplitudEn(L, f, sr), amplitudEn(R, f, sr)]
    return { guia: par(2500), bajo: par(110), teclas: par(440), click: par(1000), acento: par(1600) }
  }
  const presente = 0.02
  const ausente = 0.002

  await t.test('la consola: la banda sola, al centro (sin click ni guía); el músico: click y guía a la izquierda, banda a la derecha', async () => {
    const c = await medir(consola)
    t.diagnostic(`consola: ${JSON.stringify(c)}`)
    for (const lado of [0, 1]) {
      assert.ok(c.guia[lado] < ausente, `la guía no va a la consola (${c.guia[lado]})`)
      assert.ok(c.click[lado] < ausente && c.acento[lado] < ausente, `el click no va a la consola (${c.click[lado]}, ${c.acento[lado]})`)
      assert.ok(c.bajo[lado] > presente && c.teclas[lado] > presente, `la banda suena en los dos lados (${c.bajo}, ${c.teclas})`)
    }
    assert.ok(Math.abs(c.bajo[0] - c.bajo[1]) < 0.1 * c.bajo[0], `la banda al centro (${c.bajo})`)
    const m = await medir(musico)
    t.diagnostic(`músico: ${JSON.stringify(m)}`)
    assert.ok(m.guia[0] > presente && m.guia[1] < ausente, `guía a la izquierda (${m.guia})`)
    assert.ok(m.bajo[1] > presente && m.bajo[0] < ausente, `banda a la derecha (${m.bajo})`)
    // y en ningun momento la consola pidio el click o la guia, ni la voz de los saltos
    const idsNoBanda = p.pistas.filter((x) => x.nombre === 'Click' || x.nombre === 'Guia').map((x) => x.id)
    for (const u of mezclasPedidas.get(consola)!) {
      const mm = new URL(u).searchParams.get('m') ?? ''
      assert.ok(!idsNoBanda.some((id) => mm.includes(id)), `la consola pidió click o guía: ${u}`)
      assert.ok(!new URL(u).searchParams.has('a'), 'la consola no lleva la voz del salto')
    }
    assert.equal(mezclasPedidas.get(multimedia)!.length, 0, 'multimedia no bajó audio')
  })

  await t.test('para ensayar: "Guía en los parlantes" la suma (al centro) y se apaga igual de fácil', async () => {
    await consola.getByRole('switch', { name: 'Guía en los parlantes' }).click()
    await esperar(2500)
    const c = await medir(consola)
    assert.ok(c.guia[0] > presente && c.guia[1] > presente && Math.abs(c.guia[0] - c.guia[1]) < 0.1 * c.guia[0], `la guía al centro (${c.guia})`)
    assert.ok(c.click[0] < ausente, 'el click sigue afuera')
    assert.deepEqual((await fila(consola))!.salida, { click: false, guia: true }, 'la compu lo ve')
    await compu.waitForFunction(() => document.querySelector('.chip-consola')?.textContent?.includes('guía'))
    await consola.getByRole('switch', { name: 'Guía en los parlantes' }).click()
    await esperar(2500)
    assert.ok((await medir(consola)).guia[0] < ausente, 'la guía se fue')
  })

  await t.test('bloqueada, la pantalla de la consola no cambia con un toque (se desbloquea manteniendo apretado)', async () => {
    await consola.getByRole('button', { name: /Bloquear la pantalla/ }).click()
    assert.ok(await consola.getByRole('switch', { name: 'Guía en los parlantes' }).isDisabled())
    assert.ok(await consola.getByRole('button', { name: /^Rol: Sonido/ }).isDisabled())
    const boton = consola.getByRole('button', { name: 'Mantené apretado para desbloquear' })
    await boton.click() // un toque: nada
    assert.ok(await consola.getByRole('switch', { name: 'Guía en los parlantes' }).isDisabled())
    const caja = (await boton.boundingBox())!
    await consola.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2)
    await consola.mouse.down()
    await esperar(1500)
    await consola.mouse.up()
    assert.ok(await consola.getByRole('switch', { name: 'Guía en los parlantes' }).isEnabled())
  })

  await t.test('la compu pasa la consola a otro celular en un toque: el nuevo manda la banda sola y el anterior vuelve a tener click y guía', async () => {
    await compu.locator('.chip-consola').click()
    const etiquetaMusico = (await fila(musico))!.etiqueta
    const guiaId = p.pistas.find((x) => x.nombre === 'Guia')!.id
    t.diagnostic(
      `descargas solas del anterior (ms): ${JSON.stringify(await consola.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { diag: { solos: number[] } } } } }).__mt.engineRef.current.diag.solos.map(Math.round)))}`
    )
    const t0 = Date.now()
    await compu.locator('.lista-fila', { hasText: etiquetaMusico }).getByRole('button', { name: 'Usar para la consola' }).click()
    // el anterior: cuanto tarda en sonar la mezcla nueva (con la guia): lo que queda por sonar ya es la nueva
    await consola.waitForFunction(
      (id) => {
        const e = (globalThis as unknown as { __mt: { engineRef: { current: { ctx: AudioContext; claveMezcla: string; tramos: { inicioCtx: number; duracionCtx: number; clave: string }[] } } } }).__mt.engineRef.current
        const ahora = e.ctx.currentTime
        const porSonar = e.tramos.filter((tr) => tr.inicioCtx + tr.duracionCtx > ahora + 0.05)
        return e.claveMezcla.includes(id) && porSonar.length > 0 && porSonar.every((tr) => tr.clave.startsWith(e.claveMezcla))
      },
      guiaId,
      { timeout: 8000, polling: 20 }
    )
    t.diagnostic(`al anterior le suena la mezcla con la guía a los ${Date.now() - t0} ms`)
    await musico.getByRole('heading', { name: 'A la consola' }).waitFor()
    await consola.locator('.m-vista-cancion').waitFor()
    assert.deepEqual([await rolDe(musico), await rolDe(consola)], ['sonido', 'musico'])
    await esperar(2500)
    const nueva = await medir(musico)
    assert.ok(nueva.guia[0] < ausente && nueva.click[0] < ausente && nueva.bajo[0] > presente, `la consola nueva: banda sola (${JSON.stringify(nueva)})`)
    const anterior = await medir(consola)
    t.diagnostic(`anterior: ${JSON.stringify(anterior)}`)
    if (anterior.guia[0] <= presente) {
      const d = await consola.evaluate(() => {
        const e = (globalThis as unknown as { __mt: { engineRef: { current: { diagnostico(): { clave: string; clavesProgramadas: string[] } } } } }).__mt.engineRef.current.diagnostico()
        return { clave: e.clave, programadas: e.clavesProgramadas }
      })
      t.diagnostic(`anterior: ${JSON.stringify(anterior)} · ${JSON.stringify(d)} · pidio ${mezclasPedidas.get(consola)!.slice(-3).join(' | ')}`)
    }
    assert.ok(anterior.guia[0] > presente, `el anterior vuelve a escuchar la guía (${anterior.guia})`)
    await compu.keyboard.press('Escape')
  })

  await t.test('la compu recuerda los roles: al reconectar (o recargar) cada uno sigue siendo lo que era', async () => {
    const guardado = JSON.parse(fs.readFileSync(path.join(tmp, 'app', 'dispositivos.json'), 'utf-8')) as Record<string, { rol: string }>
    assert.ok(Object.values(guardado).some((r) => r.rol === 'sonido'))
    // el celular de la consola recarga: sigue en la consola, sin preguntar
    await musico.reload()
    await musico.getByRole('button', { name: /Tocá para empezar/ }).click()
    await musico.getByRole('heading', { name: 'A la consola' }).waitFor()
    assert.equal(await rolDe(musico), 'sonido')
  })

  await t.test('multimedia: lo que sigue y en cuántos segundos', async () => {
    await multimedia.locator('.mm-sigue .mm-cuenta').waitFor()
    assert.match((await multimedia.locator('.mm-sigue .mm-cuenta').textContent()) ?? '', /en \d+ s|ya/)
    assert.equal(mezclasPedidas.get(multimedia)!.length, 0)
  })

  await t.test('desde la compu: ajuste fino de la consola sin tocarla, y "Probar el sync" (un click en todos a la vez)', async () => {
    // la consola es ahora el celular que era del musico
    await compu.locator('.chip-consola').click()
    const panel = compu.locator('.consola-panel')
    await panel.getByRole('button', { name: 'Sumar 5 ms' }).click()
    await panel.getByRole('button', { name: 'Sumar 5 ms' }).click()
    await musico.waitForFunction(() => localStorage.getItem('multitrack:ajuste-fino-ms') === '10')
    await compu.waitForFunction(() => document.querySelector('.consola-ajuste b')?.textContent === '+10 ms')
    for (let i = 0; i < 30 && (await fila(musico))!.ajusteMs !== 10; i++) await esperar(100)
    assert.equal((await fila(musico))!.ajusteMs, 10, 'la compu sabe el ajuste del celular')
    await panel.getByRole('button', { name: /^0$/ }).click()
    await musico.waitForFunction(() => localStorage.getItem('multitrack:ajuste-fino-ms') === '0')
    // sonando no se puede: hay que parar
    await compu.getByRole('button', { name: 'Probar el sync' }).click()
    await compu.getByText('Pará la música para probar el sync').waitFor()
    await director.getByRole('button', { name: 'Pausa' }).click()
    await esperar(1500)
    await compu.getByRole('button', { name: 'Probar el sync' }).click()
    await compu.getByText('Sonando el click en todos…').waitFor()
    await esperar(1500)
    // el click de la prueba (1760 Hz el "1", 1320 Hz los demas) suena en todos, tambien en la consola
    for (const pg of [musico, consola, director]) {
      const { sr, L, R } = await grabarSalida(pg, 2)
      const golpe = Math.max(amplitudEn(L, 1320, sr), amplitudEn(R, 1320, sr), amplitudEn(L, 1760, sr), amplitudEn(R, 1760, sr))
      assert.ok(golpe > 0.002, `suena el click de la prueba (${golpe})`)
    }
    await compu.keyboard.press('Escape')
    assert.deepEqual(errores, [])
  })
})

test('talkback: la compu habla y la banda la escucha en los oídos (la consola no), con la música más baja; cada celular mide la demora', { timeout: 3 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-talkback-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  // el "microfono" de la compu: un tono de 1 kHz a pedazos (200 ms si, 300 ms no), como una voz
  const srVoz = 48000
  const voz = new Float32Array(10 * srVoz)
  for (let i = 0; i < voz.length; i++) voz[i] = (i / srVoz) % 0.5 < 0.2 ? 0.5 * Math.sin((2 * Math.PI * 1000 * i) / srVoz) : 0
  const microfono = path.join(tmp, 'microfono.wav')
  fs.writeFileSync(microfono, wav16(voz, srVoz))
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${microfono}`]
  })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const SEG = 40
  const bajo = new Float32Array(SEG * SR)
  for (let i = 0; i < bajo.length; i++) bajo[i] = 0.3 * Math.sin((2 * Math.PI * 110 * i) / SR)
  const z = new AdmZip()
  z.addFile('Bajo.wav', wav16(bajo, SR))
  z.addFile('Click.wav', wav16(generarClick(120, 4, SEG), SR))
  const zip = path.join(tmp, 'Talkback.zip')
  z.writeZip(zip)

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  await compu.evaluate((zz) => ((globalThis as unknown as { __zip: string }).__zip = zz), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })

  const celular = async (rol: string): Promise<Page> => {
    const ctx = await contextoCelular(browser, devices['Pixel 7'], rol)
    ctx.setDefaultTimeout(15000)
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
    await pg.goto(`${base}/?debug`)
    await pg.getByRole('button', { name: /Tocá para empezar/ }).click()
    return pg
  }
  const musico = await celular('musico')
  const consola = await celular('sonido')
  await compu.keyboard.press('Space')
  await esperar(5000)
  const medir = async (pg: Page): Promise<{ voz: number; bajo: number }> => {
    const { sr, L, R } = await grabarSalida(pg, 1.5, true)
    return { voz: Math.max(amplitudEn(L, 1000, sr), amplitudEn(R, 1000, sr)), bajo: Math.max(amplitudEn(L, 110, sr), amplitudEn(R, 110, sr)) }
  }
  // (el click de la cancion tambien tiene golpes en 1 kHz: de fondo queda un poquito)
  const antes = await medir(musico)
  t.diagnostic(`antes de hablar: ${JSON.stringify(antes)}`)
  assert.ok(antes.voz < 0.004, 'sin hablar no suena nada')

  await t.test('mantener la T: el músico escucha la voz y la música le baja; la consola no la recibe', async () => {
    await compu.locator('body').click({ position: { x: 5, y: 5 } })
    await compu.keyboard.down('t')
    await compu.locator('.talkback.hablando').waitFor()
    await musico.locator('.m-talkback').waitFor({ timeout: 10000 })
    await esperar(1500)
    const hablando = await medir(musico)
    const enConsola = await medir(consola)
    await compu.keyboard.up('t')
    t.diagnostic(`hablando: músico ${JSON.stringify(hablando)} · consola ${JSON.stringify(enConsola)}`)
    // el tono suena 200 de cada 500 ms: su amplitud promedio es ~0,4 de la del tono
    assert.ok(hablando.voz > 0.02, `el músico escucha la voz (${hablando.voz})`)
    assert.ok(hablando.bajo < antes.bajo * 0.65 && hablando.bajo > antes.bajo * 0.35, `la música baja 6 dB mientras se habla (${hablando.bajo} de ${antes.bajo})`)
    assert.ok(enConsola.voz < 0.002, `la consola no recibe el talkback (${enConsola.voz})`)
    await compu.locator('.talkback.hablando').waitFor({ state: 'detached' })
    await esperar(2500)
    const despues = await medir(musico)
    assert.ok(despues.voz < hablando.voz / 5 && despues.bajo > antes.bajo * 0.9, `al soltar: sin voz y la música vuelve (${JSON.stringify(despues)})`)
  })

  await t.test('cada celular mide cuánto tarda (y la compu lo muestra)', async () => {
    const etiqueta = await musico.evaluate(() => localStorage.getItem('multitrack:device-id')).then((id) => `celular:${JSON.parse(id!)}`)
    // (grabar el audio en la prueba traba al celular medio segundo y la espera sube: hablando un rato
    // sin grabar se ve como vuelve a lo que de verdad hace falta)
    await compu.keyboard.down('t')
    await esperar(7000)
    await compu.keyboard.up('t')
    await esperar(2500)
    const tb = server.devices.listar().find((d) => d.id === etiqueta)!.diag?.talkback
    t.diagnostic(`talkback medido por el celular: ${JSON.stringify(tb)}`)
    t.diagnostic(
      `demoras: ${JSON.stringify(await musico.evaluate(() => (globalThis as unknown as { __mt: { engineRef: { current: { esperaTalkback: { demoras: number[] } } } } }).__mt.engineRef.current.esperaTalkback.demoras.map(Math.round)))}`
    )
    assert.ok(tb && tb.redMs !== null && tb.redMs < 150, `llega rápido por la red de prueba (${JSON.stringify(tb)})`)
    assert.ok(tb!.objetivoMs >= 80 && tb!.objetivoMs <= 200, `se escucha a los ${tb!.objetivoMs} ms`)
    await compu.locator('.talkback-ajustes').click()
    await compu.getByText(/llega en \d+ ms por el WiFi · se escucha a los \d+ ms/).waitFor()
    await compu.getByText('Consola: no lo recibe').waitFor()
    await compu.keyboard.press('Escape')
    assert.deepEqual(errores, [])
  })
})

test('terminar con fundido: al terminar la sección la canción se apaga en todos y para; a mitad del fundido, "Seguir" la trae de vuelta (audio real)', { timeout: 3 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-fundido-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e', analisisAutomatico: false })
  const port = await server.start(0)
  const base = `http://localhost:${port}`
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  t.after(async () => {
    await browser.close()
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  // un seno parejo de 440 Hz: se ve bien como baja
  const SEG = 40
  const teclas = new Float32Array(SEG * SR)
  for (let i = 0; i < teclas.length; i++) teclas[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR)
  const z = new AdmZip()
  z.addFile('Teclas.wav', wav16(teclas, SR))
  z.addFile('marcas.txt', Buffer.from('0:06 Verso\n0:12 Coro\n0:18 Final\n'))
  const zip = path.join(tmp, 'Fundido.zip')
  z.writeZip(zip)

  const ctxCompu = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ctxCompu.setDefaultTimeout(15000)
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = { isElectron: true, compuToken: 'e2e', pickZipFile: async () => g.__zip, getConnectionInfo: async () => ({ url: '', ip: null, port: 0 }) }
  })
  const compu = await ctxCompu.newPage()
  const errores: string[] = []
  compu.on('pageerror', (e) => errores.push(e.message))
  await compu.goto(base)
  await compu.evaluate((zz) => ((globalThis as unknown as { __zip: string }).__zip = zz), zip)
  await compu.getByRole('button', { name: /Importar o abrir canción/ }).click()
  await compu.getByRole('button', { name: /Importar \.zip/ }).click()
  await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })

  const celular = async (rol: string): Promise<Page> => {
    const ctx = await contextoCelular(browser, devices['Pixel 7'], rol)
    ctx.setDefaultTimeout(15000)
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => errores.push(`celular: ${e.message}`))
    await pg.goto(`${base}/?debug`)
    await pg.getByRole('button', { name: /Tocá para empezar/ }).click()
    return pg
  }
  const director = await celular('director')
  const musico = await celular('musico')
  const posicion = (): number => posicionActualMs(server.state.getActiveTab()!.playback, Date.now())
  const esperarPosicion = async (ms: number): Promise<void> => {
    while (posicion() < ms) await esperar(20)
  }
  /** La amplitud del seno cada 250 ms (lo que sale del motor del celular). */
  const envolvente = async (pg: Page, segundos: number): Promise<number[]> => {
    const { sr, L, R } = await grabarSalida(pg, segundos)
    const n = Math.round(sr / 4)
    const v: number[] = []
    for (let i = 0; i + n <= L.length; i += n) v.push(Math.max(amplitudEn(L.slice(i, i + n), 440, sr), amplitudEn(R.slice(i, i + n), 440, sr)))
    return v
  }

  await t.test('el director lo tiene a mano (la última tarjeta) y "cómo salta" pasó a ⚙: la pantalla queda limpia', async () => {
    await director.locator('.m-vista-cancion').waitFor()
    assert.equal(await director.locator('.m-vista-cancion .m-modo-salto').count(), 0)
    assert.ok(await director.getByRole('button', { name: 'Terminar la canción con fundido' }).isDisabled(), 'parado no hay nada que terminar')
    assert.equal(await musico.getByRole('button', { name: 'Terminar la canción con fundido' }).count(), 0, 'el músico no lo tiene')
    await director.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await director.getByRole('radio', { name: 'Al terminar' }).waitFor()
    assert.equal(await director.getByRole('radio', { name: 'Al terminar' }).getAttribute('aria-checked'), 'true')
    await captura(director, 'celular-ajustes')
    await director.getByRole('button', { name: 'Cerrar' }).click()
  })

  await t.test('Terminar: queda pendiente hasta el final de la sección (en todos se ve), ahí se apaga de a poco y para', async () => {
    await director.locator('.m-barra .m-play').click()
    await esperarPosicion(1500)
    await director.getByRole('button', { name: 'Terminar la canción con fundido' }).click()
    await director.locator('.m-marcador.terminar.pendiente').waitFor()
    await director.locator('.m-terminando', { hasText: /Se apaga\s*en \d+ s/ }).waitFor()
    await musico.locator('.m-terminando', { hasText: 'Se apaga' }).waitFor()
    assert.equal(await musico.locator('.m-terminando button').count(), 0, 'el músico lo ve, pero no lo maneja')
    await compu.locator('.salto-pendiente.terminando', { hasText: 'Se apaga' }).waitFor()
    await compu.locator('.tbtn-terminar.activo').waitFor()
    await captura(director, 'celular-terminar-pendiente')
    await captura(compu, 'compu-terminar-pendiente')
    // de 3,5 s a 11,5 s: suena parejo, al terminar la seccion (6 s) baja en 4 s y despues silencio (paro)
    await esperarPosicion(3500)
    const env = await envolvente(musico, 8)
    t.diagnostic(`amplitud cada 250 ms: ${env.map((x) => x.toFixed(3)).join(' ')}`)
    const a0 = Math.max(...env.slice(0, 4))
    assert.ok(a0 > 0.03, `suena antes del fundido (${a0})`)
    const i90 = env.findIndex((x) => x < a0 * 0.9)
    const i10 = env.findIndex((x) => x < a0 * 0.1)
    assert.ok(i90 >= 6 && i90 <= 14, `empieza a bajar al terminar la sección (${(3.5 + i90 / 4).toFixed(2)} s)`)
    assert.ok(i10 > i90, 'baja hasta casi nada')
    const dura = (i10 - i90) / 4
    assert.ok(dura >= 2.6 && dura <= 3.9, `de 90 % a 10 % tarda lo que corresponde a 4 s de fundido (${dura} s)`)
    for (let i = i90 + 1; i <= i10; i++) assert.ok(env[i] <= env[i - 1] * 1.1 + 0.002, `baja parejo (ventana ${i}: ${env[i]} después de ${env[i - 1]})`)
    for (const x of env.slice(i10 + 6)) assert.ok(x < a0 * 0.02, `después, silencio (${x})`)
    await director.locator('.m-terminando').waitFor({ state: 'detached' })
    assert.equal(server.state.getActiveTab()!.playback.estado, 'stopped')
    assert.equal(server.state.fundido, null)
  })

  await t.test('desde la compu: ⚙ Ajustes (salta "Ya") y la tecla F; a mitad, "Seguir" en el celular trae la música de vuelta', async () => {
    await compu.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await compu.getByRole('radio', { name: /^Ya/ }).click()
    await compu.locator('.ajustes-opcion.activo', { hasText: /^Ya/ }).waitFor()
    await captura(compu, 'ajustes-compu')
    await compu.keyboard.press('Escape')
    await compu.locator('.modal').waitFor({ state: 'detached' })
    await director.getByRole('button', { name: 'Ajustes', exact: true }).click()
    await director.locator('[role=radio][aria-checked=true]', { hasText: /^Ya$/ }).waitFor()
    await director.getByRole('button', { name: 'Cerrar' }).click()

    await director.locator('.m-barra .m-play').click()
    await esperarPosicion(2000)
    const antes = await envolvente(musico, 1)
    await compu.locator('body').click({ position: { x: 5, y: 5 } })
    await compu.keyboard.press('f')
    await director.locator('.m-terminando', { hasText: 'Se está apagando' }).waitFor()
    // (se graba todo: baja, "Seguir", vuelve)
    const grabando = envolvente(musico, 6)
    // un segundo y medio despues de que empezo a bajar (en todos a la vez: a la hora de la compu)
    const f = server.state.fundido!
    await esperar(Math.max(0, f.desde + 1500 - Date.now()))
    await director.locator('.m-terminando').getByRole('button', { name: 'Que siga la canción' }).click()
    await director.locator('.m-terminando').waitFor({ state: 'detached' })
    const env = await grabando
    t.diagnostic(`amplitud cada 250 ms: ${env.map((x) => x.toFixed(3)).join(' ')}`)
    const a = Math.max(...antes)
    const minimo = Math.min(...env)
    assert.ok(minimo < a * 0.75 && minimo > a * 0.2, `bajó un poco y no del todo (${minimo} de ${a})`)
    const d = Math.min(...env.slice(-4))
    assert.ok(d > a * 0.9, `la música volvió (${d} de ${a})`)
    await esperar(3000)
    assert.equal(server.state.getActiveTab()!.playback.estado, 'playing', 'no paró')
    await compu.keyboard.press('Enter')
    assert.deepEqual(errores, [])
  })
})
