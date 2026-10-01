import type { ApiVideo, Reproduccion, VideoGuardado } from '../tipos'
import { ajusteDeVideo, objetivoVideo, proximoCorte } from '../../shared/videoSync'

/**
 * Ventana del proyector: el video de la cancion que suena, en el punto justo.
 * Cada 50 ms compara donde esta el video con donde tiene que estar (segun el
 * reloj de la compu de AirTracks) y lo corrige: lejos, salta; cerca, lo
 * apura o frena apenas. Para los saltos de seccion ya elegidos tiene un
 * segundo video esperando en el punto nuevo, y corta justo en ese instante.
 * Si algo falla aca, a los celulares no les pasa nada: nadie espera al video.
 */

declare global {
  interface Window {
    airtracksVideo: ApiVideo
  }
}

const api = window.airtracksVideo
const a = document.getElementById('a') as HTMLVideoElement
const b = document.getElementById('b') as HTMLVideoElement
const cartelPrueba = document.getElementById('prueba') as HTMLElement

let activo = a
let reserva = b
let rep: Reproduccion | null = null
let src: string | null = null
let visible = false
let pruebaHasta = 0
/** cuanto adelantar un salto con el video corriendo (lo que tarda en arrancar despues de saltar), aprendido */
let adelanto = 0.06
let medirSalto: { en: number } | null = null
let corte: { en: number; segundos: number; timer: ReturnType<typeof setTimeout> } | null = null

for (const v of [a, b]) {
  v.muted = true
  v.defaultMuted = true
  v.preload = 'auto'
}

api.onReproduccion((r) => {
  rep = r
  paso()
})

api.onPrueba(() => {
  pruebaHasta = Date.now() + 3000
  cartelPrueba.hidden = false
  mostrar(true)
  setTimeout(() => {
    cartelPrueba.hidden = true
    pruebaHasta = 0
    if (!videoDeLaCancion()) mostrar(false)
  }, 3000)
})

function ahoraServidor(): number {
  return Date.now() + (rep?.relojMs ?? 0)
}

function mostrar(v: boolean): void {
  if (v === visible) return
  visible = v
  api.mostrarPantalla(v)
}

/** El video de la cancion que esta arriba (ya alineado). null = no hay, o no hay conexion. */
function videoDeLaCancion(): VideoGuardado | null {
  if (!rep?.conectado || !rep.proyectoId) return null
  const v = rep.videos.find((x) => x.proyectoId === rep!.proyectoId)
  return v && v.desfaseMs !== null ? v : null
}

function cargar(v: VideoGuardado): void {
  const url = api.urlDeVideo(v.archivo)
  if (src === url) return
  cancelarCorte()
  src = url
  for (const el of [a, b]) {
    el.src = url
    el.load()
  }
}

/** Sin video: se suelta el archivo (memoria y decodificador libres para Holyrics). */
function soltar(): void {
  if (!src) return
  cancelarCorte()
  src = null
  for (const el of [a, b]) {
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
}

function cancelarCorte(): void {
  if (corte) clearTimeout(corte.timer)
  corte = null
}

/** Deja el otro video quieto en el punto del salto, y en ese instante corta a el. */
function prepararCorte(v: VideoGuardado, ahora: number): void {
  const c = proximoCorte(rep!.playback, ahora, rep!.velocidad, v.desfaseMs!)
  if (!c) return cancelarCorte()
  if (corte && corte.en === c.en && Math.abs(corte.segundos - c.segundos) < 0.01) return
  cancelarCorte()
  const falta = c.en - ahora
  if (falta < 150 || reserva.readyState < 1) return // muy encima: lo corrige el paso normal (salta)
  reserva.pause()
  reserva.currentTime = c.segundos
  reserva.playbackRate = rep!.velocidad
  corte = {
    ...c,
    timer: setTimeout(() => {
      corte = null
      const viejo = activo
      activo = reserva
      reserva = viejo
      void activo.play().catch(() => undefined)
      activo.classList.add('activo')
      reserva.classList.remove('activo')
      reserva.pause()
    }, falta)
  }
}

function paso(): void {
  if (pruebaHasta) return
  const v = videoDeLaCancion()
  if (!v || !rep) {
    mostrar(false)
    soltar()
    return
  }
  cargar(v)
  const ahora = ahoraServidor()
  const duracion = Number.isFinite(activo.duration) ? activo.duration : v.duracionSeg
  const obj = objetivoVideo(rep.playback, ahora, rep.velocidad, v.desfaseMs!, duracion)
  if (!obj.visible) {
    mostrar(false)
    cancelarCorte()
    if (!activo.paused) activo.pause()
    return
  }
  if (activo.readyState < 1) return // todavia leyendo el archivo
  prepararCorte(v, ahora)
  if (activo.seeking) return
  // despues de un salto con el video corriendo: cuanto tardo en arrancar (para el proximo)
  if (medirSalto && Date.now() >= medirSalto.en) {
    if (obj.corriendo && !activo.paused) adelanto = Math.max(0, Math.min(0.5, adelanto - (activo.currentTime - obj.segundos) * 0.7))
    medirSalto = null
  }
  const aj = ajusteDeVideo(activo.currentTime, obj)
  if (aj.saltarA !== null) {
    activo.currentTime = obj.corriendo ? aj.saltarA + adelanto : aj.saltarA
    if (obj.corriendo) medirSalto = { en: Date.now() + 600 }
  }
  activo.playbackRate = Math.max(0.5, Math.min(2, aj.velocidad))
  if (obj.corriendo && activo.paused) void activo.play().catch(() => undefined)
  if (!obj.corriendo && !activo.paused) activo.pause()
  // se muestra cuando hay un cuadro listo (nunca un negro de "cargando" encima de Holyrics)
  if (activo.readyState >= 2) mostrar(true)
}

setInterval(paso, 50)
