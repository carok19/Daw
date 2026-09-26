package com.multitrack.alabanza;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONObject;

/**
 * Busca las computadoras con AirTracks en el WiFi, sin internet ni
 * nube (como DroidCam), de tres formas a la vez:
 *
 *  1. Pregunta por difusion UDP ("MULTITRACK-ALABANZA?" al puerto 48480): la
 *     compu contesta con su nombre, puerto e id. Es lo mas rapido.
 *  2. mDNS / Bonjour (servicio _multitrack._tcp), por si el router filtra la
 *     difusion.
 *  3. Si a los pocos segundos no aparecio nada: prueba una por una las
 *     direcciones de la red (puerto 4848).
 */
final class Buscador {
    interface Oyente {
        void encontrada(Compu c);
    }

    static final int PUERTO_DESCUBRIMIENTO = 48480;
    static final int PUERTO_APP = 4848;
    private static final String PREGUNTA = "MULTITRACK-ALABANZA?";
    private static final String TIPO_SERVICIO = "_multitrack._tcp";

    private final Context ctx;
    private final Oyente oyente;
    private final Handler principal = new Handler(Looper.getMainLooper());
    private volatile boolean activo;
    private ExecutorService pool;
    private WifiManager.MulticastLock candado;
    private NsdManager nsd;
    private NsdManager.DiscoveryListener escuchaNsd;
    private final ArrayDeque<NsdServiceInfo> porResolver = new ArrayDeque<>();
    private boolean resolviendo;
    private volatile boolean huboRespuesta;

    private final Runnable escaneo = () -> {
        if (activo && !huboRespuesta) escanearRed();
    };

    Buscador(Context ctx, Oyente oyente) {
        this.ctx = ctx.getApplicationContext();
        this.oyente = oyente;
    }

    void iniciar() {
        if (activo) return;
        activo = true;
        huboRespuesta = false;
        pool = Executors.newFixedThreadPool(24);
        try {
            WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                candado = wifi.createMulticastLock("alabanza");
                candado.setReferenceCounted(false);
                candado.acquire();
            }
        } catch (RuntimeException e) {
            candado = null;
        }
        Thread hilo = new Thread(this::bucleUdp, "alabanza-udp");
        hilo.setDaemon(true);
        hilo.start();
        iniciarNsd();
        principal.postDelayed(escaneo, 4000);
    }

    void detener() {
        activo = false;
        principal.removeCallbacks(escaneo);
        if (nsd != null && escuchaNsd != null) {
            try {
                nsd.stopServiceDiscovery(escuchaNsd);
            } catch (RuntimeException ignorado) {
                // ya estaba detenida
            }
        }
        escuchaNsd = null;
        synchronized (this) {
            porResolver.clear();
        }
        if (candado != null && candado.isHeld()) candado.release();
        candado = null;
        if (pool != null) pool.shutdownNow();
        pool = null;
    }

    /** Vuelve a buscar desde cero (incluida la busqueda por toda la red). */
    void reiniciar() {
        detener();
        iniciar();
    }

    /** Pregunta directo a una direccion (la ultima compu usada, o una escrita a mano). */
    void probar(String url) {
        ExecutorService p = pool;
        if (p == null || p.isShutdown()) return;
        try {
            p.execute(() -> {
                if (!activo) return;
                Compu c = Red.preguntar(url, 1500);
                if (c != null) avisar(c);
            });
        } catch (RuntimeException ignorado) {
            // el pool se cerro justo
        }
    }

    private void avisar(Compu c) {
        huboRespuesta = true;
        principal.post(() -> {
            if (activo) oyente.encontrada(c);
        });
    }

    // ---- 1. difusion UDP ----

    private void bucleUdp() {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            s.setSoTimeout(500);
            byte[] pregunta = PREGUNTA.getBytes(StandardCharsets.UTF_8);
            byte[] buf = new byte[2048];
            long proximoEnvio = 0;
            while (activo) {
                long ahora = SystemClock.elapsedRealtime();
                if (ahora >= proximoEnvio) {
                    for (InetAddress destino : destinosDeDifusion()) {
                        try {
                            s.send(new DatagramPacket(pregunta, pregunta.length, destino, PUERTO_DESCUBRIMIENTO));
                        } catch (Exception ignorado) {
                            // esa red no deja difundir: quedan las otras formas
                        }
                    }
                    proximoEnvio = ahora + 1500;
                }
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    s.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                try {
                    JSONObject o = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    // la IP desde la que contesto es la que este celular alcanza
                    String url = "http://" + p.getAddress().getHostAddress() + ":" + o.optInt("puerto", PUERTO_APP);
                    Compu c = Compu.desdeInfo(o, url);
                    if (c != null) avisar(c);
                } catch (Exception ignorado) {
                    // otra cosa en ese puerto
                }
            }
        } catch (Exception e) {
            // sin red: el resto de las formas sigue
        }
    }

    private static List<InetAddress> destinosDeDifusion() {
        List<InetAddress> destinos = new ArrayList<>();
        for (InterfaceAddress ia : direccionesLocales()) {
            InetAddress b = ia.getBroadcast();
            if (b != null && !destinos.contains(b)) destinos.add(b);
        }
        try {
            destinos.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignorado) {
            // no pasa
        }
        return destinos;
    }

    /** Direcciones IPv4 privadas de este celular (WiFi, o el hotspot si la compu esta conectada a el). */
    private static List<InterfaceAddress> direccionesLocales() {
        List<InterfaceAddress> res = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) res.add(ia);
                }
            }
        } catch (Exception ignorado) {
            // sin interfaces
        }
        return res;
    }

    // ---- 2. mDNS (NsdManager) ----

    private void iniciarNsd() {
        try {
            nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
            if (nsd == null) return;
            escuchaNsd = new NsdManager.DiscoveryListener() {
                @Override
                public void onStartDiscoveryFailed(String tipo, int error) {}

                @Override
                public void onStopDiscoveryFailed(String tipo, int error) {}

                @Override
                public void onDiscoveryStarted(String tipo) {}

                @Override
                public void onDiscoveryStopped(String tipo) {}

                @Override
                public void onServiceFound(NsdServiceInfo info) {
                    encolarResolucion(info);
                }

                @Override
                public void onServiceLost(NsdServiceInfo info) {}
            };
            nsd.discoverServices(TIPO_SERVICIO, NsdManager.PROTOCOL_DNS_SD, escuchaNsd);
        } catch (RuntimeException e) {
            escuchaNsd = null;
        }
    }

    // NsdManager resuelve de a uno (dos a la vez fallan con FAILURE_ALREADY_ACTIVE)
    private synchronized void encolarResolucion(NsdServiceInfo info) {
        porResolver.add(info);
        siguienteResolucion();
    }

    @SuppressWarnings("deprecation")
    private synchronized void siguienteResolucion() {
        if (resolviendo || !activo || nsd == null) return;
        NsdServiceInfo info = porResolver.poll();
        if (info == null) return;
        resolviendo = true;
        try {
            nsd.resolveService(info, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo s, int error) {
                    resolucionTerminada();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo s) {
                    InetAddress host = s.getHost();
                    if (host instanceof Inet4Address) probar("http://" + host.getHostAddress() + ":" + s.getPort());
                    resolucionTerminada();
                }
            });
        } catch (RuntimeException e) {
            resolviendo = false;
        }
    }

    private synchronized void resolucionTerminada() {
        resolviendo = false;
        siguienteResolucion();
    }

    // ---- 3. probar toda la red ----

    private void escanearRed() {
        for (InterfaceAddress ia : direccionesLocales()) {
            int prefijo = ia.getNetworkPrefixLength();
            if (prefijo < 22 || prefijo > 29) continue; // redes de casa/iglesia (hasta 1022 equipos)
            int propia = aEntero(ia.getAddress());
            int mascara = -1 << (32 - prefijo);
            int red = propia & mascara;
            int cantidad = 1 << (32 - prefijo);
            for (int i = 1; i < cantidad - 1; i++) {
                int destino = red | i;
                if (destino == propia) continue;
                String url = "http://" + aTexto(destino) + ":" + PUERTO_APP;
                ExecutorService p = pool;
                if (!activo || p == null || p.isShutdown()) return;
                try {
                    p.execute(() -> {
                        if (!activo) return;
                        Compu c = Red.preguntar(url, 800);
                        if (c != null) avisar(c);
                    });
                } catch (RuntimeException e) {
                    return;
                }
            }
        }
    }

    private static int aEntero(InetAddress a) {
        byte[] b = a.getAddress();
        return ((b[0] & 255) << 24) | ((b[1] & 255) << 16) | ((b[2] & 255) << 8) | (b[3] & 255);
    }

    private static String aTexto(int ip) {
        return ((ip >>> 24) & 255) + "." + ((ip >>> 16) & 255) + "." + ((ip >>> 8) & 255) + "." + (ip & 255);
    }
}
