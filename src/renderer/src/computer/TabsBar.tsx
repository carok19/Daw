import type { TabResumen } from '@shared/types'

interface Props {
  tabs: TabResumen[]
  activeTabId: string | null
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onNuevo: () => void
  onConexion: () => void
  locked: boolean
  onToggleLock: (v: boolean) => void
}

export function TabsBar({ tabs, activeTabId, onSwitch, onClose, onNuevo, onConexion, locked, onToggleLock }: Props) {
  return (
    <div className="tabs-bar">
      <div className="tabs-lista">
        {tabs.map((t) => (
          <div key={t.tabId} className={`tab ${t.tabId === activeTabId ? 'tab-activo' : ''}`} onClick={() => onSwitch(t.tabId)}>
            <span>{t.nombre}</span>
            <button
              className="tab-cerrar"
              title="Cerrar pestaña"
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.tabId)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-nuevo" onClick={onNuevo}>
          + Canción
        </button>
      </div>
      <div className="tabs-derecha">
        <label className="lock-toggle">
          <input type="checkbox" checked={locked} onChange={(e) => onToggleLock(e.target.checked)} />
          Bloquear control solo a la computadora
        </label>
        <button className="btn-conexion" onClick={onConexion}>
          Conectar celulares
        </button>
      </div>
    </div>
  )
}
