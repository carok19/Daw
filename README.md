# Multitrack Alabanza

App de escritorio (Electron) para reproducir pistas multitrack en vivo donde
**el audio sale de los celulares de los músicos**, todos sincronizados. La
computadora es el director: arma el setlist, maneja la mezcla y el
transporte, y sirve el audio por la WiFi local. Cada celular abre una página
web (sin instalar nada), recibe el audio por streaming y lo reproduce en el
mismo instante que los demás.

No necesita internet ni ninguna base de datos en la nube: todo vive en la
computadora (`~/MultitrackApp`), para que nada dependa de una conexión externa
durante un culto.

---

## Instalar y correr

```bash
npm install
npm start              # compila y abre la app
```

Instaladores (se generan en `dist/`; hay que correr cada uno en su sistema
operativo, o en un CI con Windows/macOS):

```bash
npm run dist:win       # instalador .exe (NSIS)
npm run dist:mac       # .dmg
npm run dist:linux     # AppImage
```

Datos guardados: `~/MultitrackApp/` → `proyectos/` (una carpeta por canción
con sus pistas en WAV y `proyecto.json`), `setlists/` y `sesion.json` (las
canciones abiertas, para recuperarlas si la app se cierra a mitad de un
culto). `MULTITRACK_APP_DIR` cambia esa carpeta (lo usan los tests).

### Desarrollo

- `npm run typecheck` — tipos de main/preload/server y del renderer.
- `npm run test:server` — tests de integración del servidor (Express +
  Socket.IO + ffmpeg reales, clientes "compu" y "celular" por socket): import
  de WAV/MP3, seguridad, sincronización, loop, fin de canción, dispositivos,
  sesión, setlists, migración de canciones viejas.
- `npm run test:e2e` — prueba de punta a punta con la interfaz real en
  Chromium: una compu y dos celulares; importa WAV y MP3, reproduce, marca
  secciones, salta, repite secciones, bloquea, cierra la canción que suena, y
  mide el desfase real de cada celular contra el servidor (tiene que quedar
  por debajo de 20 ms). La primera vez: `npx playwright install chromium`.
- `npm run dev:renderer` — solo la interfaz en un navegador (sin servidor).
- Con `?debug` en la URL del celular se expone `window.__mt` (motor, socket y
  estado) para diagnosticar en pruebas de campo.

---

## Checklist para el día del culto

1. **Misma WiFi para todos.** Ideal: un router propio para el equipo de
   alabanza (5 GHz, cerca del escenario). No necesita internet.
2. **Windows:** la primera vez que se abre la app, el firewall pregunta si
   permite conexiones: marcá **redes privadas** y aceptá (si no, los
   celulares no pueden conectarse).
3. Abrí la app: si se había cerrado, **el setlist vuelve solo**. Si no, armalo
   con **+ Canción** (importar `.zip` o abrir una guardada) o abrí un setlist
   guardado.
4. **Celulares:** botón **Celulares** (arriba a la derecha) → escanear el QR →
   **“Tocá para empezar”** → conectar auriculares. En ⚙ cada músico puede
   ponerle nombre a su celular (“Batería”, “Bajo”…).
5. Mirá el chip de celulares: **verde** = todos listos y sincronizados;
   **amarillo** = alguien no activó el audio, tiene WiFi lento o está
   desfasado; **rojo** = alguien se desconectó o tiene un error de audio. El
   detalle está en la ventana de Celulares.
6. Si no querés que nadie toque el transporte desde su celular, activá
   **Celulares bloqueados**.
7. La pantalla de los celulares queda encendida sola (conviene bajar el
   brillo). Si alguien usa **auriculares Bluetooth** y lo escucha atrasado:
   ⚙ → *Ajuste fino* → sumar milisegundos hasta que coincida.
8. Cada músico puede armar **Mi mezcla** (más click, menos pad…) sin cambiar
   lo que escuchan los demás.

**Ancho de banda:** cada celular recibe ~0,7 Mbps por pista mono y ~1,4 Mbps
por pista estéreo (WAV sin comprimir, para que los saltos y el loop sean
exactos). Una canción de 10 pistas ≈ 7–14 Mbps por celular. Un router
decente en 5 GHz aguanta varios celulares; si alguno se queda corto, la app
lo avisa (en el celular y en la compu) y se pone al día sola cuando mejora.

### Atajos de teclado (compu)

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausa |
| Enter | Stop (vuelve al inicio) |
| ← / → | Sección anterior / siguiente |
| 1 … 9 | Ir a la sección 1 a 9 |
| M | Marcar una sección en la posición actual |
| L | Repetir la sección actual |
| Re Pág / Av Pág | Canción anterior / siguiente |
| ? | Ayuda de atajos |

---

## Arquitectura

- `src/server` — Express + Socket.IO embebido en el proceso principal de
  Electron. Fuente de verdad de todo: setlist, mezcla, secciones,
  reproducción, dispositivos.
  - `socketHandlers.ts` — protocolo y permisos. `transport.ts` — play/pausa/
    stop/saltos y los eventos que dependen del tiempo (fin de canción,
    repetir sección). `state.ts` — setlist en memoria. `devices.ts` —
    celulares conectados. `projects.ts` — disco, setlists, sesión,
    migración. `zip.ts` + `audio.ts` — importación con ffmpeg.
- `src/main` / `src/preload` — Electron: arranca el servidor, abre la
  ventana y le pasa (por IPC, nunca por la red) el token que la identifica
  como "la compu".
- `src/renderer` — React. Un solo bundle para la compu y los celulares
  (`App.tsx` elige según exista `window.electronAPI`).
  - `app/useAppController.ts` — conexión, motor de audio, sincronía,
    acciones. `app/playheadStore.ts` — posición de reproducción como store
    externo (solo re-renderiza lo que la muestra, no el mixer).
  - `audio/StreamingEngine.ts` — motor de audio (compu y celulares).
  - `computer/*`, `mobile/*`, `ui/*` — interfaz.
- `src/shared` — tipos, cálculo de posición/secciones y parser de WAV,
  compartidos por servidor y navegador.

### Importación de canciones

Un `.zip` con una pista por archivo (WAV, MP3, M4A/AAC, AIFF, FLAC u OGG).
Cada pista se normaliza con **ffmpeg** (incluido en la app, `ffmpeg-static`)
a **WAV PCM 16-bit**, el único formato que se puede cortar en cualquier
muestra y pedir por partes sin clicks. Si una pista estéreo es en realidad
*dual mono* (L = R, típico de click, guía, bajo, bombo) se guarda en mono: la
mitad de datos por WiFi sin diferencia audible. La duración la calcula el
servidor. Los nombres pierden el prefijo de orden (`01_Click` → `Click`) y
cada pista recibe un color distinto por orden (editable). Las canciones
guardadas con versiones anteriores (por ejemplo con MP3 que no sonaban en los
celulares) se migran solas al abrirlas.

### Streaming de audio (celulares y compu)

Nadie descarga ni decodifica la canción entera. Cada pista se pide por
**HTTP Range** en segmentos de 2 s y se mantiene una ventana de ~8 s por
delante de lo que suena; cada segmento se libera apenas termina. Los
segmentos se encadenan por aritmética de muestras (sin huecos) sobre
`GainNode` + `StereoPannerNode` persistentes por pista.

- **Orden de urgencia:** primero el próximo segmento de *todas* las pistas,
  después el siguiente (el navegador baja ~6 cosas a la vez por servidor).
- **Arranque instantáneo:** en pausa se deja listo el comienzo desde la
  posición actual, y se mantienen en memoria los primeros segundos de cada
  sección ("cues"): saltar de sección o repetir una sección entra en sync sin
  esperar la red.
- **Nunca suena algo incorrecto:** si un segmento no llega a tiempo, el motor
  espera (sin silencio sintético) y, cuando junta 3 s, se reincorpora en el
  punto exacto. El estado del buffer se muestra en el celular y en la compu.
- **Errores:** una pista con un problema irrecuperable (archivo que falta,
  formato ilegible) queda muda sin frenar a las demás y se informa; los
  errores de red se reintentan con espera creciente.

| Constante (`audio/streamConfig.ts`) | Valor | Significado |
|---|---|---|
| `SEGMENT_DURATION_SEC` | 2 | Duración de cada segmento |
| `BUFFER_TARGET_SEC` | 8 | Audio encadenado por delante |
| `BUFFER_CRITICAL_SEC` | 3 | Por debajo: aviso de conexión lenta |
| `BUFFER_MIN_START_SEC` | 3 | Mínimo para (re)arrancar |
| `MAX_CUES` / `SEGMENTOS_POR_CUE` | 16 / 2 | Arranques de sección precargados |

### Sincronización

1. **Reloj:** cada dispositivo mide su diferencia con el reloj del servidor
   (7 ping/pong, se queda con el de menor ida y vuelta; se repite cada 2 min y
   al volver a primer plano).
2. **Comandos programados:** play, pausa, stop y saltos se programan
   ~1,5 s a futuro (30 ms si no hay celulares) y cada dispositivo los ejecuta
   con Web Audio en ese instante exacto.
3. **Tramo previo:** entre que se emite un comando y su horario sigue
   sonando lo anterior; el estado lo describe (`previo`, una cadena corta si
   hay dos comandos seguidos), así la interfaz, el monitor de drift y un
   celular que se une en ese momento ven lo que realmente suena.
4. **Latencia de salida:** cada dispositivo adelanta su arranque según la
   latencia que informa su sistema (`outputLatency`) más el ajuste fino
   manual. El drift se mide sobre lo que *se escucha*, descontando esa
   compensación (si no, el monitor la "corregiría" y la desharía).
5. **Drift continuo** (cada 4 s): < 15 ms nada; 15–150 ms corrección suave
   cambiando la velocidad 0,4 % (inaudible) el tiempo justo; ≥ 150 ms
   resincronización dura de ese dispositivo.
6. **Pantalla bloqueada / segundo plano:** la pantalla se mantiene encendida
   (NoSleep.js: Wake Lock si está disponible, si no un video mudo; la app se
   sirve por `http://` y ahí el Wake Lock nativo no existe), Media Session
   marca la página como reproducción de audio, y al volver a primer plano se
   resincroniza al instante.

### Seguridad

- La compu se identifica con un **token secreto** que genera el proceso
  principal y solo conoce la ventana de Electron. Un celular que diga "soy la
  compu" sigue siendo un celular: no puede importar, borrar, editar la mezcla
  ni saltarse el bloqueo.
- Todos los ids que llegan por la red se validan como UUID antes de tocar el
  disco (no se puede pedir `../../algo`); la ruta del zip se valida.
- Límites contra zips maliciosos (tamaño y cantidad de pistas).
- `/media` es solo lectura; `index.html` no se cachea (los celulares siempre
  toman la versión nueva de la app).

---

## Decisiones de diseño

1. **El audio sale de los celulares.** La compu no suena por defecto
   (interruptor *Sonido en la compu* para ensayar o probar).
2. **Una sola canción suena a la vez.** Cambiar de canción detiene la
   anterior; cerrar la canción que suena (o borrarla) corta el audio en
   todos (con confirmación).
3. **La mezcla del director llega a todos** en tiempo real (mensajes
   livianos por pista, guardado a disco con debounce). Cada celular suma su
   volumen general y su *Mi mezcla* (recordada por nombre de pista, vale
   para todas las canciones).
4. **Curva de fader de audio** (cuadrática, se muestra en dB; doble click =
   −3,9 dB, el valor de importación). Faders y paneo con arrastre relativo:
   un click suelto no cambia el volumen.
5. **Secciones = marcadores.** La línea de tiempo muestra la canción por
   secciones; los triángulos se arrastran para moverlas. Borrar una sección
   se puede deshacer.
6. **Fin de canción y repetir sección los maneja el servidor**, así
   funcionan aunque la ventana de la compu esté ocupada.
7. **Los celulares pueden controlar** (play/pausa/saltar/repetir) salvo que
   la compu los bloquee. Editar (secciones, mezcla, setlist) es solo de la
   compu.
8. **Cada dispositivo tiene un id estable** (localStorage): al reconectar
   vuelve a su misma fila con su nombre, sin "fantasmas". Los desconectados
   quedan visibles (para notar si alguien se cayó) hasta que se limpian.
9. **Puerto fijo:** 4848, y si está ocupado 4849, 4850… (misma dirección y
   mismo QR de un día al otro).
10. **Sin base de datos externa:** todo en archivos JSON locales con
    escritura atómica. Funciona sin internet.

## Limitaciones conocidas / próximos pasos

- **Falta la prueba de campo con celulares reales.** Todo se validó con
  navegadores automatizados (compu + varios celulares, WiFi lento simulado,
  reinicio del servidor, app de Electron real), pero el sonido real, la
  latencia de cada modelo y el Bluetooth solo se pueden medir con hardware.
  Prueba sugerida: 2–3 celulares juntos reproduciendo solo el click; si se
  oye "eco", usar el ajuste fino en el que suena atrasado.
- **iPhone:** Safari puede frenar el audio si se bloquea la pantalla; la app
  mantiene la pantalla encendida, pero conviene no bloquearla a mano.
- Los instaladores no están firmados: Windows (SmartScreen) y macOS
  (Gatekeeper) muestran un aviso la primera vez.
- Una APK nativa de Android daría mejor control de la latencia y del
  segundo plano.
