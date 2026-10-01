import { useEffect, useState, useSyncExternalStore } from 'react'
import { posicionActualMs } from '../../shared/playback'
import type { ApiVideo, EstadoPantalla, Reproduccion, VideoGuardado } from '../tipos'

declare global {
  interface Window {
    airtracksVideo: ApiVideo
  }
}

export const api = window.airtracksVideo

// ---- lo que llega seguido (el monitor, el proyector): fuera de React, cada componente lee lo suyo ----

function crearStore<T>(inicial: T): { get: () => T; set: (v: T) => void; sub: (cb: () => void) => () => void } {
  let valor = inicial
  const oyentes = new Set<() => void>()
  return {
    get: () => valor,
    set: (v) => {
      valor = v
      for (const cb of oyentes) cb()
    },
    sub: (cb) => {
      oyentes.add(cb)
      return () => oyentes.delete(cb)
    }
  }
}

const repStore = crearStore<Reproduccion | null>(null)
const pantallaStore = crearStore<EstadoPantalla | null>(null)
const vistaStore = crearStore<string | null>(null)
api.onReproduccion((r) => repStore.set(r))
api.onPantalla((p) => pantallaStore.set(p))
api.onVistaPrevia((j) => vistaStore.set(j))

export const useReproduccion = (): Reproduccion | null => useSyncExternalStore(repStore.sub, repStore.get)
export const usePantalla = (): EstadoPantalla | null => useSyncExternalStore(pantallaStore.sub, pantallaStore.get)
export const useVistaPrevia = (): string | null => useSyncExternalStore(vistaStore.sub, vistaStore.get)

/** Donde va la cancion que suena en AirTracks (ms), redibujando unas 10 veces por segundo. null = otra cancion. */
export function usePosicion(rep: Reproduccion | null, proyectoId: string | null): number | null {
  const [, setTic] = useState(0)
  const activa = !!rep?.playback && !!proyectoId && rep.proyectoId === proyectoId
  const corre = activa && rep!.playback!.estado === 'playing'
  useEffect(() => {
    if (!corre) return
    const t = setInterval(() => setTic((x) => x + 1), 100)
    return () => clearInterval(t)
  }, [corre])
  return activa ? posicionActualMs(rep!.playback!, Date.now() + rep!.relojMs) : null
}

// ---- textos ----

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function segundos(ms: number): string {
  return `${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')} s`
}

export function textoDesfase(ms: number): string {
  if (Math.abs(ms) < 50) return 'el video y la canción empiezan juntos'
  return ms > 0 ? 'el video tiene eso más al principio' : 'la canción empieza eso antes que el video'
}

export type Tono = 'ok' | 'info' | 'aviso' | 'error'

/** El estado de un video, corto (la tarjeta) y largo (el panel de ajuste). */
export function estadoDe(v: VideoGuardado): { corto: string; largo: string; tono: Tono; ayuda?: string } {
  switch (v.estado) {
    case 'alineando':
      return { corto: 'Alineando…', largo: 'Alineando con la canción…', tono: 'info' }
    case 'esperando-musica':
      return { corto: 'Espera que pare la música', largo: 'Se alinea cuando pare la música en AirTracks', tono: 'info' }
    case 'sin-conexion':
      return { corto: 'Se alinea al conectar', largo: 'Se alinea al conectar con AirTracks', tono: 'info' }
    case 'listo':
      return v.alineacion?.manual
        ? { corto: 'Listo · ajustado a mano', largo: '✓ Listo (ajustado a mano)', tono: 'ok', ayuda: 'Al darle ▶ a esta canción en AirTracks, el video aparece solo' }
        : {
            corto: `Listo · coincide ${Math.round((v.alineacion?.coincide ?? 1) * 100)} %`,
            largo: `✓ Listo · coincide ${Math.round((v.alineacion?.coincide ?? 1) * 100)} %`,
            tono: 'ok',
            ayuda: 'Al darle ▶ a esta canción en AirTracks, el video aparece solo'
          }
    case 'revisar':
      return {
        corto: 'Revisar: ¿es otra versión?',
        largo: 'No coincide del todo',
        tono: 'aviso',
        ayuda: '¿Es la misma grabación que la multitrack? Probalo con la canción y ajustá el inicio a mano'
      }
    case 'desactualizado':
      return { corto: 'Actualizá AirTracks', largo: 'Para alinear hay que actualizar AirTracks en la compu principal', tono: 'error' }
    default:
      return { corto: 'No se pudo alinear', largo: v.mensaje ?? 'No se pudo alinear', tono: 'error' }
  }
}

// ---- miniaturas: un cuadro de cada video (de a uno, y se recuerdan) ----

const miniaturas = new Map<string, Promise<string | null>>()
let cola: Promise<unknown> = Promise.resolve()

/** Un cuadro del video (probando otros momentos si sale negro: un fundido, una placa). */
function cuadro(url: string, segundo: number): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    let intentos: number[] = []
    const fin = (r: string | null): void => {
      clearTimeout(limite)
      v.removeAttribute('src')
      v.load()
      resolve(r)
    }
    const limite = setTimeout(() => fin(null), 20000)
    const siguiente = (): void => {
      const t = intentos.shift()
      if (t === undefined) return fin(null)
      v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - 1))
    }
    const sacar = (): void => {
      try {
        const c = document.createElement('canvas')
        c.width = 192
        c.height = 108
        const g = c.getContext('2d')!
        const e = Math.min(c.width / v.videoWidth, c.height / v.videoHeight)
        g.fillStyle = '#000'
        g.fillRect(0, 0, c.width, c.height)
        g.drawImage(v, (c.width - v.videoWidth * e) / 2, (c.height - v.videoHeight * e) / 2, v.videoWidth * e, v.videoHeight * e)
        const px = g.getImageData(0, 0, c.width, c.height).data
        let luz = 0
        for (let i = 0; i < px.length; i += 16) luz += px[i] + px[i + 1] + px[i + 2]
        if (luz / (px.length / 16) / 3 < 14) return siguiente()
        fin(c.toDataURL('image/jpeg', 0.7))
      } catch {
        fin(null)
      }
    }
    v.onloadedmetadata = () => {
      intentos = [segundo, v.duration * 0.4, v.duration * 0.6, v.duration * 0.25]
      siguiente()
    }
    v.onseeked = () => {
      // el cuadro de verdad (no el de antes de saltar)
      const conCuadro = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }
      if (conCuadro.requestVideoFrameCallback) {
        let hecho = false
        conCuadro.requestVideoFrameCallback(() => {
          hecho = true
          sacar()
        })
        void v.play().then(() => v.pause()).catch(() => undefined)
        setTimeout(() => !hecho && sacar(), 400)
      } else setTimeout(sacar, 150)
    }
    v.onerror = () => fin(null)
    v.src = url
  })
}

/** Un cuadro del video (de la parte de la cancion, no de la placa del principio). */
export function miniatura(v: VideoGuardado): Promise<string | null> {
  const clave = `mini:${v.archivo}:${v.duracionSeg}`
  let p = miniaturas.get(clave)
  if (!p) {
    let guardada: string | null = null
    try {
      guardada = localStorage.getItem(clave)
    } catch {
      guardada = null
    }
    if (guardada) p = Promise.resolve(guardada)
    else {
      const segundo = (v.desfaseMs ?? 0) / 1000 + 25
      p = cola.then(() => cuadro(api.urlDeVideo(v.archivo), segundo))
      cola = p
      void p.then((url) => {
        if (!url) return
        try {
          localStorage.setItem(clave, url)
        } catch {
          // sin lugar: se vuelve a sacar la proxima vez
        }
      })
    }
    miniaturas.set(clave, p)
  }
  return p
}

export function useMiniatura(v: VideoGuardado | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const clave = v ? `${v.archivo}:${v.duracionSeg}` : null
  useEffect(() => {
    setUrl(null)
    if (!v) return
    let vivo = true
    void miniatura(v).then((u) => vivo && setUrl(u))
    return () => {
      vivo = false
    }
    // (cambia solo si cambia el archivo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave])
  return url
}
