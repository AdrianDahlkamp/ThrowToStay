'use strict';

/**
 * ThrowToStay – „Einweg-Kamera"-Filter (Throwaway-Look).
 *
 * Stufe 1 – Color-Science-Pass (Kodak FunSaver / Gold 800 – warm, farbig, körnig):
 *   1. Echte Film-Kurve: angehobene Tiefs (Base-Fog), sanfter S-Kontrast,
 *      Licht-Rolloff (Shoulder) mit Papierweiß – kein hartes Abschneiden.
 *   2. Farb-Matrix der Film-Sorte (Coupler): warmer, leicht entsättigter Charakter.
 *   3. Split-Toning + Desaturation: kühle Tiefs, warme Lichter; Film ist
 *      weniger gesättigt, besonders in den (Flash-)Lichtern.
 *   4. Mehrskaliges Filmkorn (fein + grob), tonabhängig maskiert – kein Digitalkorn.
 *   5. Rot-betonte Halation: weicher Glow um Lichter (Flash).
 *   6. Vignette.
 *
 * `apply()` erzeugt die gespeicherte Variante (Pixel-Transformation auf Canvas,
 * läuft asynchron im Hintergrund – die Aufnahme bleibt frei). `css`/`fx` sind die
 * Echtzeit-Näherung für die Live-Vorschau (CSS-Filter + Overlays).
 * Alle Werte über die FILM-Konstanten feinjustierbar.
 */

(function () {
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  // --------------------------------------------------------------- Film-Config
  // Kodak FunSaver / Gold 800 – warm, farbig, körnig, Flash-Look.
  // Werte bewusst dezent gehalten; Fine-Tuning passiert hier.
  const FILM = {
    fog: 0.055,            // angehobene Schwarzwerte (Base-Fog) – kein echtes Schwarz
    midContrast: 1.10,     // leichte Mitteltön-Kontraste (S-Kurve)
    shoulder: 0.80,        // Beginn des Licht-Rolloffs (Shoulder)
    paper: 0.955,          // Papierweiß – Lichter rollen unter 255 ab
    // Farb-Matrix (Coupler der Film-Sorte): warm, leicht entsättigt
    matrix: [
      [1.05, 0.01, -0.02],
      [0.00, 1.00, 0.00],
      [-0.02, 0.00, 0.94],
    ],
    // Split-Toning: kühle Tiefs, warme Lichter (klassischer Film-Look)
    shadowShift: [-4, 2, 6],      // R,G,B in Tiefs
    highlightShift: [9, 3, -7],   // R,G,B in Lichtern
    // Desaturation: Film ist weniger gesättigt, v.a. in den (Flash-)Lichtern
    desatBase: 0.08,
    desatHighlight: 0.20,
    desatShadow: 0.05,
    // Halation: warmer/roter Glow um Lichter (Flash), rot-betont
    halationStrength: 0.20,
    halationThreshold: 150,
    halationScale: 15,
    // Filmkorn: mehrskaliert, tonabhängig (800er-Körnung, moderat)
    grainAmp: 8,          // Gesamtkörnung (0–255)
    grainCoarse: 0.6,     // Gewicht der groben (1/4) Schicht – gibt das „Klümpchen"
    grainShadow: 0.5,     // Extra-Korn in den Tiefs
  };

  // --------------------------------------------------------------- Ton-Kurve
  // Echte Film-Kurve: Fog in den Tiefs, sanfter S-Kontrast, Shoulder im Licht.
  function buildToneLUT() {
    const L = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      // sanfte Film-S-Kurve (smoothstep)
      let y = x * x * (3 - 2 * x);
      // leichte Mitteltön-Kontraste
      y = clamp01(0.5 + (y - 0.5) * FILM.midContrast);
      // Tiefs anheben (Fog) – Schwarzwerte bleiben grau
      y = FILM.fog + (1 - FILM.fog) * y;
      // Licht-Rolloff (Shoulder) → Papierweiß (kein hartes Clippen)
      if (y > FILM.shoulder) {
        const t = (y - FILM.shoulder) / (1 - FILM.shoulder);
        y = FILM.shoulder + (FILM.paper - FILM.shoulder) * (2 * t - t * t);
      }
      L[i] = Math.min(255, Math.max(0, Math.round(y * 255)));
    }
    return L;
  }

  // --------------------------------------------------------------- Korn
  // Mehrskaliges Filmkorn: grobe (1/4-Auflösung) Schicht für das organische
  // „Klümpchen"; das feine Pro-Pixel-Korn kommt direkt im Haupt-Loop dazu.
  function buildGrain(w, h) {
    const n = w * h;
    const coarse = new Float32Array(n);
    const cw = Math.max(1, Math.ceil(w / 4));
    const ch = Math.max(1, Math.ceil(h / 4));
    const low = new Float32Array(cw * ch);
    for (let i = 0; i < low.length; i++) low[i] = Math.random() * 2 - 1;
    for (let y = 0; y < h; y++) {
      const cy = y >> 2;
      for (let x = 0; x < w; x++) coarse[y * w + x] = low[cy * cw + (x >> 2)];
    }
    return coarse;
  }

  // --------------------------------------------------------------- Halation
  // Warmer Glow um Lichter (Flash): Luminanz wird geschwellt, rot-betont
  // (R > G > B) und weich additiv zurückgeblendet.
  function warmHalation(ctx, w, h) {
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(w / FILM.halationScale));
    t.height = Math.max(1, Math.round(h / FILM.halationScale));
    const tctx = t.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(ctx.canvas, 0, 0, t.width, t.height);
    const td = tctx.getImageData(0, 0, t.width, t.height);
    const a = td.data;
    for (let i = 0; i < a.length; i += 4) {
      const v = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
      const k = clamp01(((v - FILM.halationThreshold) / (255 - FILM.halationThreshold)) * 1.3);
      a[i] = v * k;            // R
      a[i + 1] = v * k * 0.74;  // G
      a[i + 2] = v * k * 0.42;  // B (rot-betont)
      a[i + 3] = 255;
    }
    tctx.putImageData(td, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = FILM.halationStrength;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, w, h);
    ctx.restore();
  }

  // --------------------------------------------------------------- Vignette
  function vignette(ctx, w, h, strength) {
    const g = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.32,
      w / 2, h / 2, Math.hypot(w, h) * 0.55
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${clamp01(strength)})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  const defs = [
    {
      id: 'none',
      label: 'Ohne',
      css: 'none',
      fx: {},
      apply() {
        /* Original, ohne Verarbeitung. */
      },
    },
    {
      id: 'disposable',
      label: 'Einweg-Kamera',
      css: 'brightness(1.05) contrast(0.96) saturate(0.93) sepia(0.09)',
      fx: { grain: 0.16, vignette: 0.42, tint: 'rgba(255, 214, 174, 0.08)' },
      apply(ctx, w, h) {
        const tone = buildToneLUT();
        const coarse = buildGrain(w, h);
        const M = FILM.matrix;
        const img = ctx.getImageData(0, 0, w, h);
        const a = img.data;
        for (let i = 0; i < a.length; i += 4) {
          // 1) Ton-Kurve (Film-Dichte-Response)
          const r = tone[a[i]];
          const g = tone[a[i + 1]];
          const b = tone[a[i + 2]];
          // 2) Farb-Matrix (Film-Sorte)
          let R = M[0][0] * r + M[0][1] * g + M[0][2] * b;
          let G = M[1][0] * r + M[1][1] * g + M[1][2] * b;
          let B = M[2][0] * r + M[2][1] * g + M[2][2] * b;
          // 3) Split-Toning (kühle Tiefs, warme Lichter)
          const lum0 = 0.299 * R + 0.587 * G + 0.114 * B;
          const shadow = clamp01(1 - lum0 / 128);
          const high = clamp01((lum0 - 160) / 95);
          R += FILM.shadowShift[0] * shadow + FILM.highlightShift[0] * high;
          G += FILM.shadowShift[1] * shadow + FILM.highlightShift[1] * high;
          B += FILM.shadowShift[2] * shadow + FILM.highlightShift[2] * high;
          // 4) Desaturation (Film < Digital, v.a. in Lichtern)
          const lum = 0.299 * R + 0.587 * G + 0.114 * B;
          const desat = FILM.desatBase + FILM.desatHighlight * high + FILM.desatShadow * shadow;
          R = lum + (R - lum) * (1 - desat);
          G = lum + (G - lum) * (1 - desat);
          B = lum + (B - lum) * (1 - desat);
          // 5) Mehrskaliges Filmkorn (fein + grob), tonabhängig
          const mask = 1 - high * 0.5 + shadow * FILM.grainShadow * 0.5;
          const gn = ((Math.random() * 2 - 1) * 0.5 + coarse[i >> 2] * FILM.grainCoarse) * FILM.grainAmp * mask;
          a[i] = clamp(R + gn);
          a[i + 1] = clamp(G + gn);
          a[i + 2] = clamp(B + gn);
        }
        ctx.putImageData(img, 0, 0);
        // 6) Halation (rot-betonter Glow) + 7) Vignette
        warmHalation(ctx, w, h);
        vignette(ctx, w, h, 0.32);
      },
    },
  ];

  const grainTile = (() => {
    let cached = null;
    return () => {
      if (cached) return cached;
      const s = 256;
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const x = c.getContext('2d');
      const d = x.createImageData(s, s);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.floor(Math.random() * 256);
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
      x.putImageData(d, 0, 0);
      cached = c.toDataURL('image/png');
      return cached;
    };
  })();

  function get(id) {
    return defs.find(d => d.id === id) || defs[0];
  }

  function applyToCanvas(canvas, filterId) {
    const f = get(filterId);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    f.apply(ctx, canvas.width, canvas.height);
    return canvas;
  }

  function captureToCanvas(source, sw, sh, filterId, maxSide = 1600, zoom = 1) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const x = c.getContext('2d');
    const dx = sw / (2 * zoom), dy = sh / (2 * zoom), dsz = Math.min(sw, sh) / zoom;
    x.drawImage(source, sw / 2 - dx, sh / 2 - dy, dsz, dsz, 0, 0, c.width, c.height);
    const f = get(filterId);
    f.apply(x, c.width, c.height);
    return c;
  }

  function canvasToCanvas(src, filterId, maxSide = 1600) {
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    const f = get(filterId);
    f.apply(x, c.width, c.height);
    return c;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', quality ?? 0.92));
  }

  window.TTSFilters = { defs, get, applyToCanvas, captureToCanvas, canvasToCanvas, canvasToBlob, grainTile };
})();
