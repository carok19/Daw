import { useState } from 'react'
import { HelpCircle, KeyRound, Lock, LockOpen, Plus, Smartphone, Volume2, VolumeX, X, AudioLines } from 'lucide-react'
import type { DispositivoInfo, EstadoLicencia, TabResumen } from '@shared/types'
import { Toggle } from '../ui/Toggle'

interface Props {
  tabs: TabResumen[]
  activeTabId: string | null
  sonando: boolean
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onReorder: (orden: string[]) => void
  onNueva: () => void
  dispositivos: DispositivoInfo[]
  onDispositivos: () => void
  locked: boolean
  onLocked: (v: boolean) => void
  sonidoLocal: boolean
  onSonidoLocal: (v: boolean) => void
  onAyuda: () => void
  licencia: EstadoLicencia | null
  onLicencia: () => void
}

/** Resumen de salud de los celulares para el chip de la barra: verde / amarillo / rojo. */
function saludCelulares(dispositivos: DispositivoInfo[]): { conectados: number; nivel: 'ok' | 'alerta' | 'error' | 'nada'; detalle: string } {
  const celulares = dispositivos.filter((d) => d.origen === 'celular')
  const conectados = celulares.filter((d) => d.conectado)
  if (celulares.length === 0) return { conectados: 0, nivel: 'nada', detalle: 'Ningún celular conectado' }
  const conError = conectados.filter((d) => d.error)
  const sinAudio = conectados.filter((d) => !d.audio)
  const bufferMal = conectados.filter((d) => d.buffer === 'critico')
  const desfasados = conectados.filter((d) => d.driftMs !== null && Math.abs(d.driftMs) >= 150)
  const caidos = celulares.filter((d) => !d.conectado)
  if (conError.length || caidos.length) {
    return {
      conectados: conectados.length,
      nivel: 'error',
      detalle: caidos.length ? `${caidos.length} desconectado(s)` : `${conError.length} con error de audio`
    }
  }
  if (sinAudio.length || bufferMal.length || desfasados.length) {
    const partes = []
    if (sinAudio.length) partes.push(`${sinAudio.length} sin activar audio`)
    if (bufferMal.length) partes.push(`${bufferMal.length} con conexión lenta`)
    if (desfasados.length) partes.push(`${desfasados.length} desfasado(s)`)
    return { conectados: conectados.length, nivel: 'alerta', detalle: partes.join(' · ') }
  }
  return { conectados: conectados.length, nivel: 'ok', detalle: 'Todos sincronizados' }
}

export function TopBar(p: Props) {
  const [arrastrando, setArrastrando] = useState<string | null>(null)
  const [destino, setDestino] = useState<string | null>(null)
  const salud = saludCelulares(p.dispositivos)

  function soltar(sobre: string): void {
    if (!arrastrando || arrastrando === sobre) return
    const ids = p.tabs.map((t) => t.tabId)
    const desde = ids.indexOf(arrastrando)
    const hasta = ids.indexOf(sobre)
    ids.splice(hasta, 0, ...ids.splice(desde, 1))
    p.onReorder(ids)
  }

  return (
    <header className="topbar">
      <div className="marca">
        <span className="marca-punto" />
        Multitrack
      </div>

      <nav className="setlist" aria-label="Setlist">
        {p.tabs.map((t, i) => {
          const activa = t.tabId === p.activeTabId
          return (
            <div
              key={t.tabId}
              className={`setlist-tab ${activa ? 'activo' : ''} ${arrastrando === t.tabId ? 'arrastrando' : ''} ${
                destino === t.tabId && arrastrando !== t.tabId ? 'destino' : ''
              }`}
              onClick={() => !activa && p.onSwitch(t.tabId)}
              title={`${t.nombre} — arrastrá para reordenar el setlist`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setArrastrando(t.tabId)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDestino(t.tabId)
              }}
              onDragLeave={() => setDestino((d) => (d === t.tabId ? null : d))}
              onDrop={() => soltar(t.tabId)}
              onDragEnd={() => {
                setArrastrando(null)
                setDestino(null)
              }}
            >
              <span className="setlist-numero num">{i + 1}</span>
              <span className="setlist-nombre">{t.nombre}</span>
              {activa && p.sonando && (
                <span className="setlist-sonando" title="Sonando">
                  <AudioLines size={15} />
                </span>
              )}
              <button
                className="setlist-cerrar"
                title="Quitar del setlist"
                aria-label={`Quitar ${t.nombre} del setlist`}
                onClick={(e) => {
                  e.stopPropagation()
                  p.onClose(t.tabId)
                }}
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
      </nav>
      <button className="btn-fantasma boton-nueva" onClick={p.onNueva} title="Agregar una canción al setlist">
        <Plus size={16} /> Canción
      </button>

      <div className="topbar-derecha">
        {p.licencia?.configuradas && !p.licencia.activa && (
          <button
            className="chip-dispositivos chip-licencia"
            onClick={p.onLicencia}
            title={`Versión de prueba: hasta ${p.licencia.celularesPrueba} celulares a la vez. Tocá para activar una licencia.`}
          >
            <KeyRound size={15} />
            <span>Prueba</span>
            <span className="texto-largo">· hasta {p.licencia.celularesPrueba} celulares</span>
          </button>
        )}
        <button
          className={`chip-dispositivos ${salud.nivel !== 'nada' ? salud.nivel : ''}`}
          onClick={p.onDispositivos}
          title={`Conectar celulares — ${salud.detalle}`}
        >
          <span className={`punto ${salud.nivel === 'ok' ? 'verde' : salud.nivel === 'alerta' ? 'amarillo' : salud.nivel === 'error' ? 'rojo' : 'gris'}`} />
          <Smartphone size={16} />
          <span className="num">{salud.conectados}</span>
          <span className="texto-largo">{salud.conectados === 1 ? 'celular' : 'celulares'}</span>
        </button>
        <Toggle
          activo={p.locked}
          onCambiar={p.onLocked}
          variante="warn"
          titulo={p.locked ? 'Celulares bloqueados: no pueden reproducir, pausar ni saltar secciones' : 'Celulares con control: pueden reproducir, pausar y saltar secciones. Activá para bloquearlos.'}
        >
          {p.locked ? <Lock size={15} /> : <LockOpen size={15} />}
          <span className="texto-largo">{p.locked ? 'Celulares bloqueados' : 'Celulares con control'}</span>
        </Toggle>
        <Toggle
          activo={p.sonidoLocal}
          onCambiar={p.onSonidoLocal}
          titulo={p.sonidoLocal ? 'Sonido en la compu: activado' : 'El audio sale de los celulares. Activá esto para escuchar también en esta compu (ensayo, pruebas).'}
        >
          {p.sonidoLocal ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span className="texto-largo">Sonido en la compu</span>
        </Toggle>
        <button className="btn-fantasma btn-icono" onClick={p.onAyuda} title="Atajos de teclado (?)" aria-label="Atajos de teclado">
          <HelpCircle size={19} />
        </button>
      </div>
    </header>
  )
}
