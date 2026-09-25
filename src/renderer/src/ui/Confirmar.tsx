import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Modal } from './Modal'

interface Pedido {
  titulo: string
  mensaje: ReactNode
  confirmar: string
  peligro?: boolean
  resolver: (ok: boolean) => void
}

type Confirmar = (opciones: Omit<Pedido, 'resolver'>) => Promise<boolean>

const Ctx = createContext<Confirmar>(async () => window.confirm('¿Seguro?'))

/** Dialogo de confirmacion propio (en vez del confirm() nativo), con el mismo estilo que el resto de la app. */
export function ConfirmarProvider({ children }: { children: ReactNode }) {
  const [pedido, setPedido] = useState<Pedido | null>(null)
  const confirmar = useCallback<Confirmar>(
    (opciones) => new Promise<boolean>((resolver) => setPedido({ ...opciones, resolver })),
    []
  )
  function cerrar(ok: boolean): void {
    pedido?.resolver(ok)
    setPedido(null)
  }
  return (
    <Ctx.Provider value={confirmar}>
      {children}
      {pedido && (
        <Modal
          titulo={pedido.titulo}
          tamano="chico"
          onCerrar={() => cerrar(false)}
          pie={
            <>
              <button onClick={() => cerrar(false)}>Cancelar</button>
              <button className={pedido.peligro ? 'btn-peligro' : 'btn-primario'} onClick={() => cerrar(true)} autoFocus>
                {pedido.confirmar}
              </button>
            </>
          }
        >
          <div className="ayuda">{pedido.mensaje}</div>
        </Modal>
      )}
    </Ctx.Provider>
  )
}

export function useConfirmar(): Confirmar {
  return useContext(Ctx)
}
