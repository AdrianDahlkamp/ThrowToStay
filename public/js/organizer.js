'use strict';

/**
 * ThrowToStay – Veranstalter-Panel (Frontend-Logik).
 *
 * Veranstalter melden sich mit einem vom Admin generierten Zugangs-Schlüssel
 * an und können eigene Events anlegen und verwalten (QR-Code, Limits,
 * Bildqualität, Galerie-Freigabe, Teilnehmer, Export).
 */

(function () {
  const $ = id => document.getElementById(id);
  const els = {
    loginBox: $('loginBox'), loginForm: $('loginForm'), keyInput: $('keyInput'),
    loginError: $('loginError'), dashboard: $('dashboard'), logoutBtn: $('logoutBtn'),
    orgLabel: $('orgLabel'), newEventBtn: $('newEventBtn'),
    eventList: $('eventList'), toast: $('toast'),
    wizard: $('wizard'), wizardProgress: $('wizardProgress'), wizardBody: $('wizardBody'),
    wizardBack: $('wizardBack'), wizardNext: $('wizardNext'), wizardClose: $('wizardClose'),
  };

  const TOKEN_KEY = 'tts_organizer_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let events = [];

  // ------------------------------------------------------------- Helfer

  function api(path, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch('/api/organizer' + path, opts).then(async res => {
      if (!res.ok) {
        let msg = 'Serverfehler (' + res.status + ')';
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
        if (res.status === 401) logout(false);
        throw new Error(msg);
      }
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? res.json() : res.blob();
    });
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function toLocalInputValue(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Heutiges Datum als YYYY-MM-DD (Standard-Event-Datum beim Anlegen).
  function todayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Inline-SVG-Icons für die Button-Symbole (Feather-Style, Stroke = currentColor).
  const ICONS = {
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };
  function iconSvg(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = ICONS[name];
    return svg;
  }

  // ------------------------------------------------------------- Auth

  function logout(clearToken = true) {
    if (clearToken) localStorage.removeItem(TOKEN_KEY);
    token = '';
    els.dashboard.style.display = 'none';
    els.loginBox.style.display = 'block';
  }

  els.loginForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    els.loginError.textContent = '';
    try {
      const res = await fetch('/api/organizer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: els.keyInput.value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Login fehlgeschlagen.');
      const data = await res.json();
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      els.keyInput.value = '';
      showDashboard(data.organizer && data.organizer.label);
    } catch (err) {
      els.loginError.textContent = err.message;
    }
  });

  els.logoutBtn.addEventListener('click', () => logout(true));

  // ------------------------------------------------------------- Dashboard

  async function showDashboard(label) {
    els.loginBox.style.display = 'none';
    els.dashboard.style.display = 'block';
    els.orgLabel.textContent = label ? ` · ${label}` : '';
    await loadEvents();
  }

  async function loadEvents() {
    try {
      const data = await api('/events');
      events = data.events;
      renderEvents();
    } catch (err) {
      if (token) toast(err.message, true);
    }
  }

  function eventUrl(e) {
    return `${location.origin}/e/${e.sessionId}`;
  }

  function renderEvents() {
    const list = els.eventList;
    list.innerHTML = '';
    if (!events.length) {
      list.innerHTML = '<div class="empty-state">Noch keine Events angelegt.</div>';
      return;
    }
    for (const e of events) list.appendChild(eventCard(e));
  }

  function eventCard(e) {
    const card = document.createElement('div');
    card.className = 'event-card';

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const title = document.createElement('div');
    title.innerHTML = `<h3></h3><div class="meta"></div>`;
    title.querySelector('h3').textContent = e.name;
    title.querySelector('.meta').textContent =
      `Event-Datum: ${new Date(e.eventDate + 'T00:00:00').toLocaleDateString('de-DE')} · Session-ID: ${e.sessionId}`;
    row1.appendChild(title);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger icon-btn';
    delBtn.type = 'button';
    delBtn.title = 'Event löschen';
    delBtn.appendChild(iconSvg('trash'));
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Event "${e.name}" inkl. aller Fotos wirklich löschen?`)) return;
      try {
        await api('/events/' + e.id, { method: 'DELETE' });
        toast('Event gelöscht.');
        loadEvents();
      } catch (err) { toast(err.message, true); }
    });
    row1.appendChild(delBtn);
    card.appendChild(row1);

    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `<span><b>${e.userCount}</b> Teilnehmer</span><span><b>${e.photoCount}</b> Fotos</span>`;
    card.appendChild(stats);

    const grid = document.createElement('div');
    grid.className = 'event-grid';

    // links: QR + URL
    const share = document.createElement('div');
    share.className = 'share-box';
    const qr = document.createElement('img');
    qr.className = 'qr-img';
    qr.alt = 'QR-Code';
    qr.src = `/api/organizer/events/${e.id}/qr.png?token=${encodeURIComponent(token)}`;
    share.appendChild(qr);

    const urlLine = document.createElement('div');
    urlLine.className = 'url-line';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.value = eventUrl(e);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small secondary icon-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'Event-URL kopieren';
    copyBtn.appendChild(iconSvg('copy'));
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(eventUrl(e));
        toast('URL kopiert.');
      } catch {
        urlInput.select();
        document.execCommand('copy');
        toast('URL kopiert.');
      }
    });
    urlLine.append(urlInput, copyBtn);
    share.appendChild(urlLine);

    const dlQr = document.createElement('button');
    dlQr.className = 'btn small secondary icon-btn';
    dlQr.type = 'button';
    dlQr.style.marginTop = '10px';
    dlQr.title = 'QR-Code herunterladen (PNG)';
    dlQr.appendChild(iconSvg('download'));
    dlQr.addEventListener('click', async () => {
      const blob = await api(`/events/${e.id}/qr.png`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-${e.sessionId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    });
    share.appendChild(dlQr);
    grid.appendChild(share);

    // rechts: Einstellungen
    const settings = document.createElement('div');

    const settingsGrid = document.createElement('div');
    settingsGrid.className = 'settings-grid';

    const fName = mkField('Event-Name', 'text', e.name);
    const fDate = mkField('Event-Datum', 'date', e.eventDate);
    const fLimit = mkField('Max. Fotos pro User', 'number', e.maxPhotosPerUser,
      'Maximale Anzahl an Fotos, die ein einzelner Gast bei diesem Event speichern kann. Standard: 30.');
    fLimit.querySelector('input').min = '1';
    fLimit.querySelector('input').max = '1000';
    const fSide = mkField('Max. Bildgröße (längste Seite, px)', 'number', e.maxImageSide,
      'Längste Seite des gespeicherten Fotos in Pixeln. Höher = mehr Detail, aber deutlich größere Dateien. Standard: 1600, Maximum: 4096.');
    fSide.querySelector('input').min = '640';
    fSide.querySelector('input').max = '4096';
    const fQuality = mkField('JPEG-Qualität (%)', 'number', e.jpegQuality,
      'JPEG-Komprimierung in Prozent. 100 = beste Qualität (größte Dateien), 50 = starke Komprimierung. Standard: 92.');
    fQuality.querySelector('input').min = '50';
    fQuality.querySelector('input').max = '100';
    const fUnlock = mkField('Galerie-Freigabe', 'datetime-local', toLocalInputValue(e.galleryUnlockAt),
      'Zeitpunkt, ab dem alle Gäste die gemeinsame Galerie aller Fotos sehen. Standard: Folgetag um 08:00 Uhr.');

    // Tabs: Basis-Einstellungen / Expert-Einstellungen
    const tabBar = document.createElement('div');
    tabBar.className = 'tabs';
    const tabBasic = document.createElement('button');
    tabBasic.className = 'tab active';
    tabBasic.type = 'button';
    tabBasic.textContent = 'Einstellungen';
    const tabExpert = document.createElement('button');
    tabExpert.className = 'tab';
    tabExpert.type = 'button';
    tabExpert.textContent = 'Expert-Einstellungen';
    tabBar.append(tabBasic, tabExpert);

    const panelBasic = document.createElement('div');
    panelBasic.className = 'tab-panel active';
    settingsGrid.append(fName, fDate);
    panelBasic.appendChild(settingsGrid);

    const panelExpert = document.createElement('div');
    panelExpert.className = 'tab-panel';
    const expertGrid = document.createElement('div');
    expertGrid.className = 'settings-stack';
    expertGrid.append(fLimit, fSide, fQuality, fUnlock);
    panelExpert.appendChild(expertGrid);

    const usersBtn = document.createElement('button');
    usersBtn.className = 'btn small secondary';
    usersBtn.type = 'button';
    usersBtn.textContent = 'Teilnehmer anzeigen';
    usersBtn.title = 'Debug: Teilnehmerliste inkl. UUID und Fotoanzahl';
    usersBtn.addEventListener('click', async () => {
      try {
        const data = await api(`/events/${e.id}/users`);
        renderUsersPanel(usersPanel, data.users);
        usersPanel.classList.toggle('visible', true);
        usersBtn.textContent = usersPanel.classList.contains('visible') ? 'Teilnehmer verbergen' : 'Teilnehmer anzeigen';
      } catch (err) { toast(err.message, true); }
    });
    panelExpert.appendChild(usersBtn);

    const usersPanel = document.createElement('div');
    usersPanel.className = 'users-panel';
    panelExpert.appendChild(usersPanel);

    const switchTab = which => {
      tabBasic.classList.toggle('active', which === 'basic');
      tabExpert.classList.toggle('active', which === 'expert');
      panelBasic.classList.toggle('active', which === 'basic');
      panelExpert.classList.toggle('active', which === 'expert');
    };
    tabBasic.addEventListener('click', () => switchTab('basic'));
    tabExpert.addEventListener('click', () => switchTab('expert'));

    settings.append(tabBar, panelBasic, panelExpert);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn small icon-btn';
    saveBtn.type = 'button';
    saveBtn.title = 'Einstellungen speichern';
    saveBtn.appendChild(iconSvg('save'));
    saveBtn.append(document.createTextNode(' Speichern'));
    saveBtn.addEventListener('click', async () => {
      const patch = {
        name: val(fName).trim(),
        eventDate: val(fDate),
        maxPhotosPerUser: parseInt(val(fLimit), 10),
        maxImageSide: parseInt(val(fSide), 10),
        jpegQuality: parseInt(val(fQuality), 10),
      };
      if (val(fUnlock)) patch.galleryUnlockAt = new Date(val(fUnlock)).toISOString();
      try {
        await api('/events/' + e.id, { method: 'PATCH', body: patch });
        toast('Einstellungen gespeichert.');
        loadEvents();
      } catch (err) { toast(err.message, true); }
    });

    const nowBtn = document.createElement('button');
    nowBtn.className = 'btn small secondary';
    nowBtn.type = 'button';
    nowBtn.textContent = e.galleryUnlocked ? 'Galerie sperren' : 'Galerie vorab freigeben';
    nowBtn.addEventListener('click', async () => {
      const body = e.galleryUnlocked
        ? { galleryUnlockAt: new Date(Date.now() + 3650 * 864e5).toISOString() }
        : { galleryUnlockAt: 'now' };
      try {
        await api('/events/' + e.id, { method: 'PATCH', body });
        toast(e.galleryUnlocked ? 'Galerie gesperrt.' : 'Galerie freigegeben.');
        loadEvents();
      } catch (err) { toast(err.message, true); }
    });

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn small secondary';
    exportBtn.type = 'button';
    exportBtn.textContent = 'Alles exportieren (ZIP)';
    exportBtn.addEventListener('click', async () => {
      try {
        exportBtn.disabled = true;
        const blob = await api(`/events/${e.id}/export.zip`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `export-${e.sessionId}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { toast(err.message, true); } finally { exportBtn.disabled = false; }
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px';
    btnRow.append(saveBtn, nowBtn, exportBtn);
    settings.appendChild(btnRow);

    grid.appendChild(settings);
    card.appendChild(grid);
    return card;
  }

  // tip: optionale Erklärung, die als Tooltip über dem Label erscheint.
  function mkField(label, type, value, tip) {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    if (tip) {
      l.classList.add('tip');
      l.dataset.tip = tip;
    }
    const input = document.createElement('input');
    input.type = type;
    if (value !== undefined && value !== null) input.value = value;
    f.append(l, input);
    return f;
  }
  function val(field) {
    return field.querySelector('input').value;
  }

  function renderUsersPanel(panel, users) {
    panel.innerHTML = '';
    if (!users.length) {
      panel.innerHTML = '<div class="empty-state">Noch keine Teilnehmer registriert.</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'users-table';
    table.innerHTML = '<thead><tr><th>Name</th><th>Fotos</th><th>Registriert</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const u of users) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = `${u.firstName} ${u.lastName}`;
      const tdCount = document.createElement('td');
      tdCount.textContent = String(u.photoCount);
      const tdAt = document.createElement('td');
      tdAt.textContent = fmtDateTime(u.registeredAt);
      tr.append(tdName, tdCount, tdAt);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  // ------------------------------------------------------------- Event-Wizard

  const WIZ_STEPS = 4;
  const wiz = {
    step: 0,
    name: '',
    maxPhotos: 30,
    maxSide: 1600,
    jpegQuality: 92,
    unlockAt: '', // ISO
    creating: false,
  };

  function defaultUnlockLocal() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T08:00`;
  }

  function openWizard() {
    wiz.step = 0;
    wiz.name = '';
    wiz.maxPhotos = 30;
    wiz.maxSide = 1600;
    wiz.jpegQuality = 92;
    wiz.unlockAt = new Date(defaultUnlockLocal()).toISOString();
    els.wizard.style.display = 'flex';
    renderWizard();
  }

  function closeWizard() {
    els.wizard.style.display = 'none';
  }

  function renderWizard() {
    // Fortschrittspunkte
    els.wizardProgress.innerHTML = '';
    for (let i = 0; i < WIZ_STEPS; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot' + (i <= wiz.step ? ' active' : '');
      els.wizardProgress.appendChild(dot);
    }

    const body = els.wizardBody;
    body.innerHTML = '';
    if (wiz.step === 0) renderWizName(body);
    else if (wiz.step === 1) renderWizLimit(body);
    else if (wiz.step === 2) renderWizImage(body);
    else renderWizUnlock(body);

    els.wizardBack.style.visibility = wiz.step === 0 ? 'hidden' : 'visible';
    els.wizardNext.textContent = wiz.step === WIZ_STEPS - 1 ? 'Event erstellen' : 'Weiter';
  }

  function renderWizName(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wie heißt dein Event?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Dieser Name erscheint in der Fotobox und in der Galerie. Das Datum wird automatisch auf heute gesetzt.';
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label for="wizName">Event-Name</label>';
    const input = document.createElement('input');
    input.id = 'wizName';
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = 'z. B. Sommerfest 2026';
    input.value = wiz.name;
    field.appendChild(input);
    body.append(h, p, field);
    setTimeout(() => input.focus(), 30);
  }

  function renderWizLimit(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wie viele Fotos darf ein Gast machen?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Maximale Anzahl an Fotos, die ein einzelner Gast bei diesem Event speichern kann. Bei Überschreitung kann dieser Gast keine weiteren Fotos aufnehmen.';
    const quick = document.createElement('div');
    quick.className = 'wizard-quick';
    const qBtn = document.createElement('button');
    qBtn.className = 'btn small secondary';
    qBtn.type = 'button';
    qBtn.textContent = 'Standard: 30';
    qBtn.addEventListener('click', () => { wiz.maxPhotos = 30; renderWizard(); });
    quick.appendChild(qBtn);
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label for="wizLimit">Max. Fotos pro Gast</label>';
    const input = document.createElement('input');
    input.id = 'wizLimit';
    input.type = 'number';
    input.min = '1';
    input.max = '1000';
    input.value = wiz.maxPhotos;
    field.appendChild(input);
    body.append(h, p, quick, field);
  }

  // Beispielmotiv für die Qualitäts-Vorschau (prozedural, kein Asset nötig).
  function drawSample(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#f97316');
    g.addColorStop(0.5, '#e11d48');
    g.addColorStop(1, '#7c3aed');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(w * 0.78, h * 0.3, Math.min(w, h) * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w * 0.3, h * 0.52);
    ctx.lineTo(w * 0.55, h * 0.78);
    ctx.lineTo(w * 0.75, h * 0.58);
    ctx.lineTo(w, h * 0.82);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(h * 0.12)}px Inter, sans-serif`;
    ctx.fillText('ThrowToStay', w * 0.06, h * 0.2);
  }

  let previewToken = 0;
  function renderWizImage(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wie hoch soll die Fotoqualität sein?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Größere Bilder und höhere JPEG-Qualität geben mehr Detail, erzeugen aber deutlich größere Dateien. Die Vorschau zeigt ein Beispielfoto in der gewählten Einstellung.';
    const quick = document.createElement('div');
    quick.className = 'wizard-quick';
    const qStd = document.createElement('button');
    qStd.className = 'btn small secondary';
    qStd.type = 'button';
    qStd.textContent = 'Standard: 1600 px / 92 %';
    qStd.addEventListener('click', () => { wiz.maxSide = 1600; wiz.jpegQuality = 92; renderWizard(); });
    const qMax = document.createElement('button');
    qMax.className = 'btn small secondary';
    qMax.type = 'button';
    qMax.textContent = 'Empfohlen (max.): 4096 px / 100 %';
    qMax.addEventListener('click', () => { wiz.maxSide = 4096; wiz.jpegQuality = 100; renderWizard(); });
    quick.append(qStd, qMax);
    body.append(h, p, quick);

    const fSide = document.createElement('div');
    fSide.className = 'field';
    fSide.innerHTML = '<label>Max. Bildgröße (längste Seite, px)</label>';
    const rangeSide = document.createElement('div');
    rangeSide.className = 'range-line';
    const rs = document.createElement('input');
    rs.type = 'range';
    rs.min = '640';
    rs.max = '4096';
    rs.step = '64';
    rs.value = wiz.maxSide;
    rs.setAttribute('aria-label', 'Max. Bildgröße');
    const vs = document.createElement('span');
    vs.className = 'range-val';
    vs.textContent = wiz.maxSide + ' px';
    rs.addEventListener('input', () => {
      wiz.maxSide = parseInt(rs.value, 10);
      vs.textContent = wiz.maxSide + ' px';
      updatePreview();
    });
    rangeSide.append(rs, vs);
    fSide.appendChild(rangeSide);

    const fQual = document.createElement('div');
    fQual.className = 'field';
    fQual.innerHTML = '<label>JPEG-Qualität</label>';
    const rangeQual = document.createElement('div');
    rangeQual.className = 'range-line';
    const rq = document.createElement('input');
    rq.type = 'range';
    rq.min = '50';
    rq.max = '100';
    rq.step = '1';
    rq.value = wiz.jpegQuality;
    rq.setAttribute('aria-label', 'JPEG-Qualität');
    const vq = document.createElement('span');
    vq.className = 'range-val';
    vq.textContent = wiz.jpegQuality + ' %';
    rq.addEventListener('input', () => {
      wiz.jpegQuality = parseInt(rq.value, 10);
      vq.textContent = wiz.jpegQuality + ' %';
      updatePreview();
    });
    rangeQual.append(rq, vq);
    fQual.appendChild(rangeQual);

    const prev = document.createElement('div');
    prev.className = 'wizard-preview';
    prev.innerHTML = '<img id="wizPreviewImg" alt="Vorschau"><div class="meta" id="wizPreviewMeta">…</div>';
    body.append(fSide, fQual, prev);
    updatePreview();

    function updatePreview() {
      const token = ++previewToken;
      const src = document.createElement('canvas');
      src.width = 1280;
      src.height = 960;
      drawSample(src.getContext('2d'), 1280, 960);
      const scale = Math.min(1, wiz.maxSide / 1280);
      const w = Math.max(1, Math.round(1280 * scale));
      const hh = Math.max(1, Math.round(960 * scale));
      const dst = document.createElement('canvas');
      dst.width = w;
      dst.height = hh;
      const dctx = dst.getContext('2d');
      dctx.imageSmoothingQuality = 'high';
      dctx.drawImage(src, 0, 0, w, hh);
      dst.toBlob(blob => {
        if (token !== previewToken || !blob) return;
        const img = document.getElementById('wizPreviewImg');
        const meta = document.getElementById('wizPreviewMeta');
        if (!img || !meta) return;
        if (img.dataset.src) URL.revokeObjectURL(img.dataset.src);
        const url = URL.createObjectURL(blob);
        img.dataset.src = url;
        img.src = url;
        meta.textContent = `${w} × ${hh} px · JPEG ${wiz.jpegQuality} % · ≈ ${Math.max(1, Math.round(blob.size / 1024))} KB`;
      }, 'image/jpeg', wiz.jpegQuality / 100);
    }
  }

  function renderWizUnlock(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wann öffnet die gemeinsame Galerie?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Ab diesem Zeitpunkt sehen alle Gäste die Fotos aller Gäste. Standard ist der Folgetag um 08:00 Uhr.';
    const quick = document.createElement('div');
    quick.className = 'wizard-quick';
    const qBtn = document.createElement('button');
    qBtn.className = 'btn small secondary';
    qBtn.type = 'button';
    qBtn.textContent = 'Standard: Folgetag 08:00 Uhr';
    qBtn.addEventListener('click', () => {
      wiz.unlockAt = new Date(defaultUnlockLocal()).toISOString();
      renderWizard();
    });
    quick.appendChild(qBtn);
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label for="wizUnlock">Galerie-Freigabe</label>';
    const input = document.createElement('input');
    input.id = 'wizUnlock';
    input.type = 'datetime-local';
    input.value = toLocalInputValue(wiz.unlockAt);
    field.appendChild(input);
    body.append(h, p, quick, field);
  }

  function readWizardStep() {
    if (wiz.step === 0) {
      const v = els.wizardBody.querySelector('#wizName').value.trim();
      if (!v) { toast('Bitte einen Event-Namen angeben.', true); return false; }
      wiz.name = v;
    } else if (wiz.step === 1) {
      const v = parseInt(els.wizardBody.querySelector('#wizLimit').value, 10);
      if (!Number.isFinite(v) || v < 1) { toast('Bitte ein gültiges Foto-Limit angeben.', true); return false; }
      wiz.maxPhotos = Math.min(v, 1000);
    } else if (wiz.step === 2) {
      // Werte kommen live aus den Slidern (wiz.maxSide / wiz.jpegQuality)
    } else if (wiz.step === 3) {
      const v = els.wizardBody.querySelector('#wizUnlock').value;
      const t = v ? Date.parse(v) : NaN;
      if (Number.isNaN(t)) { toast('Bitte einen gültigen Freigabe-Zeitpunkt angeben.', true); return false; }
      wiz.unlockAt = new Date(t).toISOString();
    }
    return true;
  }

  els.newEventBtn.addEventListener('click', () => openWizard());
  els.wizardClose.addEventListener('click', closeWizard);
  els.wizardBack.addEventListener('click', () => {
    if (wiz.step > 0) { wiz.step -= 1; renderWizard(); }
  });
  els.wizardNext.addEventListener('click', async () => {
    if (!readWizardStep()) return;
    if (wiz.step < WIZ_STEPS - 1) {
      wiz.step += 1;
      renderWizard();
      return;
    }
    // Letzter Schritt: Event wirklich anlegen.
    if (wiz.creating) return;
    wiz.creating = true;
    els.wizardNext.disabled = true;
    try {
      const data = await api('/events', {
        method: 'POST',
        body: {
          name: wiz.name,
          eventDate: todayStr(),
          maxPhotosPerUser: wiz.maxPhotos,
          maxImageSide: wiz.maxSide,
          jpegQuality: wiz.jpegQuality,
          galleryUnlockAt: wiz.unlockAt,
        },
      });
      closeWizard();
      toast(`Event "${data.event.name}" erstellt – Session-ID: ${data.event.sessionId}`);
      loadEvents();
    } catch (err) {
      toast(err.message, true);
    } finally {
      wiz.creating = false;
      els.wizardNext.disabled = false;
    }
  });

  // ------------------------------------------------------------- Init

  (async function init() {
    if (!token) { els.loginBox.style.display = 'block'; return; }
    try {
      await api('/events');
      showDashboard('');
    } catch {
      logout(false);
      els.loginBox.style.display = 'block';
    }
  })();
})();