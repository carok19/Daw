import type { ApiVideo, EstadoPantalla, Reproduccion, VideoGuardado } from '../tipos'
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
/** "Ver en el proyector": el video que se esta revisando (con la musica parada) */
let enPrueba: string | null = null
/** lo que se le cuenta a la ventana de control (cada medio segundo) */
const informe: EstadoPantalla = { visible: false, proyectoId: null, corriendo: false, difMs: null, prueba: null }

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

/** "Ver en el proyector": el video desde el comienzo de la cancion, en loop, mientras no suene nada. */
function pasoPrueba(v: VideoGuardado): void {
  cargar(v)
  if (enPrueba !== v.proyectoId) {
    if (activo.readyState < 1) return
    enPrueba = v.proyectoId
    cancelarCorte()
    activo.currentTime = Math.max(0, v.desfaseMs! / 1000)
  }
  activo.playbackRate = 1
  if (activo.ended) activo.currentTime = Math.max(0, v.desfaseMs! / 1000)
  if (activo.paused) void activo.play().catch(() => undefined)
  if (activo.readyState >= 2) mostrar(true)
  Object.assign(informe, { proyectoId: v.proyectoId, corriendo: true, difMs: null, prueba: 'video' })
}

function paso(): void {
  if (pruebaHasta) {
    informe.prueba = 'cartel'
    return
  }
  informe.prueba = null
  const prueba = rep?.prueba && rep.playback?.estado !== 'playing' ? rep.videos.find((x) => x.proyectoId === rep!.prueba!.proyectoId && x.desfaseMs !== null) : null
  if (prueba) return pasoPrueba(prueba)
  if (enPrueba) {
    enPrueba = null
    activo.pause()
  }
  const v = videoDeLaCancion()
  informe.proyectoId = v?.proyectoId ?? null
  informe.corriendo = false
  informe.difMs = null
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
  informe.corriendo = obj.corriendo
  if (activo.readyState >= 2 && !activo.seeking) informe.difMs = Math.round((activo.currentTime - obj.segundos) * 1000)
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

// a la ventana de control: como va el proyector y, mientras se ve, una imagen chiquita (el monitor)
const lienzo = document.createElement('canvas')
lienzo.width = 384
lienzo.height = 216
const dibujo = lienzo.getContext('2d')!
setInterval(() => {
  informe.visible = visible
  api.informarPantalla({ ...informe })
  if (!visible || informe.prueba === 'cartel' || activo.readyState < 2 || !activo.videoWidth) return
  // el cuadro entero, con franjas negras si el video no es 16:9 (como se ve en el proyector)
  const escala = Math.min(lienzo.width / activo.videoWidth, lienzo.height / activo.videoHeight)
  const w = activo.videoWidth * escala
  const h = activo.videoHeight * escala
  dibujo.fillStyle = '#000'
  dibujo.fillRect(0, 0, lienzo.width, lienzo.height)
  try {
    dibujo.drawImage(activo, (lienzo.width - w) / 2, (lienzo.height - h) / 2, w, h)
    api.enviarVistaPrevia(lienzo.toDataURL('image/jpeg', 0.6))
  } catch {
    // un cuadro que no se pudo leer: se manda el proximo
  }
}, 500)
