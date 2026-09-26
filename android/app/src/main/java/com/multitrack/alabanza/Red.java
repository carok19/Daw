package com.multitrack.alabanza;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/** Pedidos HTTP chicos a la compu (siempre fuera del hilo principal). */
final class Red {
    private Red() {}

    /** Pregunta a una direccion si es una compu con la app. Null si no responde o no es. */
    static Compu preguntar(String url, int tiempoMs) {
        try {
            return Compu.desdeInfo(new JSONObject(get(url + "/api/info", tiempoMs)), url);
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    static String get(String direccion, int tiempoMs) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(direccion).openConnection();
        con.setConnectTimeout(tiempoMs);
        con.setReadTimeout(tiempoMs);
        con.setUseCaches(false);
        con.setInstanceFollowRedirects(true);
        try (InputStream in = con.getInputStream()) {
            ByteArrayOutputStream salida = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                salida.write(buf, 0, n);
                if (salida.size() > 64 * 1024) throw new IOException("respuesta demasiado grande");
            }
            return new String(salida.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            con.disconnect();
        }
    }

    /**
     * Lo que escribio el usuario ("192.168.1.35", "192.168.1.35:4848",
     * "http://airtracks.local") como http://host:puerto. Null si no se entiende.
     */
    static String normalizarDireccion(String texto) {
        if (texto == null) return null;
        String t = texto.trim().replaceFirst("^https?://", "");
        int barra = t.indexOf('/');
        if (barra >= 0) t = t.substring(0, barra);
        if (t.isEmpty() || !t.matches("[A-Za-z0-9.\\-]+(:\\d{1,5})?")) return null;
        return "http://" + (t.contains(":") ? t : t + ":4848");
    }
}
