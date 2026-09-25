package com.multitrack.alabanza;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.TextView;

/** Colores y piezas de la interfaz (los mismos de la app web: oscuro, alto contraste). */
final class Estilo {
    static final int FONDO = Color.parseColor("#0B0D12");
    static final int PANEL = Color.parseColor("#171B24");
    static final int LINEA = Color.parseColor("#323A4C");
    static final int TEXTO = Color.parseColor("#EEF1F7");
    static final int TEXTO_2 = Color.parseColor("#AAB2C3");
    static final int TEXTO_3 = Color.parseColor("#6F788C");
    static final int ACENTO = Color.parseColor("#4F7CFF");
    static final int ERROR = Color.parseColor("#FF8A8A");

    private Estilo() {}

    static int dp(Context ctx, float valor) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, valor, ctx.getResources().getDisplayMetrics()));
    }

    static TextView texto(Context ctx, String t, float sp, int color, boolean negrita) {
        TextView v = new TextView(ctx);
        v.setText(t);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextColor(color);
        if (negrita) v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLineSpacing(0, 1.2f);
        return v;
    }

    static GradientDrawable fondo(Context ctx, int color, int borde, float radioDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(ctx, radioDp));
        if (borde != 0) g.setStroke(dp(ctx, 1), borde);
        return g;
    }

    /** Fondo tocable (con la onda de Android). */
    static RippleDrawable tocable(Context ctx, int color, int borde, float radioDp) {
        return new RippleDrawable(ColorStateList.valueOf(Color.argb(60, 255, 255, 255)), fondo(ctx, color, borde, radioDp), null);
    }

    static Button boton(Context ctx, String t, boolean principal) {
        Button b = new Button(ctx);
        b.setText(t);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(principal ? Color.WHITE : TEXTO);
        b.setGravity(Gravity.CENTER);
        b.setBackground(tocable(ctx, principal ? ACENTO : PANEL, principal ? 0 : LINEA, 10));
        b.setStateListAnimator(null);
        int v = dp(ctx, 14);
        b.setPadding(v, v, v, v);
        return b;
    }
}
