'use strict';

/**
 * ThrowToStay – Admin-Panel (Frontend-Logik).
 *
 * Funktionen:
 *  - Login mit ADMIN_PASSWORD (Token im LocalStorage).
 *  - Events anlegen/löschen, Foto-Limit pro User konfigurieren (Standard 30),
 *    Bildauflösung und JPEG-Qualität je Event einstellen.
 *  - Zugangs-Schlüssel für Veranstalter generieren, sperren und löschen.
 *  - QR-Code + teilbare URL je Event anzeigen.
 *  - Galerie-Freigabe je Event steuern (Standard: Folgetag 08:00 Uhr, überschreibbar).
 *  - Teilnehmerliste einsehen, kompletten Export als ZIP herunterladen.
 */

(function () {
  const $ = id => document.getElementById(id);
  const els = {
    loginBox: $('loginBox'), loginForm: $('loginForm'), pwInput: $('pwInput'),
    loginError: $('loginError'), dashboard: $('dashboard'), logoutBtn: $('logoutBtn'),
    newEventBtn: $('newEventBtn'), eventList: $('eventList'), toast: $('toast'),
    keyForm: $('keyForm'), keyLabel: $('keyLabel'), keyList: $('keyList'),
    wizard: $('wizard'), wizardProgress: $('wizardProgress'), wizardBody: $('wizardBody'),
    wizardBack: $('wizardBack'), wizardNext: $('wizardNext'), wizardClose: $('wizardClose'),
  };

  const TOKEN_KEY = 'tts_admin_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let events = [];
  let keys = [];

  // ------------------------------------------------------------- Helfer

  function api(path, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch('/api/admin' + path, opts).then(async res => {
      if (!res.ok) {
        let msg = 'Serverfehler (' + res.status + ')';
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
        if (res.status === 401) { logout(false); }
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
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: els.pwInput.value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Login fehlgeschlagen.');
      const data = await res.json();
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      els.pwInput.value = '';
      showDashboard();
    } catch (err) {
      els.loginError.textContent = err.message;
    }
  });

  els.logoutBtn.addEventListener('click', () => logout(true));

  // ------------------------------------------------------------- Dashboard

  async function showDashboard() {
    els.loginBox.style.display = 'none';
    els.dashboard.style.display = 'block';
    await Promise.all([loadEvents(), loadKeys()]);
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

  // Event-URL: gleicher Origin wie das Admin-Panel.
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

    // Kopfzeile
    const row1 = document.createElement('div');
    row1.className = 'row1';
    const title = document.createElement('div');
    title.innerHTML = `<h3></h3><div class="meta"></div>`;
    title.querySelector('h3').textContent = e.name;
    title.querySelector('.meta').textContent =
      `Event-Datum: ${new Date(e.eventDate + 'T00:00:00').toLocaleDateString('de-DE')} · Session-ID: ${e.sessionId}` +
      (e.createdByLabel ? ` · Erstellt von: ${e.createdByLabel}` : '');
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
    // QR per Blob + Authorization-Header laden – kein Token in der URL
    // (würde sonst in Proxy-/Browser-Logs landen).
    api('/events/' + e.id + '/qr.png')
      .then(blob => { qr.src = URL.createObjectURL(blob); })
      .catch(() => { qr.removeAttribute('src'); });
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

    const fName = document.createElement('div');
    fName.className = 'field';
    fName.innerHTML = '<label>Event-Name</label>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = e.name;
    fName.appendChild(nameInput);

    const fDate = document.createElement('div');
    fDate.className = 'field';
    fDate.innerHTML = '<label>Event-Datum</label>';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = e.eventDate;
    fDate.appendChild(dateInput);

    const fLimit = document.createElement('div');
    fLimit.className = 'field';
    fLimit.innerHTML = '<label class="tip" data-tip="Maximale Anzahl an Fotos, die ein einzelner Gast bei diesem Event speichern kann. Standard: 30.">Max. Fotos pro User</label>';
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = '1000';
    limitInput.value = e.maxPhotosPerUser;
    fLimit.appendChild(limitInput);

    const fSide = document.createElement('div');
    fSide.className = 'field';
    fSide.innerHTML = '<label class="tip" data-tip="Längste Seite des gespeicherten Fotos in Pixeln. Höher = mehr Detail, aber deutlich größere Dateien. Standard: 1600, Maximum: 4096.">Max. Bildgröße (px, längste Seite)</label>';
    const sideInput = document.createElement('input');
    sideInput.type = 'number';
    sideInput.min = '640';
    sideInput.max = '4096';
    sideInput.value = e.maxImageSide;
    fSide.appendChild(sideInput);

    const fQuality = document.createElement('div');
    fQuality.className = 'field';
    fQuality.innerHTML = '<label class="tip" data-tip="JPEG-Komprimierung in Prozent. 100 = beste Qualität (größte Dateien), 50 = starke Komprimierung. Standard: 92.">JPEG-Qualität (%)</label>';
    const qualityInput = document.createElement('input');
    qualityInput.type = 'number';
    qualityInput.min = '50';
    qualityInput.max = '100';
    qualityInput.value = e.jpegQuality;
    fQuality.appendChild(qualityInput);

    const fUnlock = document.createElement('div');
    fUnlock.className = 'field';
    fUnlock.innerHTML = '<label class="tip" data-tip="Zeitpunkt, ab dem alle Gäste die gemeinsame Galerie aller Fotos sehen. Standard: Folgetag um 08:00 Uhr.">Galerie-Freigabe</label>';
    const unlockInput = document.createElement('input');
    unlockInput.type = 'datetime-local';
    unlockInput.value = toLocalInputValue(e.galleryUnlockAt);
    fUnlock.appendChild(unlockInput);

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
        name: nameInput.value.trim(),
        eventDate: dateInput.value,
        maxPhotosPerUser: parseInt(limitInput.value, 10),
        maxImageSide: parseInt(sideInput.value, 10),
        jpegQuality: parseInt(qualityInput.value, 10),
      };
      if (unlockInput.value) {
        patch.galleryUnlockAt = new Date(unlockInput.value).toISOString();
      }
      try {
        await api('/events/' + e.id, { method: 'PATCH', body: patch });
        toast('Einstellungen gespeichert.');
        loadEvents();
      } catch (err) { toast(err.message, true); }
    });

    const nowBtn = document.createElement('button');
    nowBtn.className = 'btn small secondary';
    nowBtn.type = 'button';
    nowBtn.style.marginLeft = '8px';
    nowBtn.textContent = e.galleryUnlocked ? 'Galerie sperren' : 'Galerie vorab freigeben';
    nowBtn.addEventListener('click', async () => {
      if (e.galleryUnlocked) {
        // Sperren = Freigabe weit in die Zukunft setzen
        try {
          await api('/events/' + e.id, { method: 'PATCH', body: { galleryUnlockAt: new Date(Date.now() + 3650 * 864e5).toISOString() } });
          toast('Galerie gesperrt.');
          loadEvents();
        } catch (err) { toast(err.message, true); }
      } else {
        try {
          await api('/events/' + e.id, { method: 'PATCH', body: { galleryUnlockAt: 'now' } });
          toast('Galerie freigegeben.');
          loadEvents();
        } catch (err) { toast(err.message, true); }
      }
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

  function renderUsersPanel(panel, users) {
    panel.innerHTML = '';
    if (!users.length) {
      panel.innerHTML = '<div class="empty-state">Noch keine Teilnehmer registriert.</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'users-table';
    table.innerHTML = '<thead><tr><th>Name</th><th>Fotos</th><th>UUID</th><th>Registriert</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const u of users) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = `${u.firstName} ${u.lastName}`;
      const tdCount = document.createElement('td');
      tdCount.textContent = String(u.photoCount);
      const tdUuid = document.createElement('td');
      tdUuid.className = 'mono';
      tdUuid.textContent = u.uuid;
      const tdAt = document.createElement('td');
      tdAt.textContent = fmtDateTime(u.registeredAt);
      tr.append(tdName, tdCount, tdUuid, tdAt);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  function toLocalInputValue(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ------------------------------------------------------------- Event-Wizard (wie im Veranstalter-Bereich)

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

  // Qualitätspresets für den Wizard (Low / Mid / High).
  const QUALITY_PRESETS = [
    { id: 'low', label: 'Low', maxSide: 1600, jpegQuality: 85, desc: 'Kleinere Dateien, reicht für die Galerie' },
    { id: 'mid', label: 'Mid', maxSide: 2560, jpegQuality: 92, desc: 'Gute Qualität – empfohlen' },
    { id: 'high', label: 'High', maxSide: 4096, jpegQuality: 100, desc: 'Maximale Qualität, größte Dateien' },
  ];

  function qualityPresetId() {
    const q = QUALITY_PRESETS.find(x => x.maxSide === wiz.maxSide && x.jpegQuality === wiz.jpegQuality);
    return q ? q.id : 'mid';
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
    h.textContent = 'Wie heißt das Event?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Dieser Name erscheint in der App und in der Galerie. Das Datum wird automatisch auf heute gesetzt.';
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

  function renderWizImage(body) {
    const h = document.createElement('div');
    h.className = 'wizard-step-title';
    h.textContent = 'Wie hoch soll die Fotoqualität sein?';
    const p = document.createElement('p');
    p.className = 'wizard-step-text';
    p.textContent = 'Größere Bilder und höhere JPEG-Qualität liefern mehr Detail, erzeugen aber deutlich größere Dateien. Feinjustieren kannst du später in den Expert-Einstellungen des Events.';
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

  // Schritt validieren + Werte übernehmen. Gibt true, wenn weitergegangen werden darf.
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
      // Werte stammen aus dem gewählten Qualitätspreset (wiz.maxSide / wiz.jpegQuality)
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

  // ------------------------------------------------------------- Veranstalter-Keys

  async function loadKeys() {
    try {
      const data = await api('/keys');
      keys = data.keys;
      renderKeys();
    } catch (err) {
      if (token) toast(err.message, true);
    }
  }

  function renderKeys() {
    const list = els.keyList;
    list.innerHTML = '';
    if (!keys.length) {
      list.innerHTML = '<div class="empty-state" style="padding:16px">Noch keine Schlüssel generiert.</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'users-table';
    table.innerHTML = '<thead><tr><th>Bezeichnung</th><th>Schlüssel</th><th>Events</th><th>Status</th><th>Aktionen</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const k of keys) {
      const tr = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.textContent = k.label || '—';

      const tdKey = document.createElement('td');
      tdKey.className = 'mono';
      tdKey.textContent = k.key;

      const tdCount = document.createElement('td');
      tdCount.textContent = String(k.eventCount);

      const tdStatus = document.createElement('td');
      tdStatus.textContent = k.revoked ? 'gesperrt' : 'aktiv';
      tdStatus.style.color = k.revoked ? 'var(--danger)' : 'var(--ok)';

      const tdActions = document.createElement('td');
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn small secondary';
      copyBtn.type = 'button';
      copyBtn.textContent = 'Kopieren';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(k.key);
          toast('Schlüssel kopiert.');
        } catch { toast(k.key); }
      });

      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'btn small secondary';
      revokeBtn.type = 'button';
      revokeBtn.style.marginLeft = '6px';
      revokeBtn.textContent = k.revoked ? 'Entsperren' : 'Sperren';
      revokeBtn.addEventListener('click', async () => {
        try {
          await api(`/keys/${k.id}`, { method: 'PATCH', body: { revoked: !k.revoked } });
          toast(k.revoked ? 'Schlüssel entsperrt.' : 'Schlüssel gesperrt.');
          loadKeys();
        } catch (err) { toast(err.message, true); }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn small danger';
      delBtn.type = 'button';
      delBtn.style.marginLeft = '6px';
      delBtn.textContent = 'Löschen';
      delBtn.addEventListener('click', async () => {
        if (!(await askConfirm('Schlüssel löschen', `Schlüssel ${k.key} wirklich löschen?`))) return;
        try {
          await api(`/keys/${k.id}`, { method: 'DELETE' });
          toast('Schlüssel gelöscht.');
          loadKeys();
        } catch (err) { toast(err.message, true); }
      });

      tdActions.append(copyBtn, revokeBtn, delBtn);
      tr.append(tdLabel, tdKey, tdCount, tdStatus, tdActions);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    list.appendChild(table);
  }

  els.keyForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      const data = await api('/keys', { method: 'POST', body: { label: els.keyLabel.value.trim() } });
      els.keyLabel.value = '';
      toast(`Schlüssel generiert: ${data.key.key}`);
      loadKeys();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------- Init

  (async function init() {
    if (!token) { els.loginBox.style.display = 'block'; return; }
    try {
      await api('/events');
      showDashboard();
    } catch {
      logout(false); // Token ungültig → Login zeigen
      els.loginBox.style.display = 'block';
    }
  })();
})();