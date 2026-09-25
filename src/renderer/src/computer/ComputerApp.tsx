import { useEffect, useRef, useState } from 'react'
import { FileArchive, FolderOpen, ListMusic, Smartphone } from 'lucide-react'
import type { AppController } from '../app/useAppController'
import { getPlayheadMs } from '../app/playheadStore'
import { useConfirmar } from '../ui/Confirmar'
import { Avisos } from '../ui/Avisos'
import { TopBar } from './TopBar'
import { Transport } from './Transport'
import { Mixer } from './Mixer'
import { MarkersPanel } from './MarkersPanel'
import { ConnectionPanel } from './ConnectionPanel'
import { ProjectsScreen } from './ProjectsScreen'
import { ShortcutsModal } from './ShortcutsModal'

type Ventana = null | { tipo: 'canciones' | 'setlists' } | { tipo: 'conexion' } | { tipo: 'atajos' }

/** Solo los campos donde se escribe texto "se comen" el teclado; faders, botones y casillas no. */
function escribiendoTexto(el: EventTarget | null): boolean {
  const h = el as HTMLElement | null
  if (!h) return false
  if (h.isContentEditable || h.tagName === 'TEXTAREA') return true
  if (h.tagName !== 'INPUT') return false
  const tipo = (h as HTMLInputElement).type
  return ['text', 'search', 'number', 'email', 'password', 'url', ''].includes(tipo)
}

export function ComputerApp({ controller }: { controller: AppController }) {
  const { estado } = controller
  const confirmar = useConfirmar()
  const [ventana, setVentana] = useState<Ventana>(null)
  const proyecto = estado?.proyectoActivo ?? null
  const sonando = estado?.playbackActivo?.estado === 'playing'

  // Los atajos se registran una sola vez y leen siempre lo mas nuevo por ref.
  const ctx = useRef({ controller, ventana, proyecto })
  ctx.current = { controller, ventana, proyecto }
  const cancionRelativaRef = useRef<(delta: number) => void>(() => {})

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const { controller: c, ventana: v, proyecto: p } = ctx.current
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (escribiendoTexto(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        setVentana({ tipo: 'atajos' })
        return
      }
      if (v || document.querySelector('[data-modal]')) return // con una ventana abierta, solo Esc (lo maneja el Modal)
      if (!p) return
      const accion = ((): (() => void) | null => {
        switch (e.code) {
          case 'Space':
            return c.togglePlay
          case 'Enter':
          case 'NumpadEnter':
            return c.stop
          case 'ArrowLeft':
            return () => c.saltarSeccion(-1)
          case 'ArrowRight':
            return () => c.saltarSeccion(1)
          case 'PageDown':
            return () => cancionRelativaRef.current(1)
          case 'PageUp':
            return () => cancionRelativaRef.current(-1)
          case 'KeyM':
            return () => c.createMarker(getPlayheadMs())
          case 'KeyL':
            return () => c.setLoop(!c.estado?.loop)
        }
        const n = /^(Digit|Numpad)([1-9])$/.exec(e.code)
        if (n) return () => c.irASeccion(Number(n[2]))
        return null
      })()
      if (accion) {
        e.preventDefault()
        // que un boton con foco no reciba ademas el Espacio/Enter
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        accion()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** Cambiar de cancion con otra sonando corta el audio de todos: se confirma (un click de mas en vivo es un desastre). */
  async function cambiarCancion(tabId: string | undefined): Promise<void> {
    const actual = ctx.current.controller.estado
    const destino = actual?.tabs.find((t) => t.tabId === tabId)
    if (!actual || !destino || destino.tabId === actual.activeTabId) return
    if (actual.playbackActivo?.estado === 'playing') {
      const ok = await confirmar({
        titulo: 'La canción está sonando',
        mensaje: (
          <>
            Si pasás a <b>{destino.nombre}</b>, se corta el audio en todos los celulares.
          </>
        ),
        confirmar: `Pasar a ${destino.nombre}`,
        peligro: true
      })
      if (!ok) return
    }
    ctx.current.controller.switchTab(destino.tabId)
  }
  const cambiarRef = useRef(cambiarCancion)
  cambiarRef.current = cambiarCancion

  function cancionRelativa(delta: number): void {
    const e = ctx.current.controller.estado
    if (!e) return
    const i = e.tabs.findIndex((t) => t.tabId === e.activeTabId)
    void cambiarRef.current(e.tabs[i + delta]?.tabId)
  }

  cancionRelativaRef.current = cancionRelativa

  async function cerrarCancion(tabId: string): Promise<void> {
    const tab = estado?.tabs.find((t) => t.tabId === tabId)
    if (tab && tabId === estado?.activeTabId && sonando) {
      const ok = await confirmar({
        titulo: 'La canción está sonando',
        mensaje: (
          <>
            Si quitás <b>{tab.nombre}</b> del setlist, se corta el audio en todos los celulares. (La canción sigue guardada.)
          </>
        ),
        confirmar: 'Cortar y quitar',
        peligro: true
      })
      if (!ok) return
    }
    controller.closeTab(tabId)
  }

  const secciones = controller.secciones

  return (
    <div className="compu">
      <TopBar
        tabs={estado?.tabs ?? []}
        activeTabId={estado?.activeTabId ?? null}
        sonando={sonando}
        onSwitch={(tabId) => void cambiarCancion(tabId)}
        onClose={cerrarCancion}
        onReorder={controller.reorderTabs}
        onNueva={() => setVentana({ tipo: 'canciones' })}
        dispositivos={controller.dispositivos}
        onDispositivos={() => setVentana({ tipo: 'conexion' })}
        locked={estado?.locked ?? false}
        onLocked={controller.setLocked}
        sonidoLocal={controller.sonidoLocal}
        onSonidoLocal={controller.setSonidoLocal}
        onAyuda={() => setVentana({ tipo: 'atajos' })}
      />

      {!controller.conectado && estado && (
        <div className="aviso aviso-error" style={{ borderRadius: 0, animation: 'none' }}>
          Reconectando con el servidor…
        </div>
      )}

      {proyecto ? (
        <>
          <Transport
            key={proyecto.id}
            proyecto={proyecto}
            secciones={secciones}
            playback={estado?.playbackActivo ?? null}
            loop={estado?.loop ?? false}
            siguienteProyecto={controller.siguienteProyecto}
            driftMs={controller.driftMs}
            sonidoLocal={controller.sonidoLocal}
            onTogglePlay={controller.togglePlay}
            onStop={controller.stop}
            onSeek={controller.seek}
            onSeccion={controller.saltarSeccion}
            onLoop={controller.setLoop}
            onSiguienteCancion={() => cancionRelativa(1)}
            onRenombrar={(n) => controller.renameProject(proyecto.id, n)}
            onMoverMarcador={(id, ms, sinAjustar) => controller.updateMarker(id, { tiempoMs: ms }, sinAjustar)}
            ajustarCompas={controller.ajustarCompas}
            onAjustarCompas={controller.setAjustarCompas}
          />
          <main className="compu-main">
            <Mixer proyecto={proyecto} onUpdate={controller.updateMixer} onReorder={controller.reorderPistas} />
            <MarkersPanel
              secciones={secciones}
              onJump={controller.jumpToMarker}
              onCreate={controller.createMarker}
              onRename={(id, nombre) => controller.updateMarker(id, { nombre })}
              onDelete={controller.deleteMarker}
            />
          </main>
        </>
      ) : (
        <div className="compu-vacio">
          <div className="vacio-tarjeta">
            <div className="icono-grande">
              <ListMusic size={32} />
            </div>
            <h2>Armá el setlist</h2>
            <p>
              Importá una canción (un .zip con una pista por archivo) o abrí una ya guardada. El audio sale de los celulares:
              conectalos con el código QR de <b>Celulares</b>.
            </p>
            <div className="vacio-acciones">
              <button className="btn-primario" onClick={() => setVentana({ tipo: 'canciones' })}>
                <FileArchive size={17} /> Importar o abrir canción
              </button>
              <button onClick={() => setVentana({ tipo: 'setlists' })}>
                <FolderOpen size={17} /> Abrir un setlist
              </button>
              <button onClick={() => setVentana({ tipo: 'conexion' })}>
                <Smartphone size={17} /> Conectar celulares
              </button>
            </div>
          </div>
        </div>
      )}

      {ventana && (ventana.tipo === 'canciones' || ventana.tipo === 'setlists') && (
        <ProjectsScreen controller={controller} vistaInicial={ventana.tipo} onCerrar={() => setVentana(null)} />
      )}
      {ventana?.tipo === 'conexion' && (
        <ConnectionPanel
          dispositivos={controller.dispositivos}
          sonando={sonando}
          onOlvidar={controller.forgetDevice}
          onCerrar={() => setVentana(null)}
        />
      )}
      {ventana?.tipo === 'atajos' && <ShortcutsModal onCerrar={() => setVentana(null)} />}

      <Avisos avisos={controller.avisos} onCerrar={controller.cerrarAviso} />
    </div>
  )
}
