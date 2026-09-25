package com.multitrack.alabanza;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Lo que la app recuerda: la ultima compu (para entrar directo en el proximo
 * ensayo) y las preferencias de la pagina (nombre, mezcla, codigo de la banda),
 * que asi no se pierden si la compu cambia de IP.
 */
final class Guardado {
    private static final String WEB = "web:";
    private final SharedPreferences prefs;

    Guardado(Context ctx) {
        prefs = ctx.getSharedPreferences("alabanza", Context.MODE_PRIVATE);
    }

    Compu ultimaCompu() {
        String url = prefs.getString("compu.url", null);
        if (url == null) return null;
        return new Compu(prefs.getString("compu.id", ""), prefs.getString("compu.nombre", ""), url, false);
    }

    void guardarCompu(Compu c) {
        prefs.edit().putString("compu.id", c.id).putString("compu.nombre", c.nombre).putString("compu.url", c.url).apply();
    }

    String leerWeb(String clave) {
        return prefs.getString(WEB + clave, null);
    }

    void guardarWeb(String clave, String valor) {
        if (clave == null || clave.length() > 100) return;
        if (valor == null) prefs.edit().remove(WEB + clave).apply();
        else if (valor.length() <= 200_000) prefs.edit().putString(WEB + clave, valor).apply();
    }
}
