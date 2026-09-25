package com.multitrack.alabanza;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * La app web de la compu (la misma que en el navegador) dentro de la app:
 *  - el audio arranca sin tocar nada y la pantalla queda encendida;
 *  - el nombre, la mezcla y el codigo de la banda se guardan en la app
 *    (window.AlabanzaApp), asi que no se pierden si la compu cambia de IP;
 *  - si se corta la conexion un rato, vuelve a buscar la compu por su id y,
 *    si cambio de direccion, se reconecta sola.
 */
public final class WebActivity extends Activity {
    static final String EXTRA_URL = "com.multitrack.alabanza.URL";
    static final String EXTRA_ID = "com.multitrack.alabanza.ID";
    private static final long ESPERA_ANTES_DE_BUSCAR_MS = 8000;

    private final Handler principal = new Handler(Looper.getMainLooper());
    private Guardado guardado;
    private WebView web;
    /** http://IP:puerto de la compu */
    private String urlCompu;
    private String urlInicial;
    private String idCompu = "";
    private boolean conectado = true;
    private Buscador reBusqueda;

    private final Runnable buscarDeNuevo = this::iniciarReBusqueda;

    @Override
    protected void onCreate(Bundle guardadoInstancia) {
        super.onCreate(guardadoInstancia);
        guardado = new Guardado(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (!leerIntent(getIntent())) {
            volverABuscar(null, null);
            return;
        }
        web = crearWebView();
        setContentView(web);
        web.loadUrl(urlInicial);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web != null && leerIntent(intent)) web.loadUrl(urlInicial);
    }

    /** De donde viene: la pantalla de busqueda, o un QR/enlace http://IP:4848 abierto con la app. */
    private boolean leerIntent(Intent i) {
        Uri datos = i.getData();
        if (Intent.ACTION_VIEW.equals(i.getAction()) && datos != null && "http".equals(datos.getScheme()) && datos.getHost() != null) {
            urlCompu = "http://" + datos.getHost() + (datos.getPort() > 0 ? ":" + datos.getPort() : "");
            urlInicial = datos.toString();
            idCompu = "";
            // queda como "la ultima compu" apenas se sabe cual es
            final String url = urlCompu;
            Thread hilo = new Thread(() -> {
                Compu c = Red.preguntar(url, 3000);
                if (c != null) principal.post(() -> {
                    if (url.equals(urlCompu)) {
                        idCompu = c.id;
                        guardado.guardarCompu(c);
                    }
                });
            }, "alabanza-info");
            hilo.setDaemon(true);
            hilo.start();
            return true;
        }
        String url = i.getStringExtra(EXTRA_URL);
        if (url == null) return false;
        urlCompu = url;
        urlInicial = url + "/";
        String id = i.getStringExtra(EXTRA_ID);
        idCompu = id == null ? "" : id;
        return true;
    }

    private WebView crearWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " AlabanzaApp/1");
        w.setBackgroundColor(Estilo.FONDO);
        w.addJavascriptInterface(new Puente(), "AlabanzaApp");
        w.setWebViewClient(new Cliente());
        w.setWebChromeClient(new WebChromeClient());
        return w;
    }

    private String hostCompu() {
        String h = Uri.parse(urlCompu).getHost();
        return h == null ? "" : h;
    }

    private final class Cliente extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            // la compu (tambien la redireccion del puerto 80 al de la app) sigue adentro
            if ("http".equals(u.getScheme()) && hostCompu().equals(u.getHost())) return false;
            // WhatsApp, etc.: afuera
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignorado) {
                // nada que lo abra
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (!r.isForMainFrame()) return;
            volverABuscar("No se pudo abrir " + urlCompu.replaceFirst("^http://", "")
                    + ". ¿La computadora sigue con la app abierta y en el mismo WiFi?", urlCompu);
        }

        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detalle) {
            // el motor de la pagina se cerro (poca memoria): se arma de nuevo y se vuelve a entrar
            if (web != null) {
                web.destroy();
                web = crearWebView();
                setContentView(web);
                web.loadUrl(urlCompu + "/");
            }
            return true;
        }
    }

    /** Lo que la pagina puede pedirle a la app (window.AlabanzaApp). */
    private final class Puente {
        @JavascriptInterface
        public String leerPref(String clave) {
            return guardado.leerWeb(clave);
        }

        @JavascriptInterface
        public void guardarPref(String clave, String valor) {
            guardado.guardarWeb(clave, valor);
        }

        @JavascriptInterface
        public void cambiarCompu() {
            principal.post(() -> {
                Intent i = new Intent(WebActivity.this, MainActivity.class).putExtra(MainActivity.EXTRA_ELEGIR, true);
                startActivity(i);
                finish();
            });
        }

        @JavascriptInterface
        public void compartir(String texto) {
            principal.post(() -> {
                Intent enviar = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, texto);
                try {
                    startActivity(Intent.createChooser(enviar, "Invitar"));
                } catch (ActivityNotFoundException ignorado) {
                    // sin apps para compartir
                }
            });
        }

        @JavascriptInterface
        public void conexion(boolean c) {
            principal.post(() -> alCambiarConexion(c));
        }
    }

    // ---- si la compu cambio de direccion ----

    private void alCambiarConexion(boolean c) {
        conectado = c;
        principal.removeCallbacks(buscarDeNuevo);
        if (c) detenerReBusqueda();
        else principal.postDelayed(buscarDeNuevo, ESPERA_ANTES_DE_BUSCAR_MS);
    }

    private void iniciarReBusqueda() {
        if (conectado || idCompu.isEmpty() || reBusqueda != null || isFinishing()) return;
        reBusqueda = new Buscador(this, c -> {
            // en la misma direccion la pagina se reconecta sola; solo interesa si se mudo
            if (!idCompu.equals(c.id) || c.url.equals(urlCompu)) return;
            detenerReBusqueda();
            urlCompu = c.url;
            guardado.guardarCompu(c);
            if (web != null) web.loadUrl(c.url + "/");
        });
        reBusqueda.iniciar();
    }

    private void detenerReBusqueda() {
        if (reBusqueda != null) reBusqueda.detener();
        reBusqueda = null;
    }

    private void volverABuscar(String error, String urlFallida) {
        Intent i = new Intent(this, MainActivity.class);
        if (error != null) i.putExtra(MainActivity.EXTRA_ERROR, error);
        if (urlFallida != null) i.putExtra(MainActivity.EXTRA_EVITAR, urlFallida);
        startActivity(i);
        finish();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("¿Salir?")
                .setMessage("Se deja de escuchar la pista en este celular.")
                .setPositiveButton("Salir", (d, w) -> finish())
                .setNegativeButton("Seguir", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        principal.removeCallbacks(buscarDeNuevo);
        detenerReBusqueda();
        if (web != null) {
            web.removeJavascriptInterface("AlabanzaApp");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
