'use strict';

/**
 * ThrowToStay – "Einweg-Kamera"-Filter (Throwaway-Look).
 *
 * Der Filter besteht aus zwei Repräsentationen:
 *   1. css + fx  → Live-Vorschau auf dem <video>-Element (CSS-Filter plus
 *                  Grain/Vignette/Tint als Overlays, ohne das Video anzufassen).
 *   2. apply()   → echte Pixel-Transformation beim Speichern bzw. beim
 *                  nachträglichen Neu-Filtern (Canvas, deterministisch).
 *
 * Look: Einwegkamera mit Blitz – harte Belichtung mit abgehobenem Blitzlicht,
 * sanftem Licht-Schein (Halation) um Lichter, leicht angehobenen Schwarzwerten,
 * warmem Farbstich, feinem Filmkorn und weicher Vignette.
 *
 * Wichtig: Der Filter wird NIE in das Original eingebrannt. Original und
 * gefilterte Variante werden als getrennte Dateien gespeichert.
 */

(function () {
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

  function vignette(ctx, w, h, strength) {
    const g = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.42,
      w / 2, h / 2, Math.hypot(w, h) / 1.9
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * Halation / Bloom: Nur die Lichter des Bildes werden verkleinert, dann
   * weich vergrößert und additiv zurückgemalt – so entsteht der typische
   * milchige Glanz um helle Stellen (Blitz, Lampen, Hautglanz), ohne teuren
   * ctx.filter-Blur (der nicht überall verfügbar ist).
   */
  function halation(ctx, w, h, strength = 0.26, threshold = 145) {
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(w / 12));
    t.height = Math.max(1, Math.round(h / 12));
    const tctx = t.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(ctx.canvas, 0, 0, t.width, t.height);
    const td = tctx.getImageData(0, 0, t.width, t.height);
    const a = td.data;
    for (let i = 0; i < a.length; i += 4) {
      const v = (a[i] + a[i + 1] + a[i + 2]) / 3;
      // Nur helle Bereiche behalten, weich auslaufen lassen
      const k = clamp(((v - threshold) / (255 - threshold)) * 1.2, 0, 1);
      a[i] = clamp(a[i] * k);
      a[i + 1] = clamp(a[i + 1] * k);
      a[i + 2] = clamp(a[i + 2] * k);
    }
    tctx.putImageData(td, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = strength;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, w, h);
    ctx.restore();
  }

  const defs = [
    {
      id: 'none',
      label: 'Ohne',
      css: 'none',
      fx: {},
      apply() { /* unverändert */ },
    },
    {
      id: 'disposable',
      label: 'Einweg-Kamera',
      css: 'brightness(1.07) contrast(1.04) saturate(0.9) sepia(0.16)',
      fx: { grain: 0.18, vignette: 0.45, tint: 'rgba(255, 224, 178, 0.10)' },
      apply(ctx, w, h) {
        const img = ctx.getImageData(0, 0, w, h);
        const a = img.data;
        for (let i = 0; i < a.length; i += 4) {
          let r = a[i], g = a[i + 1], b = a[i + 2];

          // 1) Blitz-Belichtung: anheben, Schwarzwerte anheben (angeknipst),
          //    Lichter sanft rollen (Overexposure der Einwegkamera).
          r = r * 1.12 + 12;
          g = g * 1.10 + 11;
          b = b * 1.06 + 10;
          r = r <= 205 ? r : 205 + (r - 205) * 0.68;
          g = g <= 205 ? g : 205 + (g - 205) * 0.68;
          b = b <= 210 ? b : 205 + (b - 205) * 0.68;

          // 2) Warmstich (Filmpatronen neigen zu warm) + dezente Entsättigung,
          //    damit es nicht wie "Instagram-Filter" wirkt.
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          r = r + (l - r) * 0.14;
          g = g + (l - g) * 0.14;
          b = b + (l - b) * 0.14;
          r = r * 1.05 + 5;
          g = g * 1.00 + 2;
          b = b * 0.94 - 4;

          // 3) Feines Filmkorn (luminanzbasiert, wirkt natürlicher als RGB-Rauschen)
          const n = (Math.random() - 0.5) * 13;
          const nl = n * 0.6 + (Math.random() - 0.5) * 10;

          a[i] = clamp(r + nl);
          a[i + 1] = clamp(g + nl * 0.92);
          a[i + 2] = clamp(b + nl * 0.85);
        }
        ctx.putImageData(img, 0, 0);

        // 4) Halation um Lichter (Blitz-Look) + weiche Vignette
        halation(ctx, w, h, 0.24, 148);
        vignette(ctx, w, h, 0.34);
      },
    },
  ];

  // ---------------------------------------------------------------- API

  function get(id) {
    return defs.find(f => f.id === id) || defs[0];
  }

  /** Wendet den Filter auf ein bereits bemaltes Canvas an. */
  function applyToCanvas(canvas, filterId) {
    const f = get(filterId);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    f.apply(ctx, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Zeichnet die Quelle (Video/Bild/Bitmap) skaliert auf maxSide in ein Canvas,
   * wendet optional den Filter an und unterstützt digitalen Zoom (zentraler
   * Crop um Faktor `zoom`). Liefert das Canvas zurück.
   */
  function captureToCanvas(source, sw, sh, filterId, maxSide = 1600, zoom = 1) {
    const z = Math.max(1, zoom || 1);
    const cropW = sw / z;
    const cropH = sh / z;
    const cropX = (sw - cropW) / 2;
    const cropY = (sh - cropH) / 2;
    const scale = Math.min(1, maxSide / Math.max(cropW, cropH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropW * scale);
    canvas.height = Math.round(cropH * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    if (filterId && filterId !== 'none') applyToCanvas(canvas, filterId);
    return canvas;
  }

  function canvasToBlob(canvas, quality = 0.92) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht erzeugt werden.'))),
        'image/jpeg',
        quality
      );
    });
  }

  /** Grain-Kachel als dataURL für die Live-Vorschau-Overlays. */
  function grainTile() {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  window.TTSFilters = { defs, get, applyToCanvas, captureToCanvas, canvasToBlob, grainTile };
})();