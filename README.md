# Multitrack Alabanza

App de escritorio (Electron) para reproducir pistas multitrack sincronizadas
con celulares conectados por WiFi local. Ver `prompt` original del proyecto
para la especificación completa; este README documenta cómo correrla y las
decisiones de diseño tomadas donde la especificación dejaba algo abierto.

## Cómo correr

```bash
npm install
npm start        # build (renderer + main) y abre la app de Electron
```

Durante una presentación en vivo, dejá la compu y los celulares en la misma
red WiFi. Desde "Conectar celulares" en la compu vas a ver un QR con la URL
local (`http://<ip-lan>:<puerto>`); el puerto por defecto es `4848` (si está
ocupado, el sistema operativo asigna uno libre automáticamente).

Los proyectos guardados quedan en `~/MultitrackApp/proyectos/`.

### Desarrollo

- `npm run dev:renderer` — Vite dev server del renderer solo (para iterar UI rápido en un navegador de escritorio; no reemplaza probar dentro de Electron).
- `npm run typecheck` — chequeo de tipos de main/preload/server y renderer.
- `npm run test:server` — test de integración del servidor (Express + Socket.IO), sin necesidad de Electron ni un display: arma un zip de prueba, simula un cliente "compu" y uno "celular" reales por socket, y verifica carga de zip, filtrado de audio, mixer, marcadores, bloqueo de control y el mecanismo de sincronización (`playback:scheduled`).

## Arquitectura

- `src/server` — Express + Socket.IO embebido (corre dentro del proceso principal de Electron). Fuente de verdad de todo el estado (pestañas/proyectos abiertos, mezcla, marcadores, reproducción). Sirve el build del renderer y los archivos de audio (`/media/<proyectoId>/...`) tanto a la ventana de Electron como a los celulares.
- `src/main` / `src/preload` — shell de Electron. El proceso principal arranca el servidor embebido y abre la ventana apuntando a `http://localhost:<puerto>`. El preload expone `window.electronAPI` (diálogo nativo para elegir el .zip, info de conexión) — su sola presencia es lo que distingue a la ventana de Electron de un navegador de celular.
- `src/renderer` — React + TypeScript. Un solo bundle servido tanto a la compu como a los celulares; `App.tsx` elige `ComputerApp` o `MobileApp` según si `window.electronAPI` existe.
- `src/shared` — tipos y la fórmula de posición de reproducción (`posicionActualMs`), compartidos entre server y renderer.

## Decisiones de diseño (donde la especificación no era explícita)

El documento original pide explícitamente preguntar antes de asumir. Se optó
por avanzar con una decisión razonable en cada punto (documentada acá) en
vez de bloquear la implementación; **cualquiera de estos puntos se puede
ajustar si no es lo que se esperaba**:

1. **Una sola pestaña suena a la vez.** Al cambiar de pestaña, si la que se
   deja estaba reproduciendo, se pausa automáticamente (conserva su
   posición). Evita mezclar el audio de dos canciones a la vez, que no
   parece un caso de uso real para un culto en vivo.
2. **Cómo llega la mezcla estéreo a los celulares.** En vez de transmitir un
   stream de audio ya mezclado desde el servidor (que requeriría
   codificación/streaming en tiempo real, no descrito en la especificación),
   cada dispositivo — compu y cada celular — descarga los mismos archivos de
   audio de cada pista y arma el mismo grafo Web Audio
   (`GainNode` + `StereoPannerNode` por pista) que la compu. Los valores de
   volumen/pan/mute/solo se retransmiten a todos los clientes en tiempo real,
   así el balance estéreo que se escucha en cada celular es siempre idéntico
   al de la compu. El único control propio del celular es el fader de
   volumen general (una ganancia maestra aplicada después de la mezcla).
3. **Detección Modo Computadora vs Modo Celular.** Se resuelve en el cliente
   por la presencia de `window.electronAPI` (solo existe dentro de la
   ventana de Electron, inyectada por el `preload`), no por user-agent en el
   servidor.
4. **Duración total de la canción.** Se detecta recién cuando el motor de
   audio decodifica los buffers (la compu la reporta al servidor la primera
   vez que carga cada proyecto); no se usa ninguna librería de metadata de
   audio en el backend.
5. **Curva de volumen del fader.** Mapeo lineal 0–100 → ganancia 0–1, tal
   como indica la especificación ("mapeado a ganancia lineal").
6. **Mecanismo de ping/pong para el offset de reloj.** Implementado con
   acks de Socket.IO (correlación automática pedido/respuesta) en lugar de
   dos eventos separados; el resultado es equivalente (5 muestras, se toma
   el offset de la muestra con menor RTT).
7. **Seek y salto de marcador** se resuelven como un "play" reprogramado
   (si la canción estaba sonando, con el margen de ~1.5s) o como una
   actualización inmediata de posición sin agenda (si estaba pausada o
   detenida, ya que no hay audio en curso que sincronizar).
8. **Celular que se desconecta y reconecta a mitad de canción.** Al
   reconectar, vuelve a sincronizar su reloj, pide el estado completo
   actual y, si la canción sigue sonando, se auto-programa para unirse
   ~300–600ms en el futuro (no espera al próximo comando del director).
9. **Fin de la canción.** Cuando la posición alcanza la duración total
   mientras se reproduce, la compu emite automáticamente un `stop` — no
   estaba detallado explícitamente en la especificación.
10. **Políticas de autoplay del navegador.** Se agregó una pantalla
    "Activar audio" en el Modo Celular: sin una interacción explícita del
    usuario, iOS/Android bloquean el `AudioContext` y ningún comando
    programado por el servidor podría sonar. Es un requisito técnico, no
    una funcionalidad pedida por la especificación.
11. **Stop** siempre vuelve la posición a 0 (a diferencia de Pause).
12. **Ubicación de proyectos guardados:** `~/MultitrackApp/proyectos/<id>/`
    (`MULTITRACK_APP_DIR` permite sobreescribir la base, usado por los
    tests del servidor).

## Sincronización continua (drift) — Fase 2

Programar el `start()` con el mismo horario en todos los dispositivos alinea
el *arranque*, pero no evita que se separen con el correr de los minutos: el
reloj de audio de cada dispositivo (`AudioContext.currentTime`, gobernado por
el cristal del hardware de audio) y el reloj de pared (`Date.now()`, el que
sincronizamos con el servidor) son dos relojes distintos dentro del mismo
dispositivo, y no tienen garantizado avanzar exactamente a la misma
velocidad. Mientras se está reproduciendo, cada dispositivo (compu y cada
celular) corre su propio monitor cada `INTERVALO_MONITOREO_MS` (4s,
`src/renderer/src/sync/driftConfig.ts`):

1. Calcula `drift = posición real (según el reloj de audio) − posición
   esperada (según el modelo del servidor)`.
2. `< UMBRAL_SUAVE_MS` (15ms): no hace nada.
3. `< UMBRAL_DURO_MS` (150ms): corrección suave — ajusta `playbackRate` de
   todas las pistas y vuelve a 1×. **Velocidad fija, ventana variable**: la
   desviación de velocidad queda siempre acotada a `MAX_RATE_DEV` (0.4%,
   dentro de `AudioEngine.corregirDriftSuave()`), imperceptible al oído; lo
   que varía es cuánto tarda en terminar — 15ms tarda ~3.75s, 50ms ~12.5s,
   149ms ~37.25s, siempre a la misma velocidad. Es la misma técnica
   ("vari-speed drift compensation") que usan sistemas profesionales de
   sincronización de audio.
4. `≥ UMBRAL_DURO_MS`: resincronización dura — para y vuelve a programar el
   audio de ESE dispositivo en la posición correcta, reusando el mismo
   mecanismo de `executeAtServerTime` (margen corto, ~400ms) que cualquier
   otro comando de transporte.

Es una corrección **puramente local**: cada dispositivo se corrige a sí
mismo contra el modelo de tiempo del servidor (que ya tiene, no hace falta
ningún mensaje de red nuevo para medir), así que quedan sincronizados entre
sí por transitividad sin necesidad de compararse par a par. Cada salto de
marcador (o Play) ya reprograma el audio desde cero, así que también actúa
como punto de resincronización "gratis".

El indicador 🟢/🟡/🔴 (en el transporte de la compu, y por celular en el
panel "Conectar celulares") muestra exactamente ese mismo `drift` — no es
un valor decorativo aparte.

### Pantalla bloqueada / app en segundo plano

El motivo real detrás de "un rato está bien y después se desincroniza" sin
Bluetooth de por medio: los navegadores móviles frenan los temporizadores de
JS cuando la pantalla se bloquea o la pestaña pasa a segundo plano (para
ahorrar batería) — el audio sigue sonando, pero el monitor de drift de
arriba deja de correr, así que cualquier deriva que aparezca mientras tanto
queda sin corregir. Dos mitigaciones (`src/renderer/src/mobile/useWakeLock.ts`
y el efecto de `visibilitychange` en `useAppController`):

1. **Wake Lock**: al tocar "Activar audio" se pide `navigator.wakeLock`
   para que la pantalla no se apague sola mientras el celular está en uso
   (se vuelve a pedir automáticamente si el sistema lo libera).
2. **Resync inmediato al volver**: si aun así la pantalla se bloqueó (por
   ejemplo el usuario apagó la pantalla a mano, o pasó a otra app), en
   cuanto la pestaña vuelve a primer plano se resincroniza el reloj y se
   reprograma el audio de inmediato — no se espera al próximo chequeo
   periódico.
3. **Media Session** (`navigator.mediaSession`, metadata + estado de
   reproducción, sin controles remotos de play/pausa a propósito): es la
   señal estándar que usan los navegadores para saber que una pestaña está
   reproduciendo audio real y no debería congelarse/matarse en segundo
   plano. El Wake Lock (punto 1) solo evita el apagado automático por
   inactividad — **no** evita que el usuario apague la pantalla a mano con
   el botón de encendido, que es un caso válido ("quiero apagar la
   pantalla pero que siga sonando y conectado"); Media Session es lo que
   ayuda en ese caso.

   Honestidad técnica: en Android/Chrome esto debería funcionar de forma
   confiable (Chrome exime de la congelación agresiva a las pestañas que
   están reproduciendo audio activamente). En iOS/Safari el comportamiento
   de audio en segundo plano con Web Audio API puro (sin una etiqueta
   `<audio>`) ha sido históricamente menos consistente entre versiones —
   no hay forma de garantizarlo al 100% desde JavaScript. Por eso los
   puntos 1 y 2 siguen siendo la red de seguridad: si el audio o el socket
   se llegan a cortar con la pantalla apagada, apenas el celular vuelve a
   primer plano se resincroniza solo, sin intervención manual.

## Dispositivos conectados

El servidor mantiene un roster (`src/server/devices.ts`) con etiqueta
("Computadora", "Celular 1", "Celular 2"...), estado conectado/desconectado
y último drift reportado. Un dispositivo que se desconecta **no desaparece**
de la lista — queda marcado en rojo, para que el operador note si alguien
se cayó a mitad de un culto. Se ve en el panel "Conectar celulares".

## Precarga y cache de audio

**El problema que resuelve**: antes, cada vez que la compu cambiaba de
canción (incluso volviendo a una que ya había sonado antes en el mismo
culto), cada celular volvía a descargar y decodificar TODAS las pistas
desde cero — `AudioEngine` no retenía nada entre canciones. Sesión de
reproducción continua ahora significa: Socket.IO nunca se toca al cambiar
de canción (ya no se tocaba antes tampoco), el clock offset tampoco se
recalcula (idem), y los `AudioBuffer` decodificados sí se retienen.

**Cache** (`src/renderer/src/audio/AudioEngine.ts`): `this.tracks` es
únicamente el set de pistas *activo ahora mismo*; un `Map` aparte
(`this.cache`, por `proyectoId`) retiene además los buffers ya
decodificados de otras canciones del setlist. `activarProyecto()` primero
consulta el cache — si está, activación instantánea (solo reconecta nodos
ya existentes, cero descarga, cero decodificación); si no, precarga y
activa. `A → B → A` no vuelve a descargar `A`.

**Presupuesto de memoria**: un `AudioBuffer` decodificado pesa
`duración × sampleRate × canales × 4 bytes` (PCM float32 sin comprimir,
sin importar el formato original). Una canción típica (9 pistas, ~5min)
decodificada entera ronda **500–700MB** — cachear un setlist completo sin
límite son varios GB, inviable en un celular. Por eso el cache tiene un
presupuesto (`CACHE_MAX_BYTES`, 800MB por defecto) con desalojo LRU
(se descarta primero lo usado hace más tiempo); **la canción activa y la
siguiente del setlist nunca se desalojan**, sin importar el presupuesto —
solo gobierna cuántas canciones "extra" quedan dando vueltas.

**Precarga en segundo plano** (`useAppController`): mientras suena la
canción activa, se precargan de a una por vez las demás canciones del
setlist que no estén cacheadas, por prioridad — siguiente primero, después
por cercanía hacia adelante, lo de atrás ("ya sonado") al final — sin
competir por ancho de banda entre sí, y sin interrumpir la que está
sonando (la precarga nunca toca `this.tracks`).

**Reporte de estado** (`preparacion:reportar` → `DeviceRegistry` →
`estado:actualizado`): cada dispositivo informa `sin-preparar` /
`descargando` (con %) / `preparando` (decodificando) / `listo` / `error`
por proyecto — distinguiendo explícitamente "tengo los bytes" de "el audio
ya está realmente utilizable". Se ve en el panel "Conectar celulares",
bajo el nombre de la próxima canción.

**Decisión explícita: NO bloquea `transport:play`.** Es solo informativo —
el Play sigue funcionando exactamente igual que siempre, sin esperar a que
nadie termine de preparar nada. Si un celular cambia de canción antes de
terminar su propia precarga, el comando de audio que le llegue mientras
tanto queda en espera (mecanismo ya existente de `comandoPendiente`) y se
aplica solo apenas termine — no se pierde, pero tampoco bloquea a los
demás dispositivos ni al operador.

## Qué falta / próximos pasos posibles

- No se armó un instalador (electron-builder está como dependencia pero sin
  configurar); `npm start` corre la app localmente, que es lo necesario para
  usarla en un culto.
- No se probó en dispositivos reales (celulares/red WiFi física) dentro de
  este entorno de desarrollo — la lógica de sincronización se validó con un
  test de integración de servidor (`npm run test:server`) que simula
  clientes reales por Socket.IO, pero no hay forma de levantar una ventana
  de Electron ni una red WiFi real en este entorno para una prueba end to
  end con hardware.
