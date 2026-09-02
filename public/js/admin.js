'use strict';

/**
 * ThrowToStay – Admin-Panel (Frontend-Logik).
 *
 * Funktionen:
 *  - Login mit ADMIN_PASSWORD (Token im LocalStorage).
 *  - Events anlegen/löschen, Foto-Limit pro User konfigurieren (Standard 30).
 *  - QR-Code + teilbare URL je Event anzeigen.
 *  - Galerie-Freigabe je Event steuern (Standard: Folgetag 08:00 Uhr, überschreibbar).
 *  - Teilnehmerliste einsehen, kompletten Export als ZIP herunterladen.
 */

(function () {
  const $ = id => document.getElementById(id);
  const els = {
    loginBox: $('loginBox'), loginForm: $('loginForm'), pwInput: $('pwInput'),
    loginError: $('loginError'), dashboard: $('dashboard'), logoutBtn: $('logoutBtn'),
    createForm: $('createForm'), createName: $('createName'), createDate: $('createDate'),
    createLimit: $('createLimit'), eventList: $('eventList'), toast: $('toast'),
  };

  const TOKEN_KEY = 'tts_admin_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let events = [];

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

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
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
      `Event-Datum: ${new Date(e.eventDate + 'T00:00:00').toLocaleDateString('de-DE')} · Session-ID: ${e.sessionId}`;
    row1.appendChild(title);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.type = 'button';
    delBtn.textContent = 'Event löschen';
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
    qr.src = `/api/admin/events/${e.id}/qr.png?token=${encodeURIComponent(token)}`;
    share.appendChild(qr);

    const urlLine = document.createElement('div');
    urlLine.className = 'url-line';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.value = eventUrl(e);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small secondary';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Kopieren';
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
    dlQr.className = 'btn small secondary';
    dlQr.type = 'button';
    dlQr.style.marginTop = '10px';
    dlQr.textContent = 'QR-Code herunterladen';
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
    fLimit.innerHTML = '<label>Max. Fotos pro User</label>';
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = '1000';
    limitInput.value = e.maxPhotosPerUser;
    fLimit.appendChild(limitInput);

    const fUnlock = document.createElement('div');
    fUnlock.className = 'field';
    fUnlock.innerHTML = `<label>Galerie-Freigabe (Standard: Folgetag 08:00)</label>`;
    const unlockInput = document.createElement('input');
    unlockInput.type = 'datetime-local';
    unlockInput.value = toLocalInputValue(e.galleryUnlockAt);
    fUnlock.appendChild(unlockInput);

    settingsGrid.append(fName, fDate, fLimit, fUnlock);
    settings.appendChild(settingsGrid);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn small';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Einstellungen speichern';
    saveBtn.addEventListener('click', async () => {
      const patch = {
        name: nameInput.value.trim(),
        eventDate: dateInput.value,
        maxPhotosPerUser: parseInt(limitInput.value, 10),
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
    nowBtn.textContent = e.galleryUnlocked ? 'Galerie sperren' : 'Jetzt freigeben';
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

    const usersBtn = document.createElement('button');
    usersBtn.className = 'btn small secondary';
    usersBtn.type = 'button';
    usersBtn.textContent = 'Teilnehmer anzeigen';
    usersBtn.addEventListener('click', async () => {
      try {
        const data = await api(`/events/${e.id}/users`);
        renderUsersPanel(panel, data.users);
        panel.classList.toggle('visible', true);
        usersBtn.textContent = panel.classList.contains('visible') ? 'Teilnehmer verbergen' : 'Teilnehmer anzeigen';
      } catch (err) { toast(err.message, true); }
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px';
    btnRow.append(saveBtn, nowBtn, exportBtn, usersBtn);
    settings.appendChild(btnRow);

    const panel = document.createElement('div');
    panel.className = 'users-panel';
    settings.appendChild(panel);

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

  // ------------------------------------------------------------- Event erstellen

  els.createForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = els.createName.value.trim();
    const date = els.createDate.value;
    if (!name || !date) return;
    try {
      const data = await api('/events', {
        method: 'POST',
        body: { name, eventDate: date, maxPhotosPerUser: parseInt(els.createLimit.value, 10) || 30 },
      });
      els.createName.value = '';
      toast(`Event "${data.event.name}" erstellt – Session-ID: ${data.event.sessionId}`);
      loadEvents();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------- Init

  (async function init() {
    // Default-Datum: heute
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    els.createDate.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
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