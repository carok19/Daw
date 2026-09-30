import { useEffect, useRef, useState } from 'react'
import type { OndaCancion, Proyecto } from '@shared/types'

/** Ondas ya bajadas (por cancion y revision del audio): cambiar de vista o de cancion no las vuelve a pedir. */
const ondas = new Map<string, OndaCancion>()

/** La forma de onda de la cancion (la calcula la compu una vez); null mientras no llega. */
export function useOnda(proyecto: Proyecto | null): OndaCancion | null {
  const clave = proyecto ? `${proyecto.id}:${proyecto.revision ?? 0}` : ''
  const [onda, setOnda] = useState<OndaCancion | null>(() => ondas.get(clave) ?? null)
  useEffect(() => {
    const ya = ondas.get(clave) ?? null
    setOnda(ya)
    if (!proyecto || ya) return
    let vigente = true
    let intentos = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const pedir = (): void => {
      fetch(`/onda/${proyecto.id}.json?v=${proyecto.revision ?? 0}`)
        .then((r) => (r.ok ? (r.json() as Promise<OndaCancion>) : Promise.reject(new Error(String(r.status)))))
        .then((o) => {
          ondas.set(clave, o)
          if (vigente) setOnda(o)
        })
        .catch(() => {
          // la compu se esta reconectando: se reintenta un par de veces
          if (vigente && ++intentos < 4) timer = setTimeout(pedir, 2000 * intentos)
        })
    }
    pedir()
    return () => {
      vigente = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave])
  return onda
}

/**
 * La forma de onda dibujada (barras finas, simetricas), para poner encima de
 * los colores de las secciones de la linea de tiempo. Se redibuja solo si
 * cambia el tamaño o la onda (el avance de la cancion va aparte, en CSS).
 */
export function OndaDibujo({ onda, duracionMs, className }: { onda: OndaCancion; duracionMs: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dibujar = (): void => {
      const escala = window.devicePixelRatio || 1
      const ancho = Math.max(1, Math.round(canvas.clientWidth * escala))
      const alto = Math.max(1, Math.round(canvas.clientHeight * escala))
      if (canvas.width !== ancho) canvas.width = ancho
      if (canvas.height !== alto) canvas.height = alto
      const g = canvas.getContext('2d')
      if (!g) return
      g.clearRect(0, 0, ancho, alto)
      g.fillStyle = 'rgba(255, 255, 255, 0.62)'
      // una barra cada 3 px (2 de barra y 1 de aire), con el pico de los puntos que caen en ella
      const paso = 3 * escala
      const barra = Math.max(1, 2 * escala)
      const dur = Math.max(1, duracionMs)
      const n = onda.puntos.length
      for (let x = 0; x < ancho; x += paso) {
        const desde = Math.floor(((x / ancho) * dur) / onda.msPorPunto)
        const hasta = Math.min(n, Math.max(desde + 1, Math.floor((((x + paso) / ancho) * dur) / onda.msPorPunto)))
        let v = 0
        for (let i = desde; i < hasta; i++) v = Math.max(v, onda.puntos[i] ?? 0)
        const h = Math.max(escala, (v / 100) * alto * 0.92)
        g.fillRect(x, (alto - h) / 2, barra, h)
      }
    }
    dibujar()
    const observador = new ResizeObserver(dibujar)
    observador.observe(canvas)
    return () => observador.disconnect()
  }, [onda, duracionMs])
  return <canvas ref={ref} className={className} aria-hidden />
}
