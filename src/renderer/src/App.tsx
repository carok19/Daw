import { useAppController } from './app/useAppController'
import { ComputerApp } from './computer/ComputerApp'
import { MobileApp } from './mobile/MobileApp'

export default function App() {
  const controller = useAppController()

  if (controller.origen === 'compu') {
    return <ComputerApp controller={controller} />
  }
  return <MobileApp controller={controller} />
}

export type AppController = ReturnType<typeof useAppController>
