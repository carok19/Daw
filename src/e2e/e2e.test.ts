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

const RENDERER = path.resolve(__dirname, '../renderer')
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function generarZip(dir: string, nombre: string, pistas: [string, number][], segundos: number, ext: 'wav' | 'mp3'): string {
  const ffmpeg = rutaFfmpeg()
  assert.ok(ffmpeg, 'hace falta ffmpeg')
  const zip = new AdmZip()
  for (const [pista, freq] of pistas) {
    const archivo = path.join(dir, `${pista}.${ext}`)
    const r: SpawnSyncReturns<Buffer> = spawnSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${segundos}`, '-ac', '2', archivo])
    assert.equal(r.status, 0, r.stderr?.toString())
    zip.addFile(path.basename(archivo), fs.readFileSync(archivo))
  }
  const destino = path.join(dir, `${nombre}.zip`)
  zip.writeZip(destino)
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

test('e2e: compu + 2 celulares', { timeout: 5 * 60 * 1000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multitrack-e2e-'))
  process.env.MULTITRACK_APP_DIR = path.join(tmp, 'app')
  const zipWav = generarZip(tmp, 'Cuan Grande Es El', [['01_Click', 1000], ['02_Guia', 660], ['03_Bajo', 82], ['04_Pad', 330]], 40, 'wav')
  const zipMp3 = generarZip(tmp, 'Rey de Reyes', [['Click', 900], ['Guia', 550], ['Bajo', 110]], 25, 'mp3')

  const server: AppServer = createServer(RENDERER, { compuToken: 'e2e' })
  const port = await server.start(0)
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
  await ctxCompu.addInitScript(() => {
    const g = globalThis as unknown as { __zip: string | null; electronAPI: unknown }
    g.__zip = null
    g.electronAPI = {
      isElectron: true,
      compuToken: 'e2e',
      pickZipFile: async () => g.__zip,
      getConnectionInfo: async () => ({ url: 'http://192.168.0.10:4848', ip: '192.168.0.10', port: 4848 })
    }
  })
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
    await compu.getByRole('button', { name: /Importar canción/ }).click()
    await compu.waitForSelector('.modal', { state: 'detached', timeout: 60000 })
  }

  await t.test('importar WAV y MP3 (se convierten, colores distintos, nombres limpios)', async () => {
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
    for (const cel of celulares) {
      assert.ok((await vivas(cel)) > 0, 'un celular no suena')
      const d = await desfase(cel)
      assert.ok(d !== null && Math.abs(d) < 20, `desfase ${d}ms`)
    }
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
    await celulares[0].waitForFunction(() => document.querySelectorAll('.m-marcador').length === 3)
  })

  await t.test('saltos y repetir sección: los celulares entran en sync sin cortes', async () => {
    // secciones de 8s para medir varias vueltas del loop (se ubican directo en el servidor)
    const tab = server.state.getActiveTab()!
    const ids = tab.proyecto.marcadores.map((m) => m.id) // (actualizarMarcador reordena el array)
    ids.forEach((id, i) => server.state.actualizarMarcador(tab.tabId, id, { tiempoMs: 8000 * (i + 1) }))
    server.transporte.reprogramarTimers()
    server.io.emit('estado:actualizado', buildEstadoCompleto(server.state))
    await esperar(2500) // los celulares precargan el comienzo de cada seccion
    for (const tecla of ['2', '1']) {
      await compu.keyboard.press(tecla)
      await esperar(3500)
      for (const cel of celulares) {
        const d = await desfase(cel)
        assert.ok(d !== null && Math.abs(d) < 20, `desfase tras saltar: ${d}ms`)
      }
    }
    await compu.keyboard.press('l')
    for (let i = 0; i < 12; i++) {
      await esperar(1000)
      const d = await desfase(celulares[0])
      if (d !== null) assert.ok(Math.abs(d) < 20, `desfase en el loop: ${d}ms`)
    }
    assert.match((await compu.locator('.seccion-pill').textContent()) ?? '', /Sección 1/)
    await compu.keyboard.press('l')
  })

  await t.test('bloqueo: los celulares no pueden controlar', async () => {
    await compu.getByRole('switch', { name: /Celulares/ }).click()
    await celulares[0].waitForSelector('.m-bloqueado')
    assert.ok(await celulares[0].locator('.m-marcador').first().isDisabled())
    await compu.getByRole('switch', { name: /Celulares/ }).click()
    await celulares[0].waitForSelector('.m-transporte')
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

  await t.test('sin errores de JavaScript en la compu', () => {
    assert.deepEqual(errores, [])
  })
})
