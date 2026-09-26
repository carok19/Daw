package com.multitrack.alabanza;

import org.json.JSONObject;

/** Una computadora con AirTracks encontrada en el WiFi. */
final class Compu {
    /** id de la instalacion: no cambia aunque cambie la IP */
    final String id;
    /** "AirTracks · PC-IGLESIA" */
    final String nombre;
    /** http://IP:puerto */
    final String url;
    final boolean requiereCodigo;

    Compu(String id, String nombre, String url, boolean requiereCodigo) {
        this.id = id == null ? "" : id;
        this.nombre = nombre == null ? "" : nombre;
        this.url = url;
        this.requiereCodigo = requiereCodigo;
    }

    /** Desde la respuesta de /api/info (o de la busqueda por UDP). Null si no es de esta app. */
    static Compu desdeInfo(JSONObject o, String url) {
        // id interno (de cuando la app se llamaba Multitrack Alabanza): no cambiarlo
        if (o == null || !"multitrack-alabanza".equals(o.optString("app"))) return null;
        return new Compu(o.optString("id"), o.optString("nombre"), url, o.optBoolean("requiereCodigo"));
    }

    /** El nombre de la compu sin el prefijo de la app ("PC-IGLESIA"). */
    String nombreCorto() {
        int i = nombre.lastIndexOf('·');
        String corto = i >= 0 ? nombre.substring(i + 1).trim() : nombre.trim();
        return corto.isEmpty() ? "Computadora" : corto;
    }

    /** La direccion sin "http://" ("192.168.1.35:4848"). */
    String direccion() {
        return url.replaceFirst("^https?://", "");
    }

    /** Clave para no repetir la misma compu en la lista. */
    String clave() {
        return id.isEmpty() ? url : id;
    }
}
