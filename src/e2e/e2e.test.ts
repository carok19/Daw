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

/** Cuantas secciones ve un celular (se abre y se cierra la hoja de secciones de la barra flotante). */
async function seccionesEnCelular(cel: Page): Promise<{ cantidad: number; deshabilitadas: boolean }> {
  await cel.getByRole('button', { name: 'Secciones', exact: true }).click()
  await cel.waitForSelector('.hoja')
  const cantidad = await cel.locator('.hoja .m-marcador').count()
  const deshabilitadas = cantidad > 0 && (await cel.locator('.hoja .m-marcador').first().isDisabled())
  await cel.getByRole('button', { name: 'Cerrar' }).click()
  await cel.waitForSelector('.hoja', { state: 'detached' })
  return { cantidad, deshabilitadas }
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
    assert.deepEqual(await compu.locator('.canal-nombre').allTextContents(), ['Click', 'Guia', 'Bajo', 'Pad'])
    const colores = await compu.locator('.canal').evaluateAll((els) => els.map((e) => getComputedStyle(e).getPropertyValue('--color-pista')))
    assert.equal(new Set(colores).size, colores.length)
  })

  // ---- celulares ----
  const celulares: Page[] = []
  for (const dispositivo of [devices['Pixel 7'], devices['iPhone 13']]) {
    const ctx = await browser.newContext({ ...dispositivo })
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
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-fila').length === 3)
    const fila = compu.locator('.seccion-fila').nth(2)
    await fila.hover()
    await fila.getByRole('button', { name: /Borrar/ }).click()
    await compu.getByRole('button', { name: 'Deshacer' }).click()
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-fila').length === 3)
    assert.equal((await seccionesEnCelular(celulares[0])).cantidad, 3)
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
    for (const cel of celulares) await cel.waitForSelector('.m-barra-salto')
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
    await compu.waitForFunction(() => document.querySelectorAll('.seccion-fila').length === 6, null, { timeout: 60000 })
    assert.deepEqual(await compu.locator('.seccion-nombre').allTextContents(), ['Verso 1', 'Coro', 'Verso 2', 'Coro 2', 'Puente', 'Final'])
    assert.equal(await compu.locator('.seccion-origen').count(), 6)
    assert.match((await compu.locator('.analisis-linea').textContent()) ?? '', /voz guía/)
    assert.match((await compu.locator('.chip-tempo').textContent()) ?? '', /90 BPM · 4\/4/)
    const santo = server.state.getActiveTab()!.proyecto
    santo.marcadores.forEach((m, i) =>
      assert.ok(Math.abs(m.tiempoMs - inicioCompas(ANUNCIOS[i][2]) * 1000) <= 8, `${m.nombre} en ${m.tiempoMs} ms: fuera del compás`)
    )
    for (const cel of celulares) assert.equal((await seccionesEnCelular(cel)).cantidad, 6)

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
    server.state.crearMarcador(tab.tabId, 20000, 'Salto')
    server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))

    const cel = celulares[0]
    const pedidosMedia: string[] = []
    cel.on('request', (r) => {
      if (r.url().includes('/media/') && !r.url().includes('/analisis/')) pedidosMedia.push(r.url())
    })
    // en este celular, sin el click (sus golpes taparian la posicion)
    await cel.getByRole('button', { name: 'Silenciar Click en este celular' }).click()
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
    const nuevos = todos.filter((tr) => tr.ini > tResync && Math.abs(tr.pos / 2 - Math.round(tr.pos / 2)) > 1e-6)
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
      const ctx = await browser.newContext({ ...devices['Pixel 7'] })
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
    await compu.waitForFunction(() => /WiFi .* Mbps \(usa 1,4\) · colchón \d+ s · sin cortes/.test(document.querySelector('.modal .lista')?.textContent ?? ''))
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
    const ctxNuevo = await browser.newContext({ ...devices['Pixel 7'] })
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
    const ctxTarde = await browser.newContext({ ...devices['iPhone 13'] })
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
    const ctxApp = await browser.newContext({ ...devices['Pixel 7'] })
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
    const ctx = await browser.newContext({ ...devices['Pixel 7'] })
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
    const ctx = await browser.newContext({ ...devices['Pixel 7'] })
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
    const ctx = await browser.newContext({ ...d })
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
