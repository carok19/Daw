import { useState } from 'react'
import { HelpCircle, KeyRound, ListMusic, Lock, LockOpen, Plus, Settings, ShieldAlert, Smartphone, Volume2, X, AudioLines } from 'lucide-react'
import type { DispositivoInfo, EstadoLicencia, ListaActiva, TabResumen } from '@shared/types'
import { Toggle } from '../ui/Toggle'
import { ChipConsola } from './Consola'

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
  /** elegir el celular de la consola (rol Sonido) */
  onConsola: () => void
  /** el interruptor del talkback (y, mientras se manda, el aviso de la banda en vivo) */
  talkback: React.ReactNode
  locked: boolean
  onLocked: (v: boolean) => void
  /** suena tambien en esta compu (se prende en ⚙ Ajustes; prendido, se ve "Compu" arriba) */
  sonidoLocal: boolean
  /** abrir ⚙ Ajustes en "Esta compu" */
  onSonidoLocal: () => void
  onAyuda: () => void
  /** ⚙ Ajustes: saltos, fundido, voz del salto, pads */
  onAjustes: () => void
  licencia: EstadoLicencia | null
  onLicencia: () => void
  /** la lista del dia cargada arriba */
  lista: ListaActiva | null
  viendoListas: boolean
  onListas: () => void
  /** Windows bloquea a los celulares en esta red (firewall) */
  redBloqueada: boolean
}

/** Resumen de salud de los celulares para el chip de la barra: verde / amarillo / rojo. */
function saludCelulares(dispositivos: DispositivoInfo[]): { conectados: number; nivel: 'ok' | 'alerta' | 'error' | 'nada'; detalle: string } {
  const celulares = dispositivos.filter((d) => d.origen === 'celular')
  const conectados = celulares.filter((d) => d.conectado)
  if (celulares.length === 0) return { conectados: 0, nivel: 'nada', detalle: 'Ningún celular conectado' }
  const conError = conectados.filter((d) => d.error)
  // (multimedia no baja audio a proposito)
  const sinAudio = conectados.filter((d) => !d.audio && d.rol !== 'multimedia')
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
        AirTracks
      </div>

      <button
        className={`chip-lista ${p.viendoListas ? 'activo' : ''}`}
        onClick={p.onListas}
        title={
          p.viendoListas
            ? 'Volver a la canción'
            : p.lista
              ? `Lista en uso: ${p.lista.nombre}${p.lista.carpeta ? ` (${p.lista.carpeta})` : ''}. Tocá para ver todas las listas.`
              : 'Listas por día: elegir, armar o cambiar la lista'
        }
      >
        <ListMusic size={16} />
        <span className="chip-lista-nombre">{p.lista ? p.lista.nombre : 'Listas'}</span>
      </button>

      <nav className="setlist" aria-label="Setlist">
        {p.tabs.map((t, i) => {
          const activa = t.tabId === p.activeTabId
          return (
            <div
              key={t.tabId}
              className={`setlist-tab ${activa ? 'activo' : ''} ${arrastrando === t.tabId ? 'arrastrando' : ''} ${
                destino === t.tabId && arrastrando !== t.tabId ? 'destino' : ''
              }`}
              onClick={() => p.onSwitch(t.tabId)}
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
          className={`chip-dispositivos ${p.redBloqueada ? 'error' : salud.nivel !== 'nada' ? salud.nivel : ''}`}
          onClick={p.onDispositivos}
          title={p.redBloqueada ? 'Windows bloquea a los celulares en esta red: tocá para permitirlo' : `Conectar celulares — ${salud.detalle}`}
        >
          {p.redBloqueada ? (
            <ShieldAlert size={16} />
          ) : (
            <span className={`punto ${salud.nivel === 'ok' ? 'verde' : salud.nivel === 'alerta' ? 'amarillo' : salud.nivel === 'error' ? 'rojo' : 'gris'}`} />
          )}
          <Smartphone size={16} />
          <span className="num">{salud.conectados}</span>
          <span className="texto-largo">{salud.conectados === 1 ? 'celular' : 'celulares'}</span>
        </button>
        {p.talkback}
        <ChipConsola dispositivos={p.dispositivos} onClick={p.onConsola} />
        <Toggle
          activo={p.locked}
          onCambiar={p.onLocked}
          variante="warn"
          titulo={
            p.locked
              ? 'Celulares bloqueados: nadie maneja la canción desde un celular (ni el director)'
              : 'El celular del director (rol Director) puede reproducir, pausar y saltar secciones. Activá para bloquearlo.'
          }
        >
          {p.locked ? <Lock size={15} /> : <LockOpen size={15} />}
          <span className="texto-largo">{p.locked ? 'Celulares bloqueados' : 'Celulares con control'}</span>
        </Toggle>
        {p.sonidoLocal && (
          <button
            className="chip-sonido-compu"
            onClick={p.onSonidoLocal}
            title="Suena también en esta compu (para ensayar o probar). Tocá para apagarlo o ajustarlo."
            aria-label="Sonido en esta compu: prendido"
          >
            <Volume2 size={15} />
            <span className="texto-largo">Compu</span>
          </button>
        )}
        <button className="btn-fantasma btn-icono" onClick={p.onAjustes} title="Ajustes: cómo salta y Terminar, voz del salto y pad, sonido en esta compu, talkback, banda en vivo" aria-label="Ajustes">
          <Settings size={19} />
        </button>
        <button className="btn-fantasma btn-icono" onClick={p.onAyuda} title="Atajos de teclado (?)" aria-label="Atajos de teclado">
          <HelpCircle size={19} />
        </button>
      </div>
    </header>
  )
}
