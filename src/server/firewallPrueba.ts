/**
 * Prueba del firewall en una Windows de verdad (la corre GitHub Actions en la
 * compu Windows que arma el instalador): se crea para un programa de prueba el
 * bloqueo que deja el aviso de Windows ("redes publicas" sin marcar), se
 * comprueba que se detecta, se arregla con "Permitir en todas las redes" y se
 * comprueba que quedo permitido. Al final se borra todo.
 *
 *   node out/main/firewall-prueba.cjs
 */
import { spawnSync } from 'node:child_process'
import { evaluarFirewall, leerFirewall, permitirEnFirewall, type DatosFirewall } from './firewall'

const PROGRAMA = 'C:\\AirTracks Prueba\\AirTracks Prueba.exe'

function ps(script: string): void {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`PowerShell: ${r.stderr}`)
}

function limpiar(): void {
  ps(
    `Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq '${PROGRAMA}' } | Get-NetFirewallRule | Remove-NetFirewallRule -ErrorAction SilentlyContinue`
  )
}

/** Como si la compu estuviera en una WiFi publica nueva (la del runner puede ser de cualquier tipo). */
function enRedPublica(d: DatosFirewall): DatosFirewall {
  return { ...d, redes: [{ nombre: 'Iglesia', interfaz: 'Wi-Fi', categoria: 'Public' }] }
}

function comprobar(condicion: boolean, mensaje: string): void {
  if (!condicion) throw new Error(mensaje)
  console.log(`ok - ${mensaje}`)
}

async function main(): Promise<void> {
  limpiar()
  try {
    ps(
      [
        `New-NetFirewallRule -DisplayName 'AirTracks Prueba' -Direction Inbound -Program '${PROGRAMA}' -Action Allow -Profile Private | Out-Null`,
        `New-NetFirewallRule -DisplayName 'AirTracks Prueba' -Direction Inbound -Program '${PROGRAMA}' -Action Block -Profile Public | Out-Null`
      ].join('; ')
    )
    const antes = await leerFirewall(PROGRAMA)
    console.log('leido:', JSON.stringify(antes))
    comprobar(!!antes && antes.legible, 'se lee el firewall sin error (redes, reglas y perfiles)')
    comprobar(antes!.reglas.length === 2, `se encuentran las 2 reglas del programa (${antes!.reglas.length})`)
    const e1 = evaluarFirewall(enRedPublica(antes!))
    comprobar(e1.estado === 'bloqueado', `en una red publica, bloqueado (${e1.estado})`)
    comprobar(evaluarFirewall({ ...antes!, redes: [{ nombre: 'Casa', interfaz: 'Wi-Fi', categoria: 'Private' }] }).estado === 'ok', 'en una red privada, ok')

    const r = await permitirEnFirewall(PROGRAMA)
    comprobar(r === 'ok', `"Permitir en todas las redes" (${r})`)
    const despues = await leerFirewall(PROGRAMA)
    console.log('leido:', JSON.stringify(despues))
    comprobar(!!despues && despues.reglas.length === 1 && despues.reglas[0].accion === 'Allow' && despues.reglas[0].perfil === 'Any', 'queda una sola regla que permite en cualquier red')
    comprobar(evaluarFirewall(enRedPublica(despues!)).estado === 'ok', 'en una red publica, ok')
  } finally {
    limpiar()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
