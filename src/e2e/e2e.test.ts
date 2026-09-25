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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import AdmZip from 'adm-zip'
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer, type AppServer } from '../server'
import { rutaFfmpeg } from '../server/audio'
import { buildEstadoCompleto } from '../server/estado'
import { ANUNCIOS, inicioCompas, zipConGuia } from '../server/__fixtures__/sintetico'
import { crearRar5 } from '../server/__fixtures__/rar'

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
    // despues del cambio, ningun celular tendria que volver a pedir lo precargado: el encabezado del WAV
    // (bytes=0-) ni los 2 primeros segmentos de cada pista (encabezado de 44 bytes, segmentos de igual largo)
    let cambio = false
    const repetidos: string[] = []
    for (const cel of celulares) {
      cel.on('request', (r) => {
        if (!cambio || !r.url().includes(`/media/${santoId}/`)) return
        const [, desde, hasta] = /bytes=(\d+)-(\d+)/.exec(r.headers()['range'] ?? '')?.map(Number) ?? []
        const indice = desde === 0 ? -1 : Math.round((desde - 44) / (hasta - desde + 1))
        if (indice < 2) repetidos.push(`${r.url()} ${r.headers()['range']}`)
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

  await t.test('sin errores de JavaScript en la compu', () => {
    assert.deepEqual(errores, [])
  })
})
