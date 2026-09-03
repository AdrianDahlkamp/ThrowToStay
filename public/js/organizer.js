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

  // Bestätigungsdialog als eigenes Modal (ersetzt window.confirm).
  // Löst mit true (bestätigt) oder false (abgebrochen) auf.
  function askConfirm(title, message, confirmLabel = 'Löschen') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      const card = document.createElement('div');
      card.className = 'confirm-card';
      const t = document.createElement('div');
      t.className = 'confirm-title';
      t.textContent = title;
      const m = document.createElement('div');
      m.className = 'confirm-msg';
      m.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn small secondary';
      cancel.textContent = 'Abbrechen';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn small danger';
      ok.textContent = confirmLabel;
      let finished = false;
      const done = v => {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(v);
      };
      const onKey = ev => {
        if (ev.key === 'Escape') done(false);
        if (ev.key === 'Enter') done(true);
      };
      cancel.addEventListener('click', () => done(false));
      ok.addEventListener('click', () => done(true));
      overlay.addEventListener('click', ev => { if (ev.target === overlay) done(false); });
      card.append(t, m, actions);
      actions.append(cancel, ok);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey);
      ok.focus();
    });
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
      if (!(await askConfirm('Event löschen', `Event "${e.name}" inkl. aller Fotos wirklich löschen?`))) return;
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
    maxSide: 2560, // Default: Preset „Mid“
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
    wiz.maxSide = 2560; // Default: Preset „Mid“
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

  // Qualitätspresets für den Wizard (Low / Mid / High, ohne Slider & Preview).
  const QUALITY_PRESETS = [
    { id: 'low', label: 'Low', maxSide: 1600, jpegQuality: 85, desc: 'Kleinere Dateien, reicht für die Galerie' },
    { id: 'mid', label: 'Mid', maxSide: 2560, jpegQuality: 92, desc: 'Gute Qualität – empfohlen' },
    { id: 'high', label: 'High', maxSide: 4096, jpegQuality: 100, desc: 'Maximale Qualität, größte Dateien' },
  ];

  function qualityPresetId() {
    const q = QUALITY_PRESETS.find(x => x.maxSide === wiz.maxSide && x.jpegQuality === wiz.jpegQuality);
    return q ? q.id : 'mid';
  }

  function renderWizImage(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wie hoch soll die Fotoqualität sein?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Größere Bilder und höhere JPEG-Qualität geben mehr Detail, erzeugen aber deutlich größere Dateien. Feinjustieren kannst du später in den Expert-Einstellungen des Events.';
    body.append(h, p);

    const wrap = document.createElement('div');
    wrap.className = 'quality-options';
    const selId = qualityPresetId();
    for (const q of QUALITY_PRESETS) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'quality-option' + (q.id === selId ? ' selected' : '');
      const radio = document.createElement('span');
      radio.className = 'qo-radio';
      const label = document.createElement('span');
      label.className = 'qo-label';
      label.innerHTML = `<b>${q.label}</b> · ${q.maxSide} px · ${q.jpegQuality} %`;
      const desc = document.createElement('span');
      desc.className = 'qo-desc';
      desc.textContent = q.desc;
      opt.append(radio, label, desc);
      opt.addEventListener('click', () => {
        wiz.maxSide = q.maxSide;
        wiz.jpegQuality = q.jpegQuality;
        for (const b of wrap.querySelectorAll('.quality-option')) b.classList.toggle('selected', b === opt);
      });
      wrap.appendChild(opt);
    }
    body.append(wrap);
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
      // Werte kommen aus dem gewählten Qualitätspreset (wiz.maxSide / wiz.jpegQuality)
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