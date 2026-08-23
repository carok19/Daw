/** Rueda de progreso simple (SVG) + porcentaje, para la descarga de audio en el celular. */
export function LoadingRing({ progreso }: { progreso: number }) {
  const tamano = 88
  const grosor = 7
  const radio = (tamano - grosor) / 2
  const circunferencia = 2 * Math.PI * radio
  const fraccion = Math.min(1, Math.max(0, progreso))
  const offset = circunferencia * (1 - fraccion)

  return (
    <div className="loading-ring">
      <svg width={tamano} height={tamano} viewBox={`0 0 ${tamano} ${tamano}`}>
        <circle cx={tamano / 2} cy={tamano / 2} r={radio} fill="none" stroke="#2c303c" strokeWidth={grosor} />
        <circle
          cx={tamano / 2}
          cy={tamano / 2}
          r={radio}
          fill="none"
          stroke="#3a5bd9"
          strokeWidth={grosor}
          strokeLinecap="round"
          strokeDasharray={circunferencia}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${tamano / 2} ${tamano / 2})`}
          style={{ transition: 'stroke-dashoffset 0.2s linear' }}
        />
      </svg>
      <span className="loading-ring-texto">{Math.round(fraccion * 100)}%</span>
    </div>
  )
}
