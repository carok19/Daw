import type { DiagnosticoDispositivo, DiagnosticoServidor, DispositivoInfo } from '@shared/types'

/**
 * Textos del diagnostico: lo que mide cada celular (WiFi, colchon, cortes) y
 * el informe completo de "Copiar diagnostico" para mandar por chat.
 */

const n = (v: number, dec = 1): string => v.toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: 0 })

export type NivelDiagnostico = 'bien' | 'justo' | 'mal'

/**
 * - mal: se corto el audio o el WiFi no llega a lo que hace falta.
 * - justo: anda, pero con poco margen (un bajon del WiFi se va a notar).
 */
export function nivelDiagnostico(d: DiagnosticoDispositivo): NivelDiagnostico {
  const capacidad = d.mbpsCapacidad
  if (d.cortes > 0 || (capacidad !== null && capacidad < d.mbpsNecesarios * 1.1)) return 'mal'
  if ((capacidad !== null && capacidad < d.mbpsNecesarios * 2) || d.errores > 3 || d.resyncs > 2) return 'justo'
  return 'bien'
}

/** Una linea para la lista de celulares de la compu. */
export function resumenCorto(d: DiagnosticoDispositivo): string {
  const wifi = d.mbpsCapacidad !== null ? `WiFi ${n(d.mbpsCapacidad)} Mbps (usa ${n(d.mbpsNecesarios)})` : `usa ${n(d.mbpsNecesarios)} Mbps`
  const cortes = d.cortes === 0 ? 'sin cortes' : d.cortes === 1 ? '1 corte' : `${d.cortes} cortes`
  return `${wifi} · colchón ${n(d.colchonSeg, 0)} s · ${cortes}`
}

/** Explicacion para el propio celular (Ajustes). */
export function explicacion(d: DiagnosticoDispositivo): string {
  const nivel = nivelDiagnostico(d)
  if (nivel === 'bien') return 'El WiFi alcanza de sobra.'
  if (d.cortes > 0 && (d.mbpsCapacidad === null || d.mbpsCapacidad >= d.mbpsNecesarios * 1.1))
    return 'Hubo cortes: el WiFi tuvo bajones. Acercate al router o pedí que usen 5 GHz.'
  if (nivel === 'mal') return 'El WiFi no alcanza: acercate al router, usá la red de 5 GHz o que se conecten menos celulares.'
  return 'Anda, pero con poco margen: si podés, acercate al router.'
}

function lineaDispositivo(d: DispositivoInfo): string {
  const estado = !d.conectado ? 'desconectado' : !d.audio && d.origen === 'celular' ? 'conectado, sin activar el audio' : 'conectado'
  const x = d.diag
  const partes = [`- ${d.etiqueta}${x?.plataforma ? ` (${x.plataforma})` : ''}: ${estado}`]
  if (d.driftMs !== null) partes.push(`desfase ${Math.round(d.driftMs)} ms`)
  if (x) {
    partes.push(
      `modo ${x.modo === 'mezcla' ? 'mezcla de la compu' : 'pistas sueltas'}`,
      `usa ${n(x.mbpsNecesarios, 2)} Mbps, recibió ${n(x.mbpsRecibidos, 2)}`,
      x.mbpsCapacidad !== null ? `el WiFi dio ${n(x.mbpsCapacidad)} Mbps` : 'sin medir el WiFi todavía',
      `colchón ${n(x.colchonSeg)} s`,
      `${x.cortes} cortes`,
      `${x.resyncs} resync`,
      `${x.correcciones} correcciones finas`,
      `${x.errores} errores de red`,
      x.latenciaMs !== null ? `pedidos de ${x.latenciaMs} ms` : '',
      `memoria ${n(x.memoriaMB)} MB`,
      `salida de audio ${x.salidaMs} ms`,
      `nivel: ${nivelDiagnostico(x)}`
    )
  }
  if (d.error) partes.push(`ERROR: ${d.error}`)
  return partes.filter(Boolean).join(' · ')
}

/** Informe completo para pegar en un chat (lo que hace falta para entender que paso en un ensayo). */
export function informeTexto(s: DiagnosticoServidor, ahora = new Date()): string {
  const lineas = [
    `Diagnóstico Multitrack Alabanza — ${ahora.toLocaleString('es-AR')}`,
    `Compu: versión ${s.version || '?'} · ${s.sistema}`,
    `Direcciones: ${s.direcciones.map((ip) => `${ip}:${s.puerto}`).join(', ') || 'sin red'}${s.puertoCorto ? ` · dirección corta en el puerto ${s.puertoCorto}` : ''}`
  ]
  if (s.licencia) lineas.push(`Licencia: ${s.licencia}`)
  if (s.cancion) {
    const min = Math.floor(s.cancion.duracionMs / 60000)
    const seg = Math.round((s.cancion.duracionMs % 60000) / 1000)
    lineas.push(`Canción: ${s.cancion.nombre} · ${s.cancion.pistas} pistas · ${min}:${String(seg).padStart(2, '0')}${s.cancion.bpm ? ` · ${s.cancion.bpm} BPM` : ''}`)
  }
  if (s.mezcla) {
    const m = s.mezcla
    const cache = m.pedidos ? Math.round((m.aciertosCache / m.pedidos) * 100) : 0
    lineas.push(`Mezcla en la compu: ${m.pedidos} pedidos (${cache}% ya estaban hechos) · ${m.msPromedio} ms por segmento (máx ${m.msMax} ms) · ${n(m.bytes / 1e6)} MB enviados`)
  }
  const celulares = s.dispositivos.filter((d) => d.origen === 'celular')
  lineas.push('', `Celulares (${celulares.filter((d) => d.conectado).length} conectados de ${celulares.length}):`)
  for (const d of celulares) lineas.push(lineaDispositivo(d))
  const compu = s.dispositivos.find((d) => d.origen === 'compu')
  if (compu?.diag) lineas.push('', `Sonido en la compu: ${lineaDispositivo(compu).replace(/^- /, '')}`)
  return lineas.join('\n')
}
