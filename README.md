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
3. `< UMBRAL_DURO_MS` (150ms): corrección suave — ajusta levemente
   `playbackRate` de todas las pistas por unos segundos (la cantidad justa
   para absorber el drift) y vuelve a 1×. Un cambio de velocidad menor a
   ~1% sostenido pocos segundos no se percibe al oído; es la misma técnica
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

## Dispositivos conectados

El servidor mantiene un roster (`src/server/devices.ts`) con etiqueta
("Computadora", "Celular 1", "Celular 2"...), estado conectado/desconectado
y último drift reportado. Un dispositivo que se desconecta **no desaparece**
de la lista — queda marcado en rojo, para que el operador note si alguien
se cayó a mitad de un culto. Se ve en el panel "Conectar celulares".

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
