import { useRef, useState } from 'react'
import { BadgeCheck, Check, Copy, FileKey, KeyRound } from 'lucide-react'
import type { AppController } from '../app/useAppController'
import { copiarTexto } from '../conexion'
import { Modal } from '../ui/Modal'
import { useConfirmar } from '../ui/Confirmar'

function fecha(aaaammdd: string): string {
  const [a, m, d] = aaaammdd.split('-')
  return `${d}/${m}/${a}`
}

/** Licencia de esta compu: estado, codigo de la compu y pegar/abrir una licencia. */
export function LicenciaPanel({ controller, onCerrar }: { controller: AppController; onCerrar: () => void }) {
  const l = controller.licencia
  const confirmar = useConfirmar()
  const [texto, setTexto] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activando, setActivando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const archivo = useRef<HTMLInputElement>(null)

  async function activar(t = texto): Promise<void> {
    if (!t.trim() || activando) return
    setActivando(true)
    setError(null)
    try {
      const r = await controller.activarLicencia(t)
      if (r.ok) {
        setTexto('')
        controller.avisar({ tipo: 'info', texto: '¡Licencia activada!' })
      } else setError(r.error ?? 'No se pudo activar la licencia')
    } catch {
      setError('No se pudo activar la licencia')
    }
    setActivando(false)
  }

  async function abrirArchivo(f: File | undefined): Promise<void> {
    if (!f) return
    const t = f.size < 20000 ? await f.text() : ''
    setTexto(t.trim())
    await activar(t)
  }

  async function quitar(): Promise<void> {
    const ok = await confirmar({
      titulo: 'Quitar la licencia',
      mensaje: `Esta compu vuelve a la versión de prueba (hasta ${l?.celularesPrueba ?? 2} celulares a la vez). Guardá la licencia por si la querés activar de nuevo.`,
      confirmar: 'Quitar',
      peligro: true
    })
    if (ok) await controller.quitarLicencia()
  }

  return (
    <Modal
      titulo="Licencia"
      icono={<KeyRound size={20} color="var(--accent)" />}
      onCerrar={onCerrar}
      pie={
        <>
          {l?.activa && (
            <button className="btn-fantasma" style={{ marginRight: 'auto' }} onClick={() => void quitar()}>
              Quitar licencia
            </button>
          )}
          <button onClick={onCerrar}>Cerrar</button>
        </>
      }
    >
      {!l ? (
        <p className="ayuda">Cargando…</p>
      ) : (
        <div className="licencia">
          {l.activa ? (
            <div className="licencia-estado activa">
              <BadgeCheck size={22} />
              <div>
                <strong>Licencia activa</strong>
                <div className="ayuda">
                  A nombre de <b>{l.nombre}</b>
                  <br />
                  {l.celulares ? `Hasta ${l.celulares} celulares a la vez` : 'Celulares sin límite'}
                  {' · '}
                  {l.vence ? `vence el ${fecha(l.vence)}` : 'sin vencimiento'}
                  {l.atadaAEquipo && ' · solo en esta computadora'}
                </div>
              </div>
            </div>
          ) : (
            <div className="licencia-estado prueba">
              <KeyRound size={22} />
              <div>
                <strong>Versión de prueba</strong>
                <div className="ayuda">
                  Todo funciona completo, con hasta <b>{l.celularesPrueba} celulares</b> a la vez. Con una licencia se suman más.
                </div>
                {l.error && <p className="error-texto">La licencia guardada no sirve: {l.error}</p>}
              </div>
            </div>
          )}

          <div className="licencia-equipo">
            <span className="ayuda">Código de esta computadora</span>
            <code className="num">{l.equipo}</code>
            <button
              className="btn-chico"
              onClick={() => {
                if (copiarTexto(l.equipo)) {
                  setCopiado(true)
                  setTimeout(() => setCopiado(false), 2000)
                }
              }}
            >
              {copiado ? <Check size={14} /> : <Copy size={14} />} {copiado ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <p className="ayuda" style={{ margin: 0 }}>
            Si la licencia es para una sola computadora, pasale este código a quien te la vende.
          </p>

          <form
            className="licencia-activar"
            onSubmit={(e) => {
              e.preventDefault()
              void activar()
            }}
          >
            <label className="ayuda" htmlFor="texto-licencia">
              {l.activa ? '¿Tenés otra licencia (por ejemplo, con más celulares)? Pegala acá:' : 'Pegá acá la licencia que te mandaron (empieza con LIC1.):'}
            </label>
            <textarea
              id="texto-licencia"
              className="licencia-texto"
              rows={4}
              spellCheck={false}
              placeholder="LIC1.…"
              value={texto}
              onChange={(e) => {
                setTexto(e.target.value)
                setError(null)
              }}
            />
            {error && (
              <p className="error-texto" role="alert">
                {error}
              </p>
            )}
            <div className="licencia-botones">
              <button type="button" onClick={() => archivo.current?.click()}>
                <FileKey size={16} /> Abrir archivo .licencia
              </button>
              <button className="btn-primario" disabled={!texto.trim() || activando}>
                {activando ? 'Activando…' : 'Activar'}
              </button>
            </div>
            <input
              ref={archivo}
              type="file"
              accept=".licencia,.txt"
              hidden
              onChange={(e) => {
                void abrirArchivo(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </form>
          <p className="ayuda" style={{ margin: 0, color: 'var(--text-3)' }}>
            No hace falta internet: la licencia se revisa en esta computadora.
          </p>
        </div>
      )}
    </Modal>
  )
}
