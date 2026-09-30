import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Headphones,
  LayoutGrid,
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
  SlidersVertical,
  UserPlus,
  Volume2,
  WifiOff,
  X
} from 'lucide-react'
import type { OndaCancion, Proyecto, SaltoPendiente } from '@shared/types'
import { seccionEn, type Seccion } from '@shared/playback'
import { textoSemitonos, tonalidadOriginal, transponerTonalidad } from '@shared/tonalidad'
import type { AppController } from '../app/useAppController'
import { useGolpeCuenta, usePlayheadMs, usePlayheadPaso } from '../app/playheadStore'
import { leerPref } from '../app/preferencias'
import { clavePista, type AjustePersonal } from '../audio/PlaybackEngine'
import { fueraDelSolo } from '@shared/mezcla'
import { VOLUMEN_MAX } from '../audio/streamConfig'
import { formatMmSs } from '../format'
import { colorDeSeccion } from '../secciones'
import { Avisos } from '../ui/Avisos'
import { FaderTactil } from '../ui/FaderTactil'
import { useConfirmar } from '../ui/Confirmar'
import { useWakeLock } from './useWakeLock'
import { OndaDibujo, useOnda } from '../ui/Onda'
import { textoPorcentaje, velocidadAplicada } from '@shared/velocidad'
import { guardarPref } from '../app/preferencias'
import { Hoja, HojaAjustes } from './Hojas'
import { AbrirEnApp, AccesoFijo, HojaInvitar, PantallaCodigo, PantallaLicencia } from './Conectar'
import { enPantallaDeInicio, esAndroid, esIOS, puenteAndroid } from '../conexion'

type HojaAbierta = null | 'ajustes' | 'secciones' | 'canciones' | 'invitar'
/** La cancion (por donde va y sus secciones) o "Mi mezcla" a pantalla completa. */
type VistaCelular = 'cancion' | 'mezcla'

/**
 * Celular: la pantalla principal es la cancion (el recorrido con la forma de
 * onda y las secciones como tarjetas grandes: tocar = ir ahi) y "Mi mezcla"
 * es otra pantalla entera, a un toque. El transporte va siempre abajo.
 */
export function MobileApp({ controller }: { controller: AppController }) {
  const { estado, conectado } = controller
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
    <div className={`mobile ${proyecto ? 'con-barra' : ''} vista-${vista}`}>
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
            <VistaCancion controller={controller} proyecto={proyecto} onHoja={setHoja} />
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
        </>
      )}

      {proyecto && <BarraFlotante controller={controller} onHoja={setHoja} conInfo={vista === 'mezcla'} />}

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
          {!app && esAndroid() && conectado && <AbrirEnApp controller={controller} />}
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
      <FaderTactil valor={v} min={0} max={VOLUMEN_MAX} neutro={100} etiqueta="Volumen de este celular" onCambio={controller.setVolumenGeneral} />
      {v > 100 && <p className="m-volumen-extra">Por encima de 100 % suena más fuerte que lo normal (sin saturar). Cuidá los oídos.</p>}
    </div>
  )
}

function Mezcla({ controller, proyecto }: { controller: AppController; proyecto: Proyecto }) {
  const mezcla = controller.mezclaPersonal
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
      {proyecto.pistas.map((p) => {
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

// ---------- barra flotante: cancion, seccion y transporte ----------

function faltaPara(salto: SaltoPendiente, pos: number): string {
  const s = Math.max(0, Math.ceil((salto.limiteMs - pos) / 1000))
  return s <= 0 ? 'ya' : `en ${s} s`
}

/** Tonalidad en la que suena la cancion ("B +2"): asi la banda sabe en que tono esta tocando. */
function TonoQueSuena({ proyecto }: { proyecto: Proyecto }) {
  const n = proyecto.tonoAplicado ?? 0
  const original = tonalidadOriginal(proyecto)
  if (!original && !n) return null
  return (
    <span className={`m-barra-tono num ${n ? 'cambiado' : ''}`} title={n ? `Tono cambiado ${textoSemitonos(n)} semitonos` : 'Tonalidad'}>
      {original && transponerTonalidad(original, n)}
      {n !== 0 && <small>{textoSemitonos(n)}</small>}
    </span>
  )
}

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
  const locked = estado?.locked ?? false
  const loop = estado?.loop ?? false
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const salto = estado?.saltoPendiente ?? null
  const cantidadCanciones = estado?.tabs.length ?? 0

  return (
    <div className={`m-barra ${conInfo ? '' : 'solo-botones'}`} role="region" aria-label="Canción y transporte">
      {conInfo && (
      <button className="m-barra-info" onClick={() => onHoja('secciones')} aria-label="Ver secciones">
        <span className="m-barra-fila">
          <span className="m-barra-cancion">{proyecto.nombre}</span>
          <TonoQueSuena proyecto={proyecto} />
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
            </span>
          )}
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
      )}
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

/** La cancion de punta a punta, dividida en secciones. Grande (el "recorrido"), con la forma de onda y los nombres. */
function MiniTimeline({ controller, onda, grande }: { controller: AppController; onda?: OndaCancion | null; grande?: boolean }) {
  const { secciones, estado } = controller
  const dur = Math.max(estado?.proyectoActivo?.duracionTotalMs ?? 1, 1)
  const pos = usePlayheadMs()
  const actual = seccionEn(secciones, pos)
  const salto = estado?.saltoPendiente ?? null
  const destino = salto ? seccionEn(secciones, salto.destinoMs) : null
  const pct = (ms: number): string => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`
  return (
    <span className={`m-timeline ${grande ? 'm-recorrido' : ''} ${onda ? 'con-onda' : ''}`} aria-hidden>
      {secciones.map((s) => (
        <span
          key={s.marcador?.id ?? 'inicio'}
          className={`${actual?.indice === s.indice ? 'actual' : ''} ${destino?.indice === s.indice ? 'destino' : ''}`}
          style={{ width: `${((s.finMs - s.inicioMs) / dur) * 100}%`, background: colorDeSeccion(s) }}
        >
          {grande && s.marcador && <em>{s.nombre}</em>}
        </span>
      ))}
      {onda && <OndaDibujo onda={onda} duracionMs={dur} className="m-onda" />}
      {grande && <span className="m-pasado" style={{ width: pct(pos) }} />}
      {salto && <span className="m-salto-limite" style={{ left: pct(salto.limiteMs) }} />}
      <span className="m-playhead" style={{ left: pct(pos) }} />
    </span>
  )
}

/** Cuantos compases (con tempo) o cuanto dura una seccion. */
function largoDeSeccion(s: Seccion, compasesMs: number[] | null): string {
  if (compasesMs && compasesMs.length > 1) {
    const n = compasesMs.filter((c) => c >= s.inicioMs - 50 && c < s.finMs - 50).length
    if (n > 0) return `${n} ${n === 1 ? 'compás' : 'compases'}`
  }
  return formatMmSs(s.finMs - s.inicioMs)
}

// ---------- la cancion: recorrido + secciones ----------

function VistaCancion({ controller, proyecto, onHoja }: { controller: AppController; proyecto: Proyecto; onHoja: (h: HojaAbierta) => void }) {
  const { estado, secciones } = controller
  const pos = usePlayheadPaso(200)
  const golpe = useGolpeCuenta()
  const onda = useOnda(proyecto)
  const actual = seccionEn(secciones, pos)
  const siguiente = actual ? secciones[actual.indice + 1] : null
  const locked = estado?.locked ?? false
  const loop = estado?.loop ?? false
  const sonando = estado?.playbackActivo?.estado === 'playing'
  const salto = estado?.saltoPendiente ?? null
  const destino = salto ? seccionEn(secciones, salto.destinoMs) : null
  const modo = estado?.modoSalto ?? 'seccion'
  const conMarcador = secciones.filter((s) => s.marcador)
  const compases = proyecto.tempo?.compasesMs ?? null
  const ayuda = locked
    ? null
    : !sonando || modo === 'inmediato'
      ? 'Tocá una sección para ir ahí.'
      : modo === 'compas'
        ? 'Tocá una sección: salta en el próximo compás.'
        : 'Tocá una sección: la actual termina y sigue la que elijas, sin cortes.'

  return (
    <section className="m-vista-cancion" aria-label="Canción">
      <div className="m-cancion-cabeza">
        <button className="m-cancion-nombre" onClick={() => onHoja('canciones')} aria-label={`${proyecto.nombre}: ver las canciones`}>
          <span>{proyecto.nombre}</span>
          <ChevronDown size={16} />
        </button>
        <TonoQueSuena proyecto={proyecto} />
        {velocidadAplicada(proyecto) !== 1 && proyecto.tempo && (
          <span className="m-barra-tono cambiado num" title={`Velocidad cambiada (${textoPorcentaje(velocidadAplicada(proyecto))})`}>
            {Math.round(proyecto.tempo.bpm)} BPM
          </span>
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
          <span className="m-ahora-seccion" style={{ color: actual ? colorClaro(colorDeSeccion(actual)) : undefined }}>
            {loop && <Repeat size={22} />}
            {actual?.nombre ?? '—'}
          </span>
        )}
        {salto ? (
          <span className="m-salto" role="status">
            <ArrowRight size={15} /> {salto.nombre} <span className="num">{faltaPara(salto, pos)}</span>
            {!locked && (
              <button onClick={controller.cancelarSalto} aria-label="Cancelar el salto">
                <X size={15} />
              </button>
            )}
          </span>
        ) : (
          <span className="m-barra-sigue">{loop ? 'repitiendo' : siguiente ? `sigue ${siguiente.nombre}` : 'última sección'}</span>
        )}
      </div>
      <MiniTimeline controller={controller} onda={onda} grande />
      {conMarcador.length === 0 ? (
        <p className="vacio">Esta canción todavía no tiene secciones marcadas.</p>
      ) : (
        <div className="m-marcadores">
          {conMarcador.map((s) => {
            const esActual = actual?.indice === s.indice
            const pendiente = !!salto && destino?.indice === s.indice
            const avance = esActual ? Math.min(1, Math.max(0, (pos - s.inicioMs) / Math.max(1, s.finMs - s.inicioMs))) : 0
            return (
              <button
                key={s.marcador!.id}
                className={`m-marcador ${esActual ? 'actual' : ''} ${pendiente ? 'pendiente' : ''}`}
                style={{ '--color-seccion': colorDeSeccion(s) } as React.CSSProperties}
                disabled={locked}
                onClick={() => controller.jumpToMarker(s.marcador!.id)}
              >
                <span className="m-marcador-nombre">
                  {esActual && loop && <Repeat size={15} />}
                  {s.nombre}
                </span>
                <small className="m-marcador-detalle num">
                  {pendiente ? `sigue · ${faltaPara(salto!, pos)}` : esActual ? (loop ? 'repitiendo' : 'sonando') : largoDeSeccion(s, compases)}
                </small>
                {esActual && <i className="m-marcador-avance" style={{ width: `${avance * 100}%` }} />}
              </button>
            )
          })}
        </div>
      )}
      <p className="m-ayuda-salto">
        {locked ? (
          <>
            <Lock size={14} /> El control lo tiene la computadora.
          </>
        ) : (
          ayuda
        )}
      </p>
    </section>
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
    <Hoja titulo={estado?.lista ? `Canciones · ${estado.lista.nombre}` : 'Canciones'} onCerrar={onCerrar}>
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
