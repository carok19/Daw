# AirTracks Wireless Monitor

App de escritorio (Electron) para reproducir pistas multitrack en vivo donde
**el audio sale de los celulares de los músicos**, todos sincronizados. La
computadora es el director: arma el setlist, maneja la mezcla y el
transporte, y sirve el audio por la WiFi local. Cada celular abre una página
web (sin instalar nada) o la app para Android, recibe el audio por streaming y
lo reproduce en el mismo instante que los demás.

No necesita internet ni ninguna base de datos en la nube: todo vive en la
computadora (`~/MultitrackApp`), para que nada dependa de una conexión externa
durante un culto.

---

## Descargas

Página de descargas (se actualiza sola con cada cambio, los enlaces no cambian):
**https://github.com/carok19/Daw/releases/tag/descargas**

- Computadora (Windows): [AirTracks-Wireless-Monitor-Instalador.exe](https://github.com/carok19/Daw/releases/download/descargas/AirTracks-Wireless-Monitor-Instalador.exe)
  — incluye el reconocedor de voz y la app Android (la compu se la ofrece a los celulares).
- Celulares Android: [AirTracks.apk](https://github.com/carok19/Daw/releases/download/descargas/AirTracks.apk)
  — también se baja desde la compu, sin internet.

Los arma GitHub Actions (`.github/workflows/instaladores.yml`): pruebas, app
Android, instalador de Windows con el reconocedor y la app adentro, y los sube
a la release `descargas`. Windows puede avisar que el instalador "no es común"
(no está firmado): **Más información → Ejecutar de todas formas**.

## Instalar y correr

```bash
npm install
npm start              # compila y abre la app
```

Instaladores (se generan en `dist/`; hay que correr cada uno en su sistema
operativo, o en un CI con Windows/macOS):

```bash
npm run modelos        # (opcional, una vez) incluye el reconocedor de voz en el instalador
npm run dist:win       # instalador .exe (NSIS); con extras/airtracks.apk incluye la app Android
npm run dist:mac       # .dmg
npm run dist:linux     # AppImage
```

`npm run modelos` baja a `modelos/` el reconocedor de voz (~80 MB) con el que
se detectan las secciones por la voz guía, y `dist` lo mete en el instalador:
así en la iglesia no hay que descargar nada. Si no se incluye, la app ofrece
bajarlo una sola vez desde el panel de secciones.

Datos guardados: `~/MultitrackApp/` → `proyectos/` (una carpeta por canción
con sus pistas en WAV y `proyecto.json`), `setlists/` (las **listas por
día**, una por archivo, y `carpetas.json`) y `sesion.json` (las canciones de
arriba y su lista, para recuperarlas si la app se cierra a mitad de un
culto). `MULTITRACK_APP_DIR` cambia esa carpeta (lo usan los tests).
`~/MultitrackApp/modelos/` guarda el reconocedor de voz si se bajó desde la
app. La **carpeta de canciones** (biblioteca) es, por defecto,
`Documentos/AirTracks`.

**Antes se llamaba Multitrack Alabanza.** Al actualizar no se pierde nada: si
ya existían, se siguen usando la carpeta `Documentos/Multitrack Alabanza` y
las preferencias de la compu; `alabanza.local` y el enlace viejo de la app
Android siguen andando, y la app Android ya instalada se actualiza (mismo
paquete y firma). Los ids internos (`multitrack-alabanza` en la búsqueda,
`_multitrack._tcp`, `~/MultitrackApp`, las fichas `.multitrack.json`) no
cambian a propósito.

### Desarrollo

- `npm run typecheck` — tipos de main/preload/server y del renderer.
- `npm run test:server` — tests de integración del servidor (Express +
  Socket.IO + ffmpeg reales, clientes "compu" y "celular" por socket): import
  de WAV/MP3, seguridad, sincronización, loop, fin de canción, dispositivos,
  sesión, setlists, migración de canciones viejas; y el análisis automático
  (BPM y compás del click, secciones de la voz guía, marcadores de WAV/MIDI/
  texto, biblioteca que importa sola, categorías, zips movidos/actualizados).
  La voz guía de prueba es voz sintética en español (`__fixtures__/guia`).
- `npm run test:e2e` — prueba de punta a punta con la interfaz real en
  Chromium: una compu y dos celulares; importa WAV y MP3, reproduce, marca
  secciones, salta, repite secciones, bloquea, cierra la canción que suena, y
  mide el desfase real de cada celular contra el servidor (tiene que quedar
  por debajo de 20 ms, y si se corre, volver solo). También copia un zip a la
  biblioteca y verifica que se importe con su categoría y BPM, que las
  secciones salgan de la voz guía en el “1” del compás, el arrastre con imán,
  y que los celulares precarguen la siguiente canción. Además: el código de
  la banda (incorrecto, correcto, recordado), "Invitar" desde un celular
  (QR del WiFi y de la app, WhatsApp) y que el que llega tarde entre con ese
  enlace, y la app Android simulada (`window.AlabanzaApp`: arranca sola y
  guarda nombre y mezcla en la app). También: que el audio que realmente sale
  del celular coincida con la posición calculada (corrección, cambio de
  mezcla, salto, reentrada en el compás) y que con el WiFi limitado a 3 Mbps
  la mezcla de la compu suene sin cortes mientras 8 pistas sueltas no llegan.
  El reconocedor de voz se reemplaza por uno falso (`window.__asrFalso`). La primera vez:
  `npx playwright install chromium`.
- App Android: ver `android/LEEME.md` (Java sin librerías; la arma el CI).
- `npm run dev:renderer` — solo la interfaz en un navegador (sin servidor).
- Con `?debug` en la URL del celular se expone `window.__mt` (motor, socket y
  estado) para diagnosticar en pruebas de campo.

---

## Checklist para el día del culto

1. **Misma WiFi para todos.** Ideal: un router propio para el equipo de
   alabanza (5 GHz, cerca del escenario). No necesita internet.
2. **Windows:** el instalador deja a la app pasar el firewall. Si igual
   Windows pregunta al abrirla, marcá **las dos casillas** (redes privadas y
   públicas: la WiFi de una iglesia suele quedar como "pública") y aceptá; si
   no, los celulares no pueden conectarse.
3. Abrí la app: aparecen las **listas por día**. Tocá **Usar** en la de hoy
   (se destaca sola por la fecha) y sus canciones se cargan arriba, en orden.
   Si la app se cerró hace menos de 2 horas (se cortó a mitad del culto),
   **vuelve sola** donde estaba; si no, abajo está **“Seguir donde quedé”**.
   - **Carpetas:** una por evento o por mes (“Congreso Juvenil 2026”,
     “Domingos”), con una lista por día adentro (“Sábado 17/10 · 19 hs”). Una
     lista puede no tener carpeta.
   - **Armar una lista:** *Nueva lista* (queda con la fecha de hoy) → a la
     izquierda la biblioteca, se suman canciones con **+**; a la derecha la
     lista, se ordena arrastrando (o con ↑ ↓) y se saca con ✕. Nombre, fecha
     y carpeta arriba. Se guarda sola. *Duplicar* sirve para usar una lista
     de base otro día. Sacar una canción de una lista o borrar la lista no
     borra la canción.
   - **La lista en uso** se ve en el botón de la izquierda de la barra
     (tocándolo se va a las listas y se vuelve). Lo que se cambie arriba
     (sumar con **+ Canción**, sacar, ordenar) queda guardado en esa lista, y
     editar esa lista cambia las canciones de arriba (la que suena no se
     puede sacar). Se pueden armar las listas de otros días con la música
     sonando: arriba aparece “Sonando” con *Parar* y *Volver al escenario*.
   - Lo más cómodo para las canciones: copiar los `.zip` o `.rar` en la
     **carpeta de canciones** (con subcarpetas por categoría) antes del
     culto; se importan y se analizan solos. Conviene abrir cada canción
     nueva una vez antes, para revisar sus secciones.
4. **Celulares:** botón **Celulares** (arriba a la derecha) → escanear el QR →
   **“Tocá para empezar”** → conectar auriculares. En ⚙ cada músico puede
   ponerle nombre a su celular (“Batería”, “Bajo”…). Para no escanear en cada
   ensayo:
   - **Android:** la app (`AirTracks.apk`, se baja desde la compu). Se abre y
     encuentra la compu sola en el WiFi (sin QR ni internet, como DroidCam);
     la próxima vez entra directo, aunque la compu cambie de IP.
   - **iPhone:** la dirección fija **`airtracks.local`** (no cambia con la IP)
     y *Compartir → Agregar a inicio*: queda el ícono “AirTracks”. El celular
     lo explica solo en “¿La próxima vez sin escanear el QR?”.
   - **El que llega tarde**, con la banda ya tocando: cualquiera que ya esté
     conectado toca **Invitar** en su celular y le muestra el QR (o se lo
     manda por WhatsApp). Si en la compu se cargó el WiFi, también sale el QR
     del WiFi (se conecta sin preguntar la clave).
   - **Hoja impresa:** en la ventana de Celulares, *Imprimir hoja para la
     banda* (QR del WiFi, QR de la app, código y pasos) para pegar en la sala.
   - **Dirección corta:** si el puerto 80 está libre, alcanza con escribir
     `http://192.168.x.x` (sin `:4848`).
   - **Código de la banda** (opcional, en la ventana de Celulares): solo entra
     quien lo sabe. Se pone una vez por celular; va incluido en el QR y en las
     invitaciones. Cambiarlo no desconecta a los que ya están.
5. Mirá el chip de celulares: **verde** = todos listos y sincronizados;
   **amarillo** = alguien no activó el audio, tiene WiFi lento o está
   desfasado; **rojo** = alguien se desconectó o tiene un error de audio. El
   detalle está en la ventana de Celulares.
6. Si no querés que nadie toque el transporte desde su celular, activá
   **Celulares bloqueados**.
7. La pantalla de los celulares queda encendida sola (conviene bajar el
   brillo). Si alguien usa **auriculares Bluetooth** y lo escucha atrasado:
   ⚙ → *Ajuste fino* → sumar milisegundos hasta que coincida.
8. En el celular, la pantalla principal es **Mi mezcla**: cada músico sube o
   baja cada pista (más click, menos pad…) sin cambiar lo que escuchan los
   demás. Los faders se mueven **deslizando de costado**; deslizando para
   arriba o abajo la pantalla scrollea sin tocar ningún volumen, y un toque
   suelto no cambia nada (doble toque: vuelve a “igual”). La canción, la
   sección y el transporte van en una **barra flotante** abajo, con las
   secciones y las canciones del setlist a un toque.
   **Paneo por defecto: click y guía en L, la banda en R.** Toda canción
   entra así, sin tocar nada, en la mezcla de la compu (se ve en los paneos
   de cada pista) y por lo tanto en todos los celulares. El click y la guía
   se detectan solos (los nombres típicos: *Click*, *Metrónomo*, *Guía*,
   *Guide*, *Cues*…, y el click también por cómo suena, cuando termina el
   análisis). Si se mueve un paneo a mano, queda así (la app no lo vuelve a
   acomodar) y se guarda en la ficha de la canción. Las canciones que ya
   estaban importadas se acomodan al abrirlas, si nadie les había tocado el
   paneo.
9. **Elegir una sección con la canción sonando** no corta: la sección
   actual termina y la música sigue directo en la elegida (se ve “→ Coro en
   5 s” en la compu y en los celulares). Se puede cambiar por otra, o
   cancelar con ✕ / Esc. En el panel de secciones se elige si salta *al
   terminar* la sección, *en el compás* o *ya*. Con el tempo detectado,
   todo salto cae en el “1”: el destino y el momento se llevan al compás
   (aunque la marca haya quedado unos ms corrida), un click en la línea de
   tiempo espera al próximo compás, y la vuelta de “repetir” también va de
   compás a compás. Así, aunque se salte muy lejos, el pulso no se corta.

**Ancho de banda:** la compu le arma a cada celular **su mezcla** (la del
director + su “Mi mezcla”) y le manda **una sola pista estéreo**: ~1,4 Mbps
por celular, tenga la canción 4 pistas o 20 (antes, con cada pista por
separado, una canción de 20 pistas pedía más de 25 Mbps por celular y el WiFi
no daba). Sigue siendo WAV sin comprimir, sin pérdida de calidad. Con 10
celulares son ~14 Mbps en total: entra en cualquier router. Mover un fader de
“Mi mezcla” se escucha en menos de un segundo.

**¿Se corta?** En la ventana de Celulares, debajo de cada celular, se ve
cuánto WiFi le da la red, cuánto necesita, cuántos segundos de audio tiene
listos (colchón) y si tuvo cortes. **Copiar diagnóstico** copia un informe de
todo (compu, canción, cada celular) para mandarlo por chat. En el celular, lo
mismo en ⚙ → Estado.

### Atajos de teclado (compu)

| Tecla | Acción |
|---|---|
| Espacio | Reproducir / pausa |
| Enter | Stop (vuelve al inicio) |
| ← / → | Sección anterior / siguiente (sonando: en el límite; dos veces → saltea una) |
| 1 … 9 | Ir a la sección 1 a 9 (sonando: al terminar la sección actual) |
| Shift + 1…9 / ← → | Lo mismo, pero ya |
| Esc | Cancelar el salto elegido |
| Click en la línea de tiempo | Sonando: salta en el próximo compás, al “1” más cercano (Shift: ya; Alt: sin imán) |
| M | Marcar una sección en la posición actual |
| L | Repetir la sección actual |
| Alt + arrastrar | Mover una sección sin ajustarla al compás |
| Re Pág / Av Pág | Canción anterior / siguiente |
| ? | Ayuda de atajos |

---

## Arquitectura

- `src/server` — Express + Socket.IO embebido en el proceso principal de
  Electron. Fuente de verdad de todo: setlist, mezcla, secciones,
  reproducción, dispositivos.
  - `socketHandlers.ts` — protocolo y permisos. `transport.ts` — play/pausa/
    stop/saltos y los eventos que dependen del tiempo (fin de canción,
    repetir sección). `state.ts` — canciones de arriba en memoria (y su
    lista del día, que se guarda sola). `listas.ts` — listas por día y
    carpetas. `devices.ts` — celulares conectados. `projects.ts` — disco,
    sesión, migración. `zip.ts` + `audio.ts` — importación con ffmpeg.
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

Un `.zip` o un `.rar` (también un `.rar` en partes: `Canción.part1.rar`,
`Canción.part2.rar`… — se puede elegir cualquier parte, tienen que estar en
la misma carpeta) con una pista por archivo (WAV, MP3, M4A/AAC, AIFF, FLAC u
OGG). Se descomprime en un **proceso aparte** (el RAR con `node-unrar-js`, el
descompresor oficial de RARLAB compilado a WebAssembly, gratis y sin
internet): aunque la canción pese 1 GB, el servidor sigue atendiendo a los
celulares mientras tanto. Un `.rar` con contraseña se rechaza con un aviso
claro.
Cada pista se normaliza con **ffmpeg** (incluido en la app, `ffmpeg-static`)
a **WAV PCM 16-bit**, el único formato que se puede cortar en cualquier
muestra y pedir por partes sin clicks. Si una pista estéreo es en realidad
*dual mono* (L = R, típico de click, guía, bajo, bombo) se guarda en mono: la
mitad de datos por WiFi sin diferencia audible. La duración la calcula el
servidor. Los nombres pierden el prefijo de orden (`01_Click` → `Click`) y
cada pista recibe un color distinto por orden (editable). Las canciones
guardadas con versiones anteriores (por ejemplo con MP3 que no sonaban en los
celulares) se migran solas al abrirlas.

### Análisis automático: tempo, compás y secciones

Al importar (y en segundo plano, **nunca mientras suena una canción**):

1. **Click → BPM, compás y el “1”.** Se busca la pista de click por nombre
   (*Click*, *Metrónomo*…) y, si no, por cómo suena (golpes cortos y
   regulares). De los golpes salen el BPM, el compás (4/4, 3/4, 6/8…) y
   dónde cae cada “1” (el golpe acentuado). Se muestra como **90 BPM · 4/4**
   en el transporte, con rayitas de compás en la línea de tiempo.
2. **Secciones desde los archivos**, si el zip las trae: marcadores de los
   WAV (cue/labl, los que exportan Ableton, Reaper, Logic…), un `.mid` con
   marcadores (usa su mapa de tempo) o un `.txt`/`.csv` con líneas
   `0:32 Coro` (también el formato de etiquetas de Audacity).
3. **Si no, por la voz guía.** Se busca la pista de guía (*Guía*, *Guide*,
   *Cues*…), se detectan las frases habladas y la compu las escucha con un
   **reconocedor de voz local** (Whisper “base”, en español, corre en la
   compu sin internet). “Verso uno”, “Coro”, “Puente”, “Final”, “Intro”…
   (también en inglés) se convierten en secciones que arrancan en el “1” del
   compás siguiente al anuncio; repetidas quedan como *Coro 2*, *Coro 3*.
4. Nunca pisa secciones marcadas a mano. **Detectar** (panel de secciones)
   vuelve a analizar la canción y las reemplaza (pide confirmación).
5. **Imán de compás** (el botón al lado del BPM, prendido por defecto):
   marcar con **M** o arrastrar una sección la deja en el “1” más cercano;
   con **Alt** queda donde se suelta.

El reconocedor (~80 MB) viene en el instalador si se corrió `npm run
modelos`; si no, el panel de secciones ofrece bajarlo **una sola vez** de
Hugging Face (después funciona sin internet). Corre en un *Web Worker* con
WebAssembly (`@huggingface/transformers` + ONNX Runtime), de a una frase y
pausado mientras suena música.

### Carpeta de canciones (biblioteca)

La app vigila una carpeta (por defecto `Documentos/AirTracks`, se
cambia en **+ Canción**): cada `.zip` o `.rar` que se copia ahí se importa solo
(un `.rar` en partes, una sola vez y recién cuando están todas), y las
**subcarpetas son categorías** (*Adoración*, *Alabanza*, *Navidad/2024*…).
Mover un zip de carpeta cambia su categoría; reemplazarlo por uno nuevo
actualiza la canción conservando la mezcla y las secciones marcadas a mano
(los celulares descartan el audio viejo); borrarlo no borra la canción. No
importa nada mientras suena música (espera a que pare) y avisa una sola vez
por tanda. Sirve también una carpeta sincronizada (Drive, Dropbox…) para
preparar las canciones desde otra computadora.

**Todo queda guardado solo, para siempre.** Las secciones (detectadas o
marcadas), la mezcla, los colores y el tempo se guardan en cuanto cambian;
el análisis se hace una sola vez, al importar. Además, al lado de cada
canción de la carpeta la app escribe su **ficha** (`Santo.zip` →
`Santo.multitrack.json`, un JSON chico que se actualiza solo), como el
archivo de proyecto de un DAW: si se copia la carpeta a otra compu, se
reinstala la app o se pierden sus datos, las canciones se importan **ya con
sus secciones, mezcla y tempo, sin volver a analizar** (y con el mismo id,
así los setlists que las nombran siguen andando). También sirve metida
adentro del zip con el nombre `multitrack.json`. Si el audio cambió (otra
versión del zip), de la ficha se usan la mezcla y las secciones puestas a
mano.

Las secciones que se tocan a mano (agregar, mover, renombrar, borrar) pasan a
ser del usuario: ni un zip actualizado ni un análisis automático las pisan
(solo **Detectar**, que pide confirmación).

### Streaming de audio (celulares y compu)

Nadie descarga ni decodifica la canción entera: se piden segmentos de 2 s y
cada segmento se libera apenas termina.

- **Celulares: la mezcla la hace la compu.** El celular pide
  `/mezcla/<canción>/<n>.wav?m=…` (ganancia y paneo de cada pista, ya con
  su “Mi mezcla”) y recibe el segmento `n` como un WAV estéreo de 16 bits
  (`server/mezclador.ts`, mismo paneo “equal power” que Web Audio y un
  limitador suave por encima de 0,9). La compu no se traba: mezcla de a 2 por
  vez y cede el turno entre pista y pista (los mensajes de sincronización
  salen a tiempo), y guarda los segmentos recientes (los celulares con la
  misma mezcla los comparten). ~20 ms por segmento con 20 pistas estéreo.
  Colchón de 20 s por delante.
- **Cambio de mezcla sin cortes:** mientras llega la mezcla nueva sigue
  sonando la anterior; cuando llega, se pasa a ella en el mismo punto exacto
  de la canción con un fundido de 20 ms (mientras se arrastra un fader, como
  mucho cada 300 ms).
- **La compu (sonido local)** sigue pidiendo cada pista por **HTTP Range**
  (lee de su propio disco) con `GainNode` + `StereoPannerNode` por pista: sus
  faders suenan al instante. Colchón de 8 s. `?modo=pistas` / `?modo=mezcla`
  en la dirección fuerza uno u otro (pruebas).
- **Encadenado exacto:** los segmentos se programan en Web Audio uno detrás
  del otro por aritmética de muestras (sin huecos), solo 4 s por delante; lo
  demás espera bajado. Cada tramo programado guarda qué parte de la canción
  suena y a qué velocidad: la posición que se escucha sale de ahí, exacta.

- **Orden de urgencia:** primero el próximo segmento de *todas* las pistas,
  después el siguiente (el navegador baja ~6 cosas a la vez por servidor).
- **Arranque instantáneo:** en pausa se deja listo el comienzo desde la
  posición actual, y se mantienen en memoria los primeros segundos de cada
  sección ("cues"): saltar de sección o repetir una sección entra en sync sin
  esperar la red.
- **Siguiente canción precargada:** con la canción actual asegurada, cada
  celular baja de a poco el comienzo de la siguiente del setlist (desde donde
  va a arrancar): al pasar de canción, suena sin esperar la red.
- **Nunca suena algo incorrecto:** si un segmento no llega a tiempo, el motor
  espera (sin silencio sintético) y, cuando junta 3 s, se reincorpora en el
  punto exacto. El estado del buffer se muestra en el celular y en la compu.
- **Errores:** una pista con un problema irrecuperable (archivo que falta,
  formato ilegible) queda muda sin frenar a las demás y se informa; los
  errores de red se reintentan con espera creciente.

| Constante (`audio/streamConfig.ts`) | Valor | Significado |
|---|---|---|
| `SEGMENT_DURATION_SEC` | 2 | Duración de cada segmento |
| `BUFFER_TARGET_SEC` | 20 / 8 | Colchón bajado por delante (mezcla / pistas sueltas) |
| `HORIZONTE_PROGRAMADO_SEC` | 4 | Audio ya programado en Web Audio |
| `BUFFER_CRITICAL_SEC` | 3 | Por debajo: aviso de conexión lenta |
| `BUFFER_MIN_START_SEC` | 3 | Mínimo para (re)arrancar |
| `MAX_CUES` / `SEGMENTOS_POR_CUE` | 16 / 2 | Arranques de sección precargados |
| `SEGMENTOS_PRECARGA_SIGUIENTE` | 2 | Comienzo de la próxima canción precargado |

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
5. **Drift continuo** (cada 2 s): < 15 ms nada; 15–150 ms corrección suave;
   ≥ 150 ms resincronización dura de ese dispositivo. La corrección suave hace
   sonar los próximos tramos un 0,4 % más lentos o rápidos (inaudible) y
   calcula cuánto duran de verdad, así el siguiente arranca donde termina el
   anterior. (Antes la velocidad se cambiaba sobre lo ya programado y cada
   segmento nuevo arrancaba en el horario original: la corrección se deshacía
   cada 2 s aunque el monitor creyera que estaba hecha.)
6. **Volver a entrar en el “1”:** cuando un celular tiene que reincorporarse
   (se quedó sin audio, un desfase grande, activó el audio tarde, volvió de
   segundo plano), con el tempo detectado entra en el comienzo del próximo
   compás, como un músico que retoma, y no a mitad de un acorde.
7. **Verificado con el audio real:** una prueba graba lo que sale del motor
   (AudioWorklet) con una pista que codifica en cada muestra en qué segundo de
   la canción está, y lo compara con la posición que calcula el motor durante
   una corrección, un cambio de mezcla y un salto: coinciden a menos de 1 ms.
8. **Pantalla bloqueada / segundo plano:** la pantalla se mantiene encendida
   (NoSleep.js: Wake Lock si está disponible, si no un video mudo; la app se
   sirve por `http://` y ahí el Wake Lock nativo no existe), Media Session
   marca la página como reproducción de audio, y al volver a primer plano se
   resincroniza al instante.

### Conexión de los celulares

Todo por la WiFi local, sin internet ni servidores externos:

- **QR / dirección**: `http://IP:4848`. La IP que se muestra (y la que recibe
  cada celular al invitar) es la de la interfaz que está en la misma red que
  ese celular (WiFi/Ethernet reales antes que adaptadores virtuales o VPN).
- **Puerto 80**: si está libre, un servidor chico redirige `http://IP` al
  puerto de la app (dirección corta).
- **mDNS/Bonjour**: la compu responde `airtracks.local` (y `alabanza.local`, el
  nombre de antes, para los íconos ya guardados; iPhone lo resuelve en
  Safari y en el ícono de inicio) y anuncia el servicio `_multitrack._tcp`
  (lo busca la app Android). Si hay dos compus con la app en la misma red,
  las dos responden ese nombre: la app Android igual las distingue por su id.
- **Búsqueda UDP**: la app Android pregunta `MULTITRACK-ALABANZA?` por
  difusión al puerto 48480 y cada compu contesta con su nombre, puerto e id.
  Si el router filtra difusión y mDNS, la app prueba las direcciones de la red.
- `/api/info` (nombre, versión, id, si pide código) y `/app/airtracks.apk`
  (la app Android incluida en el instalador).

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
- **Código de la banda** (opcional): sin el código un celular no se conecta
  (la compu siempre); 5 intentos fallidos desde el mismo celular lo frenan un
  minuto. Protege el control y la información de la sesión; el audio en sí
  (`/media`) no pide código.
- El instalador agrega una regla del firewall de Windows solo para el
  programa de la app, en todos los perfiles de red (la WiFi de una iglesia
  suele quedar como "pública"). Si se usa la compu en redes ajenas, conviene
  poner el código de la banda.

### Licencias (para vender el programa)

Sin internet y sin servidor: la licencia es una línea de texto firmada que se
manda por WhatsApp o mail y se pega en la compu.

- **Versión de prueba:** todo funciona completo, con hasta **2 celulares a la
  vez**. El tercero ve “No hay más lugar” y entra solo cuando se libera un
  lugar o se activa una licencia. La compu muestra el chip **Prueba** arriba
  y un aviso cuando un celular no pudo entrar.
- **Licencia:** dice a nombre de quién está, cuántos celulares a la vez (o sin
  límite), si vence y, opcionalmente, en qué compu sirve (el **código de la
  computadora** `EQ-XXXX-XXXX-XXXX` que se ve en *Prueba → Licencia*). Se
  activa pegándola o abriendo el archivo `.licencia`; queda guardada en la
  compu (`licencia.txt` en la carpeta de la app).
- **Cómo se verifica:** formato `LIC1.<datos>.<firma>`, firma Ed25519. La app
  trae solo la **clave pública** (`licencias/clave-publica.txt`, se mete en el
  programa al compilar): sirve para comprobar licencias pero no para hacerlas.
  Cambiar cualquier dato (por ejemplo, los celulares) rompe la firma.
- **Mientras `licencias/clave-publica.txt` no tenga una clave, la app no pide
  licencia** (todo libre, como hasta ahora).

**Para empezar a vender (una sola vez):**

1. Abrí `herramientas/generador-licencias.html` con Chrome o Edge (funciona
   sin internet, desde el disco) y tocá **Crear claves nuevas**. Se baja un
   archivo `claves-licencias-….json`: es tu clave privada. Guardalo en un
   lugar seguro con una copia. **No lo subas a GitHub ni lo mandes a nadie.**
2. Copiá la **clave pública** que muestra y pegala en
   `licencias/clave-publica.txt` (en una línea, sin `#`). Subí ese cambio: el
   próximo instalador ya arranca en versión de prueba.

**Para cada venta:** abrí el generador → *Abrir mi archivo de claves* →
completá a nombre de quién, cuántos celulares, vencimiento y (si querés)
el código de la computadora → **Crear licencia** → *Copiar mensaje para
WhatsApp* o *Descargar archivo .licencia*. El generador comprueba cada
licencia que hace, puede comprobar una que te pasen y guarda el historial
(con planilla para Excel).

Lo que una licencia sin internet no puede evitar: que alguien comparta una
licencia **sin** código de computadora (por eso conviene atarlas a la compu),
o que modifique el programa para saltarse el control. Es la protección
habitual de los programas que se venden sin conexión.

---

## Decisiones de diseño

1. **El audio sale de los celulares.** La compu no suena por defecto
   (interruptor *Sonido en la compu* para ensayar o probar).
2. **Una sola canción suena a la vez, y nada la corta por accidente.**
   Pasar a otra canción o quitar la que suena pide confirmación (corta el
   audio en todos). Importar o agregar canciones al setlist mientras algo
   suena no lo interrumpe: la nueva queda al final.
3. **La mezcla del director llega a todos** en menos de un segundo
   (mensajes livianos por pista, guardado a disco con debounce): la compu
   rehace la mezcla de cada celular con su *Mi mezcla* (recordada por nombre
   de pista, vale para todas las canciones) y el celular pasa a ella con un
   fundido. El volumen general de cada celular es local (al instante).
4. **Curva de fader de audio** (cuadrática, se muestra en dB; doble click =
   −3,9 dB, el valor de importación). Faders y paneo con arrastre relativo:
   un click suelto no cambia el volumen.
5. **Secciones = marcadores.** La línea de tiempo muestra la canción por
   secciones; los triángulos se arrastran para moverlas. Borrar una sección
   se puede deshacer.
6. **Fin de canción y repetir sección los maneja el servidor**, así
   funcionan aunque la ventana de la compu esté ocupada.
7. **Los celulares pueden controlar** (play/pausa/secciones/repetir y pasar
   de canción, con confirmación si algo suena) salvo que la compu los
   bloquee. Editar (secciones, mezcla, setlist) es solo de la compu.
7b. **Saltos de sección en el límite:** los decide el servidor (igual desde
   la compu o un celular). El salto queda pendiente y se manda a los
   celulares con el margen de sync antes del límite; en ese instante cada
   uno corta el tramo actual y arranca el elegido, con el comienzo de cada
   sección ya precargado: sin silencio ni corrimiento. El corte se hace
   sobre la línea de tiempo del audio que ese celular está tocando (no sobre
   el reloj): si iba unos ms corrido, el pulso igual queda parejo en el
   salto, y el corrimiento lo sigue corrigiendo el monitor de drift.
8. **Cada dispositivo tiene un id estable** (localStorage): al reconectar
   vuelve a su misma fila con su nombre, sin "fantasmas". Los desconectados
   quedan visibles (para notar si alguien se cayó) hasta que se limpian. Al
   reconectarse, un celular se alinea con lo que está pasando (si mientras
   no estaba se pausó o se saltó, lo aplica en el momento).
9. **Puerto fijo:** 4848, y si está ocupado 4849, 4850… (misma dirección y
   mismo QR de un día al otro). La app Android y el ícono de iPhone no
   dependen de la IP (id de la instalación / `airtracks.local`).
10. **Sin base de datos externa:** todo en archivos JSON locales con
    escritura atómica. Funciona sin internet (una base en la nube, como
    Supabase, haría depender el culto de internet sin aportar nada acá).
11. **Lo automático nunca compite con el vivo:** análisis, reconocimiento de
    voz e importación de la biblioteca esperan a que no suene nada.

## Limitaciones conocidas / próximos pasos

- **Falta la prueba de campo con celulares reales.** Todo se validó con
  navegadores automatizados (compu + varios celulares, WiFi lento simulado,
  reinicio del servidor, app de Electron real), pero el sonido real, la
  latencia de cada modelo y el Bluetooth solo se pueden medir con hardware.
  Prueba sugerida: 2–3 celulares juntos reproduciendo solo el click; si se
  oye "eco", usar el ajuste fino en el que suena atrasado.
- **Reconocimiento de la voz guía:** la cadena completa (frases, ajuste al
  compás, nombres de sección) está probada con voz sintética en español y un
  reconocedor simulado; el modelo Whisper real no se pudo probar en el
  entorno de desarrollo (sin acceso a huggingface.co). Si alguna guía no se
  entiende bien, las secciones se corrigen a mano o con marcadores en el zip.
- **iPhone:** Safari puede frenar el audio si se bloquea la pantalla; la app
  mantiene la pantalla encendida, pero conviene no bloquearla a mano.
- Los instaladores no están firmados: Windows (SmartScreen) y macOS
  (Gatekeeper) muestran un aviso la primera vez.
- **App Android:** el código se compiló contra la API de Android 15 y la
  parte web se probó con el puente simulado, pero el APK lo arma GitHub
  Actions (en el entorno de desarrollo no hay SDK de Android) y falta
  probarlo en celulares reales (búsqueda en distintos routers, audio en
  segundo plano). La firma por defecto es pública a propósito (ver
  `android/LEEME.md`).
- `airtracks.local` depende de que el router deje pasar mDNS (la mayoría lo
  hace); el celular lo prueba antes de ofrecerlo.
