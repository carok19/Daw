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
- Compu del proyector (Windows 7 en adelante, 32 o 64 bits): [AirTracks-Video-Instalador.exe](https://github.com/carok19/Daw/releases/download/descargas/AirTracks-Video-Instalador.exe)
  — el video con la letra en el proyector, siguiendo a la canción (ver *AirTracks Video*).

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
2. **Windows:** si al abrirla Windows pregunta por el firewall, marcá **las
   dos casillas** (redes privadas y públicas) y aceptá. Funciona en
   **cualquier WiFi**, no solo en el primero: pero Windows toma cada WiFi
   nueva como “pública”, y si aquella vez quedó sin marcar “públicas”, en
   otro lugar los celulares **no encuentran la compu**. La app lo detecta
   sola (al abrir y al cambiar de WiFi): el chip de celulares se pone rojo
   con un escudo y en **Celulares** aparece **Permitir en todas las redes**
   (Windows pide permiso una vez; se arregla para siempre). Otras causas,
   en la misma ventana: *¿Los celulares no encuentran la compu?* (WiFi de
   invitados que no deja que los equipos se vean: usar el punto de acceso
   de un celular o un router propio).
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
   - **La pantalla de la canción** tiene dos vistas (se cambia con los dos
     botones o con **Tab**): **Secciones**, con el **recorrido** de la canción
     arriba (la forma de onda entera, dividida en secciones de colores, como
     un reproductor: click para ir a un punto) y las secciones como
     **tarjetas grandes** (click = ir ahí; la que suena muestra cuánto va, la
     elegida “sigue en 21 s”), y **Mezcla**, el mixer a pantalla completa con
     el recorrido finito arriba. La vista elegida se recuerda.
4. **Celulares:** botón **Celulares** (arriba a la derecha) → escanear el QR →
   **“Tocá para empezar”** → conectar auriculares. En ⚙ cada músico puede
   ponerle nombre a su celular (“Batería”, “Bajo”…). Para no escanear en cada
   ensayo:
   - **Android:** la app (`AirTracks.apk`, se baja desde la compu). Se abre y
     encuentra la compu sola en el WiFi (sin QR ni internet, como DroidCam);
     la próxima vez entra directo, aunque la compu cambie de IP. También
     tiene **Escanear el QR de la compu** (con la cámara, sin internet ni
     servicios de Google). Si alguien escanea el QR con la cámara del
     celular, se abre el navegador: ahí aparece **“¿Tenés la app AirTracks?
     Abrir en la app”**, que sigue en la app con la misma dirección y código
     (si no la tiene, ofrece bajarla).
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
8. En el celular hay dos pantallas, a un toque arriba: **Canción** (la
   principal) muestra la canción, la sección que suena en grande (y “→ Coro
   en 21 s” si se eligió un salto), el **recorrido** con la forma de onda y
   las secciones como **tarjetas grandes para tocar** (tocar = ir ahí, según
   el modo de salto; si la compu bloqueó los celulares se ven pero no se
   tocan). **Mi mezcla** es la otra pantalla, entera: cada músico sube o
   baja cada pista (más click, menos pad…) sin cambiar lo que escuchan los
   demás. El transporte va siempre abajo. Los faders se mueven **deslizando de costado**; deslizando para
   arriba o abajo la pantalla scrollea sin tocar ningún volumen, y un toque
   suelto no cambia nada (doble toque: vuelve a “igual”). Cada pista tiene
   **M** (mute) y **S** (solo) propios del celular: con una o varias pistas
   en **S** ese músico escucha solo esas (el solo del celular manda sobre el
   de la compu; lo muteado en la compu sigue apagado). El resto de la banda
   no se entera. La canción, la sección y el transporte van en una **barra
   flotante** abajo, con las secciones y las canciones del setlist a un
   toque.
   **Volumen de este celular: hasta 200 %.** Si con el celular al máximo
   suena bajito (pasa con muchos auriculares), se sube por encima de 100 %
   (hasta +6 dB). Un limitador en el celular evita que distorsione: los
   golpes más fuertes se aplanan en vez de saturar. 100 % es el volumen
   normal (doble toque vuelve ahí).
   **Paneo por defecto: click y guía en L, la banda en R.** Toda canción
   entra así, sin tocar nada, en la mezcla de la compu (se ve en los paneos
   de cada pista) y por lo tanto en todos los celulares. El click y la guía
   se detectan solos (los nombres típicos: *Click*, *Metrónomo*, *Guía*,
   *Guide*, *Cues*…, y el click también por cómo suena, cuando termina el
   análisis). Si se mueve un paneo a mano, queda así (la app no lo vuelve a
   acomodar) y se guarda en la ficha de la canción. Las canciones que ya
   estaban importadas se acomodan al abrirlas, si nadie les había tocado el
   paneo.
9. **Compases que faltan:** al lado de la sección que suena se ve cuántos
   compases le quedan (en el celular, un número grande: “Verso 1 · **3**
   compases”; en la compu, “faltan 3” en el transporte y en su tarjeta),
   contando el que suena: en el último dice **“último compás”** y titila.
   Así la batería prepara la entrada y el director elige el salto a tiempo.
   Si hay un salto elegido, cuenta hasta el salto. Hace falta el tempo
   detectado (sale del click).
   **Elegir una sección con la canción sonando** no corta: la sección
   actual termina y la música sigue directo en la elegida (se ve “→ Coro en
   5 s” en la compu y en los celulares). Se puede cambiar por otra, o
   cancelar con ✕ / Esc. En el panel de secciones se elige si salta *al
   terminar* la sección, *en el compás* o *ya*. Con el tempo detectado,
   todo salto cae en el “1”: el destino y el momento se llevan al compás
   (aunque la marca haya quedado unos ms corrida), un click en la línea de
   tiempo espera al próximo compás, y la vuelta de “repetir” también va de
   compás a compás. Así, aunque se salte muy lejos, el pulso no se corta.
   **Voz que avisa el salto:** en el último compás antes de saltar se
   escucha la sección elegida en el “1” y la cuenta en los dos últimos
   pulsos (“**Coro… 3, 4**”; en 3/4 “2, 3”), con el volumen y el lado de la
   guía de cada uno. En ese compás la guía de la canción se calla (diría la
   sección que venía, no la elegida). **Las voces vienen con el programa, en
   español** (las secciones —Intro, Verso 1 a 6, Pre Coro, Coro, Puente,
   Interludio, Instrumental, Final, Repetir…— y los números 1 a 7, de los
   recursos gratuitos “Click and Guide Samples” de
   [Secuencias.com](https://secuencias.com)): no hay que importar nada. En
   el panel de secciones se apaga o prende (**Avisar con voz**), y el botón
   de al lado permite usar **otro pack** (un .zip o .rar con un audio por
   sección y los números; si trae varios idiomas se usa el español); con
   el tacho se quita ese pack y vuelven las del programa. Los nombres se
   reconocen aunque varíen (“Estribillo” → Coro, “Coro 5” → Coro,
   “Precoro” → Pre Coro) y se usa el momento exacto en que empieza a
   hablar cada archivo. Si el salto se elige tan encima que el “1” ya pasó,
   el nombre va en el primer pulso que llega; sin la voz de esa sección,
   solo la cuenta.
10. **Cambiar el tono** (de −6 a +6 semitonos): en la compu, al lado del
    nombre de la canción, **− A +**. Cada toque sube o baja medio tono y se
    ve “A → B +2”. La compu prepara las pistas en el tono nuevo (unos
    segundos por pista; se ve “Preparando 3/12”) y, cuando están todas, la
    canción pasa a ese tono en la compu y en todos los celulares (arriba del
    celular se ve “B +2”). Conviene hacerlo antes del culto o entre
    canciones: **con la canción sonando no se cambia** (si se le da play
    mientras se prepara, el tono nuevo entra al parar).
    - El **click, la guía y la batería** quedan como están; las **voces**
      (coros, voz principal) conservan el timbre, no suenan “chillonas”.
    - Todo sigue cayendo justo con el click: las pistas nuevas duran
      exactamente lo mismo y la demora del cambio de tono se corrige.
    - La canción **recuerda su tono** (también en su ficha). Tocar “→ B +2”
      vuelve al original al instante.
    - La tonalidad original se lee del nombre (“Digno - A”, “Oceans (Bb)”,
      “… - Key of F#m”, “Coritos-MSM-G-115.00bpm”); si no está o está mal,
      se elige en el mismo botón.
    - **Canciones que cambian de tono:** en la tarjeta de la sección, el
      botón ♪ marca el tono desde ahí (“Coro final: E”); rige hasta otra
      sección que diga otro. Se escribe en el tono original (con el tono
      cambiado, se transpone igual). El pad del colchón usa el tono de la
      sección donde se entra, la compu muestra “Tono E” y “Sigue: Coro final ·
      en E”, y en los celulares aparece grande **“Pasa a E”** los últimos 2
      compases antes del cambio y **“Tono E”** al entrar.
    - **Afinado:** las pistas quedan en la nota exacta (medido: menos de
      1 cent de error, del bajo a los agudos).
10b. **Cambiar la velocidad** (hasta 20 % más lenta o más rápida, **sin
    cambiar el tono**): en el chip del tempo, **− 72 BPM +** (de a 1 BPM). Se
    ve “76 BPM +6 %” (pasando el mouse: “era 72 BPM”); como el tono, la compu prepara las pistas antes
    (todas: también el click y la guía, que se estiran sin cambiar su tono) y
    la canción pasa a esa velocidad cuando están (“Preparando 3/12”). No se
    cambia con la canción sonando. Todo se acomoda solo a la velocidad
    nueva: las secciones, los compases, la cuenta, los saltos, la voz que los
    avisa y el recorrido; si estaba pausada, sigue en el mismo punto de la
    música. En el celular se ve “76 BPM”. Se combina con el tono, la canción
    recuerda su velocidad y tocar “+6 %” vuelve a la original.
11. **Cuenta antes de la canción:** al dar play (desde parado, en pausa o
    desde una sección) el click cuenta un compás, **“1 2 3 4”**, y recién
    entra la canción, en todos a la vez. Usa el tempo y el compás que la app
    detecta del click (3/4: “1 2 3”) y **el mismo sonido del click de la
    canción** (el “1” con su acento), por el oído del click y con el volumen
    de click de cada uno. En la compu el reloj muestra el número de la cuenta
    y en los celulares “Cuenta 3”.
    - **Canciones que ya traen su cuenta** (la guía dice “1, 2, 3, 4” con la
      banda en silencio, o cuenta solo el click): la app lo detecta sola y,
      **desde el principio, no agrega otra** (cuenta la canción). Desde una
      sección o después de una pausa, sí cuenta su compás (ahí la canción no
      trae cuenta). Se ve en el selector: “Cuenta: la de la canción (auto)”.
      Un pad bajito de fondo o un golpe de batería en el “4” no la engañan;
      una intro suave, en cambio, es música (lleva cuenta). Las canciones que
      ya estaban importadas se revisan solas al abrirlas.
    - Al lado del BPM se puede forzar por canción: automática, 2 compases, 1
      o **sin cuenta**.
    - Después de una pausa, la cuenta sigue el pulso de la canción y la
      música vuelve justo donde quedó. Los saltos con la música sonando no
      llevan cuenta. Sin tempo detectado, arranca directo como siempre.
12. **Colchón: pad y click, sin la banda.** Un **pad** de ambiente (un
    colchón sostenido en el tono) y el **click**, sonando en todos a la vez.
    El pad lo hace la app (no hay que bajar nada): raíz, quinta y octava, sin
    tercera, así sirve igual en mayor y en menor. Va del lado de la banda y
    el click del lado del click; en **Mi mezcla** cada músico tiene una fila
    **Pad** (y **Click**) para subirlo, bajarlo o mutearlo solo para él. Dos
    formas:
    - **Dentro de una canción** (botón de las ondas al lado de “repetir”, o
      **C**; en el celular, el mismo botón en la barra de abajo): en el próximo compás la banda se va (se apaga en ese compás) y
      siguen el click, en el mismo pulso, y el pad en el tono de la canción (el de la sección, si cambia de tono).
      Para volver, **tocar una sección** (en la compu o en el celular): la
      canción entra ahí en el “1” del próximo compás, sin cuenta (el click
      nunca paró). **▶** vuelve donde quedó; **Terminar** (o **C**) para el
      click y apaga el pad despacio. Mientras dura se ve arriba “Colchón · D
      · 72 BPM” con el pulso, y se puede cambiar el tono y el volumen del
      pad. Hace falta el tempo detectado.
    - **Como una canción de la lista** (para la oración, la ministración o
      entre canciones): en el editor de la lista, **Colchón** → tono del pad
      (o sin pad), con o sin click, BPM y compás → *Sumar a la lista*. Arriba
      muestra el tono en grande, **Empezar** / **Terminar** (Espacio), y todo
      se puede cambiar sonando (el BPM, desde el próximo golpe). Queda en la
      biblioteca como cualquier canción.
    - **El colchón sigue aunque se cambie de canción:** al darle ▶ a la
      siguiente, el click del colchón para donde empieza la cuenta, el pad la
      acompaña bajando y se va cuando entra la canción. Así se pasa de un
      momento de oración a la próxima canción sin silencio.

13. **AirTracks Video: el video con la letra en el proyector.** Un
    programa aparte para la compu del data (la de Holyrics; corre desde
    **Windows 7**, en compus viejas). Ahí se cargan los videos con la letra
    (*lyric videos*) de las canciones que los tengan; las demás siguen con
    Holyrics como siempre.
    - **Instalarlo** en la compu del proyector y abrirlo: busca sola la compu
      de AirTracks en la red del router (sin internet y sin escribir IP; si
      la banda tiene código, lo pide una vez). Elegir en qué pantalla está el
      proyector y tocar **Probar**.
    - **+ Agregar video** → elegir el archivo → **¿de qué canción es?** (sugiere
      la del mismo nombre). El programa encuentra solo **dónde empieza la
      canción en el video** comparando el sonido del video con el de las
      pistas: tiene que ser **la misma grabación** que la multitrack (que el
      video tenga voz y la multitrack no, o una placa con el título al
      principio, da igual). Si es otra versión (en vivo, otro tempo, un video
      editado), avisa y se ajusta a mano con **+0,1 s / −0,1 s**. Mientras
      alinea muestra en qué paso va (leer el video, sacar el sonido, *AirTracks
      prepara la canción: pista 5 de 18*, comparar) con una barra. La primera vez
      por canción la compu principal tarda unos segundos por pista; si está
      sonando música, espera a que pare.
    - **Hay que actualizar AirTracks** en la compu principal (el instalador de
      siempre): si tiene una versión de antes de los videos, AirTracks Video lo
      avisa arriba en vez de quedarse alineando.
    - **En el culto no se toca nada:** al darle ▶ a una canción con video, el
      video aparece **encima de Holyrics** en el proyector (quieto durante la
      cuenta) y sigue a la banda: saltos de sección, repetir, pausa, cambio
      de velocidad. Al parar, se va y vuelve a verse Holyrics. Nunca le saca
      el teclado ni el mouse al que maneja Holyrics.
    - En la compu de AirTracks, la canción muestra **Video** al lado del
      tempo, y en *Conectar celulares* figura la pantalla de video.
    - **Los celulares no se enteran:** la pantalla de video no cuenta como
      celular (no cambia la espera para arrancar juntos ni ocupa lugar de la
      licencia), no recibe audio, los videos ya están en su compu (no viajan
      por el WiFi) y nadie la espera: si se traba o se cae, la música sigue
      igual. Medido: el video queda a menos de 30 ms de la canción (sonando,
      después de un salto y en pausa).
    - Conviene que los videos sean **MP4 de 720p** (en una compu vieja, un
      1080p o un WebM pueden ir a los saltos). La compu del data mejor por
      **cable** al router (igual funciona por WiFi: el video no pasa por la red).

**Ancho de banda:** la compu le arma a cada celular **su mezcla** (la del
director + su “Mi mezcla”) y le manda **una sola pista estéreo**: ~1,4 Mbps
por celular, tenga la canción 4 pistas o 20 (antes, con cada pista por
separado, una canción de 20 pistas pedía más de 25 Mbps por celular y el WiFi
no daba). Sigue siendo WAV sin comprimir, sin pérdida de calidad. Con 10
celulares son ~14 Mbps en total: entra en cualquier router. Un mute o un
fader (de la compu o de “Mi mezcla”) se escucha en el celular en **~0,1 s**
con buen WiFi y en **~0,6 s** con el WiFi cargado (medido con audio real,
limitando el celular a 6 Mbps; un cambio justo al final de un pedazo de 2 s
puede tardar hasta ~1,3 s).

**¿Se corta?** En la ventana de Celulares, debajo de cada celular, se ve
cuánto WiFi le da la red, cuánto necesita, cuántos segundos de audio tiene
listos por delante y si tuvo cortes. **Copiar diagnóstico** copia un informe de
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
| C | Colchón: la banda se va en el próximo compás y siguen el click y el pad (otra vez: terminar) |
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
   - **Click que marca corcheas o semicorcheas** (golpes más suaves entre
     los tiempos): se toma el tiempo de la negra, no el doble. Si el nombre
     trae el BPM (“… - 125BPM”), ayuda a decidir.
   - **Compás por compás:** cada “1” acentuado del click abre un compás, así
     un 2/4 o un 3/4 suelto no corre los que siguen, y los cambios de tempo
     (una parte lenta en una canción rápida, un popurrí) se siguen solos.
     Sonando una sección con otro tempo, al lado se ve “68 BPM aquí” (en el
     celular, “68 BPM”). La cuenta y el colchón usan el compás típico de ese
     lugar (un 2/4 suelto no los apura).
   - Las canciones que se analizaron con un detector anterior vuelven a
     detectar el tempo solas al abrir la app (en segundo plano, sin repetir
     la voz guía); sus secciones de la guía pasan al “1” de la grilla nueva.
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
   Las secciones **van apareciendo mientras se reconoce** (no hace falta
   esperar al final), y con una compu de 4 núcleos o más se reconocen 2 o 3
   frases a la vez.
4. Nunca pisa secciones marcadas a mano. **Detectar** (panel de secciones)
   vuelve a analizar la canción y las reemplaza (pide confirmación).
5. **Imán de compás** (el botón al lado del BPM, prendido por defecto):
   marcar con **M** o arrastrar una sección la deja en el “1” más cercano;
   con **Alt** queda donde se suelta.

El reconocedor (~80 MB) viene en el instalador si se corrió `npm run
modelos`; si no, el panel de secciones ofrece bajarlo **una sola vez** de
Hugging Face (después funciona sin internet). Corre en un *Web Worker* con
WebAssembly (`@huggingface/transformers` + ONNX Runtime), uno a tres a la
vez según los núcleos, y pausado mientras suena música.

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
  limitador suave por encima de 0,9). La compu no se traba: mezcla en
  **hilos de trabajo** (uno por núcleo, hasta 4, dejando uno libre para el
  resto de la app) y atiende **primero lo más urgente**: el segmento que va a
  sonar antes en la canción que está arriba, aunque se haya pedido último
  (la precarga de la siguiente canción, al final). Guarda los segmentos
  recientes (los celulares con la misma mezcla los comparten). ~20 ms por
  segmento con 20 pistas estéreo. Colchón de 20 s por delante. Probado con
  48 celulares con 16 pistas, todos arrancando juntos y cambiando “Mi mezcla”
  a la vez: ningún segmento llegó tarde (antes, con 32 ya se atrasaban).
  `MULTITRACK_HILOS_MEZCLA=0` mezcla en el hilo principal.
- **Cambio de mezcla sin cortes:** mientras llega la mezcla nueva sigue
  sonando la anterior; cuando llega, se pasa a ella en el mismo punto exacto
  de la canción con un fundido de 20 ms (mientras se arrastra un fader, como
  mucho cada 300 ms), aunque ese pedazo esté corrigiendo el sync.
- **Primero lo urgente, de a uno:** después de un cambio de mezcla (un mute,
  un fader) el celular pide **un solo pedazo por vez y en orden**, empezando
  por el primero que llega a tiempo, hasta tener la mezcla nueva en todo lo
  que ya estaba programado; recién después vuelve a bajar varios a la vez
  para el colchón. Antes pedía 4 a la vez: con el WiFi cargado se repartían
  la red, llegaban todos tarde y el mute tardaba 2-4 s. Para elegir por cuál
  empezar estima cuánto tarda un pedazo solo (con lo último que bajó, cada
  pedido con su parte de la red) y deja tiempo para el siguiente: así la
  pista muteada nunca vuelve a sonar un rato.
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

### Recorrido (forma de onda)

`server/onda.ts`: `/onda/<canción>.json?v=<revisión>` da la forma de la
canción entera (~1200 puntos de 0 a 100): cuánto suena **la banda** en cada
momento, sin el click ni la guía (sonarían parejo y taparían la forma). Se
calcula una vez por revisión del audio leyendo un pedacito de cada pista en
cada punto (no la pista entera: tarda poco aunque sean 20 pistas) y queda en
la carpeta de la canción (`onda.json`). La compu y los celulares la dibujan
en un `<canvas>` encima de los colores de las secciones; lo que ya sonó se
oscurece.

### Cambio de tono y de velocidad

`server/tono.ts`. El tono y la velocidad se preparan **antes** de tocar, en
la compu: por cada pista que cambia (con otro tono, todas menos click, guía
y batería, detectados por el análisis o por el nombre; con otra velocidad,
todas) se corre ffmpeg con **rubberband** (`pitchq=quality`,
`transients=smooth`; `formant=preserved` en las voces; ventana corta en el
click, la guía y la batería) en procesos aparte con prioridad baja (hasta 3
a la vez; 1 si hay algo sonando). Las pistas nuevas van a
`proyectos/<id>/tono/<semitonos>[v<velocidad>]/` y recién cuando están todas
la canción pasa a sonar así: sube la `revision` (los dispositivos vuelven a
cargarla) y `/media` y la mezcla de los celulares sirven las transpuestas en
lugar de las originales. Así, mientras se toca, no hay ningún trabajo extra
y el audio es el mismo WAV de siempre.

- **A tiempo con el click:** rubberband corre el audio unos milisegundos,
  distinto en cada tono (de −20 ms a +17 ms). Se mide una vez por tono y
  frecuencia de muestreo con una señal de prueba (correlación de
  envolventes) y se corrige al escribir la pista, que además queda con
  exactamente la misma cantidad de muestras que la original. Resto medido:
  ~1 ms.
- Se guarda solo el último tono de cada canción. Apretar varias veces
  seguidas es un solo trabajo (se cancela el anterior). Si la app se cierra
  a mitad, se retoma al abrir la canción; si se reemplaza el audio (zip
  actualizado), se vuelve a preparar solo.
- ~10 s por pista estéreo de 5 minutos en una compu común (en paralelo).
- **Afinación:** con la detección de ataques de fábrica (`crisp`), el
  rubberband que trae ffmpeg desafina: medido con un seno puro, −19 cents
  al bajar un semitono a 220 Hz, en los graves (82-110 Hz) deja sonando la
  nota original, y +10 % de velocidad baja 46 cents. Con
  `transients=smooth` da la nota exacta (0 cents) en todos los casos; la
  prueba del tono verifica la afinación de cada pista (< 5 cents).
- **Velocidad** (`shared/velocidad.ts`): mientras suena a otra velocidad,
  todos los tiempos de la canción (secciones, compases, BPM, duración)
  están en el tiempo que suena, así el resto de la app (saltos, cuenta, voz
  del salto, celulares) no se entera; al aplicar se reescalan (y la posición
  en pausa). La ficha los guarda en el tiempo original, y el análisis (que
  lee las pistas originales) pasa lo que detecta al tiempo que suena. Las
  pistas quedan con la cantidad exacta de muestras (`original / velocidad`)
  y la demora de rubberband se mide con los golpes de prueba donde deben
  caer a esa velocidad. Medido: el click cae a ±2 ms de donde corresponde,
  el bajo ~5 ms antes (el vocoder de fase adelanta los graves), y la nota
  exacta (< 5 cents).

### AirTracks Video

`src/video/` (programa aparte: `video/package.json`, Electron **22**, el último
que corre en Windows 7; se arma con `npm run build:video` y el instalador con
`cd video && npm run dist:win`, 32 y 64 bits en uno), `shared/huella.ts`,
`shared/videoSync.ts`, `server/huellas.ts`.

- **Conexión:** busca la compu como la app Android (pregunta UDP
  `MULTITRACK-ALABANZA?` al puerto 48480) y entra con `origen: 'video'`. El
  servidor la trata aparte: no está en `idsCelulares` (margen de arranque,
  pings de entrega), no cuenta para la licencia, una sola a la vez
  (`video-ocupado`), y avisa qué canciones tiene (`video:estado` →
  `pantallaVideo` en el estado). Recibe lo mismo que un celular
  (`estado:actualizado`, `playback:scheduled`) y sincroniza el reloj igual.
- **Alineación:** la *huella* de un audio son, cada 10 ms y en 12 bandas
  (80 Hz a 3,4 kHz), las subidas de energía (ataques), suavizadas y en un
  byte (~1 KB por segundo). La compu de AirTracks hace la de la canción
  (sus pistas sin click ni guía, a 8 kHz, una vez y guardada; solo con la
  música parada y de a poco: `video:huella` contesta enseguida `calculando`
  con cuántas pistas lleva, `esperando` mientras suena, o `lista`); la del
  video la hace la compu del data (Chromium decodifica el audio del video).
  La correlación (FFT) da el desfase; es *segura* si el pico sobresale
  (confianza ≥ 9 desvíos) y coincide en ≥ 60 % de la canción por tramos de
  15 s. Probado: encuentra el desfase a ±20 ms con la voz de más, con la
  banda baja y con ruido, y rechaza otra canción o la misma grabada de nuevo.
- **Seguir la canción** (`objetivoVideo`): tiempo del video = posición ×
  velocidad + desfase (el video es la grabación original). Cada 50 ms:
  lejos (> 0,3 s) salta, cerca lo apura o frena hasta un 8 %, a menos de
  30 ms lo deja. Un salto ya programado deja el otro `<video>` quieto en el
  punto nuevo y corta justo a su hora. Contando o en pausa: quieto en el
  cuadro justo. Sin video, parado o desconectado: la ventana se esconde.
- **La ventana del proyector:** sin marco, encima de todo (`screen-saver`),
  sin foco ni mouse (`focusable: false`, `setIgnoreMouseEvents`), solo en la
  pantalla elegida (sin segunda pantalla no se muestra, salvo que se elija la
  principal a propósito). Las páginas y los videos se sirven por un protocolo
  propio (`atv://app/…`, con saltos dentro del archivo).
- `npm run test:video` (en Linux dentro de `xvfb-run`): servidor real +
  AirTracks Video real (Electron 22) + un celular; arma una canción y su
  "lyric video" (otra grabación no, la misma con 3 s de placa y una voz de
  más), y comprueba la alineación (3000 ms ± 40), el video sonando, después
  de un salto y en pausa (< 0,12 s; medido < 30 ms), que se esconda al parar,
  que el margen de arranque no cambie y que si el programa se cae la
  reproducción siga.

### Colchón (pad y click)

`shared/colchon.ts`, `server/pads.ts`, `Transporte` (colchón) y
`StreamingEngine` (colchón). El colchón es **un estado del servidor**
(`ColchonActivo`: cuándo empezó, la grilla del click —un “1” y el largo del
compás—, la nota y los volúmenes, y cuándo termina) que va a todos con el
estado. **Nada de su audio viaja por la red mientras suena:**

- **El click** lo programa cada dispositivo a la hora de la compu, como la
  cuenta: los golpes de los próximos 4 s, con el sonido del click de la
  canción (o uno sintetizado), por el canal del click de su mezcla. Así dura
  lo que haga falta y suena junto en todos (medido con audio real: la
  canción, el colchón y la canción otra vez caen en la misma grilla, a
  ±10 ms de su hora, compu y celular juntos).
- **El pad** es un loop de 32 s por nota que la compu **sintetiza una vez**
  (18 osciladores: 6 notas con 3 voces apenas desafinadas, un filtro que
  “respira” y una reverb larga; mono a 22 kHz, 1,4 MB) y guarda en
  `~/MultitrackApp/pads`. Todas sus frecuencias dan vueltas enteras en los
  32 s y se guarda la segunda vuelta, así el final empalma con el principio
  sin corte. La app instalada los prepara de a uno un rato después de abrir;
  si se pide uno que no está, tarda ~1 s. Cada dispositivo lo baja una vez
  (`/pad/<0-11>.wav`) y lo toca en loop, todos en el mismo punto del loop.
- **Dentro de una canción:** el colchón empieza en el próximo compás
  (`limiteDeSalto` en modo compás). Todo el audio de la canción pasa por un
  bus (`cancionGain`) que baja a 0 en ese compás mientras el click del
  colchón sube (el mismo pulso: se funden) y el pad entra en 2 compases; al
  terminar ese compás el servidor pausa la canción (ya en silencio). Una
  sección (o ▶) programa la canción en el “1” del próximo compás del
  colchón, sin cuenta: el bus vuelve de golpe en ese instante, el click del
  colchón para justo ahí y el pad se va en 1,5 s. Si se elige antes de que
  empiece, el colchón se cancela y es un salto común.
- **De la lista:** un proyecto sin pistas con `colchon` (ajustes). El
  motor no baja nada; play/pausa del transporte lo empiezan y terminan. Un
  cambio de BPM sonando mueve el “1” al próximo golpe (el pad sigue).
- Al terminar, el click para en el próximo golpe y el pad se apaga en 4 s;
  un colchón que sigue al cambiar de canción termina donde arranca la
  próxima (con cuenta, el pad la acompaña). El servidor lo borra cuando el
  pad terminó de irse.

### Sincronización

1. **Reloj:** cada dispositivo mide su diferencia con el reloj del servidor
   (7 ping/pong, se queda con el de menor ida y vuelta; se repite cada 2 min y
   al volver a primer plano).
2. **Comandos programados:** play, pausa, stop y saltos se programan un
   poco a futuro (el **margen**) y cada dispositivo los ejecuta con Web Audio
   en ese instante exacto. El margen se mide (`server/entrega.ts`): la compu
   le pregunta algo a cada celular cada 2 s y cuenta cuánto tarda en volver
   la respuesta (incluye las demoras del WiFi y del ahorro de energía del
   celular); el margen es lo que tardó el más lento en el último minuto más
   250 ms, entre 0,45 y 1,5 s. Con buen WiFi, **medio segundo** desde que se
   toca play (antes siempre 1,5 s). Un celular recién conectado usa 1,5 s
   hasta tener 5 mediciones, y si a alguno una orden le llega sin tiempo
   para programarla, se vuelve a 1,5 s por 2 minutos. Sin celulares, 30 ms.
   El margen actual sale en “Copiar diagnóstico”.
3. **Cuenta:** el play desde parado o en pausa lleva los golpes de la cuenta
   (`shared/cuenta.ts`) con su hora: cada dispositivo los toca con el mismo
   reloj que la música, con el sonido del click recortado de la propia
   pista (`/cuenta/<canción>.wav`). Medido con audio real grabado en la
   compu y en un celular: cada golpe y la entrada de la canción, a 1–2 ms
   entre ellos. La cuenta que ya trae la canción (`tempo.cuentaPropia`, en
   compases) la mide `server/cuenta.ts` una vez por tempo: la energía de la
   banda (todo menos click y guía) en la primera parte de cada uno de los
   primeros 12 compases; los primeros que están 24 dB por debajo del más
   fuerte, con la guía hablando (o en silencio de verdad, si cuenta solo el
   click), y después entra la banda (hasta 4 compases). Arrancando antes de
   su último compás, la cuenta automática no suma otra.
4. **Tramo previo:** entre que se emite un comando y su horario sigue
   sonando lo anterior; el estado lo describe (`previo`, una cadena corta si
   hay dos comandos seguidos), así la interfaz, el monitor de drift y un
   celular que se une en ese momento ven lo que realmente suena.
5. **Reloj de salida:** para arrancar (y para medir el drift) cada
   dispositivo usa la hora exacta en que su parlante saca cada muestra
   (`getOutputTimestamp`), más el ajuste fino manual. Antes usaba
   `currentTime` + `outputLatency`: `currentTime` se actualiza “a saltos”
   (10 ms en la compu, 20–40 ms en muchos celulares), así que cada play
   —al empezar, después de una pausa o de cambiar de canción— arrancaba
   corrido distinto en cada dispositivo, y el monitor lo medía con el mismo
   error. Si el navegador no da esa hora, se usa el método anterior.
6. **Drift continuo** (cada 2 s): con el reloj de salida, < 5 ms nada (sin
   él, < 15 ms); de ahí a 150 ms corrección suave; ≥ 150 ms resincronización
   dura de ese dispositivo. La corrección suave hace
   sonar los próximos tramos un 0,4 % más lentos o rápidos (inaudible) y
   calcula cuánto duran de verdad, así el siguiente arranca donde termina el
   anterior. (Antes la velocidad se cambiaba sobre lo ya programado y cada
   segmento nuevo arrancaba en el horario original: la corrección se deshacía
   cada 2 s aunque el monitor creyera que estaba hecha.)
7. **Volver a entrar en el “1”:** cuando un celular tiene que reincorporarse
   (se quedó sin audio, un desfase grande, activó el audio tarde, volvió de
   segundo plano), con el tempo detectado entra en el comienzo del próximo
   compás, como un músico que retoma, y no a mitad de un acorde.
8. **Verificado con el audio real:** una prueba graba lo que sale del motor
   (AudioWorklet) con una pista que codifica en cada muestra en qué segundo de
   la canción está, y lo compara con la posición que calcula el motor durante
   una corrección, un cambio de mezcla y un salto: coinciden a menos de 1 ms.
   Otra graba a la vez la compu (con sonido) y dos celulares y compara lo que
   sale de cada uno al dar play después de cambiar de canción, en pausa → play
   y al cambiar con la música sonando: arrancan a menos de 5 ms entre sí (con
   el método anterior se separaban hasta ~10 ms en la prueba, y más en
   celulares reales).
9. **Pantalla bloqueada / segundo plano:** la pantalla se mantiene encendida
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

### Firewall de Windows

`server/firewall.ts`. La causa típica de “en casa anda y en la iglesia el
celular no encuentra la compu”: Windows marca cada WiFi nueva como pública
y, si el aviso del firewall se aceptó con “redes públicas” sin marcar, además
de permitir la app en las privadas crea una regla que la **bloquea** en las
públicas (un bloqueo gana sobre cualquier permiso, y Windows no vuelve a
preguntar). La compu lee con PowerShell, sin permisos de administrador, en
qué redes está (ignorando adaptadores virtuales) y qué reglas de entrada
tiene la app; si alguna red la bloquea, avisa. *Permitir en todas las
redes* (con el permiso de administrador que pide Windows) borra las reglas
de entrada de la app y deja una sola que la permite en cualquier red: no se
toca el resto del firewall ni el tipo de red. El instalador también borra
esos bloqueos cuando corre como administrador. GitHub Actions lo prueba en
una Windows real (`firewall-prueba.cjs`).

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
7c. **Voz del salto** (`shared/anuncio.ts`, `server/voces.ts`): al elegir el
   salto el servidor arma el audio del aviso (el compás antes del límite,
   cada voz en su pulso) y lo manda en `saltoPendiente.anuncio`. Los
   celulares lo reciben **dentro de su mezcla**: los pedazos de ese compás
   se vuelven a pedir con `&a=<id>` y la compu los mezcla con la guía
   callada (fundidos de 10 ms) y la voz con el volumen y el paneo de la guía
   en esa mezcla (sin guía, los del click); así cae exacta en el tiempo de
   cada uno, como cualquier cambio de mezcla. La compu (pistas sueltas) baja
   `/anuncio/<id>.wav`, lo programa en ese punto de la canción y calla la
   guía con un `GainNode` propio. Como la orden del salto llega antes de
   que suene, el aviso se sigue escuchando hasta el salto; si se cancela o
   se elige otra sección, se corta. Medido con audio real: la cuenta cae a
   menos de 3 ms del pulso y la guía queda en silencio todo el compás. Las
   voces de fábrica están en `recursos/voces-es` (van al instalador como
   `resources/voces-es`): el pack de Secuencias.com importado como cualquier
   otro (solo el español) y cada voz recortada a lo hablado (5 MB); ver
   `armarVocesDeFabrica` en `server/voces.ts`. Un pack importado va a
   `~/MultitrackApp/voces` y se usa en su lugar; apagar las de fábrica queda
   en `voces-fabrica.json`.
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
  segundo plano, el escáner de QR con distintas cámaras). La firma por defecto es pública a propósito (ver
  `android/LEEME.md`).
- `airtracks.local` depende de que el router deje pasar mDNS (la mayoría lo
  hace); el celular lo prueba antes de ofrecerlo.
- **Pads del colchón:** los sintetiza la app (sin samples ni licencias), con
  un solo timbre (un pad suave, tipo cuerdas/sintetizador). Todavía no se
  pueden importar pads propios.
