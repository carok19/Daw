import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Headphones,
  ListMusic,
  Lock,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Rows3,
  Settings,
  SkipBack,
  SkipForward,
  UserPlus,
  Volume2,
  VolumeX,
  WifiOff,
  X
} from 'lucide-react'
import type { Proyecto, SaltoPendiente } from '@shared/types'
import { seccionEn } from '@shared/playback'
import type { AppController } from '../app/useAppController'
import { usePlayheadMs, usePlayheadPaso } from '../app/playheadStore'
import { leerPref } from '../app/preferencias'
import { clavePista } from '../audio/PlaybackEngine'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Avisos } from '../ui/Avisos'
import { FaderTactil } from '../ui/FaderTactil'
import { useConfirmar } from '../ui/Confirmar'
import { useWakeLock } from './useWakeLock'
import { Hoja, HojaAjustes } from './Hojas'
import { Toggle } from '../ui/Toggle'
import { pistasClickYGuia } from '@shared/mezcla'
import { AccesoFijo, HojaInvitar, PantallaCodigo, PantallaLicencia } from './Conectar'
import { enPantallaDeInicio, esAndroid, esIOS, puenteAndroid } from '../conexion'

type HojaAbierta = null | 'ajustes' | 'secciones' | 'canciones' | 'invitar'

/**
 * Celular: lo que el musico toca es SU mezcla, asi que es la pantalla
 * principal. La cancion, la seccion y el transporte van en una barra
 * flotante abajo (con las secciones y las canciones a un toque).
 */
export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado } = controller
  const [hoja, setHoja] = useState<HojaAbierta>(null)
  const wake = useWakeLock()
  const proyecto = estado?.proyectoActivo ?? null
  // dentro de la app Android: el audio arranca solo y la pantalla la mantiene encendida la app
  const app = puenteAndroid()
  const [mostrarActivar, setMostrarActivar] = useState(!app)
  const activarAudio = controller.activarAudio
  useEffect(() => {
    if (!app) return
    void activarAudio()
    // si el sistema igual pidio un toque, aparece el boton
    const t = setTimeout(() => setMostrarActivar(true), 1500)
    return () => clearTimeout(t)
  }, [app, activarAudio])

  const miEtiqueta = useMemo(() => {
    const id = `celular:${leerPref<string>('device-id', '')}`
    return controller.dispositivos.find((d) => d.id === id)?.etiqueta ?? 'Este celular'
  }, [controller.dispositivos])

  async function empezar(): Promise<void> {
    if (!app) wake.activar() // tiene que ser dentro del toque del usuario
    await controller.activarAudio()
  }

  return (
    <div className={`mobile ${proyecto ? 'con-barra' : ''}`}>
      <div className="m-top">
        <span className="m-conexion">
          <span className={`punto ${conectado ? 'verde' : 'rojo'}`} />
          <strong>{miEtiqueta}</strong>
        </span>
        <button onClick={() => setHoja('invitar')} disabled={!conectado} aria-label="Invitar a alguien">
          <UserPlus size={18} /> Invitar
        </button>
        <button onClick={() => setHoja('ajustes')} aria-label="Ajustes">
          <Settings size={18} />
        </button>
      </div>

      {!conectado && (
        <div className="m-alerta error">
          <WifiOff size={20} />
          <span>Sin conexión con la computadora. Reconectando… (revisá que el celular siga en el mismo WiFi)</span>
        </div>
      )}
      {controller.errorAudio && (
        <div className="m-alerta error">
          <AlertTriangle size={20} />
          <span>Problema de audio en {controller.errorAudio}. Avisale al que maneja la compu.</span>
        </div>
      )}
      {controller.bufferEstado === 'critico' && !controller.errorAudio && (
        <div className="m-alerta warn">
          <AlertTriangle size={20} />
          <span>El WiFi está lento: el audio puede cortarse. Acercate al router si podés.</span>
        </div>
      )}

      {proyecto ? (
        <Mezcla controller={controller} proyecto={proyecto} />
      ) : (
        <>
          <div className="m-esperando">
            <Headphones size={40} color="var(--text-3)" />
            <strong>Esperando canción…</strong>
            <span>Cuando la computadora elija una canción aparece acá.</span>
          </div>
          <CanalGeneral controller={controller} />
        </>
      )}

      {proyecto && <BarraFlotante controller={controller} onHoja={setHoja} />}

      {!controller.audioActivo && mostrarActivar && (
        <div className="activar">
          <h1>{proyecto?.nombre ?? 'AirTracks'}</h1>
          <p>Conectá los auriculares y tocá el botón. La pantalla va a quedar encendida mientras uses la app.</p>
          <button className="activar-boton" onClick={empezar}>
            <Headphones size={40} />
            Tocá para empezar
          </button>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            <span className={`punto ${conectado ? 'verde' : 'rojo'}`} /> {conectado ? 'Conectado a la computadora' : 'Conectando…'}
          </p>
          {!app && !enPantallaDeInicio() && (esIOS() || esAndroid()) && conectado && <ProximaVez controller={controller} />}
        </div>
      )}

      {hoja === 'ajustes' && (
        <HojaAjustes
          controller={controller}
          etiqueta={miEtiqueta}
          pantallaEncendida={!!app || wake.activo}
          accesoFijo={<AccesoFijo controller={controller} />}
          onCerrar={() => setHoja(null)}
        />
      )}
      {hoja === 'invitar' && <HojaInvitar controller={controller} onCerrar={() => setHoja(null)} />}
      {hoja === 'secciones' && proyecto && <HojaSecciones controller={controller} onCerrar={() => setHoja(null)} />}
      {hoja === 'canciones' && <HojaCanciones controller={controller} onCerrar={() => setHoja(null)} />}

      {controller.pedidoCodigo && <PantallaCodigo controller={controller} />}
      {controller.pedidoLicencia && !controller.conectado && <PantallaLicencia controller={controller} />}

      <Avisos avisos={controller.avisos} onCerrar={controller.cerrarAviso} />
    </div>
  )
}

/** En la pantalla de inicio: como no escanear el QR en el proximo ensayo (plegado). */
function ProximaVez({ controller }: { controller: AppController }) {
  const [abierto, setAbierto] = useState(false)
  if (!abierto) {
    return (
      <button className="btn-fantasma activar-proxima-boton" onClick={() => setAbierto(true)}>
        ¿La próxima vez sin escanear el QR?
      </button>
    )
  }
  return (
    <div className="activar-proxima">
      <AccesoFijo controller={controller} />
    </div>
  )
}

// ---------- Mi mezcla (pantalla principal) ----------

function textoGanancia(pct: number): string {
  return pct === 100 ? 'igual' : `${pct}%`
}

function CanalGeneral({ controller }: { controller: AppController }) {
  const v = controller.volumenGeneral
  return (
    <div className="m-canal m-canal-general">
      <div className="m-canal-cabeza">
        <Volume2 size={17} />
        <span className="m-canal-nombre">Volumen de este celular</span>
        <small className="num">{v}%</small>
      </div>
      <FaderTactil valor={v} min={0} max={100} etiqueta="Volumen de este celular" onCambio={controller.setVolumenGeneral} />
    </div>
  )
}

function Mezcla({ controller, proyecto }: { controller: AppController; proyecto: Proyecto }) {
  const mezcla = controller.mezclaPersonal
  const hayCambios = Object.keys(mezcla).length > 0
  const haySolo = proyecto.pistas.some((p) => p.solo)
  const separar = controller.clickIzquierda
  const izquierda = useMemo(() => pistasClickYGuia(proyecto), [proyecto])
  const nombresIzquierda = proyecto.pistas.filter((p) => izquierda.has(p.id)).map((p) => p.nombre)

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
    <section className="m-mezcla" aria-label="Mi mezcla">
      <div className="m-mezcla-cabecera">
        <div>
          <h2>Mi mezcla</h2>
          <span>Solo cambia lo que escuchás vos</span>
        </div>
        <button disabled={!hayCambios} onClick={() => controller.setMezclaPersonal({})} title="Volver a la mezcla de la computadora">
          <RotateCcw size={15} /> Igual que la compu
        </button>
      </div>
      <CanalGeneral controller={controller} />
      <div className={`m-split ${separar ? 'activo' : ''}`}>
        <Toggle activo={separar} onCambiar={controller.setClickIzquierda}>
          Click y guía a la izquierda
        </Toggle>
        <span className="m-split-detalle">
          {nombresIzquierda.length === 0
            ? 'En esta canción no se encontró el click ni la guía (se pueden marcar en la compu).'
            : separar
              ? `Izquierda: ${nombresIzquierda.join(', ')}. Derecha: el resto de la banda.`
              : `Mandá ${nombresIzquierda.join(', ')} al oído izquierdo y la banda al derecho.`}
        </span>
      </div>
      {proyecto.pistas.map((p) => {
        const ajuste = mezcla[clavePista(p.nombre)] ?? { ganancia: 1, mute: false }
        const pct = Math.round(ajuste.ganancia * 100)
        const apagadaEnCompu = p.mute || (haySolo && !p.solo)
        return (
          <div key={p.id} className={`m-canal ${ajuste.mute ? 'muteado' : ''}`}>
            <div className="m-canal-cabeza">
              <span className="punto" style={{ background: p.color }} />
              <span className="m-canal-nombre">{p.nombre}</span>
              {apagadaEnCompu && <span className="m-canal-aviso">apagada en la compu</span>}
              {separar && !apagadaEnCompu && <span className="m-canal-lado">{izquierda.has(p.id) ? 'izq.' : 'der.'}</span>}
              <small className="num">{ajuste.mute ? 'muda' : textoGanancia(pct)}</small>
            </div>
            <div className="m-canal-control">
              <FaderTactil
                valor={pct}
                min={0}
                max={200}
                neutro={100}
                paso={5}
                color={p.color}
                deshabilitado={ajuste.mute}
                etiqueta={`Volumen de ${p.nombre} en este celular`}
                onCambio={(v) => set(p.nombre, { ganancia: v / 100 })}
              />
              <button
                className={`m-mute ${ajuste.mute ? 'activo' : ''}`}
                onClick={() => set(p.nombre, { mute: !ajuste.mute })}
                aria-pressed={ajuste.mute}
                aria-label={`${ajuste.mute ? 'Volver a escuchar' : 'Silenciar'} ${p.nombre} en este celular`}
              >
                {ajuste.mute ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
            </div>
          </div>
        )
      })}
      <p className="m-mezcla-pie">
        Deslizá los faders de costado (para arriba o abajo, la pantalla se mueve sin tocar nada). Doble toque: vuelve a “igual”. La
        mezcla la arma la compu para este celular: los cambios se escuchan en menos de un segundo. Se recuerda por nombre de pista,
        para todas las canciones.
      </p>
    </section>
  )
}

// ---------- barra flotante: cancion, seccion y transporte ----------

function faltaPara(salto: SaltoPendiente, pos: number): string {
  const s = Math.max(0, Math.ceil((salto.limiteMs - pos) / 1000))
  return s <= 0 ? 'ya' : `en ${s} s`
}

function BarraFlotante({ controller, onHoja }: { controller: AppController; onHoja: (h: HojaAbierta) => void }) {
  const { estado, secciones } = controller
  const proyecto = estado!.proyectoActivo!
  const pos = usePlayheadPaso(200)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  const locked = estado?.locked ?? false
  const loop = estado?.loop ?? false
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const salto = estado?.saltoPendiente ?? null
  const cantidadCanciones = estado?.tabs.length ?? 0

  return (
    <div className="m-barra" role="region" aria-label="Canción y transporte">
      <button className="m-barra-info" onClick={() => onHoja('secciones')} aria-label="Ver secciones">
        <span className="m-barra-fila">
          <span className="m-barra-cancion">{proyecto.nombre}</span>
          <span className="m-barra-tiempo num">
            {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
          </span>
        </span>
        <span className="m-barra-fila">
          <span className="m-barra-seccion" style={{ color: actual ? colorClaro(colorDeSeccion(actual)) : undefined }}>
            {loop && <Repeat size={15} />}
            {actual?.nombre ?? '—'}
          </span>
          {salto ? (
            <span className="m-barra-salto">
              <ArrowRight size={14} /> {salto.nombre} <span className="num">{faltaPara(salto, pos)}</span>
            </span>
          ) : (
            <span className="m-barra-sigue">{loop ? 'repitiendo' : siguiente ? `sigue ${siguiente.nombre}` : 'última sección'}</span>
          )}
        </span>
        <MiniTimeline controller={controller} />
      </button>
      <div className="m-barra-botones">
        {locked ? (
          <span className="m-barra-bloqueado">
            <Lock size={15} /> Control en la compu
          </span>
        ) : (
          <>
            <button onClick={() => controller.saltarSeccion(-1)} aria-label="Sección anterior">
              <SkipBack size={20} />
            </button>
            <button className={`m-play ${sonando ? 'sonando' : ''}`} onClick={controller.togglePlay} aria-label={sonando ? 'Pausa' : 'Reproducir'}>
              {sonando ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
            <button onClick={() => controller.saltarSeccion(1)} aria-label="Sección siguiente">
              <SkipForward size={20} />
            </button>
            <button className={`m-loop ${loop ? 'activo' : ''}`} onClick={() => controller.setLoop(!loop)} aria-pressed={loop} aria-label="Repetir sección">
              <Repeat size={19} />
            </button>
          </>
        )}
        <button onClick={() => onHoja('secciones')} aria-label="Secciones">
          <Rows3 size={19} />
        </button>
        <button onClick={() => onHoja('canciones')} aria-label="Canciones del setlist">
          <ListMusic size={19} />
          {cantidadCanciones > 1 && <span className="m-barra-cuenta num">{cantidadCanciones}</span>}
        </button>
      </div>
    </div>
  )
}

function MiniTimeline({ controller }: { controller: AppController }) {
  const { secciones, estado } = controller
  const dur = Math.max(estado?.proyectoActivo?.duracionTotalMs ?? 1, 1)
  const pos = usePlayheadMs()
  const actual = seccionEn(secciones, pos)
  const salto = estado?.saltoPendiente ?? null
  return (
    <span className="m-timeline" aria-hidden>
      {secciones.map((s) => (
        <span
          key={s.marcador?.id ?? 'inicio'}
          className={`${actual?.indice === s.indice ? 'actual' : ''} ${salto?.destinoMs === s.inicioMs ? 'destino' : ''}`}
          style={{ width: `${((s.finMs - s.inicioMs) / dur) * 100}%`, background: colorDeSeccion(s) }}
        />
      ))}
      {salto && <span className="m-salto-limite" style={{ left: `${Math.min(100, (salto.limiteMs / dur) * 100)}%` }} />}
      <span className="m-playhead" style={{ left: `${Math.min(100, (pos / dur) * 100)}%` }} />
    </span>
  )
}

// ---------- hojas: secciones y canciones ----------

function HojaSecciones({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const pos = usePlayheadPaso(200)
  const { estado } = controller
  const locked = estado?.locked ?? false
  const salto = estado?.saltoPendiente ?? null
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const modo = estado?.modoSalto ?? 'seccion'
  const conMarcador = controller.secciones.filter((s) => s.marcador)
  const actual = seccionEn(controller.secciones, pos)
  const explicacion =
    modo === 'inmediato'
      ? 'Tocá una sección para ir ahí.'
      : modo === 'compas'
        ? 'Sonando, el salto se hace en el próximo compás.'
        : 'Sonando, la sección actual termina y sigue la que elijas, sin cortes.'

  return (
    <Hoja titulo="Secciones" onCerrar={onCerrar}>
      {locked && (
        <p className="ayuda">
          <Lock size={14} /> El control lo tiene la computadora.
        </p>
      )}
      {!locked && sonando && <p className="ayuda" style={{ marginTop: 0 }}>{explicacion}</p>}
      {salto && (
        <div className="m-salto-aviso">
          <ArrowRight size={16} />
          <span>
            Sigue <b>{salto.nombre}</b> <span className="num">{faltaPara(salto, pos)}</span>
          </span>
          {!locked && (
            <button onClick={controller.cancelarSalto}>
              <X size={15} /> Cancelar
            </button>
          )}
        </div>
      )}
      {conMarcador.length === 0 ? (
        <p className="vacio">Esta canción todavía no tiene secciones marcadas.</p>
      ) : (
        <div className="m-marcadores">
          {conMarcador.map((s) => (
            <button
              key={s.marcador!.id}
              className={`m-marcador ${actual?.indice === s.indice ? 'actual' : ''} ${salto?.destinoMs === s.inicioMs ? 'pendiente' : ''}`}
              style={{ '--color-seccion': colorDeSeccion(s) } as React.CSSProperties}
              disabled={locked}
              onClick={() => controller.jumpToMarker(s.marcador!.id)}
            >
              <span>{s.nombre}</span>
            </button>
          ))}
        </div>
      )}
    </Hoja>
  )
}

function HojaCanciones({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const confirmar = useConfirmar()
  const { estado } = controller
  const locked = estado?.locked ?? false
  const tabs = estado?.tabs ?? []
  const iActiva = tabs.findIndex((t) => t.tabId === estado?.activeTabId)

  async function pasarA(tabId: string, nombre: string): Promise<void> {
    if (tabId === estado?.activeTabId) return onCerrar()
    if (estado?.playbackActivo?.estado === 'playing') {
      const ok = await confirmar({
        titulo: 'La canción está sonando',
        mensaje: (
          <>
            Si pasás a <b>{nombre}</b>, se corta el audio en todos los celulares.
          </>
        ),
        confirmar: `Pasar a ${nombre}`,
        peligro: true
      })
      if (!ok) return
    }
    controller.switchTab(tabId)
    onCerrar()
  }

  return (
    <Hoja titulo="Canciones" onCerrar={onCerrar}>
      {locked && (
        <p className="ayuda">
          <Lock size={14} /> El control lo tiene la computadora.
        </p>
      )}
      <ol className="m-canciones">
        {tabs.map((t, i) => (
          <li key={t.tabId}>
            <button className={i === iActiva ? 'activa' : ''} disabled={locked && i !== iActiva} onClick={() => void pasarA(t.tabId, t.nombre)}>
              <span className="num">{i + 1}</span>
              <span className="m-canciones-nombre">{t.nombre}</span>
              {i === iActiva ? <small>ahora</small> : i === iActiva + 1 ? <small>sigue</small> : null}
            </button>
          </li>
        ))}
      </ol>
    </Hoja>
  )
}

/** Version mas clara de un color de seccion, para texto sobre fondo oscuro. */
function colorClaro(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const mezclar = (c: number): number => Math.round(c + (255 - c) * 0.45)
  return `rgb(${mezclar((n >> 16) & 255)}, ${mezclar((n >> 8) & 255)}, ${mezclar(n & 255)})`
}
