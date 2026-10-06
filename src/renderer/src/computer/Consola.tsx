import { useEffect, useState } from 'react'
import { Activity, BellOff, Cable, Check, Laptop, Smartphone, Speaker, Volume2 } from 'lucide-react'
import type { DispositivoInfo, RolDispositivo } from '@shared/types'
import type { AppController } from '../app/useAppController'
import { Modal } from '../ui/Modal'
import { INFO_ROL } from '../mobile/Roles'

/** Los celulares de Sonido (los que van a la consola): normalmente uno. */
export function celularesDeConsola(dispositivos: DispositivoInfo[]): DispositivoInfo[] {
  return dispositivos.filter((d) => d.origen === 'celular' && d.rol === 'sonido')
}

/** Como esta la consola, en pocas palabras (para el chip de arriba y el panel). */
export function estadoConsola(d: DispositivoInfo | undefined): { nivel: 'ok' | 'alerta' | 'error' | 'nada'; texto: string } {
  if (!d) return { nivel: 'nada', texto: 'Elegir' }
  if (!d.conectado) return { nivel: 'error', texto: `${d.etiqueta}: desconectado` }
  if (d.error) return { nivel: 'error', texto: `${d.etiqueta}: error de audio` }
  if (!d.audio) return { nivel: 'alerta', texto: `${d.etiqueta}: falta tocar “empezar”` }
  if (d.buffer === 'critico') return { nivel: 'alerta', texto: `${d.etiqueta}: WiFi lento` }
  if (d.driftMs !== null && Math.abs(d.driftMs) >= 50) return { nivel: 'alerta', texto: `${d.etiqueta}: ajustando el sync` }
  return { nivel: 'ok', texto: d.etiqueta }
}

/** Chip de la barra de arriba: que celular va a la consola (y si esta bien). Tocarlo abre el panel. */
export function ChipConsola({ dispositivos, onClick }: { dispositivos: DispositivoInfo[]; onClick: () => void }) {
  const consolas = celularesDeConsola(dispositivos)
  const principal = consolas.find((d) => d.conectado) ?? consolas[0]
  const e = estadoConsola(principal)
  const extra = principal?.salida && (principal.salida.guia || principal.salida.click) ? [principal.salida.guia && 'guía', principal.salida.click && 'click'].filter(Boolean).join(' y ') : null
  return (
    <button
      className={`chip-consola ${e.nivel}`}
      onClick={onClick}
      title={
        principal
          ? `Celular de la consola: ${e.texto}. Manda la banda sola${extra ? ` (con ${extra} en los parlantes)` : ', sin click ni guía'}. Tocá para cambiarlo.`
          : 'Elegir qué celular va a la consola (la banda sola, sin click ni guía)'
      }
    >
      <span className={`punto ${e.nivel === 'ok' ? 'verde' : e.nivel === 'alerta' ? 'amarillo' : e.nivel === 'error' ? 'rojo' : 'gris'}`} />
      <Speaker size={16} />
      <span className="chip-consola-texto">{principal ? principal.etiqueta : 'Consola'}</span>
      {extra && <span className="chip-consola-extra">+ {extra}</span>}
    </button>
  )
}

/**
 * Elegir el celular que va a la consola (rol Sonido): manda la banda sola, en
 * estereo, sin click ni guia; para un ensayo se suman la guia o el click a los
 * parlantes. No siempre es el mismo celular: se elige de los conectados.
 */
export function PanelConsola({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const celulares = controller.dispositivos.filter((d) => d.origen === 'celular')
  const consolas = celularesDeConsola(controller.dispositivos)
  const conectados = celulares.filter((d) => d.conectado)
  const [cambiando, setCambiando] = useState<string | null>(null)

  async function usar(id: string): Promise<void> {
    setCambiando(id)
    // la consola es una: la anterior vuelve a ser un celular comun (con click y guia)
    for (const d of consolas) if (d.id !== id) await controller.setRolDe(d.id, 'musico')
    await controller.setRolDe(id, 'sonido')
    setCambiando(null)
  }

  return (
    <Modal titulo="Celular de la consola" icono={<Speaker size={20} color="var(--warn)" />} onCerrar={onCerrar}>
      <p className="ayuda" style={{ marginTop: 0 }}>
        El celular de <b>Sonido</b> va conectado a la consola: manda <b>la banda sola, en estéreo, sin click ni guía</b> (ni la voz que avisa los
        saltos). Así no hay que mutear nada en cada canción. Para un ensayo se pueden sumar la guía o el click a los parlantes.
      </p>

      {consolas.map((d) => {
        const e = estadoConsola(d)
        return (
          <section key={d.id} className={`consola-panel ${e.nivel}`}>
            <div className="consola-panel-fila">
              <Speaker size={22} />
              <div className="consola-panel-nombre">
                <b>{d.etiqueta}</b>
                <span className={`texto-${e.nivel === 'ok' ? 'verde' : e.nivel === 'nada' ? 'gris' : e.nivel === 'alerta' ? 'amarillo' : 'rojo'}`}>
                  {e.nivel === 'ok' ? (d.driftMs !== null ? `Sonando en sync (${Math.round(d.driftMs)} ms)` : 'Listo') : e.texto}
                </span>
              </div>
              <button className="btn-fantasma btn-chico" onClick={() => void controller.setRolDe(d.id, 'musico')} title="Que vuelva a ser un celular común (con click y guía)">
                Sacar de la consola
              </button>
            </div>
            <div className="consola-panel-salidas">
              <label className="consola-panel-salida">
                <input type="checkbox" checked={!!d.salida?.guia} onChange={(ev) => controller.setSalidaDe(d.id, { guia: ev.target.checked })} />
                Guía en los parlantes
              </label>
              <label className="consola-panel-salida">
                <input type="checkbox" checked={!!d.salida?.click} onChange={(ev) => controller.setSalidaDe(d.id, { click: ev.target.checked })} />
                Click en los parlantes
              </label>
            </div>
            {(d.salida?.guia || d.salida?.click) && <p className="consola-panel-aviso">Para ensayar. Antes del culto, apagalos: la gente los escucharía.</p>}
            <AjusteFino controller={controller} d={d} />
          </section>
        )
      })}

      <h3 className="consola-panel-titulo">{consolas.length ? 'Cambiar de celular' : '¿Cuál va a la consola?'}</h3>
      {conectados.length === 0 ? (
        <p className="ayuda">No hay celulares conectados. El de la consola entra como cualquier otro (QR o la app) y acá se lo elige.</p>
      ) : (
        <ul className="lista">
          {conectados.map((d) => {
            const esConsola = d.rol === 'sonido'
            const rol: RolDispositivo | null = d.rol
            return (
              <li key={d.id} className="lista-fila">
                <Smartphone size={18} color="var(--text-3)" />
                <div className="lista-principal">
                  <span className="lista-titulo">{d.etiqueta}</span>
                  <span className="lista-meta">{rol ? INFO_ROL[rol].nombre : 'Sin rol todavía'}</span>
                </div>
                {esConsola ? (
                  <span className="texto-verde consola-panel-elegido">
                    <Check size={15} /> En la consola
                  </span>
                ) : (
                  <button className="btn-chico" onClick={() => void usar(d.id)} disabled={cambiando !== null}>
                    {cambiando === d.id ? 'Cambiando…' : 'Usar para la consola'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ProbarSync controller={controller} />
      <AjusteCompu controller={controller} />

      <ul className="consola-panel-consejos ayuda">
        <li>
          <Cable size={14} /> Del celular a la consola: miniplug estéreo a dos plugs (o a una caja directa), en una entrada de línea.
        </li>
        <li>
          <Volume2 size={14} /> Volumen del celular al máximo; la ganancia se ajusta en la consola.
        </li>
        <li>
          <BellOff size={14} /> En ese celular, “No molestar” (o modo avión con el WiFi prendido): una llamada saldría por los parlantes.
        </li>
      </ul>
    </Modal>
  )
}

/**
 * Ajuste fino de sincronizacion de un celular, desde la compu (sin tocar el
 * celular): si los parlantes suenan antes o despues que los oidos.
 */
function AjusteFino({ controller, d }: { controller: AppController; d: DispositivoInfo }) {
  // lo pedido manda hasta que el celular lo confirma (dos toques rapidos suman, no repiten el mismo valor)
  const [pedido, setPedido] = useState<number | null>(null)
  useEffect(() => {
    if (pedido !== null && d.ajusteMs === pedido) setPedido(null)
  }, [d.ajusteMs, pedido])
  useEffect(() => {
    if (pedido === null) return
    const t = setTimeout(() => setPedido(null), 5000)
    return () => clearTimeout(t)
  }, [pedido])
  const ms = pedido ?? d.ajusteMs
  const poner = (valor: number): void => {
    const v = Math.max(-500, Math.min(500, valor))
    setPedido(v)
    void controller.setAjusteDe(d.id, v)
  }
  const cambiar = (delta: number): void => poner(ms + delta)
  return (
    <div className="consola-ajuste">
      <span className="consola-ajuste-texto">
        <span>
          Ajuste fino: <b className="num">{ms > 0 ? `+${ms}` : ms} ms</b>
        </span>
        <small>si los parlantes suenan después que los oídos, restá; si suenan antes, sumá</small>
      </span>
      <span className="consola-ajuste-botones">
        <button className="btn-chico" onClick={() => cambiar(-5)} disabled={!d.conectado} aria-label="Restar 5 ms">
          −5
        </button>
        <button className="btn-chico" onClick={() => cambiar(-1)} disabled={!d.conectado} aria-label="Restar 1 ms">
          −1
        </button>
        <button className="btn-chico" onClick={() => cambiar(1)} disabled={!d.conectado} aria-label="Sumar 1 ms">
          +1
        </button>
        <button className="btn-chico" onClick={() => cambiar(5)} disabled={!d.conectado} aria-label="Sumar 5 ms">
          +5
        </button>
        {ms !== 0 && (
          <button className="btn-chico btn-fantasma" onClick={() => poner(0)} disabled={!d.conectado}>
            0
          </button>
        )}
      </span>
    </div>
  )
}

/** Un click en todos a la vez durante 8 s: con dos celulares (o la consola y un celular) juntos, suenan como uno solo. */
export function ProbarSync({ controller }: { controller: AppController }) {
  const [estado, setEstado] = useState<'listo' | 'sonando' | string>('listo')
  async function probar(): Promise<void> {
    const r = await controller.probarSync()
    if (!r.ok) {
      setEstado(r.error ?? 'No se pudo')
      setTimeout(() => setEstado('listo'), 3000)
      return
    }
    setEstado('sonando')
    setTimeout(() => setEstado('listo'), 9000)
  }
  return (
    <div className="probar-sync">
      <button onClick={() => void probar()} disabled={estado === 'sonando'}>
        <Activity size={16} /> {estado === 'sonando' ? 'Sonando el click en todos…' : 'Probar el sync'}
      </button>
      <span className="ayuda">
        {estado !== 'listo' && estado !== 'sonando'
          ? estado
          : 'Un click en todos a la vez (8 s, con la música parada): con dos celulares juntos, o la consola y un celular, tienen que sonar como uno solo.'}
      </span>
    </div>
  )
}

/**
 * El sonido de esta compu (si se usa: "Sonido en la compu", o si la compu va
 * a la consola): Windows a veces informa mal la demora de su placa de sonido
 * y la compu suena corrida contra los celulares. Se corrige de oido con
 * "Probar el sync".
 */
export function AjusteCompu({ controller }: { controller: AppController }) {
  const ms = controller.ajusteManualMs
  const cambiar = (delta: number): void => controller.setAjusteManualMs(ms + delta)
  return (
    <section className="consola-panel esta-compu">
      <div className="consola-panel-fila">
        <Laptop size={22} />
        <div className="consola-panel-nombre">
          <b>El sonido de esta compu</b>
          <span className="texto-gris">{controller.sonidoLocal ? 'Sonando en la compu' : 'Apagado (se prende en ⚙ Ajustes → Esta compu)'}</span>
        </div>
      </div>
      <div className="consola-ajuste">
        <span className="consola-ajuste-texto">
          <span>
            Ajuste fino: <b className="num">{ms > 0 ? `+${ms}` : ms} ms</b>
          </span>
          <small>si la compu suena después que los celulares, restá; si suena antes, sumá (probalo con “Probar el sync”)</small>
        </span>
        <span className="consola-ajuste-botones">
          <button className="btn-chico" onClick={() => cambiar(-10)} aria-label="Compu: restar 10 ms">
            −10
          </button>
          <button className="btn-chico" onClick={() => cambiar(-1)} aria-label="Compu: restar 1 ms">
            −1
          </button>
          <button className="btn-chico" onClick={() => cambiar(1)} aria-label="Compu: sumar 1 ms">
            +1
          </button>
          <button className="btn-chico" onClick={() => cambiar(10)} aria-label="Compu: sumar 10 ms">
            +10
          </button>
          {ms !== 0 && (
            <button className="btn-chico btn-fantasma" onClick={() => controller.setAjusteManualMs(0)}>
              0
            </button>
          )}
        </span>
      </div>
    </section>
  )
}
