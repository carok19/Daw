# App Android de AirTracks Wireless Monitor

(Antes se llamaba Multitrack Alabanza: el paquete `com.multitrack.alabanza`, la
firma y el puente `window.AlabanzaApp` siguen iguales para que la app ya
instalada se actualice sin desinstalarla.)

App chiquita (Java, sin librerías externas) que:

- **Busca la computadora sola en el WiFi** (sin internet ni nube, como DroidCam):
  pregunta por difusión UDP (puerto 48480), por mDNS (`_multitrack._tcp`) y,
  si no aparece nada, prueba las direcciones de la red en el puerto 4848.
- **Recuerda la última compu** (por su id, aunque cambie de IP) y entra directo.
- Muestra la misma app web de la compu, con el audio que arranca solo, la
  pantalla siempre encendida y el nombre, la mezcla y el código de la banda
  guardados en la app.
- Si se corta la conexión un rato, vuelve a buscar la compu y, si cambió de
  dirección, se reconecta sola.

## Cómo se arma

La arma GitHub Actions (`.github/workflows/instaladores.yml`) y la publica en
la página de Descargas junto con el instalador de Windows. La compu la ofrece
a los celulares en `http://IP:4848/app/airtracks.apk`.

A mano (con el SDK de Android y JDK 17):

    gradle -p android assembleRelease
    # -> android/app/build/outputs/apk/release/app-release.apk

## Firma

Android solo deja *actualizar* la app si la versión nueva está firmada con la
misma clave. Por defecto se usa la firma comunitaria de `firma/alabanza.p12`
(clave `alabanza`): es pública a propósito, para que cualquiera pueda armar la
app y actualizarla. Para usar una firma propia y privada, cargá en GitHub
(Settings → Secrets → Actions) `ANDROID_KEYSTORE_B64` (el .p12 en base64),
`ANDROID_KEYSTORE_PASSWORD` y `ANDROID_KEY_ALIAS`. Ojo: al cambiar de firma hay
que desinstalar la app una vez en cada celular.
