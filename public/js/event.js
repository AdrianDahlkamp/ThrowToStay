'use strict';

/**
 * ThrowToStay – Kamera-App (Frontend-Logik).
 *
 * Ablauf beim ersten Aufruf:
 *   1. UUID generieren und im LocalStorage speichern (bleibt dauerhaft auf dem Gerät).
 *   2. Vor-/Nachname eingeben → Server-Registrierung pro Event.
 *   3. Kamera mit Einweg-Kamera-Filter (Live-Vorschau); beim Auslösen werden
 *      Original und gefilterte Variante getrennt hochgeladen (der Filter wird
 *      nicht eingebrannt). Zoom und Blitz werden unterstützt, sofern das Gerät
 *      sie hergibt (Blitz-Fallback: heller Screen-Flash).
 *   4. Galerie: eigene Fotos sofort, alle Fotos aller Gäste ab Freigabe
 *      (Standard: Folgetag 08:00). Namens-Overlay nur kosmetisch.
 */

(function () {
  // ------------------------------------------------------------- Grundlagen

  const parts = location.pathname.split('/').filter(Boolean);
  const SID = parts[0] === 'e' ? parts[1] : null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const $ = id => document.getElementById(id);
  const els = {
    eventName: $('eventName'), userLine: $('userLine'),
    tabCamera: $('tabCamera'), tabGallery: $('tabGallery'),
    cameraView: $('cameraView'), galleryView: $('galleryView'),
    cameraStage: $('cameraStage'), video: $('video'),
    fxTint: $('fxTint'), fxGrain: $('fxGrain'), fxVignette: $('fxVignette'),
    camError: $('camError'), camErrorText: $('camErrorText'), camRetryBtn: $('camRetryBtn'),
    filterRow: $('filterRow'),
    zoomRow: $('zoomRow'), zoomSlider: $('zoomSlider'), zoomLabel: $('zoomLabel'),
    flashBtn: $('flashBtn'), flipBtn: $('flipBtn'), shutterBtn: $('shutterBtn'), toGalleryBtn: $('toGalleryBtn'),
    photoCounter: $('photoCounter'),
    retryBanner: $('retryBanner'), retryText: $('retryText'), retryBtn: $('retryBtn'),
    galleryHint: $('galleryHint'), selectToggle: $('selectToggle'), lockedBanner: $('lockedBanner'), photoGrid: $('photoGrid'),
    selectBar: $('selectBar'), selectCount: $('selectCount'), selectAllBtn: $('selectAllBtn'), downloadSelBtn: $('downloadSelBtn'),
    lightbox: $('lightbox'), lbImg: $('lbImg'), lbName: $('lbName'), lbClose: $('lbClose'),
    lbVariantBtns: $('lbVariantBtns'), lbFilterChips: $('lbFilterChips'),
    onboard: $('onboard'), onboardEventName: $('onboardEventName'), onboardForm: $('onboardForm'),
    firstNameInput: $('firstNameInput'), lastNameInput: $('lastNameInput'), joinBtn: $('joinBtn'), onboardError: $('onboardError'),
    toast: $('toast'),
  };

  const state = {
    uuid: null,
    event: null,
    user: null,
    photos: [],
    filter: 'none',
    facing: 'environment',
    stream: null,
    track: null,
    zoomMode: 'digital',   // 'native' (Track-Zoom) | 'digital' (Crop)
    zoomCaps: null,        // { min, max, step } bei nativem Zoom
    zoom: 1,
    torchCapable: false,
    flashOn: false,
    mode: 'camera',
    selectMode: false,
    selected: new Map(),   // photoId -> { original: bool, filtered: bool }
    variantOf: new Map(),  // photoId -> aktuell angezeigte Variante (Ansicht)
    captureBusy: false,
    failedUploads: [],
    uploadChain: Promise.resolve(),
    galleryTimer: null,
    lbPhotoId: null,
  };

  // ------------------------------------------------------------- Helfer

  function ensureUuid() {
    let u = localStorage.getItem('tts_uuid');
    if (!u) {
      u = (crypto.randomUUID && crypto.randomUUID()) || `uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem('tts_uuid', u);
    }
    return u;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = 'Serverfehler (' + res.status + ')';
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, v);
    return p.toString();
  }

  function fileUrl(photo, variant, extra = {}) {
    return `/api/e/${SID}/photos/${photo.id}/file?` + qs({ variant, uuid: state.uuid, ...extra });
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  /** Standard-Ansicht: das Bild so, wie es gemacht wurde (mit/ohne Filter). */
  function defaultVariant(p) {
    return p.takenWithFilter && p.hasFiltered ? 'filtered' : 'original';
  }
  function currentVariant(p) {
    const v = state.variantOf.get(p.id);
    if (v === 'original') return 'original';
    if (v === 'filtered' && p.hasFiltered) return 'filtered';
    return defaultVariant(p);
  }
  /** Galerie-Anzeige: Nachname nur als Anfangsbuchstabe ("Adrian D."). */
  function shortName(p) {
    const f = (p.owner.firstName || '').trim();
    const l = (p.owner.lastName || '').trim();
    return `${f} ${l ? l.charAt(0).toUpperCase() + '.' : ''}`.trim();
  }
  function fullName(p) {
    return `${p.owner.firstName} ${p.owner.lastName}`.trim();
  }

  // ------------------------------------------------------------- Icons

  const ICONS = {
    plain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z"/><path d="M19 14l.9 2.4L21.5 16l-2.6.9L19 19l-.9-2.1-2.6-.9 2.5-.6L19 14z" opacity=".7"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  // ------------------------------------------------------------- Filter-UI

  function renderFilterChips(container, activeId, onSelect) {
    container.innerHTML = '';
    for (const f of window.TTSFilters.defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'filter-chip' + (f.id === activeId ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch' + (f.id === 'none' ? ' none' : '');
      b.appendChild(sw);
      b.appendChild(document.createTextNode(f.label));
      b.addEventListener('click', () => onSelect(f.id));
      container.appendChild(b);
    }
  }

  function setFilter(id) {
    state.filter = id;
    const f = window.TTSFilters.get(id);
    // Live-Vorschau: CSS-Filter + Grain/Vignette/Tint als reine Overlays.
    els.video.style.filter = f.css === 'none' ? '' : f.css;
    els.fxTint.style.background = f.fx.tint || 'transparent';
    els.fxTint.style.opacity = f.fx.tint ? 1 : 0;
    els.fxVignette.style.opacity = f.fx.vignette || 0;
    els.fxGrain.style.opacity = f.fx.grain || 0;
    renderFilterChips(els.filterRow, id, setFilter);
  }

  // ------------------------------------------------------------- Kamera

  async function startCamera() {
    stopCamera();
    els.camError.classList.remove('visible');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      state.stream = stream;
      els.video.srcObject = stream;
      try { await els.video.play(); } catch { /* autoplay fine */ }
      setupZoomAndTorch();
    } catch (err) {
      state.stream = null;
      els.camErrorText.textContent =
        err && err.name === 'NotAllowedError'
          ? 'Kamerazugriff wurde abgelehnt. Bitte in den Browser-Einstellungen erlauben und erneut versuchen.'
          : 'Kein Kamerazugriff möglich (' + (err && err.name ? err.name : 'unbekannt') + '). Kamera von anderer App freigeben und erneut versuchen.';
      els.camError.classList.add('visible');
    }
  }

  function stopCamera() {
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
state.track = null;
    }
    els.video.srcObject = null;
    els.video.style.transform = '';
  }

  /** Zoom & Blitz-Fähigkeiten des aktuellen Tracks ermitteln. */
  function setupZoomAndTorch() {
    state.zoom = 1;
    state.zoomMode = 'digital';
    state.zoomCaps = null;
    state.torchCapable = false;
    state.track = null;
    els.video.style.transform = '';

    const track = state.stream && state.stream.getVideoTracks()[0];
    state.track = track || null;
    let caps = {};
    try {
      caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
    } catch { /* nicht unterstützt */ }

    if (caps.torch) state.torchCapable = true;

    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      state.zoomMode = 'native';
      state.zoomCaps = caps.zoom;
      els.zoomSlider.min = String(caps.zoom.min);
      els.zoomSlider.max = String(caps.zoom.max);
      els.zoomSlider.step = String(Math.max((caps.zoom.max - caps.zoom.min) / 60, 0.01));
    } else {
      // Digitaler Zoom: zentraler Crop, für die Vorschau per CSS skaliert.
      state.zoomMode = 'digital';
      els.zoomSlider.min = '1';
      els.zoomSlider.max = '4';
      els.zoomSlider.step = '0.1';
    }
    els.zoomSlider.value = '1';
    els.zoomLabel.textContent = '1,0×';
  }

  function setZoom(v) {
    v = Math.max(1, Math.min(Number(v) || 1, parseFloat(els.zoomSlider.max)));
    state.zoom = v;
    els.zoomLabel.textContent = `${v.toFixed(1).replace('.', ',')}×`;
    if (state.zoomMode === 'native' && state.track) {
      state.track.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {});
    } else {
      els.video.style.transform = v > 1 ? `scale(${v})` : '';
    }
  }

  async function setTorch(on) {
    if (!state.torchCapable || !state.track) return;
    try { await state.track.applyConstraints({ advanced: [{ torch: on }] }); } catch { /* egal */ }
  }

  function flashWhite() {
    const fl = document.createElement('div');
    fl.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:.85;pointer-events:none;transition:opacity .18s ease;z-index:6;';
    els.cameraStage.appendChild(fl);
    requestAnimationFrame(() => { fl.style.opacity = '0'; });
    setTimeout(() => fl.remove(), 220);
  }

  /** Heller Screen-Flash als Blitz-Fallback (z. B. iOS ohne Torch-Support). */
  function screenFlashOverlay() {
    const fl = document.createElement('div');
    fl.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:1;pointer-events:none;z-index:400;';
    document.body.appendChild(fl);
    return fl;
  }

  function updateCounter() {
    const count = (state.user && state.user.photoCount) || 0;
    const max = state.event ? state.event.maxPhotosPerUser : 30;
    if (count >= max) {
      els.photoCounter.innerHTML = `Limit erreicht: <b>${count}</b> / ${max} Fotos`;
      els.shutterBtn.disabled = true;
    } else {
      els.photoCounter.innerHTML = `<b>${count}</b> / ${max} Fotos`;
      els.shutterBtn.disabled = false;
    }
  }

  /** Vom Event konfigurierte Bildqualität (Admin-Panel). */
  function imageSettings() {
    const e = state.event || {};
    return {
      maxSide: Math.min(Math.max(parseInt(e.maxImageSide, 10) || 1600, 640), 4096),
      quality: Math.min(Math.max(parseInt(e.jpegQuality, 10) || 92, 50), 100) / 100,
    };
  }

  async function capture() {
    if (state.captureBusy || !state.user) return;
    const video = els.video;
    if (!video.videoWidth) { toast('Kamera ist noch nicht bereit.', true); return; }

    const filterId = state.filter;
    const takenWithFilter = filterId !== 'none';
    state.captureBusy = true;
    els.shutterBtn.classList.add('busy');

    // Blitz: echtes Torch-Licht vor der Aufnahme aktivieren, sonst Screen-Flash.
    let torchUsed = false;
    let overlay = null;
    if (state.flashOn) {
      if (state.torchCapable && state.track) {
        torchUsed = true;
        await setTorch(true);
        await sleep(450); // Blitz braucht einen Moment, bis die Szene beleuchtet ist
      } else {
        overlay = screenFlashOverlay();
        await sleep(550);
      }
    }
    flashWhite();

    try {
      const zoomArg = state.zoomMode === 'digital' ? state.zoom : 1;
      const { maxSide, quality } = imageSettings();
      // Frame NUR EINMAL vom Video aufnehmen. Original und gefilterte Variante
      // werden aus demselben Frame abgeleitet (Kopie + Filter), damit beide
      // exakt übereinander liegen – kein Versatz wie bei zwei Aufnahmen.
      const originalCanvas = window.TTSFilters.captureToCanvas(video, video.videoWidth, video.videoHeight, 'none', maxSide, zoomArg);
      const originalBlob = await window.TTSFilters.canvasToBlob(originalCanvas, quality);
      // Die Filter-Variante (Einweg-Kamera-Look) wird IMMER mitgespeichert,
      // damit beide Varianten zum Download verfügbar sind – unabhängig davon,
      // ob der Filter bei der Aufnahme aktiv war (der bestimmt nur die
      // Standard-Ansicht). Aus demselben Frame wie das Original (kein Versatz).
      const variantFilterId = filterId !== 'none' ? filterId : 'disposable';
      const fc = document.createElement('canvas');
      fc.width = originalCanvas.width;
      fc.height = originalCanvas.height;
      fc.getContext('2d').drawImage(originalCanvas, 0, 0);
      window.TTSFilters.applyToCanvas(fc, variantFilterId);
      const filteredBlob = await window.TTSFilters.canvasToBlob(fc, quality);
      queueUpload({ originalBlob, filteredBlob, filterId: variantFilterId, takenWithFilter });
    } catch (err) {
      toast(err.message || 'Aufnahme fehlgeschlagen.', true);
    } finally {
      if (torchUsed) await setTorch(false);
      if (overlay) overlay.remove();
      state.captureBusy = false;
      els.shutterBtn.classList.remove('busy');
    }
  }

  function queueUpload(item) {
    state.uploadChain = state.uploadChain.then(() => sendUpload(item)).catch(() => {
      state.failedUploads.push(item);
      updateRetryBanner();
    });
  }

  async function sendUpload(item) {
    const fd = new FormData();
    fd.set('uuid', state.uuid);
    fd.set('filterId', item.filterId);
    fd.set('takenWithFilter', item.takenWithFilter ? '1' : '0');
    fd.set('original', item.originalBlob, 'original.jpg');
    // Filter-Variante wird immer mitgesendet (wird bei der Aufnahme erzeugt).
    if (item.filteredBlob) fd.set('filtered', item.filteredBlob, 'filtered.jpg');

    const res = await fetch(`/api/e/${SID}/photos`, { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = 'Upload fehlgeschlagen';
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    state.user.photoCount = data.photoCount;
    updateCounter();
    const photo = data.photo;
    state.photos.push(photo);
    state.variantOf.set(photo.id, defaultVariant(photo));
  }

  function updateRetryBanner() {
    const n = state.failedUploads.length;
    els.retryBanner.classList.toggle('visible', n > 0);
    els.retryText.textContent = n === 1 ? 'Ein Foto konnte nicht hochgeladen werden.' : `${n} Fotos konnten nicht hochgeladen werden.`;
  }

  function retryFailed() {
    const items = state.failedUploads.splice(0);
    updateRetryBanner();
    for (const item of items) queueUpload(item);
  }

  // ------------------------------------------------------------- Galerie

  async function loadGallery() {
    if (!state.user) return;
    const data = await api(`/api/e/${SID}/photos?` + qs({ uuid: state.uuid }));
    // Frisch geladene Liste mit lokalen Varianten-Overrides mergen.
    if (state.event) state.event.galleryUnlocked = data.galleryUnlocked;
    const overrides = state.variantOf;
    state.photos = data.photos;
    state.variantOf = new Map();
    for (const p of state.photos) {
      const v = overrides.get(p.id);
      state.variantOf.set(p.id, v === 'filtered' && !p.hasFiltered ? 'original' : (v || defaultVariant(p)));
    }
    // Auswahlbereinigung: Fotos, die es nicht mehr gibt, aus der Auswahl entfernen.
    const ids = new Set(state.photos.map(p => p.id));
    for (const id of [...state.selected.keys()]) {
      if (!ids.has(id)) state.selected.delete(id);
    }
    renderLockedBanner(data.galleryUnlocked, data.galleryUnlockAt);
    renderGrid();
  }

  function renderLockedBanner(unlocked, unlockAt) {
    const when = new Date(unlockAt);
    const whenStr = when.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (unlocked) {
      els.lockedBanner.classList.add('unlocked');
      els.lockedBanner.innerHTML = `✓ Galerie freigeschaltet – hier sind <b>alle Fotos aller Gäste</b> dieses Events.`;
    } else {
      els.lockedBanner.classList.remove('unlocked');
      els.lockedBanner.innerHTML = '';
      const span = document.createElement('span');
      span.innerHTML = `🔒 Gesamtgalerie folgt am <b>${whenStr}</b>`;
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'info-btn';
      infoBtn.title = 'Mehr erfahren';
      infoBtn.innerHTML = ICONS.info;
      const details = document.createElement('div');
      details.className = 'locked-details';
      details.style.display = 'none';
      details.textContent = 'Bis dahin siehst du hier nur deine eigenen Fotos. Ab dem genannten Zeitpunkt sehen alle Gäste die Fotos aller Gäste.';
      infoBtn.addEventListener('click', () => {
        details.style.display = details.style.display === 'none' ? 'block' : 'none';
      });
      els.lockedBanner.append(span, infoBtn, details);
    }
  }

  function renderGrid() {
    const grid = els.photoGrid;
    grid.innerHTML = '';
    const unlocked = state.event && state.event.galleryUnlocked;
    // Sperren-Zustand wird unten im Banner erklärt – hier keine Doppel-Erklärung.
    els.galleryHint.textContent = unlocked
      ? 'Tippe auf ein Foto für die Großansicht.'
      : '';

    if (!state.photos.length) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.style.gridColumn = '1/-1';
      div.textContent = unlocked
        ? 'Noch keine Fotos in dieser Galerie.'
        : 'Noch keine eigenen Fotos vorhanden.';
      grid.appendChild(div);
      return;
    }

    for (const p of state.photos) grid.appendChild(photoCard(p));
    updateSelectBar();
  }

  function photoCard(p) {
    const variant = currentVariant(p);
    const sel = state.selected.get(p.id) || null;
    const card = document.createElement('div');
    card.className = 'photo-card' + (state.selectMode ? ' selectable' : '') + (sel ? ' selected' : '');

    const wrap = document.createElement('div');
    wrap.className = 'imgwrap';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = fileUrl(p, variant);
    img.alt = 'Foto von ' + shortName(p);
    wrap.appendChild(img);

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.textContent = shortName(p);
    wrap.appendChild(tag);

    if (p.mine) {
      const badge = document.createElement('div');
      badge.className = 'mine-badge';
      badge.textContent = 'Du';
      wrap.appendChild(badge);
    }

    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'rbtn tick-btn select-tick' + (sel ? ' checked' : '');
    tick.title = 'Ganzes Foto auswählen (beide Varianten)';
    tick.innerHTML = ICONS.check;
    tick.addEventListener('click', ev => { ev.stopPropagation(); toggleSelectPhoto(p); });
    wrap.appendChild(tick);

    wrap.addEventListener('click', () => {
      if (state.selectMode) toggleSelectPhoto(p); else openLightbox(p.id);
    });

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    // Zwei kleine runde Buttons: Variante ohne Filter / mit Filter.
    // Im Auswahlmodus fungieren sie als Mehrfachauswahl pro Variante,
    // sonst schalten sie die angezeigte Variante um.
    const btnOrig = document.createElement('button');
    btnOrig.type = 'button';
    btnOrig.className = 'rbtn variant-btn' + (state.selectMode ? (sel && sel.original ? ' active' : '') : (variant === 'original' ? ' active' : ''));
    btnOrig.title = state.selectMode ? '„Ohne Filter“ für den Download auswählen' : 'Ohne Filter anzeigen';
    btnOrig.innerHTML = ICONS.plain;
    btnOrig.addEventListener('click', () => {
      if (state.selectMode) toggleSelectVariant(p, 'original'); else setCardVariant(p, 'original');
    });

    const btnFilt = document.createElement('button');
    btnFilt.type = 'button';
    btnFilt.className = 'rbtn variant-btn' + (state.selectMode ? (sel && sel.filtered ? ' active' : '') : (variant === 'filtered' ? ' active' : ''));
    btnFilt.title = state.selectMode ? '„Mit Filter“ für den Download auswählen' : 'Mit Filter anzeigen';
    btnFilt.innerHTML = ICONS.sparkle;
    // Filter-Variante erzeugen: bei eigenen Fotos immer möglich, bei fremden
    // Fotos nach Galerie-Freigabe (die Bilder sind dann für alle sichtbar).
    const canGenerateFilt = p.mine || !!(state.event && state.event.galleryUnlocked);
    if (state.selectMode) {
      // Auswahlmodus: nur vorhandene Varianten anwählbar.
      btnFilt.disabled = !p.hasFiltered;
      btnFilt.title = p.hasFiltered ? '„Mit Filter“ für den Download auswählen' : 'Keine Filter-Variante vorhanden';
    } else {
      btnFilt.disabled = !p.hasFiltered && !canGenerateFilt;
      btnFilt.title = p.hasFiltered ? 'Mit Filter anzeigen' : (canGenerateFilt ? 'Filter anwenden – erzeugt die Variante' : 'Keine Filter-Variante vorhanden');
    }
    btnFilt.addEventListener('click', () => {
      if (state.selectMode) {
        toggleSelectVariant(p, 'filtered');
      } else if (!p.hasFiltered) {
        refilterPhoto(p, 'disposable');
      } else {
        setCardVariant(p, 'filtered');
      }
    });

    const hint = document.createElement('span');
    hint.className = 'variant-hint';
    hint.textContent = state.selectMode
      ? 'Variante(n) wählen'
      : (variant === 'filtered' ? 'mit Filter' : 'ohne Filter');

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'rbtn dl-btn';
    dl.title = 'Aktuelle Variante herunterladen';
    dl.innerHTML = ICONS.download;
    dl.style.display = state.selectMode ? 'none' : 'inline-flex';
    dl.addEventListener('click', () => downloadSingle(p, currentVariant(p)));

    actions.append(btnOrig, btnFilt, hint, spacer, dl);
    card.append(wrap, actions);
    return card;
  }

  function setCardVariant(p, variant) {
    if (variant === 'filtered' && !p.hasFiltered) return;
    state.variantOf.set(p.id, variant);
    // Karten leicht aktualisieren (nur die betroffene).
    const grid = els.photoGrid;
    const idx = state.photos.findIndex(x => x.id === p.id);
    const card = grid.children[idx];
    if (card) {
      const img = card.querySelector('img');
      img.src = fileUrl(p, variant);
      const btns = card.querySelectorAll('.variant-btn');
      btns.forEach(b => b.classList.remove('active'));
      btns[variant === 'original' ? 0 : 1].classList.add('active');
      card.querySelector('.variant-hint').textContent = variant === 'filtered' ? 'mit Filter' : 'ohne Filter';
    }
    if (state.lbPhotoId === p.id) renderLightbox();
  }

  // ------------------------------------------------------------- Mehrfach-Auswahl

  /** Auswahl-Status eines Fotos abrufen/erzeugen. */
  function selectionFor(p, create = false) {
    let sel = state.selected.get(p.id);
    if (!sel && create) {
      sel = { original: false, filtered: false };
      state.selected.set(p.id, sel);
    }
    return sel;
  }

  function isSelected(p) {
    const sel = state.selected.get(p.id);
    return !!(sel && (sel.original || sel.filtered));
  }

  function updateCardSelectionUI(p) {
    const idx = state.photos.findIndex(x => x.id === p.id);
    const card = els.photoGrid.children[idx];
    if (!card) return;
    const sel = state.selected.get(p.id) || null;
    const btns = card.querySelectorAll('.variant-btn');
    btns[0].classList.toggle('active', !!(sel && sel.original));
    btns[1].classList.toggle('active', !!(sel && sel.filtered));
    const tickBtn = card.querySelector('.tick-btn');
    if (tickBtn) tickBtn.classList.toggle('checked', !!sel);
    card.classList.toggle('selected', !!sel);
  }

  /** Ganze Foto aus-/abwählen: beide verfügbaren Varianten auf einmal. */
  function toggleSelectPhoto(p) {
    if (isSelected(p)) {
      state.selected.delete(p.id);
    } else {
      state.selected.set(p.id, { original: true, filtered: !!p.hasFiltered });
    }
    updateCardSelectionUI(p);
    updateSelectBar();
  }

  /** Einzelne Variante für den Download an-/abwählen. */
  function toggleSelectVariant(p, variant) {
    if (variant === 'filtered' && !p.hasFiltered) return;
    const sel = selectionFor(p, true);
    sel[variant] = !sel[variant];
    if (!sel.original && !sel.filtered) state.selected.delete(p.id);
    updateCardSelectionUI(p);
    updateSelectBar();
  }

  function updateSelectBar() {
    const n = [...state.selected.values()].reduce((s, v) => s + (v.original ? 1 : 0) + (v.filtered ? 1 : 0), 0);
    els.selectCount.textContent = `${n} Bild${n === 1 ? '' : 'er'} ausgewählt`;
    els.selectBar.classList.toggle('visible', state.selectMode && state.mode === 'gallery');
    els.downloadSelBtn.disabled = n === 0;
    els.selectToggle.textContent = state.selectMode ? 'Fertig' : 'Auswählen';
    els.selectToggle.classList.toggle('active', state.selectMode);
  }

  function toggleSelectMode() {
    state.selectMode = !state.selectMode;
    renderGrid();
  }

  function selectAll() {
    if (state.selected.size === state.photos.length) {
      state.selected.clear();
    } else {
      for (const p of state.photos) {
        state.selected.set(p.id, { original: true, filtered: !!p.hasFiltered });
      }
    }
    renderGrid();
  }

  // ------------------------------------------------------------- Downloads

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function fileNameFor(p, variant) {
    const base = `${p.owner.firstName}-${p.owner.lastName}-${p.createdAt.slice(0, 10)}-${variant === 'filtered' ? 'filter' : 'original'}`;
    return base.replace(/[^A-Za-z0-9._-]+/g, '_') + '.jpg';
  }

  function downloadSingle(p, variant) {
    const a = document.createElement('a');
    a.href = fileUrl(p, variant, { download: 1 });
    a.download = fileNameFor(p, variant);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadSelected() {
    if (!state.selected.size) { toast('Bitte zuerst Bilder auswählen.', true); return; }
    const items = [];
    for (const [photoId, sel] of state.selected) {
      if (sel.original) items.push({ photoId, variant: 'original' });
      if (sel.filtered) items.push({ photoId, variant: 'filtered' });
    }
    if (!items.length) { toast('Bitte zuerst Bilder auswählen.', true); return; }

    els.downloadSelBtn.disabled = true;
    els.downloadSelBtn.textContent = 'ZIP wird erstellt…';
    try {
      const res = await fetch(`/api/e/${SID}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: state.uuid, items }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download fehlgeschlagen.');
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      triggerBlobDownload(blob, m ? m[1] : 'throwtostay-fotos.zip');
      toast(`${items.length} Bild(er) als ZIP heruntergeladen.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      els.downloadSelBtn.disabled = false;
      els.downloadSelBtn.textContent = 'Als ZIP herunterladen';
    }
  }

  // ------------------------------------------------------------- Lightbox

  function openLightbox(p) {
    state.lbPhotoId = p.id;
    renderLightbox();
    els.lightbox.classList.add('visible');
  }

  function renderLightbox() {
    const p = state.photos.find(x => x.id === state.lbPhotoId);
    if (!p) { closeLightbox(); return; }
    const variant = currentVariant(p);
    els.lbImg.src = fileUrl(p, variant);
    els.lbName.textContent = shortName(p);

    // Runde Varianten-Buttons
    els.lbVariantBtns.innerHTML = '';
    const mk = (v, icon, title, disabled, action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rbtn variant-btn' + (variant === v ? ' active' : '');
      b.title = title;
      b.innerHTML = icon;
      b.disabled = disabled;
      b.addEventListener('click', action || (() => {
        state.variantOf.set(p.id, v);
        renderLightbox();
        renderGrid();
      }));
      return b;
    };
    // Filter-Variante erzeugen: bei eigenen Fotos immer möglich, bei fremden
    // Fotos nach Galerie-Freigabe (die Bilder sind dann für alle sichtbar).
    const canGenerateFilt = p.mine || !!(state.event && state.event.galleryUnlocked);
    els.lbVariantBtns.append(
      mk('original', ICONS.plain, 'Ohne Filter anzeigen', false),
      mk('filtered', ICONS.sparkle,
        p.hasFiltered ? 'Mit Filter anzeigen' : (canGenerateFilt ? 'Filter anwenden – erzeugt die Variante' : 'Keine Filter-Variante vorhanden'),
        !p.hasFiltered && !canGenerateFilt,
        !p.hasFiltered && canGenerateFilt ? () => refilterPhoto(p, 'disposable') : null)
    );
    const dlB = document.createElement('button');
    dlB.type = 'button';
    dlB.className = 'rbtn dl-btn';
    dlB.title = 'Aktuelle Variante herunterladen';
    dlB.innerHTML = ICONS.download;
    dlB.addEventListener('click', () => downloadSingle(p, variant));
    els.lbVariantBtns.append(dlB);

    // Eigene Fotos: Filter nachträglich ändern (nicht-destructiv, neue Variante).
    els.lbFilterChips.innerHTML = '';
    if (p.mine) {
      const label = document.createElement('span');
      label.className = 'variant-hint';
      label.textContent = 'Filter ändern:';
      label.style.alignSelf = 'center';
      const chipsWrap = document.createElement('span');
      chipsWrap.style.display = 'inline-flex';
      chipsWrap.style.gap = '6px';
      chipsWrap.style.flexWrap = 'wrap';
      renderFilterChips(chipsWrap, p.filterId || 'none', id => refilterPhoto(p, id));
      els.lbFilterChips.append(label, chipsWrap);
    }
  }

  async function refilterPhoto(p, filterId) {
    toast('Wende Filter an …');
    try {
      // Original laden (Blob), Filter anwenden, neue gefilterte Variante hochladen.
      const res0 = await fetch(fileUrl(p, 'original'));
      if (!res0.ok) throw new Error('Original konnte nicht geladen werden.');
      const blob = await res0.blob();
      const bitmap = await createImageBitmap(blob);
      // Ohne Downscale: die Variante hat dieselbe Auflösung wie das Original.
      const canvas = window.TTSFilters.captureToCanvas(bitmap, bitmap.width, bitmap.height, filterId, Math.max(bitmap.width, bitmap.height));
      bitmap.close();
      const filteredBlob = await window.TTSFilters.canvasToBlob(canvas, imageSettings().quality);

      const fd = new FormData();
      fd.set('uuid', state.uuid);
      fd.set('filterId', filterId);
      if (filterId !== 'none') fd.set('filtered', filteredBlob, 'filtered.jpg');

      const res = await fetch(`/api/e/${SID}/photos/${p.id}/refilter`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Filter konnte nicht gespeichert werden.');
      const data = await res.json();
      Object.assign(p, data.photo);
      // Direkt die neu erzeugte (bzw. entfernte) Variante anzeigen.
      state.variantOf.set(p.id, filterId === 'none' ? 'original' : 'filtered');
      // Auswahl-Status pflegen: gefilterte Variante evtl. nicht mehr verfügbar.
      const sel = state.selected.get(p.id);
      if (sel && !p.hasFiltered) {
        sel.filtered = false;
        if (!sel.original) state.selected.delete(p.id);
      }
      renderLightbox();
      renderGrid();
      toast(filterId === 'none' ? 'Gefilterte Variante entfernt.' : 'Filter gespeichert – beide Varianten sind verfügbar.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function closeLightbox() {
    els.lightbox.classList.remove('visible');
    state.lbPhotoId = null;
  }

  // ------------------------------------------------------------- Tabs & Onboarding

  function switchMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    els.cameraView.classList.toggle('visible', mode === 'camera');
    els.galleryView.classList.toggle('visible', mode === 'gallery');
    els.tabCamera.classList.toggle('active', mode === 'camera');
    els.tabGallery.classList.toggle('active', mode === 'gallery');
    if (mode === 'gallery') {
      loadGallery().catch(err => toast(err.message, true));
    } else {
      // Kamera-Modus: Auswahl-Leiste automatisch ausblenden.
      state.selectMode = false;
    }
    updateSelectBar();
  }

  function renderHeader() {
    els.eventName.textContent = state.event ? state.event.name : 'Event';
    if (state.user) {
      els.userLine.textContent = `${state.user.firstName} ${state.user.lastName}`;
    }
  }

  async function registerUser(firstName, lastName) {
    const data = await api(`/api/e/${SID}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: state.uuid, firstName, lastName }),
    });
    state.event = data.event;
    state.user = data.user;
    return data;
  }

  function showOnboard(prefill = false) {
    els.onboardEventName.textContent = state.event ? state.event.name : 'Event';
    if (prefill && state.user) {
      els.firstNameInput.value = state.user.firstName;
      els.lastNameInput.value = state.user.lastName;
      els.joinBtn.textContent = 'Speichern';
    }
    els.onboardError.textContent = '';
    els.onboard.style.display = 'flex';
    els.firstNameInput.focus();
  }

  function hideOnboard() {
    els.onboard.style.display = 'none';
  }

  async function afterJoin() {
    hideOnboard();
    renderHeader();
    updateCounter();
    els.galleryTimer = setInterval(() => {
      if (state.mode === 'gallery' && state.event && !state.event.galleryUnlocked) {
        // Wenn die Freigabe erreicht ist, Galerie neu laden.
        if (Date.now() >= Date.parse(state.event.galleryUnlockAt)) loadGallery().catch(() => {});
      }
    }, 30_000);
  }

  // ------------------------------------------------------------- Init

  async function init() {
    if (!SID) {
      els.eventName.textContent = 'Ungültiger Link';
      return;
    }
    state.uuid = ensureUuid();

    try {
      const data = await api(`/api/e/${SID}/state?` + qs({ uuid: state.uuid }));
      state.event = data.event;
      state.user = data.user;
    } catch (err) {
      els.eventName.textContent = 'Event nicht gefunden';
      toast(err.message, true);
      return;
    }
    if (!state.event) return;

    renderHeader();
    setFilter('none');
    els.fxGrain.style.backgroundImage = `url(${window.TTSFilters.grainTile()})`;
    renderFilterChips(els.filterRow, state.filter, setFilter);

    if (!state.user) {
      els.onboard.style.display = 'flex';
      els.onboardEventName.textContent = state.event.name;
    }

    startCamera();
  }

  // ------------------------------------------------------------- Events

  els.tabCamera.addEventListener('click', () => switchMode('camera'));
  els.tabGallery.addEventListener('click', () => switchMode('gallery'));
  els.toGalleryBtn.addEventListener('click', () => switchMode('gallery'));
  els.shutterBtn.addEventListener('click', capture);
  els.camRetryBtn.addEventListener('click', startCamera);
  els.retryBtn.addEventListener('click', retryFailed);
  els.flipBtn.addEventListener('click', () => {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  els.flashBtn.addEventListener('click', () => {
    state.flashOn = !state.flashOn;
    els.flashBtn.classList.toggle('active', state.flashOn);
    if (state.flashOn) {
      toast(state.torchCapable
        ? 'Blitz an (LED bei der Aufnahme).'
        : 'Blitz an (heller Screen-Blitz – dieses Gerät unterstützt keine LED-Steuerung).');
    }
  });
  els.zoomSlider.addEventListener('input', () => setZoom(parseFloat(els.zoomSlider.value)));
  els.selectToggle.addEventListener('click', toggleSelectMode);
  els.selectAllBtn.addEventListener('click', selectAll);
  els.downloadSelBtn.addEventListener('click', downloadSelected);
  els.lbClose.addEventListener('click', closeLightbox);
  els.lightbox.addEventListener('click', ev => { if (ev.target === els.lightbox) closeLightbox(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeLightbox(); });

  els.onboardForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    const first = els.firstNameInput.value.trim();
    const last = els.lastNameInput.value.trim();
    if (!first || !last) { els.onboardError.textContent = 'Bitte Vor- und Nachnamen angeben.'; return; }
    els.joinBtn.disabled = true;
    try {
      await registerUser(first, last);
      hideOnboard();
      els.joinBtn.textContent = 'Beitreten';
      await afterJoin();
      toast(`Willkommen, ${first}!`);
    } catch (err) {
      els.onboardError.textContent = err.message;
    } finally {
      els.joinBtn.disabled = false;
    }
  });

  // Name ist klickbar → Namen ändern
  els.userLine.addEventListener('click', () => showOnboard(true));

  init();
})();