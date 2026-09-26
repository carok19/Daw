package com.multitrack.alabanza;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.LinkedHashMap;

/**
 * Pantalla de inicio: busca las computadoras en el WiFi y muestra la lista.
 * Si ya se uso una, entra directo a esa apenas la encuentra (aunque haya
 * cambiado de IP: se la reconoce por su id).
 */
public final class MainActivity extends Activity implements Buscador.Oyente {
    /** true: mostrar la lista sin entrar solo a la ultima ("Elegir otra computadora") */
    static final String EXTRA_ELEGIR = "com.multitrack.alabanza.ELEGIR";
    /** mensaje de error para mostrar (la compu no respondio) */
    static final String EXTRA_ERROR = "com.multitrack.alabanza.ERROR";
    /** direccion que acaba de fallar: no se vuelve a entrar sola ahi (evita ir y volver sin fin) */
    static final String EXTRA_EVITAR = "com.multitrack.alabanza.EVITAR";

    private final Handler principal = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<String, Compu> encontradas = new LinkedHashMap<>();
    private Guardado guardado;
    private Buscador buscador;
    private Compu ultima;
    private String evitar;
    private boolean autoConectar;
    private boolean abriendo;

    private LinearLayout lista;
    private TextView estado;
    private TextView error;
    private Button botonOtra;

    private final Runnable sinResultados = () -> {
        if (encontradas.isEmpty() && !abriendo) {
            estado.setText("Todavía no aparece. ¿La computadora tiene abierto AirTracks y está en este mismo WiFi?");
        }
    };

    @Override
    protected void onCreate(Bundle guardadoInstancia) {
        super.onCreate(guardadoInstancia);
        guardado = new Guardado(this);
        ultima = guardado.ultimaCompu();
        Intent i = getIntent();
        evitar = i.getStringExtra(EXTRA_EVITAR);
        autoConectar = ultima != null && !i.getBooleanExtra(EXTRA_ELEGIR, false);
        buscador = new Buscador(this, this);
        setContentView(construir());
        String mensaje = i.getStringExtra(EXTRA_ERROR);
        if (mensaje != null) mostrarError(mensaje);
        actualizarEstado();
    }

    @Override
    protected void onResume() {
        super.onResume();
        abriendo = false;
        buscador.iniciar();
        // lo mas rapido: preguntarle directo a la ultima direccion
        if (autoConectar && !ultima.url.equals(evitar)) buscador.probar(ultima.url);
        principal.postDelayed(sinResultados, 12000);
    }

    @Override
    protected void onPause() {
        super.onPause();
        buscador.detener();
        principal.removeCallbacks(sinResultados);
    }

    @Override
    public void encontrada(Compu c) {
        if (abriendo) return;
        if (autoConectar && esLaUltima(c) && !c.url.equals(evitar)) {
            abrir(c);
            return;
        }
        encontradas.put(c.clave(), c);
        dibujarLista();
        actualizarEstado();
    }

    private boolean esLaUltima(Compu c) {
        if (ultima == null) return false;
        return ultima.id.isEmpty() ? ultima.url.equals(c.url) : ultima.id.equals(c.id);
    }

    private void abrir(Compu c) {
        abriendo = true;
        guardado.guardarCompu(c);
        startActivity(new Intent(this, WebActivity.class).putExtra(WebActivity.EXTRA_URL, c.url).putExtra(WebActivity.EXTRA_ID, c.id));
        finish();
    }

    // ---- interfaz ----

    private View construir() {
        int margen = Estilo.dp(this, 24);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(margen, Estilo.dp(this, 40), margen, margen);

        ImageView icono = new ImageView(this);
        icono.setImageDrawable(getApplicationInfo().loadIcon(getPackageManager()));
        int lado = Estilo.dp(this, 76);
        LinearLayout.LayoutParams pIcono = new LinearLayout.LayoutParams(lado, lado);
        pIcono.gravity = Gravity.CENTER_HORIZONTAL;
        col.addView(icono, pIcono);

        TextView titulo = Estilo.texto(this, "AirTracks", 28, Estilo.TEXTO, true);
        titulo.setGravity(Gravity.CENTER);
        col.addView(titulo, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 14, 0));
        TextView sub = Estilo.texto(this, "La pista de la banda en tu celular", 15, Estilo.TEXTO_2, false);
        sub.setGravity(Gravity.CENTER);
        col.addView(sub, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 2, 26));

        LinearLayout filaEstado = new LinearLayout(this);
        filaEstado.setOrientation(LinearLayout.HORIZONTAL);
        filaEstado.setGravity(Gravity.CENTER_VERTICAL);
        ProgressBar ruedita = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        filaEstado.addView(ruedita, new LinearLayout.LayoutParams(Estilo.dp(this, 20), Estilo.dp(this, 20)));
        estado = Estilo.texto(this, "", 15, Estilo.TEXTO_2, false);
        LinearLayout.LayoutParams pEstado = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        pEstado.leftMargin = Estilo.dp(this, 12);
        filaEstado.addView(estado, pEstado);
        col.addView(filaEstado, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 0, 14));

        lista = new LinearLayout(this);
        lista.setOrientation(LinearLayout.VERTICAL);
        col.addView(lista, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 0, 4));

        error = Estilo.texto(this, "", 14, Estilo.ERROR, false);
        error.setVisibility(View.GONE);
        col.addView(error, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 4, 12));

        botonOtra = Estilo.boton(this, "Elegir otra computadora", false);
        botonOtra.setOnClickListener(v -> {
            autoConectar = false;
            actualizarEstado();
            dibujarLista();
        });
        col.addView(botonOtra, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 4, 10));

        Button escribir = Estilo.boton(this, "Escribir la dirección", false);
        escribir.setOnClickListener(v -> escribirDireccion());
        col.addView(escribir, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 0, 18));

        TextView ayuda = Estilo.texto(this,
                "La computadora tiene que tener abierto AirTracks y estar en el mismo WiFi que este celular (o conectada al "
                        + "punto de acceso de este celular). No hace falta internet.",
                13, Estilo.TEXTO_3, false);
        col.addView(ayuda, conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Estilo.FONDO);
        scroll.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private LinearLayout.LayoutParams conMargen(int ancho, float arribaDp, float abajoDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ancho, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = Estilo.dp(this, arribaDp);
        p.bottomMargin = Estilo.dp(this, abajoDp);
        return p;
    }

    private void actualizarEstado() {
        botonOtra.setVisibility(autoConectar ? View.VISIBLE : View.GONE);
        if (autoConectar) estado.setText("Buscando “" + ultima.nombreCorto() + "”…");
        else if (encontradas.isEmpty()) estado.setText("Buscando computadoras en el WiFi…");
        else estado.setText(encontradas.size() == 1 ? "Tocá la computadora para entrar:" : "Tocá tu computadora:");
    }

    private void dibujarLista() {
        lista.removeAllViews();
        for (Compu c : encontradas.values()) lista.addView(tarjeta(c), conMargen(ViewGroup.LayoutParams.MATCH_PARENT, 0, 10));
    }

    private View tarjeta(Compu c) {
        LinearLayout fila = new LinearLayout(this);
        fila.setOrientation(LinearLayout.HORIZONTAL);
        fila.setGravity(Gravity.CENTER_VERTICAL);
        int p = Estilo.dp(this, 16);
        fila.setPadding(p, p, p, p);
        fila.setBackground(Estilo.tocable(this, Estilo.PANEL, Estilo.LINEA, 14));
        fila.setClickable(true);
        fila.setFocusable(true);
        fila.setOnClickListener(v -> abrir(c));

        LinearLayout textos = new LinearLayout(this);
        textos.setOrientation(LinearLayout.VERTICAL);
        textos.addView(Estilo.texto(this, c.nombreCorto(), 18, Estilo.TEXTO, true));
        String detalle = c.direccion() + (c.requiereCodigo ? "  ·  pide el código de la banda" : "");
        textos.addView(Estilo.texto(this, detalle, 13, Estilo.TEXTO_3, false));
        fila.addView(textos, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView entrar = Estilo.texto(this, "Entrar ›", 16, Estilo.ACENTO, true);
        fila.addView(entrar);
        fila.setContentDescription("Entrar a " + c.nombreCorto());
        return fila;
    }

    private void mostrarError(String mensaje) {
        error.setText(mensaje);
        error.setVisibility(View.VISIBLE);
    }

    private void escribirDireccion() {
        EditText campo = new EditText(this);
        campo.setHint("192.168.1.35");
        campo.setSingleLine();
        campo.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        if (ultima != null) campo.setText(ultima.direccion());
        FrameLayout marco = new FrameLayout(this);
        int m = Estilo.dp(this, 22);
        marco.setPadding(m, Estilo.dp(this, 8), m, 0);
        marco.addView(campo);

        AlertDialog d = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Dirección de la computadora")
                .setMessage("La que muestra la compu en “Conectar celulares”.")
                .setView(marco)
                .setPositiveButton("Entrar", null)
                .setNegativeButton("Cancelar", null)
                .create();
        d.setOnShowListener(x -> d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String url = Red.normalizarDireccion(campo.getText().toString());
            if (url == null) {
                campo.setError("Revisá la dirección");
                return;
            }
            d.dismiss();
            probarManual(url);
        }));
        d.show();
    }

    private void probarManual(String url) {
        estado.setText("Probando " + url.replaceFirst("^http://", "") + "…");
        error.setVisibility(View.GONE);
        Thread hilo = new Thread(() -> {
            Compu c = Red.preguntar(url, 3000);
            principal.post(() -> {
                if (isFinishing() || abriendo) return;
                if (c != null) {
                    abrir(c);
                } else {
                    actualizarEstado();
                    mostrarError("No responde " + url.replaceFirst("^http://", "")
                            + ". Revisá que la computadora tenga la app abierta y que estén en el mismo WiFi.");
                }
            });
        }, "alabanza-manual");
        hilo.setDaemon(true);
        hilo.start();
    }
}
