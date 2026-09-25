import { useAppController } from './app/useAppController'
import { ComputerApp } from './computer/ComputerApp'
import { MobileApp } from './mobile/MobileApp'
import { ConfirmarProvider } from './ui/Confirmar'

export default function App() {
  const controller = useAppController()
  return (
    <ConfirmarProvider>
      {controller.origen === 'compu' ? <ComputerApp controller={controller} /> : <MobileApp controller={controller} />}
    </ConfirmarProvider>
  )
}
