import { useEffect, useRef, useState } from 'react'
import type { AppController } from '../App'
import { TabsBar } from './TabsBar'
import { Mixer } from './Mixer'
import { Transport } from './Transport'
import { MarkersPanel } from './MarkersPanel'
import { ConnectionPanel } from './ConnectionPanel'
import { ProjectsScreen } from './ProjectsScreen'

function esCampoDeTexto(el: EventTarget | null): boolean {
  const tag = (el as HTMLElement | null)?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

export function ComputerApp({ controller }: { controller: AppController }) {
  const { estado } = controller
  const [pantalla, setPantalla] = useState<'ninguna' | 'proyectos' | 'conexion'>('ninguna')
  const [cargando, setCargando] = useState(false)
  const [errorCarga, setErrorCarga] = useState<string | null>(null)

  useEffect(() => {
    if (estado && estado.tabs.length === 0) setPantalla('proyectos')
  }, [estado?.tabs.length])

  // El controller se recrea en cada render (y playheadMs cambia ~60 veces por
  // segundo), asi que el atajo de teclado NO depende de esos valores: se
  // registra una sola vez y siempre lee el estado mas fresco a traves de este
  // ref (si dependiera de `controller`/`estado`, el listener se sacaria y
  // volvería a poner en cada frame).
  const controllerRef = useRef(controller)
  controllerRef.current = controller

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // ignora la repeticion automatica al mantener apretada la tecla: sino
      // cada repeticion vuelve a mandar "play", empujando el horario programado
      // cada vez mas adelante y dando la sensacion de que "no arranca".
      if (e.repeat) return
      if (esCampoDeTexto(e.target)) return
      const c = controllerRef.current
      if (e.code === 'Space') {
        e.preventDefault()
        const playing = c.estado?.playbackActivo?.estado === 'playing'
        if (playing) c.pause()
        else c.play()
      } else if (e.key === 'm' || e.key === 'M') {
        if (c.estado?.proyectoActivo) {
          e.preventDefault()
          c.createMarker(c.playheadMs)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function cargarZip(): Promise<void> {
    setCargando(true)
    setErrorCarga(null)
    const r = await controller.loadZip()
    setCargando(false)
    if (!r.ok && r.error) setErrorCarga(r.error)
    if (r.ok) setPantalla('ninguna')
  }

  const proyecto = estado?.proyectoActivo ?? null

  return (
    <div className="compu">
      <TabsBar
        tabs={estado?.tabs ?? []}
        activeTabId={estado?.activeTabId ?? null}
        onSwitch={controller.switchTab}
        onClose={controller.closeTab}
        onNuevo={() => setPantalla('proyectos')}
        onConexion={() => setPantalla('conexion')}
        locked={estado?.locked ?? false}
        onToggleLock={(v) => controller.setLocked(v)}
      />

      {controller.ultimoError && (
        <div className="banner-error" onClick={controller.limpiarError}>
          {controller.ultimoError}
        </div>
      )}

      {proyecto ? (
        <div className="compu-body">
          <Mixer proyecto={proyecto} onUpdatePista={controller.updateMixer} onReorder={controller.reorderPistas} />
          <MarkersPanel
            proyecto={proyecto}
            playheadMs={controller.playheadMs}
            onJump={controller.jumpToMarker}
            onCreate={controller.createMarker}
            onUpdate={controller.updateMarker}
            onDelete={controller.deleteMarker}
          />
        </div>
      ) : (
        <div className="compu-vacio">Cargá una canción para empezar (botón &ldquo;+ Canción&rdquo; arriba).</div>
      )}

      {proyecto && (
        <Transport
          proyecto={proyecto}
          playback={estado?.playbackActivo ?? null}
          playheadMs={controller.playheadMs}
          onPlay={() => controller.play()}
          onPause={controller.pause}
          onStop={controller.stop}
          onSeek={controller.seek}
          onJumpMarker={controller.jumpToMarker}
          onDragMarker={(id, tiempoMs) => controller.updateMarker(id, { tiempoMs })}
        />
      )}

      {pantalla === 'proyectos' && (
        <ProjectsScreen
          controller={controller}
          cargando={cargando}
          error={errorCarga}
          onCargarZip={cargarZip}
          onCerrar={() => estado && estado.tabs.length > 0 && setPantalla('ninguna')}
          puedeCerrar={!!estado && estado.tabs.length > 0}
        />
      )}

      {pantalla === 'conexion' && <ConnectionPanel onCerrar={() => setPantalla('ninguna')} />}
    </div>
  )
}
