package com.multitrack.alabanza;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.io.IOException;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Escanea el QR de la compu ("Conectar celulares", o la hoja impresa) y entra
 * directo, recordandola para la proxima. Sin internet ni servicios de Google:
 * la camara del celular y un lector de QR que viene adentro de la app (ZXing).
 */
@SuppressWarnings("deprecation")
public final class EscanerActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private static final int PEDIDO_CAMARA = 1;

    private final Handler principal = new Handler(Looper.getMainLooper());
    private final QRCodeReader lectorQr = new QRCodeReader();
    private final Map<DecodeHintType, Object> pistas = new EnumMap<>(DecodeHintType.class);
    private HandlerThread hiloLector;
    private Handler lector;
    private Camera camara;
    private int idCamara = -1;
    private int ancho;
    private int alto;
    private boolean superficieLista;
    private boolean leyendo;
    private boolean encontrado;
    private SurfaceView vista;
    private FrameLayout marco;
    private TextView aviso;

    private final Runnable enfocar = new Runnable() {
        @Override
        public void run() {
            if (camara == null || encontrado) return;
            try {
                camara.autoFocus(null);
            } catch (RuntimeException ignorado) {
                // la camara no deja enfocar ahora
            }
            principal.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        pistas.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        pistas.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        setContentView(construir());
    }

    private View construir() {
        marco = new FrameLayout(this);
        marco.setBackgroundColor(Color.BLACK);
        vista = new SurfaceView(this);
        vista.getHolder().addCallback(this);
        marco.addView(vista, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));

        // cuadro guia en el centro
        View guia = new View(this);
        GradientDrawable borde = new GradientDrawable();
        borde.setColor(Color.TRANSPARENT);
        borde.setStroke(Estilo.dp(this, 3), Estilo.ACENTO);
        borde.setCornerRadius(Estilo.dp(this, 18));
        guia.setBackground(borde);
        int lado = Estilo.dp(this, 250);
        marco.addView(guia, new FrameLayout.LayoutParams(lado, lado, Gravity.CENTER));

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        int m = Estilo.dp(this, 20);
        panel.setPadding(m, m, m, m);
        panel.setBackgroundColor(Color.argb(210, 11, 13, 18));
        aviso = Estilo.texto(this, "Apuntá al QR de la compu (en “Conectar celulares” o en la hoja impresa).", 16, Estilo.TEXTO, false);
        aviso.setGravity(Gravity.CENTER);
        panel.addView(aviso);
        Button cancelar = Estilo.boton(this, "Cancelar", false);
        cancelar.setOnClickListener(v -> finish());
        LinearLayout.LayoutParams pc = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pc.topMargin = Estilo.dp(this, 14);
        panel.addView(cancelar, pc);
        marco.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        return marco;
    }

    @Override
    protected void onResume() {
        super.onResume();
        hiloLector = new HandlerThread("alabanza-qr");
        hiloLector.start();
        lector = new Handler(hiloLector.getLooper());
        if (camara != null) pedirCuadro();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) abrirCamara();
        else requestPermissions(new String[] {Manifest.permission.CAMERA}, PEDIDO_CAMARA);
    }

    @Override
    protected void onPause() {
        super.onPause();
        cerrarCamara();
        if (hiloLector != null) hiloLector.quitSafely();
        hiloLector = null;
        lector = null;
    }

    @Override
    public void onRequestPermissionsResult(int pedido, String[] permisos, int[] resultados) {
        if (pedido != PEDIDO_CAMARA) return;
        if (resultados.length > 0 && resultados[0] == PackageManager.PERMISSION_GRANTED) abrirCamara();
        else aviso.setText("Sin permiso para usar la cámara no se puede escanear. Podés darlo en los ajustes del celular, o escribir la dirección a mano.");
    }

    // ---- camara ----

    private void abrirCamara() {
        if (camara != null) return;
        try {
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                    idCamara = i;
                    break;
                }
            }
            if (idCamara < 0 && Camera.getNumberOfCameras() > 0) idCamara = 0;
            if (idCamara < 0) {
                aviso.setText("Este celular no tiene cámara. Escribí la dirección a mano.");
                return;
            }
            camara = Camera.open(idCamara);
            Camera.getCameraInfo(idCamara, info);
            Camera.Parameters p = camara.getParameters();
            Camera.Size tam = mejorTamano(p.getSupportedPreviewSizes());
            p.setPreviewSize(tam.width, tam.height);
            List<String> focos = p.getSupportedFocusModes();
            boolean continuo = focos != null && focos.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            if (continuo) p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            else if (focos != null && focos.contains(Camera.Parameters.FOCUS_MODE_AUTO)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            try {
                camara.setParameters(p);
            } catch (RuntimeException ignorado) {
                // algun parametro no le gusto: se queda con los de fabrica
            }
            Camera.Size real = camara.getParameters().getPreviewSize();
            ancho = real.width;
            alto = real.height;
            // la app va siempre vertical: la imagen de la camara se gira lo que diga el sensor
            boolean frontal = info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT;
            camara.setDisplayOrientation(frontal ? (360 - info.orientation % 360) % 360 : info.orientation);
            ajustarVista(info.orientation % 180 != 0);
            if (!continuo) principal.postDelayed(enfocar, 800);
            if (superficieLista) iniciarVista();
        } catch (RuntimeException e) {
            camara = null;
            aviso.setText("No se pudo abrir la cámara (¿la está usando otra app?).");
        }
    }

    /** Un tamano de vista previa cercano a 1280×720 (suficiente para leer el QR sin cargar el celular). */
    private static Camera.Size mejorTamano(List<Camera.Size> tamanos) {
        Camera.Size mejor = tamanos.get(0);
        long objetivo = 1280L * 720L;
        for (Camera.Size s : tamanos) {
            long area = (long) s.width * s.height;
            if (s.width > 1920) continue;
            if (Math.abs(area - objetivo) < Math.abs((long) mejor.width * mejor.height - objetivo)) mejor = s;
        }
        return mejor;
    }

    /** La vista previa con la proporcion de la camara (sin estirarla), ocupando el ancho. */
    private void ajustarVista(boolean girada) {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        float proporcion = girada ? (float) ancho / alto : (float) alto / ancho;
        int w = dm.widthPixels;
        int h = Math.round(w * proporcion);
        if (h < dm.heightPixels) {
            h = dm.heightPixels;
            w = Math.round(h / proporcion);
        }
        vista.setLayoutParams(new FrameLayout.LayoutParams(w, h, Gravity.CENTER));
    }

    private void iniciarVista() {
        if (camara == null) return;
        try {
            camara.setPreviewDisplay(vista.getHolder());
            camara.startPreview();
            pedirCuadro();
        } catch (IOException | RuntimeException e) {
            aviso.setText("No se pudo mostrar la cámara.");
        }
    }

    private void pedirCuadro() {
        if (camara != null && !encontrado) {
            try {
                camara.setOneShotPreviewCallback(this);
            } catch (RuntimeException ignorado) {
                // se esta cerrando
            }
        }
    }

    private void cerrarCamara() {
        principal.removeCallbacks(enfocar);
        if (camara == null) return;
        try {
            camara.setOneShotPreviewCallback(null);
            camara.stopPreview();
        } catch (RuntimeException ignorado) {
            // ya estaba detenida
        }
        camara.release();
        camara = null;
    }

    @Override
    public void surfaceCreated(SurfaceHolder h) {
        superficieLista = true;
        iniciarVista();
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int formato, int w, int hh) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        superficieLista = false;
        if (camara != null) {
            try {
                camara.stopPreview();
            } catch (RuntimeException ignorado) {
                // ya estaba detenida
            }
        }
    }

    // ---- lectura del QR (en otro hilo, de a un cuadro) ----

    @Override
    public void onPreviewFrame(byte[] datos, Camera c) {
        Handler h = lector;
        if (encontrado || leyendo) return;
        if (h == null || datos == null) {
            // todavia no esta el hilo que lee (volviendo del permiso): se prueba con otro cuadro
            principal.postDelayed(this::pedirCuadro, 200);
            return;
        }
        leyendo = true;
        final int w = ancho;
        final int hh = alto;
        h.post(() -> {
            String texto = null;
            try {
                PlanarYUVLuminanceSource fuente = new PlanarYUVLuminanceSource(datos, w, hh, 0, 0, w, hh, false);
                Result r = lectorQr.decode(new BinaryBitmap(new HybridBinarizer(fuente)), pistas);
                texto = r.getText();
            } catch (Exception ignorado) {
                // en este cuadro no hay un QR legible
            } finally {
                lectorQr.reset();
            }
            final String leido = texto;
            principal.post(() -> {
                leyendo = false;
                if (leido != null) usar(leido);
                else pedirCuadro();
            });
        });
    }

    private void usar(String texto) {
        String t = texto.trim();
        if (t.regionMatches(true, 0, "WIFI:", 0, 5)) {
            reintentar("Ese es el QR del WiFi: conectá el celular a esa red (desde los ajustes o con la cámara) y después escaneá el de la compu.");
            return;
        }
        if (t.regionMatches(true, 0, "airtracks://", 0, 12)) t = "http://" + t.substring(12);
        Uri u = Uri.parse(t);
        if (!"http".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) {
            reintentar("Ese QR no es el de la compu. Buscá el de “Conectar celulares”.");
            return;
        }
        encontrado = true;
        cerrarCamara();
        // entra como si se hubiera abierto el link del QR (y queda como la ultima compu)
        Intent i = new Intent(Intent.ACTION_VIEW, u, this, WebActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(i);
        finish();
    }

    private void reintentar(String mensaje) {
        aviso.setText(mensaje);
        principal.postDelayed(this::pedirCuadro, 1500);
    }
}
