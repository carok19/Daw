import { useState, type ReactNode } from 'react'
import { RotateCcw, VolumeX, X } from 'lucide-react'
import type { Proyecto } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { clavePista } from '../audio/PlaybackEngine'

function Hoja({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: ReactNode }) {
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
  onCerrar
}: {
  controller: AppController
  etiqueta: string
  pantallaEncendida: boolean
  onCerrar: () => void
}) {
  const [nombre, setNombre] = useState(controller.nombreDispositivo)
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

      <div className="hoja-seccion">
        <h3>Estado</h3>
        <p className="ayuda" style={{ margin: 0 }}>
          Pantalla siempre encendida: <b>{pantallaEncendida ? 'activa' : 'no disponible — no bloquees el celular'}</b>
          <br />
          Conexión: <b>{controller.conectado ? 'conectado' : 'reconectando…'}</b>
        </p>
      </div>
    </Hoja>
  )
}

export function HojaMezcla({ controller, proyecto, onCerrar }: { controller: AppController; proyecto: Proyecto; onCerrar: () => void }) {
  const mezcla = controller.mezclaPersonal
  const hayCambios = Object.keys(mezcla).length > 0

  function set(nombre: string, patch: Partial<{ ganancia: number; mute: boolean }>): void {
    const clave = clavePista(nombre)
    const actual = mezcla[clave] ?? { ganancia: 1, mute: false }
    const nuevo = { ...actual, ...patch }
    const copia = { ...mezcla }
    if (Math.abs(nuevo.ganancia - 1) < 0.001 && !nuevo.mute) delete copia[clave]
    else copia[clave] = nuevo
    controller.setMezclaPersonal(copia)
  }

  return (
    <Hoja titulo="Mi mezcla" onCerrar={onCerrar}>
      <p className="ayuda" style={{ marginTop: 0 }}>
        Cambia solo lo que escuchás en <b>este</b> celular (por ejemplo, más click o menos pad), sobre la mezcla de la computadora. Se
        recuerda por nombre de pista, así que vale para todas las canciones.
      </p>
      {proyecto.pistas.map((p) => {
        const ajuste = mezcla[clavePista(p.nombre)] ?? { ganancia: 1, mute: false }
        const pct = Math.round(ajuste.ganancia * 100)
        return (
          <div key={p.id} className="mezcla-fila">
            <span className="mezcla-nombre">
              <span className="punto" style={{ background: p.color }} />
              {p.nombre}
              <small className="num">{ajuste.mute ? 'mute' : `${pct}%`}</small>
            </span>
            <button
              className={ajuste.mute ? 'btn-peligro' : ''}
              onClick={() => set(p.nombre, { mute: !ajuste.mute })}
              aria-pressed={ajuste.mute}
              aria-label={`Silenciar ${p.nombre} en este celular`}
            >
              <VolumeX size={16} />
            </button>
            <input
              className="slider"
              type="range"
              min={0}
              max={200}
              step={5}
              value={pct}
              style={{ '--p': `${pct / 2}%` } as React.CSSProperties}
              onChange={(e) => set(p.nombre, { ganancia: Number(e.target.value) / 100 })}
              onDoubleClick={() => set(p.nombre, { ganancia: 1 })}
              aria-label={`Volumen de ${p.nombre} en este celular`}
            />
          </div>
        )
      })}
      <button className="btn-fantasma" style={{ width: '100%', marginTop: 8 }} disabled={!hayCambios} onClick={() => controller.setMezclaPersonal({})}>
        <RotateCcw size={15} /> Igual que la computadora
      </button>
    </Hoja>
  )
}
