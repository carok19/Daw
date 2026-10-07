import { useEffect, useMemo, useState } from 'react'
import {
  AudioLines,
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Headphones,
  LayoutGrid,
  ListMusic,
  Lock,
  Megaphone,
  Metronome,
  Mic,
  Music4,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Rows3,
  Settings,
  SkipBack,
  SkipForward,
  SlidersVertical,
  Square,
  UserPlus,
  Volume2,
  Waves,
  WifiOff,
  X
} from 'lucide-react'
import type { ColchonActivo, Proyecto, RolDispositivo } from '@shared/types'
import { bpmDistintoEnSeccion, compasesQueFaltan, seccionEn, textoQueFaltan } from '@shared/playback'
import type { AppController } from '../app/useAppController'
import { useGolpeColchon, useGolpeCuenta, usePlayheadPaso } from '../app/playheadStore'
import { leerPref } from '../app/preferencias'
import { clavePista, type AjustePersonal } from '../audio/PlaybackEngine'
import { CLAVE_GRUPO, fueraDelSolo, tipoDePista, type MezclaPersonal } from '@shared/mezcla'
import { VOLUMEN_MAX } from '../audio/streamConfig'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Avisos } from '../ui/Avisos'
import { FaderTactil } from '../ui/FaderTactil'
import { useConfirmar } from '../ui/Confirmar'
import { useWakeLock } from './useWakeLock'
import { useOnda } from '../ui/Onda'
import { textoPorcentaje, velocidadAplicada } from '@shared/velocidad'
import { guardarPref } from '../app/preferencias'
import { Hoja, HojaAjustes } from './Hojas'
import { AbrirEnApp, AccesoFijo, HojaInvitar, PantallaCodigo, PantallaLicencia } from './Conectar'
import { AvisoTono, avisoDeTono, cambioDeTono, colorClaro, faltaPara, largoDeSeccion, MiniTimeline, TonoQueSuena } from './Comunes'
import { ChipRol, ElegirRol, INFO_ROL } from './Roles'
import { VistaSonido } from './VistaSonido'
import { VistaMultimedia, VistaVoz } from './VistasRol'
import { enPantallaDeInicio, esAndroid, esIOS, puenteAndroid } from '../conexion'
import { PulsoColchon, textoColchon, textoCompasColchon } from '../ui/Colchon'
import { estadoTerminar, IconoFundido, textoCuandoTermina } from '../ui/Fundido'
import { SALIDA_PAD_VUELTA_MS } from '@shared/colchon'
import { FADER_VIVO } from '@shared/audioVivo'

type HojaAbierta = null | 'ajustes' | 'secciones' | 'canciones' | 'invitar'
/** La cancion (por donde va y sus secciones) o "Mi mezcla" a pantalla completa. */
type VistaCelular = 'cancion' | 'mezcla'

/**
 * Celular: cada uno ve lo suyo segun su rol (ver Roles.tsx). Director y
 * musico: la cancion (el recorrido con la forma de onda y las secciones como
 * tarjetas grandes; el director las toca para ir ahi) y "Mi mezcla" en otra
 * pantalla, a un toque. Voz: la seccion, lo que sigue y el tono, bien grandes.
 * Sonido: la consola (banda sola, vumetro, bloqueo). Multimedia: que sigue y
 * cuanto falta, sin audio.
 */
export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado, rol } = controller
  const [hoja, setHoja] = useState<HojaAbierta>(null)
  const [vista, setVistaState] = useState<VistaCelular>(() => (leerPref<string>('vista-celular', 'cancion') === 'mezcla' ? 'mezcla' : 'cancion'))
  const setVista = (v: VistaCelular): void => {
    setVistaState(v)
    guardarPref('vista-celular', v)
    window.scrollTo({ top: 0 })
  }
  const wake = useWakeLock()
  const proyecto = estado?.proyectoActivo ?? null
  // dentro de la app Android: el audio arranca solo y la pantalla la mantiene encendida la app
  const app = puenteAndroid()
  const [mostrarActivar, setMostrarActivar] = useState(!app)
  const activarAudio = controller.activarAudio
  const [cambiandoRol, setCambiandoRol] = useState(false)
  const consola = rol === 'sonido'
  const multimedia = rol === 'multimedia'
  // multimedia: sin audio salvo que lo pida (igual hace falta un toque para que la pantalla no se apague)
  const necesitaAudio = !multimedia || controller.escucharMultimedia
  const [despierto, setDespierto] = useState(!!app)
  const [consolaBloqueada, setConsolaBloqueadaState] = useState<boolean>(() => leerPref('consola-bloqueada', false))
  const setConsolaBloqueada = (v: boolean): void => {
    setConsolaBloqueadaState(v)
    guardarPref('consola-bloqueada', v)
  }
  const bloqueada = consola && consolaBloqueada
  useEffect(() => {
    if (!app || !necesitaAudio || rol === null) return
    void activarAudio()
    // si el sistema igual pidio un toque, aparece el boton
    const t = setTimeout(() => setMostrarActivar(true), 1500)
    return () => clearTimeout(t)
  }, [app, activarAudio, necesitaAudio, rol])

  const miEtiqueta = useMemo(() => {
    const id = `celular:${leerPref<string>('device-id', '')}`
    return controller.dispositivos.find((d) => d.id === id)?.etiqueta ?? 'Este celular'
  }, [controller.dispositivos])

  async function empezar(): Promise<void> {
    if (!app) wake.activar() // tiene que ser dentro del toque del usuario
    setDespierto(true)
    if (necesitaAudio) await controller.activarAudio()
  }

  async function elegirRol(r: RolDispositivo): Promise<void> {
    controller.elegirRol(r)
    setCambiandoRol(false)
    window.scrollTo({ top: 0 })
    // el mismo toque arranca (audio y pantalla encendida) si todavia no estaba
    if (!app) wake.activar()
    setDespierto(true)
    if ((r !== 'multimedia' || controller.escucharMultimedia) && !controller.audioActivo) await controller.activarAudio()
  }

  const pedirInicio = rol !== null && !cambiandoRol && mostrarActivar && (necesitaAudio ? !controller.audioActivo : !despierto)
  // barra de abajo: el transporte del director (los demas, solo en "Mi mezcla": la cancion y la seccion a la vista)
  const conBarra = !!proyecto && !consola && !multimedia && (controller.puedeControlar || !!estado?.locked || vista === 'mezcla')

  return (
    <div className={`mobile ${conBarra ? 'con-barra' : ''} vista-${vista} ${rol ? `rol-${rol}` : ''}`}>
      <div className="m-top">
        <span className="m-conexion">
          <span className={`punto ${conectado ? 'verde' : 'rojo'}`} />
          <strong>{miEtiqueta}</strong>
        </span>
        <ChipRol rol={rol} onClick={() => setCambiandoRol(true)} deshabilitado={bloqueada} />
        {!consola && (
          <button onClick={() => setHoja('invitar')} disabled={!conectado} aria-label="Invitar a alguien">
            <UserPlus size={18} /> <span className="m-top-texto">Invitar</span>
          </button>
        )}
        <button onClick={() => setHoja('ajustes')} aria-label="Ajustes" disabled={bloqueada}>
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
      {controller.bufferEstado === 'critico' && !controller.errorAudio && !consola && (
        <div className="m-alerta warn">
          <AlertTriangle size={20} />
          <span>El WiFi está lento: el audio puede cortarse. Acercate al router si podés.</span>
        </div>
      )}

      {consola ? (
        <VistaSonido controller={controller} bloqueada={consolaBloqueada} onBloquear={setConsolaBloqueada} />
      ) : multimedia ? (
        <VistaMultimedia controller={controller} proyecto={proyecto} onHoja={setHoja} />
      ) : proyecto ? (
        <>
          <div className="m-vistas segmentado" role="tablist" aria-label="Pantalla">
            <button role="tab" aria-selected={vista === 'cancion'} className={vista === 'cancion' ? 'activo' : ''} onClick={() => setVista('cancion')}>
              <LayoutGrid size={17} /> Canción
            </button>
            <button role="tab" aria-selected={vista === 'mezcla'} className={vista === 'mezcla' ? 'activo' : ''} onClick={() => setVista('mezcla')}>
              <SlidersVertical size={17} /> Mi mezcla
            </button>
          </div>
          {vista === 'cancion' ? (
            proyecto.colchon ? (
              <VistaColchon controller={controller} proyecto={proyecto} />
            ) : rol === 'voz' ? (
              <VistaVoz controller={controller} proyecto={proyecto} onHoja={setHoja} />
            ) : (
              <VistaCancion controller={controller} proyecto={proyecto} onHoja={setHoja} onAjustes={() => setHoja('ajustes')} />
            )
          ) : (
            <Mezcla controller={controller} proyecto={proyecto} />
          )}
        </>
      ) : (
        <>
          <div className="m-esperando">
            <Headphones size={40} color="var(--text-3)" />
            <strong>Esperando canción…</strong>
            <span>Cuando la computadora elija una canción aparece acá.</span>
          </div>
          <CanalGeneral controller={controller} />
          <CanalTalkback controller={controller} />
          <CanalBanda controller={controller} />
        </>
      )}

      {conBarra && <BarraFlotante controller={controller} onHoja={setHoja} conInfo={vista === 'mezcla'} />}

      {pedirInicio && (
        <div className="activar">
          <h1>{proyecto?.nombre ?? 'AirTracks'}</h1>
          <p>
            {consola
              ? 'Conectá el cable a la consola y tocá el botón. La pantalla va a quedar encendida.'
              : multimedia
                ? 'Tocá el botón: la pantalla va a quedar encendida mientras uses la app.'
                : 'Conectá los auriculares y tocá el botón. La pantalla va a quedar encendida mientras uses la app.'}
          </p>
          <button className="activar-boton" onClick={empezar}>
            <Headphones size={40} />
            Tocá para empezar
          </button>
          {rol && (
            <button className="activar-rol" onClick={() => setCambiandoRol(true)}>
              {INFO_ROL[rol].nombre} · <u>cambiar</u>
            </button>
          )}
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            <span className={`punto ${conectado ? 'verde' : 'rojo'}`} /> {conectado ? 'Conectado a la computadora' : 'Conectando…'}
          </p>
          {!app && esAndroid() && conectado && <AbrirEnApp controller={controller} />}
          {!app && !enPantallaDeInicio() && (esIOS() || esAndroid()) && conectado && <ProximaVez controller={controller} />}
        </div>
      )}

      {(rol === null || cambiandoRol) && <ElegirRol actual={rol} onElegir={(r) => void elegirRol(r)} onCerrar={rol !== null ? () => setCambiandoRol(false) : undefined} />}

      {hoja === 'ajustes' && (
        <HojaAjustes
          controller={controller}
          etiqueta={miEtiqueta}
          pantallaEncendida={!!app || wake.activo}
          accesoFijo={<AccesoFijo controller={controller} />}
          onCambiarRol={() => {
            setHoja(null)
            setCambiandoRol(true)
          }}
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

/** Por que este celular no maneja la cancion. */
function textoSinControl(controller: AppController): string {
  return controller.estado?.locked ? 'El control lo tiene la computadora.' : 'La canción la maneja el director (en ⚙ se cambia el rol).'
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
      <FaderTactil valor={v} min={0} max={VOLUMEN_MAX} neutro={100} etiqueta="Volumen de este celular" onCambio={controller.setVolumenGeneral} />
      {v > 100 && <p className="m-volumen-extra">Por encima de 100 % suena más fuerte que lo normal (sin saturar). Cuidá los oídos.</p>}
    </div>
  )
}

/** "Mi mezcla" de lo que no es una pista: el pad y el click del colchon, el talkback. Solo en este celular. */
function CanalColchon({
  nombre,
  color,
  ajuste,
  onCambio,
  etiquetaAviso = 'colchón',
  Icono = Waves,
  aria
}: {
  nombre: string
  color: string
  ajuste: AjustePersonal | undefined
  onCambio: (patch: Partial<AjustePersonal>) => void
  etiquetaAviso?: string
  Icono?: typeof Waves
  /** como lo nombran los lectores de pantalla ("todo el click"); por defecto, el nombre */
  aria?: string
}) {
  const quien = aria ?? nombre
  const a = ajuste ?? { ganancia: 1, mute: false }
  const pct = Math.round(a.ganancia * 100)
  return (
    <div className={`m-canal m-canal-colchon ${a.mute ? 'muteado' : ''}`}>
      <div className="m-canal-cabeza">
        <Icono size={15} color={color} />
        <span className="m-canal-nombre">{nombre}</span>
        <span className="m-canal-aviso">{etiquetaAviso}</span>
        <small className="num">{a.mute ? 'muda' : textoGanancia(pct)}</small>
      </div>
      <div className="m-canal-control">
        <FaderTactil
          valor={pct}
          min={0}
          max={200}
          neutro={100}
          paso={5}
          color={color}
          deshabilitado={a.mute}
          etiqueta={`Volumen de ${quien} en este celular`}
          onCambio={(v) => onCambio({ ganancia: v / 100 })}
        />
        <button
          className={`m-ms m-mute ${a.mute ? 'activo' : ''}`}
          onClick={() => onCambio({ mute: !a.mute })}
          aria-pressed={a.mute}
          aria-label={`Mute de ${quien} en este celular`}
          title="Mute: no escucharlo (solo en este celular)"
        >
          M
        </button>
      </div>
    </div>
  )
}

/**
 * Talkback: un fader mas de "Mi mezcla" (la voz de la compu, abierta todo el
 * tiempo mientras alguien no la cierre). Cada uno le da su volumen o la mutea.
 */
function CanalTalkback({ controller }: { controller: AppController }) {
  const mezcla = controller.mezclaPersonal
  const clave = clavePista(FADER_VIVO.talkback)
  const cambiar = (patch: Partial<AjustePersonal>): void => {
    const nuevo = { ...(mezcla[clave] ?? { ganancia: 1, mute: false }), ...patch }
    const copia = { ...mezcla }
    if (Math.abs(nuevo.ganancia - 1) < 0.001 && !nuevo.mute) delete copia[clave]
    else copia[clave] = nuevo
    controller.setMezclaPersonal(copia)
  }
  return (
    <CanalColchon
      nombre={FADER_VIVO.talkback}
      etiquetaAviso={controller.talkbackActivo ? 'abierto' : 'cerrado en la compu'}
      color="var(--danger)"
      Icono={Mic}
      ajuste={mezcla[clave]}
      onCambio={cambiar}
    />
  )
}

/**
 * Banda en vivo: lo que sale de la consola, de referencia (llega un poco
 * despues que el sonido real). Un fader mas de "Mi mezcla", solo mientras la
 * compu la manda.
 */
function CanalBanda({ controller }: { controller: AppController }) {
  if (!controller.bandaActivo) return null
  const mezcla = controller.mezclaPersonal
  const clave = clavePista(FADER_VIVO.banda)
  const cambiar = (patch: Partial<AjustePersonal>): void => {
    const nuevo = { ...(mezcla[clave] ?? { ganancia: 1, mute: false }), ...patch }
    const copia = { ...mezcla }
    if (Math.abs(nuevo.ganancia - 1) < 0.001 && !nuevo.mute) delete copia[clave]
    else copia[clave] = nuevo
    controller.setMezclaPersonal(copia)
  }
  return <CanalColchon nombre={FADER_VIVO.banda} etiquetaAviso="de referencia" color="var(--accent)" Icono={AudioLines} ajuste={mezcla[clave]} onCambio={cambiar} />
}

function Mezcla({ controller, proyecto }: { controller: AppController; proyecto: Proyecto }) {
  const estado = controller.estado
  const mezcla = controller.mezclaPersonal
  // la voz casi nunca necesita pista por pista: arranca plegado (se recuerda)
  const [verPistas, setVerPistasState] = useState<boolean>(() => leerPref('ver-pistas', controller.rol !== 'voz'))
  const setVerPistas = (v: boolean): void => {
    setVerPistasState(v)
    guardarPref('ver-pistas', v)
  }
  const hayCambios = Object.keys(mezcla).length > 0
  const soloAca = proyecto.pistas.some((p) => mezcla[clavePista(p.nombre)]?.solo)

  function set(nombre: string, patch: Partial<AjustePersonal>): void {
    const clave = clavePista(nombre)
    const actual = mezcla[clave] ?? { ganancia: 1, mute: false }
    const nuevo = { ...actual, ...patch }
    if (!nuevo.solo) delete nuevo.solo
    const copia = { ...mezcla }
    if (Math.abs(nuevo.ganancia - 1) < 0.001 && !nuevo.mute && !nuevo.solo) delete copia[clave]
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
      <MezclaRapida proyecto={proyecto} mezcla={mezcla} onCambio={set} />
      <CanalTalkback controller={controller} />
      <CanalBanda controller={controller} />
      {(proyecto.colchon || estado?.colchon) && (
        <>
          {proyecto.colchon && <CanalColchon nombre="Click" color="var(--text-2)" ajuste={mezcla[clavePista('Click')]} onCambio={(patch) => set('Click', patch)} />}
          <CanalColchon nombre="Pad" color="var(--colchon)" ajuste={mezcla[clavePista('Pad')]} onCambio={(patch) => set('Pad', patch)} />
        </>
      )}
      <button className="m-pistas-una-por-una" onClick={() => setVerPistas(!verPistas)} aria-expanded={verPistas}>
        <ChevronDown size={16} style={{ transform: verPistas ? 'rotate(180deg)' : undefined }} /> Pistas una por una ({proyecto.pistas.length})
      </button>
      {verPistas && proyecto.pistas.map((p) => {
        const ajuste: AjustePersonal = mezcla[clavePista(p.nombre)] ?? { ganancia: 1, mute: false }
        const pct = Math.round(ajuste.ganancia * 100)
        const afueraDelSolo = fueraDelSolo(proyecto.pistas, mezcla, p)
        const aviso = p.mute ? 'apagada en la compu' : afueraDelSolo ? (soloAca ? null : 'solo en la compu') : null
        const noSuena = ajuste.mute || p.mute || afueraDelSolo
        return (
          <div key={p.id} className={`m-canal ${noSuena ? 'muteado' : ''} ${ajuste.solo ? 'en-solo' : ''}`}>
            <div className="m-canal-cabeza">
              <span className="punto" style={{ background: p.color }} />
              <span className="m-canal-nombre">{p.nombre}</span>
              {aviso && <span className="m-canal-aviso">{aviso}</span>}
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
                className={`m-ms m-mute ${ajuste.mute ? 'activo' : ''}`}
                onClick={() => set(p.nombre, { mute: !ajuste.mute })}
                aria-pressed={ajuste.mute}
                aria-label={`Mute de ${p.nombre} en este celular`}
                title="Mute: no escuchar esta pista (solo en este celular)"
              >
                M
              </button>
              <button
                className={`m-ms m-solo ${ajuste.solo ? 'activo' : ''}`}
                onClick={() => set(p.nombre, { solo: !ajuste.solo })}
                aria-pressed={!!ajuste.solo}
                aria-label={`Solo de ${p.nombre} en este celular`}
                title="Solo: escuchar solo las pistas en solo (solo en este celular)"
              >
                S
              </button>
            </div>
          </div>
        )
      })}
      <p className="m-mezcla-pie">
        Deslizá los faders de costado (para arriba o abajo, la pantalla se mueve sin tocar nada). Doble toque: vuelve a “igual”.
        <b> M</b> silencia la pista y <b>S</b> la deja sola (podés poner varias en solo); es solo para vos, el resto de la banda sigue
        igual. La mezcla la arma la compu para este celular: los cambios se escuchan en menos de un segundo. Se recuerda por nombre de
        pista, para todas las canciones.
      </p>
    </section>
  )
}

/**
 * Mezcla rapida: un fader para todo el click, toda la guia y toda la banda
 * (lo mas comun: "mas click", "menos guia"). Encima de lo de cada pista.
 */
function MezclaRapida({ proyecto, mezcla, onCambio }: { proyecto: Proyecto; mezcla: MezclaPersonal; onCambio: (nombre: string, patch: Partial<AjustePersonal>) => void }) {
  const hay = new Set(proyecto.pistas.map((p) => tipoDePista(proyecto, p)))
  const grupos = (
    [
      ['click', 'Click', 'var(--text-2)', Metronome],
      ['guia', 'Guía', 'var(--loop)', Megaphone],
      ['banda', 'Banda', 'var(--play)', Music4]
    ] as const
  ).filter(([t]) => hay.has(t))
  if (grupos.length < 2) return null
  return (
    <div className="m-mezcla-rapida" aria-label="Mezcla rápida">
      {grupos.map(([t, nombre, color, Icono]) => (
        <CanalColchon
          key={t}
          nombre={nombre}
          etiquetaAviso={t === 'banda' ? 'todo lo demás' : 'todas sus pistas'}
          color={color}
          Icono={Icono}
          ajuste={mezcla[CLAVE_GRUPO[t]]}
          onCambio={(patch) => onCambio(CLAVE_GRUPO[t], patch)}
          aria={t === 'click' ? 'todo el click' : t === 'guia' ? 'toda la guía' : 'toda la banda'}
        />
      ))}
    </div>
  )
}

// ---------- barra flotante: cancion, seccion y transporte ----------

/**
 * Abajo, siempre: el transporte. En "Mi mezcla" ademas la cancion y la
 * seccion (en la vista de la cancion eso ya esta grande arriba).
 */
function BarraFlotante({ controller, onHoja, conInfo }: { controller: AppController; onHoja: (h: HojaAbierta) => void; conInfo: boolean }) {
  const { estado, secciones } = controller
  const proyecto = estado!.proyectoActivo!
  const pos = usePlayheadPaso(200)
  const golpe = useGolpeCuenta()
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  // sin control: la compu lo bloqueo, o este celular no es el del director
  const locked = !controller.puedeControlar
  const loop = estado?.loop ?? false
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const salto = estado?.saltoPendiente ?? null
  const cantidadCanciones = estado?.tabs.length ?? 0
  // colchon: la banda se va y siguen el click y el pad (hace falta el tempo de la cancion)
  const colchon = estado?.colchon ?? null
  const hayColchon = !!colchon && colchon.hasta === null
  const enColchon = hayColchon && colchon!.desdeCancion && colchon!.tabId === estado?.activeTabId
  const conTempo = (proyecto.tempo?.compasesMs.length ?? 0) > 1
  const faltanBarra = compasesQueFaltan(proyecto.tempo?.compasesMs, actual, pos, salto?.limiteMs)

  if (proyecto.colchon) {
    const c = estado?.colchon
    const suena = !!c && c.tabId === estado?.activeTabId && c.hasta === null
    return (
      <div className={`m-barra ${conInfo ? '' : 'solo-botones'}`} role="region" aria-label="Colchón y transporte">
        {conInfo && (
          <div className="m-barra-info">
            <span className="m-barra-fila">
              <span className="m-barra-cancion">{proyecto.nombre}</span>
            </span>
            <span className="m-barra-fila">{suena && c ? <PulsoColchon pulsos={c.pulsos} /> : <span className="m-barra-sigue">parado</span>}</span>
          </div>
        )}
        <div className="m-barra-botones">
          {locked ? (
            <span className="m-barra-bloqueado">
              <Lock size={15} /> Control en la compu
            </span>
          ) : (
            <button className={`m-play ${suena ? 'sonando' : ''}`} onClick={controller.togglePlay} aria-label={suena ? 'Terminar el colchón' : 'Empezar el colchón'}>
              {suena ? <Square size={20} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
          )}
          <button onClick={() => onHoja('canciones')} aria-label="Canciones del setlist">
            <ListMusic size={19} />
            {cantidadCanciones > 1 && <span className="m-barra-cuenta num">{cantidadCanciones}</span>}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`m-barra ${conInfo ? '' : 'solo-botones'}`} role="region" aria-label="Canción y transporte">
      {conInfo && (
      <button className="m-barra-info" onClick={() => onHoja('secciones')} aria-label="Ver secciones">
        <span className="m-barra-fila">
          <span className="m-barra-cancion">{proyecto.nombre}</span>
          <TonoQueSuena proyecto={proyecto} pos={pos} />
          <span className="m-barra-tiempo num">
            {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
          </span>
        </span>
        <span className="m-barra-fila">
          {golpe > 0 ? (
            <span className="m-barra-seccion m-contando num" role="status">
              Cuenta {golpe}
            </span>
          ) : (
            <span className="m-barra-seccion" style={{ color: actual ? colorClaro(colorDeSeccion(actual)) : undefined }}>
              {loop && <Repeat size={15} />}
              {actual?.nombre ?? '—'}
              {faltanBarra !== null && <small className={`m-barra-faltan num ${faltanBarra === 1 ? 'ultimo' : ''}`}> · {textoQueFaltan(faltanBarra)}</small>}
            </span>
          )}
          {estado?.fundido ? (
            <span className="m-barra-salto">
              <IconoFundido size={14} /> se está apagando…
            </span>
          ) : salto ? (
            <span className="m-barra-salto">
              {salto.fin ? <IconoFundido size={14} /> : <ArrowRight size={14} />} {salto.fin ? 'se apaga' : salto.nombre} <span className="num">{faltaPara(salto, pos)}</span>
            </span>
          ) : (
            <span className="m-barra-sigue">
            {loop
              ? 'repitiendo'
              : siguiente
                ? `sigue ${siguiente.nombre}${cambioDeTono(proyecto, pos, siguiente)}`
                : 'última sección'}
          </span>
          )}
        </span>
        <MiniTimeline controller={controller} />
      </button>
      )}
      <div className="m-barra-botones">
        {locked ? (
          <span className="m-barra-bloqueado">
            <Lock size={15} /> {estado?.locked ? 'Control en la compu' : 'Maneja el director'}
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
            {conTempo && (
              <button
                className={`m-colchon-boton ${enColchon ? 'activo' : ''}`}
                onClick={enColchon ? controller.terminarColchon : () => void controller.entrarEnColchon()}
                disabled={!enColchon && hayColchon}
                aria-pressed={enColchon}
                aria-label="Colchón"
                title={
                  enColchon
                    ? 'Terminar el colchón'
                    : sonando
                      ? 'Colchón: al terminar la sección se va la banda y siguen el click y un pad'
                      : 'Colchón: el click y un pad en el tono de la canción, ya (▶ la hace entrar en el próximo compás)'
                }
              >
                <Waves size={19} />
              </button>
            )}
          </>
        )}
        {conInfo && (
          <button onClick={() => onHoja('secciones')} aria-label="Secciones">
            <Rows3 size={19} />
          </button>
        )}
        <button onClick={() => onHoja('canciones')} aria-label="Canciones del setlist">
          <ListMusic size={19} />
          {cantidadCanciones > 1 && <span className="m-barra-cuenta num">{cantidadCanciones}</span>}
        </button>
      </div>
    </div>
  )
}

// ---------- la cancion: recorrido + secciones ----------

/**
 * "Terminar" (la ultima tarjeta, despues de las secciones): la cancion
 * termina al final de esta seccion (o en el compas, o ya: el modo de salto)
 * apagandose en unos segundos, en todos a la vez. Otra vez: se cancela (o,
 * si ya se estaba apagando, la musica vuelve y sigue).
 */
function TarjetaTerminar({ controller, pos }: { controller: AppController; pos: number }) {
  const e = controller.estado
  const sonando = e?.playbackActivo?.estado === 'playing'
  const terminar = estadoTerminar(e)
  const salto = e?.saltoPendiente ?? null
  const segundos = Math.round((e?.fundidoMs ?? 4000) / 1000)
  const detalle =
    terminar === 'apagandose'
      ? 'apagándose · tocá para seguir'
      : terminar === 'pendiente' && salto
        ? `se apaga ${faltaPara(salto, pos)} · tocá para cancelar`
        : sonando
          ? `${textoCuandoTermina(e?.modoSalto)} (${segundos} s)`
          : 'apaga la canción de a poco'
  return (
    <button
      className={`m-marcador terminar ${terminar ? 'pendiente' : ''}`}
      disabled={!sonando && !terminar}
      onClick={() => void controller.terminar()}
      aria-label={terminar === 'apagandose' ? 'Que siga la canción' : terminar ? 'Cancelar el final' : 'Terminar la canción con fundido'}
    >
      <span className="m-marcador-nombre">
        <IconoFundido size={18} /> Terminar
      </span>
      <small className="m-marcador-detalle num">{detalle}</small>
    </button>
  )
}

function VistaCancion({ controller, proyecto, onHoja, onAjustes }: { controller: AppController; proyecto: Proyecto; onHoja: (h: HojaAbierta) => void; onAjustes: () => void }) {
  const { estado, secciones } = controller
  const pos = usePlayheadPaso(200)
  const golpe = useGolpeCuenta()
  const onda = useOnda(proyecto)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  // sin control: la compu lo bloqueo, o este celular no es el del director
  const locked = !controller.puedeControlar
  const loop = estado?.loop ?? false
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const salto = estado?.saltoPendiente ?? null
  // "Terminar con fundido" pendiente: el limite es el final, no hay seccion de destino
  const destino = salto && !salto.fin ? seccionEn(secciones, salto.destinoMs) : null
  const terminar = estadoTerminar(estado)
  const modo = estado?.modoSalto ?? 'seccion'
  const conMarcador = secciones.filter((s) => s.marcador)
  // las tarjetas: las secciones marcadas y, siempre primero, el comienzo de la cancion ("Inicio")
  const tarjetas = secciones.filter((s) => s.marcador || s.indice === 0)
  const compases = proyecto.tempo?.compasesMs ?? null
  // compases que faltan para que termine la seccion (o para el salto elegido)
  const faltan = compasesQueFaltan(compases, actual, pos, salto?.limiteMs)
  const bpmAqui = bpmDistintoEnSeccion(proyecto.tempo, actual)
  const proxima = salto ? destino : loop || terminar ? null : siguiente
  const aviso = avisoDeTono(proyecto, pos, proxima, faltan, salto ? salto.limiteMs : (actual?.finMs ?? null))
  const enSuColchon = !!estado?.colchon && estado.colchon.desdeCancion && estado.colchon.hasta === null && estado.colchon.tabId === estado.activeTabId
  const ayuda = locked
    ? null
    : enSuColchon
      ? 'Tocá una sección: la canción vuelve ahí en el próximo compás.'
      : !sonando || modo === 'inmediato'
      ? 'Tocá una sección para ir ahí.'
      : modo === 'compas'
        ? 'Tocá una sección: salta en el próximo compás.'
        : 'Tocá una sección: la actual termina y sigue la que elijas, sin cortes.'

  return (
    <section className={`m-vista-cancion ${locked && !estado?.locked ? 'solo-mirar' : ''}`} aria-label="Canción">
      {estado?.colchon && <AvisoColchon controller={controller} colchon={estado.colchon} />}
      <div className="m-cancion-cabeza">
        <button className="m-cancion-nombre" onClick={() => onHoja('canciones')} aria-label={`${proyecto.nombre}: ver las canciones`}>
          <span>{proyecto.nombre}</span>
          <ChevronDown size={16} />
        </button>
        <TonoQueSuena proyecto={proyecto} pos={pos} />
        {bpmAqui !== null ? (
          <span className="m-barra-tono cambiado num" title="Tempo de esta sección (la canción cambia de tempo)" data-testid="bpm-seccion">
            {Math.round(bpmAqui)} BPM
          </span>
        ) : (
          velocidadAplicada(proyecto) !== 1 &&
          proyecto.tempo && (
            <span className="m-barra-tono cambiado num" title={`Velocidad cambiada (${textoPorcentaje(velocidadAplicada(proyecto))})`}>
              {Math.round(proyecto.tempo.bpm)} BPM
            </span>
          )
        )}
        <span className="m-cancion-tiempo num">
          {formatMmSs(pos)} / {formatMmSs(proyecto.duracionTotalMs)}
        </span>
      </div>
      <div className="m-ahora">
        {golpe > 0 ? (
          <span className="m-ahora-seccion m-contando num" role="status">
            Cuenta {golpe}
          </span>
        ) : (
          <>
            <span className="m-ahora-seccion" style={{ color: actual ? colorClaro(colorDeSeccion(actual)) : undefined }}>
              {loop && <Repeat size={22} />}
              {actual?.nombre ?? '—'}
            </span>
            {faltan !== null && (
              <span className={`m-faltan ${faltan === 1 ? 'ultimo' : faltan === 2 ? 'penultimo' : ''}`} role="status" aria-label={faltan === 1 ? 'Último compás de la sección' : `Faltan ${faltan} compases`}>
                <b className="num">{faltan}</b>
                <small>{faltan === 1 ? 'último' : 'compases'}</small>
              </span>
            )}
            <AvisoTono aviso={aviso} />
          </>
        )}
        {terminar ? (
          <span className="m-salto m-terminando" role="status">
            <IconoFundido size={15} /> {terminar === 'apagandose' ? 'Se está apagando…' : 'Se apaga'}
            {salto && <span className="num">{faltaPara(salto, pos)}</span>}
            {!locked && (
              <button onClick={controller.cancelarSalto} aria-label={terminar === 'apagandose' ? 'Que siga la canción' : 'Cancelar el final'}>
                {terminar === 'apagandose' ? 'Seguir' : <X size={15} />}
              </button>
            )}
          </span>
        ) : salto ? (
          <span className="m-salto" role="status">
            <ArrowRight size={15} /> {salto.nombre}
            {cambioDeTono(proyecto, pos, destino)} <span className="num">{faltaPara(salto, pos)}</span>
            {!locked && (
              <button onClick={controller.cancelarSalto} aria-label="Cancelar el salto">
                <X size={15} />
              </button>
            )}
          </span>
        ) : (
          <span className="m-barra-sigue">
            {loop
              ? 'repitiendo'
              : siguiente
                ? `sigue ${siguiente.nombre}${cambioDeTono(proyecto, pos, siguiente)}`
                : 'última sección'}
          </span>
        )}
      </div>
      <MiniTimeline controller={controller} onda={onda} grande />
      <div className="m-marcadores">
        {tarjetas.map((s) => {
          const esActual = actual?.indice === s.indice
          const pendiente = !!salto && destino?.indice === s.indice
          const avance = esActual ? Math.min(1, Math.max(0, (pos - s.inicioMs) / Math.max(1, s.finMs - s.inicioMs))) : 0
          return (
            <button
              key={s.marcador?.id ?? 'inicio'}
              className={`m-marcador ${esActual ? 'actual' : ''} ${pendiente ? 'pendiente' : ''} ${s.marcador ? '' : 'inicio'}`}
              style={{ '--color-seccion': colorDeSeccion(s) } as React.CSSProperties}
              disabled={locked}
              onClick={() => controller.irASeccionEn(s.inicioMs)}
              aria-label={s.marcador ? undefined : 'Inicio: volver al principio de la canción'}
            >
              <span className="m-marcador-nombre">
                {esActual && loop && <Repeat size={15} />}
                {!s.marcador && <SkipBack size={17} />}
                {s.nombre}
              </span>
                <small className="m-marcador-detalle num">
                  {pendiente
                    ? `sigue · ${faltaPara(salto!, pos)}`
                    : esActual && (sonando || faltan !== null)
                      ? [loop ? 'repitiendo' : null, faltan === null ? (loop ? null : 'sonando') : faltan === 1 ? 'último compás' : `faltan ${faltan}`].filter(Boolean).join(' · ')
                      : largoDeSeccion(s, compases)}
                </small>
                {esActual && <i className="m-marcador-avance" style={{ width: `${avance * 100}%` }} />}
              </button>
            )
          })}
        {!locked && <TarjetaTerminar controller={controller} pos={pos} />}
      </div>
      {conMarcador.length === 0 && <p className="vacio">Esta canción todavía no tiene secciones marcadas.</p>}
      {locked ? (
        <p className="m-ayuda-salto">
          <Lock size={14} /> {textoSinControl(controller)}
        </p>
      ) : (
        // como salta se elige en ⚙ (no ocupa lugar aca): el texto dice como esta
        <button className="m-ayuda-salto m-ayuda-boton" onClick={onAjustes} aria-label={`${ayuda} Cambiar cómo salta`}>
          {ayuda} <Settings size={13} />
        </button>
      )}
    </section>
  )
}

// ---------- colchon: pad y click sin la banda ----------

/** Arriba de la cancion, mientras suena un colchon: que pasa y como se sale. */
function AvisoColchon({ controller, colchon }: { controller: AppController; colchon: ColchonActivo }) {
  const e = controller.estado
  const locked = !controller.puedeControlar
  const empezo = useGolpeColchon() !== null
  const terminando = colchon.hasta !== null
  const deEstaCancion = colchon.desdeCancion && colchon.tabId === e?.activeTabId
  const banda = colchon.sinBanda
    ? 'Click y pad, con la canción parada.'
    : empezo
    ? 'La banda paró: siguen el click y el pad.'
    : e?.modoSalto === 'seccion'
      ? 'La banda se va al terminar la sección: siguen el click y el pad.'
      : 'La banda se va en el próximo compás: siguen el click y el pad.'
  return (
    <div className={`m-colchon ${terminando ? 'terminando' : ''}`} role="status">
      <span className="m-colchon-fila">
        <Waves size={18} />
        <b>{textoColchon(colchon)}</b>
        {!terminando && <PulsoColchon pulsos={colchon.pulsos} />}
      </span>
      <span className="m-colchon-texto">
        {terminando
          ? colchon.salidaPadMs <= SALIDA_PAD_VUELTA_MS
            ? 'Vuelve la banda…'
            : 'Se está apagando…'
          : deEstaCancion
            ? locked
              ? banda
              : colchon.sinBanda
                ? `${banda} ▶ o una sección: la canción entra en el próximo compás, sin cuenta.`
                : `${banda} Tocá una sección para volver (entra en el próximo compás).`
            : 'Suenan el click y el pad.'}
      </span>
      {!terminando && !locked && (
        <button className="m-colchon-terminar" onClick={controller.terminarColchon}>
          <Square size={13} fill="currentColor" /> Terminar
        </button>
      )}
    </div>
  )
}

/** Un colchon de la lista (sin pistas): el tono del pad, el pulso y si esta sonando. */
function VistaColchon({ controller, proyecto }: { controller: AppController; proyecto: Proyecto }) {
  const e = controller.estado
  const a = proyecto.colchon!
  const c = e?.colchon ?? null
  const suena = !!c && c.tabId === e?.activeTabId && c.hasta === null
  return (
    <section className="m-vista-colchon" aria-label="Colchón">
      {c && c.tabId !== e?.activeTabId && <AvisoColchon controller={controller} colchon={c} />}
      <div className="m-colchon-grande">
        <Waves size={26} />
        <h2>{proyecto.nombre}</h2>
        <div className="m-colchon-nota">{a.tonalidad ?? '—'}</div>
        <div className="m-colchon-bpm num">{a.click ? `${a.bpm} BPM · ${textoCompasColchon(a.compas)}` : 'sin click'}</div>
        {suena && c ? <PulsoColchon pulsos={c.pulsos} grande /> : <span className="m-colchon-parado">{c && c.tabId === e?.activeTabId ? 'se está apagando…' : 'parado'}</span>}
      </div>
      <p className="m-ayuda-salto">Pad de ambiente y click, sin la banda. El volumen del pad y del click para vos, en “Mi mezcla”.</p>
    </section>
  )
}

// ---------- hojas: secciones y canciones ----------

function HojaSecciones({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const pos = usePlayheadPaso(200)
  const { estado } = controller
  // sin control: la compu lo bloqueo, o este celular no es el del director
  const locked = !controller.puedeControlar
  const salto = estado?.saltoPendiente ?? null
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const modo = estado?.modoSalto ?? 'seccion'
  const conMarcador = controller.secciones.filter((s) => s.marcador)
  const tarjetas = controller.secciones.filter((s) => s.marcador || s.indice === 0)
  const actual = seccionEn(controller.secciones, pos)
  const destino = salto && !salto.fin ? seccionEn(controller.secciones, salto.destinoMs) : null
  const terminar = estadoTerminar(estado)
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
          <Lock size={14} /> {textoSinControl(controller)}
        </p>
      )}
      {!locked && sonando && <p className="ayuda" style={{ marginTop: 0 }}>{explicacion}</p>}
      {terminar ? (
        <div className="m-salto-aviso">
          <IconoFundido size={16} />
          <span>{terminar === 'apagandose' ? 'La canción se está apagando…' : <>Se apaga <span className="num">{salto ? faltaPara(salto, pos) : ''}</span></>}</span>
          {!locked && <button onClick={controller.cancelarSalto}>{terminar === 'apagandose' ? 'Seguir' : <><X size={15} /> Cancelar</>}</button>}
        </div>
      ) : (
        salto && (
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
        )
      )}
      <div className="m-marcadores">
        {tarjetas.map((s) => (
          <button
            key={s.marcador?.id ?? 'inicio'}
            className={`m-marcador ${actual?.indice === s.indice ? 'actual' : ''} ${destino?.indice === s.indice ? 'pendiente' : ''} ${s.marcador ? '' : 'inicio'}`}
            style={{ '--color-seccion': colorDeSeccion(s) } as React.CSSProperties}
            disabled={locked}
            onClick={() => controller.irASeccionEn(s.inicioMs)}
            aria-label={s.marcador ? undefined : 'Inicio: volver al principio de la canción'}
          >
            <span>
              {!s.marcador && <SkipBack size={15} />} {s.nombre}
            </span>
          </button>
        ))}
        {!locked && <TarjetaTerminar controller={controller} pos={pos} />}
      </div>
      {conMarcador.length === 0 && <p className="vacio">Esta canción todavía no tiene secciones marcadas.</p>}
    </Hoja>
  )
}

function HojaCanciones({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const confirmar = useConfirmar()
  const { estado } = controller
  // sin control: la compu lo bloqueo, o este celular no es el del director
  const locked = !controller.puedeControlar
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
    <Hoja titulo={estado?.lista ? `Canciones · ${estado.lista.nombre}` : 'Canciones'} onCerrar={onCerrar}>
      {locked && (
        <p className="ayuda">
          <Lock size={14} /> {textoSinControl(controller)}
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
