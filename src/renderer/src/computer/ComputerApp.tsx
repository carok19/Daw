import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, AudioLines, Square } from 'lucide-react'
import type { AppController } from '../app/useAppController'
import { getPlayheadMs } from '../app/playheadStore'
import { useConfirmar } from '../ui/Confirmar'
import { Avisos } from '../ui/Avisos'
import { TopBar } from './TopBar'
import { Transport } from './Transport'
import { Mixer } from './Mixer'
import { MarkersPanel } from './MarkersPanel'
import { ConnectionPanel } from './ConnectionPanel'
import { LicenciaPanel } from './LicenciaPanel'
import { ProjectsScreen } from './ProjectsScreen'
import { ShortcutsModal } from './ShortcutsModal'
import { ListaEditor, ListasScreen } from './Listas'

type Ventana = null | { tipo: 'canciones' } | { tipo: 'conexion' } | { tipo: 'atajos' } | { tipo: 'licencia' }
/** escenario = la cancion (mixer, secciones); listas = las listas por dia; editar = armar una lista */
type Vista = { tipo: 'escenario' } | { tipo: 'listas' } | { tipo: 'editar'; listaId: string }

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
  const [vistaElegida, setVista] = useState<Vista>({ tipo: 'escenario' })
  const proyecto = estado?.proyectoActivo ?? null
  const sonando = estado?.playbackActivo?.estado === 'playing'
  // sin canciones arriba (al abrir el programa, o si se cerraron todas): las listas
  const vista: Vista = vistaElegida.tipo === 'escenario' && estado && estado.tabs.length === 0 ? { tipo: 'listas' } : vistaElegida

  // Los atajos se registran una sola vez y leen siempre lo mas nuevo por ref.
  const ctx = useRef({ controller, ventana, proyecto, vista })
  ctx.current = { controller, ventana, proyecto, vista }
  const cancionRelativaRef = useRef<(delta: number) => void>(() => {})

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const { controller: c, ventana: v, proyecto: p, vista: vi } = ctx.current
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (escribiendoTexto(e.target)) return
      if (e.key === '?') {
        e.preventDefault()
        setVentana({ tipo: 'atajos' })
        return
      }
      if (v || document.querySelector('[data-modal]')) return // con una ventana abierta, solo Esc (lo maneja el Modal)
      if (!p || vi.tipo !== 'escenario') return // armando listas: las teclas no tocan la musica
      const accion = ((): (() => void) | null => {
        switch (e.code) {
          case 'Space':
            return c.togglePlay
          case 'Enter':
          case 'NumpadEnter':
            return c.stop
          case 'ArrowLeft':
            return () => c.saltarSeccion(-1, e.shiftKey)
          case 'ArrowRight':
            return () => c.saltarSeccion(1, e.shiftKey)
          case 'Escape':
            return c.estado?.saltoPendiente ? c.cancelarSalto : null
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
        if (n) return () => c.irASeccion(Number(n[2]), e.shiftKey)
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

  /** "Detectar": vuelve a analizar la cancion y reemplaza las secciones (si hay, se confirma). */
  async function detectarSecciones(): Promise<void> {
    if (!proyecto) return
    const cuantas = proyecto.marcadores.length
    if (cuantas > 0) {
      const ok = await confirmar({
        titulo: 'Detectar secciones',
        mensaje: (
          <>
            Se va a escuchar la voz guía de <b>{proyecto.nombre}</b> y, si se reconocen secciones, reemplazan a las{' '}
            {cuantas === 1 ? 'que ya está marcada' : `${cuantas} que ya están marcadas`}.
          </>
        ),
        confirmar: 'Detectar y reemplazar'
      })
      if (!ok) return
    }
    controller.detectarSecciones(proyecto.id)
    if (sonando) controller.avisar({ tipo: 'info', texto: 'El análisis arranca cuando pare la música (no le saca potencia al vivo).' })
  }

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
        licencia={controller.licencia}
        onLicencia={() => setVentana({ tipo: 'licencia' })}
        lista={estado?.lista ?? null}
        viendoListas={vista.tipo !== 'escenario'}
        onListas={() => setVista(vista.tipo === 'escenario' ? { tipo: 'listas' } : { tipo: 'escenario' })}
      />

      {!controller.conectado && estado && (
        <div className="aviso aviso-error" style={{ borderRadius: 0, animation: 'none' }}>
          Reconectando con el servidor…
        </div>
      )}

      {vista.tipo !== 'escenario' && sonando && proyecto && (
        <div className="barra-sonando">
          <AudioLines size={16} />
          <span>
            Sonando: <b>{proyecto.nombre}</b>
          </span>
          <button className="btn-chico" onClick={controller.stop}>
            <Square size={13} /> Parar
          </button>
          <button className="btn-chico" onClick={() => setVista({ tipo: 'escenario' })}>
            <ArrowLeft size={13} /> Volver al escenario
          </button>
        </div>
      )}

      {vista.tipo === 'listas' ? (
        <ListasScreen
          controller={controller}
          onUsada={() => setVista({ tipo: 'escenario' })}
          onEditar={(listaId) => setVista({ tipo: 'editar', listaId })}
          onCanciones={() => setVentana({ tipo: 'canciones' })}
          onVolver={proyecto ? () => setVista({ tipo: 'escenario' }) : null}
        />
      ) : vista.tipo === 'editar' ? (
        <ListaEditor
          key={vista.listaId}
          controller={controller}
          listaId={vista.listaId}
          onListo={() => setVista({ tipo: 'listas' })}
          onUsada={() => setVista({ tipo: 'escenario' })}
        />
      ) : proyecto ? (
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
            saltoPendiente={estado?.saltoPendiente ?? null}
            onCancelarSalto={controller.cancelarSalto}
          />
          <main className="compu-main">
            <Mixer proyecto={proyecto} onUpdate={controller.updateMixer} onReorder={controller.reorderPistas} />
            <MarkersPanel
              secciones={secciones}
              analisis={proyecto.analisis ?? null}
              progreso={controller.progresoAnalisis[proyecto.id] ?? null}
              modeloVoz={controller.modeloVoz}
              sonando={sonando}
              onJump={controller.jumpToMarker}
              saltoPendiente={estado?.saltoPendiente ?? null}
              modoSalto={estado?.modoSalto ?? 'seccion'}
              hayTempo={!!proyecto.tempo}
              onModoSalto={controller.setModoSalto}
              onCancelarSalto={controller.cancelarSalto}
              onCreate={controller.createMarker}
              onRename={(id, nombre) => controller.updateMarker(id, { nombre })}
              onDelete={controller.deleteMarker}
              onDetectar={() => void detectarSecciones()}
              onDescargarModelo={controller.descargarModeloVoz}
            />
          </main>
        </>
      ) : null}

      {ventana?.tipo === 'canciones' && <ProjectsScreen controller={controller} onCerrar={() => setVentana(null)} />}
      {ventana?.tipo === 'conexion' && (
        <ConnectionPanel
          controller={controller}
          sonando={sonando}
          onCerrar={() => setVentana(null)}
          onLicencia={() => setVentana({ tipo: 'licencia' })}
        />
      )}
      {ventana?.tipo === 'licencia' && <LicenciaPanel controller={controller} onCerrar={() => setVentana(null)} />}
      {ventana?.tipo === 'atajos' && <ShortcutsModal onCerrar={() => setVentana(null)} />}

      <Avisos avisos={controller.avisos} onCerrar={controller.cerrarAviso} />
    </div>
  )
}
