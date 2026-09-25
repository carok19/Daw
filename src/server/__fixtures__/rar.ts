import zlib from 'node:zlib'

/**
 * Archivos .rar minimos para las pruebas, sin compresion ("store"). El
 * programa oficial para crear RAR es de pago, pero el formato esta
 * documentado por RARLAB (technote de RAR 5.0 y de RAR 2.9-4.x); esto arma
 * lo justo para que el descompresor real (unrar) lo abra: archivos,
 * multi-volumen (RAR5) y una entrada con contraseña.
 */

export interface ArchivoRar {
  nombre: string
  datos: Buffer
}

function crc32(b: Buffer): number {
  return zlib.crc32(b) >>> 0
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

// ---------- RAR 5 ----------

/** Entero de largo variable de RAR5: 7 bits por byte, el bit alto indica que sigue. */
function vint(n: number): Buffer {
  const bytes: number[] = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    bytes.push(b)
  } while (n > 0)
  return Buffer.from(bytes)
}

/** Bloque RAR5: CRC32 + tamaño + (tipo, flags, [extra], [datos], campos, extra) + datos. */
function bloque5(tipo: number, flags: number, campos: Buffer, extra?: Buffer, datos?: Buffer): Buffer {
  const hflags = flags | (extra ? 0x0001 : 0) | (datos ? 0x0002 : 0)
  const cuerpo = Buffer.concat([
    vint(tipo),
    vint(hflags),
    extra ? vint(extra.length) : Buffer.alloc(0),
    datos ? vint(datos.length) : Buffer.alloc(0),
    campos,
    extra ?? Buffer.alloc(0)
  ])
  const tam = vint(cuerpo.length)
  return Buffer.concat([u32(crc32(Buffer.concat([tam, cuerpo]))), tam, cuerpo, datos ?? Buffer.alloc(0)])
}

const FIRMA_RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])

function cabeceraArchivo5(nombre: string, tamTotal: number, crc: number, cifrado: boolean): { campos: Buffer; extra?: Buffer } {
  const n = Buffer.from(nombre, 'utf8')
  const campos = Buffer.concat([
    vint(0x0004), // file flags: hay CRC32
    vint(tamTotal),
    vint(0x20), // atributos (archivo comun)
    u32(crc),
    vint(0), // compresion: version 0, metodo 0 = store
    vint(0), // SO de origen: Windows
    vint(n.length),
    n
  ])
  if (!cifrado) return { campos }
  // registro de cifrado (tipo 1): AES-256, sin valor de verificacion; sal e IV cualquiera
  const registro = Buffer.concat([vint(1), vint(0), vint(0), Buffer.from([15]), Buffer.alloc(16, 7), Buffer.alloc(16, 9)])
  return { campos, extra: Buffer.concat([vint(registro.length), registro]) }
}

/**
 * RAR5 "store". Con `bytesPorVolumen`, se parte en volumenes (nombre.part1.rar,
 * part2...), cortando los datos de los archivos entre volumenes.
 */
export function crearRar5(archivos: ArchivoRar[], opciones: { bytesPorVolumen?: number; cifrado?: boolean } = {}): Buffer[] {
  const porVolumen = opciones.bytesPorVolumen ?? Infinity
  // trozos: cada archivo partido en pedazos de a lo sumo `porVolumen`
  const volumenes: { archivo: ArchivoRar; desde: number; hasta: number }[][] = [[]]
  let libre = porVolumen
  for (const archivo of archivos) {
    let desde = 0
    do {
      if (libre <= 0) {
        volumenes.push([])
        libre = porVolumen
      }
      const hasta = Math.min(archivo.datos.length, desde + libre)
      volumenes[volumenes.length - 1].push({ archivo, desde, hasta })
      libre -= hasta - desde
      desde = hasta
    } while (desde < archivo.datos.length)
  }
  const multi = volumenes.length > 1
  return volumenes.map((trozos, v) => {
    const partes: Buffer[] = [FIRMA_RAR5]
    const flagsArchivo = (multi ? 0x0001 : 0) | (v > 0 ? 0x0002 : 0)
    partes.push(bloque5(1, 0, Buffer.concat([vint(flagsArchivo), v > 0 ? vint(v) : Buffer.alloc(0)])))
    for (const { archivo, desde, hasta } of trozos) {
      const datos = archivo.datos.subarray(desde, hasta)
      const ultimoTrozo = hasta === archivo.datos.length
      // en los trozos que no son el ultimo, el CRC es el de los datos de este volumen
      const crc = ultimoTrozo ? crc32(archivo.datos) : crc32(datos)
      const flags = (desde > 0 ? 0x0008 : 0) | (!ultimoTrozo ? 0x0010 : 0)
      const { campos, extra } = cabeceraArchivo5(archivo.nombre, archivo.datos.length, crc, !!opciones.cifrado)
      partes.push(bloque5(2, flags, campos, extra, datos))
    }
    partes.push(bloque5(5, 0, vint(multi && v < volumenes.length - 1 ? 0x0001 : 0)))
    return Buffer.concat(partes)
  })
}

// ---------- RAR 2.9 - 4.x ----------

function bloque4(tipo: number, flags: number, campos: Buffer, datos?: Buffer): Buffer {
  const tam = 7 + campos.length
  const sinCrc = Buffer.concat([Buffer.from([tipo]), u16(flags), u16(tam), campos])
  return Buffer.concat([u16(crc32(sinCrc) & 0xffff), sinCrc, datos ?? Buffer.alloc(0)])
}

/** RAR 4 "store" (nombres ASCII). */
export function crearRar4(archivos: ArchivoRar[]): Buffer {
  const partes: Buffer[] = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  partes.push(bloque4(0x73, 0, Buffer.concat([u16(0), u32(0)])))
  const fechaDos = ((2024 - 1980) << 25) | (1 << 21) | (1 << 16)
  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre.replace(/\//g, '\\'), 'latin1')
    const campos = Buffer.concat([
      u32(a.datos.length), // PACK_SIZE
      u32(a.datos.length), // UNP_SIZE
      Buffer.from([2]), // Win32
      u32(crc32(a.datos)),
      u32(fechaDos),
      Buffer.from([29, 0x30]), // version 2.9, metodo "store"
      u16(nombre.length),
      u32(0x20),
      nombre
    ])
    partes.push(bloque4(0x74, 0x8000, campos, a.datos))
  }
  partes.push(Buffer.from([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00]))
  return Buffer.concat(partes)
}
