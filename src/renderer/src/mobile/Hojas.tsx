import { useEffect, useState, type ReactNode } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { AppController } from '../app/useAppController'
import { explicacion, nivelDiagnostico } from '../diagnostico'

export function Hoja({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: ReactNode }) {
  return (
    <div className="hoja-overlay" onClick={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="hoja" role="dialog" aria-modal>
        <div className="hoja-agarre" />
        <h2>
          {titulo}
          <button className="btn-fantasma btn-icono" onClick={onCerrar} aria-label="Cerrar">
            <X size={20} />
          </button>
        </h2>
        {children}
      </div>
    </div>
  )
}

export function HojaAjustes({
  controller,
  etiqueta,
  pantallaEncendida,
  accesoFijo,
  onCerrar
}: {
  controller: AppController
  etiqueta: string
  pantallaEncendida: boolean
  /** como entrar sin QR la proxima vez (segun el celular) */
  accesoFijo?: ReactNode
  onCerrar: () => void
}) {
  const [nombre, setNombre] = useState(controller.nombreDispositivo)
  // lo que mide el audio de este celular (WiFi, colchon, cortes), al dia mientras la hoja esta abierta
  const leerDiag = controller.diagnosticoLocal
  const [diag, setDiag] = useState(() => leerDiag())
  useEffect(() => {
    const id = setInterval(() => setDiag(leerDiag()), 2000)
    return () => clearInterval(id)
  }, [leerDiag])
  const ms = controller.ajusteManualMs
  const cambiar = (delta: number): void => controller.setAjusteManualMs(ms + delta)

  return (
    <Hoja titulo="Ajustes de este celular" onCerrar={onCerrar}>
      <div className="hoja-seccion">
        <h3>Nombre</h3>
        <div className="hoja-fila">
          <input
            placeholder={etiqueta}
            value={nombre}
            maxLength={24}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && controller.setNombreDispositivo(nombre)}
          />
          <button className="btn-primario" onClick={() => controller.setNombreDispositivo(nombre)} disabled={nombre.trim() === controller.nombreDispositivo}>
            Guardar
          </button>
        </div>
        <p className="ayuda" style={{ marginBottom: 0 }}>
          Así te ve la computadora en la lista de celulares (ej: “Batería”, “Guitarra”).
        </p>
      </div>

      <div className="hoja-seccion">
        <h3>Ajuste fino de sincronización</h3>
        <p className="ayuda" style={{ marginTop: 0 }}>
          Solo si ESTE celular suena <b>después</b> que los demás (típico con auriculares Bluetooth), sumá (+). Si suena{' '}
          <b>antes</b>, restá (−). Se guarda en este celular.
        </p>
        <div className="ajuste-valor num">
          {ms > 0 ? '+' : ms < 0 ? '−' : ''}
          {Math.abs(ms)} ms
        </div>
        <input
          className="slider"
          type="range"
          min={-500}
          max={500}
          step={5}
          value={ms}
          style={{ '--p': `${((ms + 500) / 1000) * 100}%` } as React.CSSProperties}
          onChange={(e) => controller.setAjusteManualMs(Number(e.target.value))}
          aria-label="Ajuste fino en milisegundos"
        />
        <div className="ajuste-botones">
          <button onClick={() => cambiar(-10)}>−10</button>
          <button onClick={() => cambiar(-5)}>−5</button>
          <button onClick={() => cambiar(5)}>+5</button>
          <button onClick={() => cambiar(10)}>+10</button>
        </div>
        <button className="btn-fantasma" style={{ width: '100%', marginTop: 8 }} onClick={() => controller.setAjusteManualMs(0)} disabled={ms === 0}>
          <RotateCcw size={15} /> Volver a 0
        </button>
      </div>

      {accesoFijo && (
        <div className="hoja-seccion">
          <h3>La próxima vez, sin QR</h3>
          {accesoFijo}
        </div>
      )}

      <div className="hoja-seccion">
        <h3>Estado</h3>
        <p className="ayuda" style={{ margin: 0 }}>
          Pantalla siempre encendida: <b>{pantallaEncendida ? 'activa' : 'no disponible — no bloquees el celular'}</b>
          <br />
          Conexión: <b>{controller.conectado ? 'conectado' : 'reconectando…'}</b>
        </p>
        {diag && (
          <div className={`diag-celular diag-${nivelDiagnostico(diag)}`}>
            <b>{explicacion(diag)}</b>
            <span>
              WiFi: {diag.mbpsCapacidad !== null ? `${diag.mbpsCapacidad.toLocaleString('es-AR')} Mbps` : 'midiendo…'} · hace falta{' '}
              {diag.mbpsNecesarios.toLocaleString('es-AR')} Mbps
            </span>
            <span>
              Audio listo por delante: {Math.round(diag.colchonSeg)} s · cortes: {diag.cortes}
            </span>
          </div>
        )}
      </div>
    </Hoja>
  )
}
