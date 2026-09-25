import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

interface Props {
  valor: number
  min: number
  max: number
  /** valor "neutro": se marca en la pista, el arrastre se "pega" ahi y el doble toque vuelve a el */
  neutro?: number
  paso?: number
  color?: string
  deshabilitado?: boolean
  etiqueta: string
  onCambio: (v: number) => void
}

/** Movimiento (px) a partir del cual se decide si el gesto es arrastrar el fader o scrollear la pantalla. */
const UMBRAL_PX = 8

/**
 * Fader horizontal para usar con el dedo en vivo, sin sorpresas:
 *  - tocarlo NO cambia el valor (no salta a donde cae el dedo): se arrastra
 *    de forma relativa desde donde estaba;
 *  - solo se mueve si el dedo va de costado; si va para arriba o abajo, la
 *    pantalla scrollea normalmente (touch-action: pan-y) y el fader no se toca;
 *  - doble toque: vuelve al valor neutro (100% = igual que la compu).
 */
export function FaderTactil({ valor, min, max, neutro, paso = 1, color, deshabilitado, etiqueta, onCambio }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const gesto = useRef<{ id: number; x: number; y: number; valor: number; modo: 'indeciso' | 'arrastre' | 'scroll' } | null>(null)
  const ultimoToque = useRef(0)
  const [arrastrando, setArrastrando] = useState(false)
  const rango = max - min
  const pct = ((Math.min(max, Math.max(min, valor)) - min) / rango) * 100

  function redondear(v: number): number {
    let r = Math.min(max, Math.max(min, Math.round(v / paso) * paso))
    // se "pega" al neutro al pasar cerca (facil volver a "igual que la compu")
    if (neutro !== undefined && Math.abs(r - neutro) <= rango * 0.03) r = neutro
    return r
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (deshabilitado || (e.pointerType === 'mouse' && e.button !== 0)) return
    gesto.current = { id: e.pointerId, x: e.clientX, y: e.clientY, valor, modo: 'indeciso' }
    // con mouse no hay scroll que respetar: se arrastra directo
    if (e.pointerType === 'mouse') {
      gesto.current.modo = 'arrastre'
      e.currentTarget.setPointerCapture(e.pointerId)
      setArrastrando(true)
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const g = gesto.current
    if (!g || g.id !== e.pointerId || g.modo === 'scroll') return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (g.modo === 'indeciso') {
      if (Math.abs(dy) > UMBRAL_PX && Math.abs(dy) >= Math.abs(dx)) {
        g.modo = 'scroll'
        return
      }
      if (Math.abs(dx) <= UMBRAL_PX) return
      g.modo = 'arrastre'
      g.x = e.clientX // el recorrido cuenta desde aca: sin salto al decidir
      e.currentTarget.setPointerCapture(e.pointerId)
      setArrastrando(true)
      return
    }
    const ancho = ref.current?.getBoundingClientRect().width || 1
    const nuevo = redondear(g.valor + (dx / ancho) * rango)
    if (nuevo !== valor) onCambio(nuevo)
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    const g = gesto.current
    if (!g || g.id !== e.pointerId) return
    gesto.current = null
    setArrastrando(false)
    // un toque sin moverse: si es el segundo seguido, vuelve al neutro
    if (g.modo === 'indeciso' && Math.hypot(e.clientX - g.x, e.clientY - g.y) <= UMBRAL_PX) {
      const ahora = Date.now()
      if (neutro !== undefined && ahora - ultimoToque.current < 350) {
        onCambio(neutro)
        ultimoToque.current = 0
      } else ultimoToque.current = ahora
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (deshabilitado) return
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? paso * 2 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -paso * 2 : 0
    if (delta) {
      e.preventDefault()
      onCambio(redondear(valor + delta))
    }
  }

  return (
    <div
      ref={ref}
      className={`fader-tactil ${arrastrando ? 'arrastrando' : ''} ${deshabilitado ? 'deshabilitado' : ''}`}
      style={{ '--p': `${pct}%`, '--color-fader': color ?? 'var(--accent)' } as CSSProperties}
      role="slider"
      tabIndex={deshabilitado ? -1 : 0}
      aria-label={etiqueta}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={valor}
      aria-disabled={deshabilitado}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesto.current = null
        setArrastrando(false)
      }}
      onKeyDown={onKeyDown}
    >
      <div className="fader-tactil-pista">
        <div className="fader-tactil-relleno" />
        {neutro !== undefined && <div className="fader-tactil-neutro" style={{ left: `${((neutro - min) / rango) * 100}%` }} />}
      </div>
      <div className="fader-tactil-perilla" />
    </div>
  )
}
