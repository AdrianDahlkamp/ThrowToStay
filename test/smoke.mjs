'use strict';

/**
 * Smoke-Tests für ThrowToStay: startet einen Testserver und prüft die Kernabläufe.
 * Ausführen: npm test
 */

import { spawn } from 'node:child_process';
import { rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3743;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(root, 'data-test');

rmSync(DATA_DIR, { recursive: true, force: true });

const server = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  env: { ...process.env, TTS_PORT: String(PORT), TTS_DATA_DIR: DATA_DIR, ADMIN_PASSWORD: 'test-pw' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

// 1x1-Test-JPEG
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64'
);

async function waitForServer(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return;
    } catch { /* noch nicht bereit */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server nicht gestartet:\n' + serverLog);
}

function uuid() {
  return crypto.randomUUID();
}

function makeUpload({ user, withFilter, filterId = 'retro' }) {
  const fd = new FormData();
  fd.set('uuid', user);
  fd.set('filterId', withFilter ? filterId : 'none');
  fd.set('takenWithFilter', withFilter ? '1' : '0');
  fd.set('original', new Blob([JPEG], { type: 'image/jpeg' }), 'original.jpg');
  if (withFilter) fd.set('filtered', new Blob([JPEG], { type: 'image/jpeg' }), 'filtered.jpg');
  return fd;
}

function countZipEntries(buf) {
  let count = 0;
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) count++;
  }
  return count;
}

async function main() {
  await waitForServer();

  console.log('\n— Static & Landing —');
  const landing = await fetch(BASE + '/');
  check('Landing liefert HTML', landing.ok && (await landing.text()).includes('ThrowToStay'));

  console.log('\n— Admin: Login & Event-Verwaltung —');
  const badLogin = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'falsch' }),
  });
  check('Falsches Admin-Passwort → 401', badLogin.status === 401);

  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pw' }),
  });
  check('Admin-Login OK', login.ok);
  const { token } = await login.json();
  const auth = { Authorization: 'Bearer ' + token };

  const noAuth = await fetch(BASE + '/api/admin/events');
  check('Admin-API ohne Token → 401', noAuth.status === 401);

  const today = new Date().toISOString().slice(0, 10);
  const createRes = await fetch(BASE + '/api/admin/events', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Testevent', eventDate: today, maxPhotosPerUser: 30 }),
  });
  check('Event anlegen OK (201)', createRes.status === 201);
  const { event } = await createRes.json();
  check('Event hat 10-stellige Session-ID', /^[0-9A-HJKMNP-TV-Z]{10}$/.test(event.sessionId), event.sessionId);
  const unlockDate = new Date(event.galleryUnlockAt);
  const tomorrow = new Date(Date.now() + 864e5);
  check('Freigabe = Folgetag 08:00 Uhr (lokale Zeit)',
    unlockDate.getHours() === 8 && unlockDate.toDateString() === tomorrow.toDateString(), event.galleryUnlockAt);

  const eventsList = await fetch(BASE + '/api/admin/events', { headers: auth });
  const eventsData = await eventsList.json();
  check('Eventliste enthält Event', eventsData.events.some(e => e.id === event.id));

  const qr = await fetch(BASE + `/api/admin/events/${event.id}/qr.png?token=${encodeURIComponent(token)}`);
  const qrBuf = Buffer.from(await qr.arrayBuffer());
  check('QR-Code PNG ausgeliefert', qr.ok && qrBuf.length > 100 && qrBuf[0] === 0x89 && qrBuf[1] === 0x50);

  console.log('\n— Event-App: State & Registrierung —');
  const eventPage = await fetch(BASE + `/e/${event.sessionId}`);
  check('Event-URL liefert Kamera-App', eventPage.ok && (await eventPage.text()).includes('shutterBtn'));

  const stateAnon = await fetch(BASE + `/api/e/${event.sessionId}/state`);
  const stateAnonData = await stateAnon.json();
  check('State ohne UUID: Event sichtbar, kein User', stateAnonData.event.name === 'Testevent' && stateAnonData.user === null);

  const userA = uuid();
  const reg = await fetch(BASE + `/api/e/${event.sessionId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: userA, firstName: 'Lena', lastName: 'Musterfrau' }),
  });
  const regData = await reg.json();
  check('Registrierung User A OK', reg.ok && regData.user.firstName === 'Lena' && regData.user.photoCount === 0);

  const badReg = await fetch(BASE + `/api/e/${event.sessionId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: 'kein-uuid', firstName: 'X', lastName: 'Y' }),
  });
  check('Ungültige UUID → 400', badReg.status === 400);

  console.log('\n— Foto-Upload & Varianten —');
  async function uploadPhoto(u, { withFilter }) {
    const fd = new FormData();
    fd.set('uuid', u);
    fd.set('filterId', withFilter ? 'retro' : 'none');
    fd.set('takenWithFilter', withFilter ? '1' : '0');
    fd.set('original', new Blob([JPEG], { type: 'image/jpeg' }), 'original.jpg');
    if (withFilter) fd.set('filtered', new Blob([JPEG], { type: 'image/jpeg' }), 'filtered.jpg');
    return fetch(BASE + `/api/e/${event.sessionId}/photos`, { method: 'POST', body: fd });
  }

  const p1Res = await uploadPhoto(userA, { withFilter: false });
  const p1Data = await p1Res.json();
  check('Upload ohne Filter OK (201)', p1Res.status === 201);
  check('Foto 1: takenWithFilter=false, keine gefilterte Variante', p1Data.photo.takenWithFilter === false && p1Data.photo.hasFiltered === false);
  check('Zähler steigt', p1Data.photoCount === 1);

  const p2Res = await uploadPhoto(userA, { withFilter: true });
  const p2Data = await p2Res.json();
  check('Upload mit Filter OK (beide Varianten)', p2Res.ok && p2Data.photo.hasFiltered === true && p2Data.photo.takenWithFilter === true);

  const filesOnDisk = readdirSync(path.join(DATA_DIR, 'photos', event.sessionId, userA));
  check('Dateien liegen im UUID-Ordner auf dem Server (3 Dateien)', filesOnDisk.length === 3, JSON.stringify(filesOnDisk));

  console.log('\n— Galerie-Sperre vor Freigabe —');
  const userB = uuid();
  await fetch(BASE + `/api/e/${event.sessionId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: userB, firstName: 'Ben', lastName: 'Anderer' }),
  });
  const pBRes = await uploadPhoto(userB, { withFilter: false });
  check('Upload von User B OK', pBRes.ok);

  const listLockedA = await (await fetch(BASE + `/api/e/${event.sessionId}/photos?uuid=${userA}`)).json();
  check('User A sieht vor Freigabe nur eigene Fotos', listLockedA.galleryUnlocked === false && listLockedA.photos.length === 2 && listLockedA.photos.every(p => p.mine));

  const foreignFile = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listLockedA.photos[0].id}/file?uuid=${userB}`);
  check('Fremdes Foto vor Freigabe → 403', foreignFile.status === 403);

  const ownFile = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listLockedA.photos[0].id}/file?uuid=${userA}&variant=original`);
  check('Eigenes Foto vor Freigabe abrufbar', ownFile.status === 200);

  console.log('\n— Nachträglicher Filter (Re-Filter) —');
  const refilterFd = new FormData();
  refilterFd.set('uuid', userA);
  refilterFd.set('filterId', 'bw');
  refilterFd.set('filtered', new Blob([JPEG], { type: 'image/jpeg' }), 'filtered.jpg');
  const refilterRes = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listLockedA.photos[0].id}/refilter`, { method: 'POST', body: refilterFd });
  const refilterData = await refilterRes.json();
  check('Re-Filter durch Besitzer OK', refilterRes.ok && refilterData.photo.hasFiltered === true && refilterData.photo.filterId === 'bw');

  const foreignFd = new FormData();
  foreignFd.set('uuid', userB);
  foreignFd.set('filterId', 'none');
  const refilterForeign = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listLockedA.photos[0].id}/refilter`, { method: 'POST', body: foreignFd });
  check('Re-Filter durch Fremden → 403', refilterForeign.status === 403);

  const removeFd = new FormData();
  removeFd.set('uuid', userA);
  removeFd.set('filterId', 'none');
  const removeRes = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listLockedA.photos[0].id}/refilter`, { method: 'POST', body: removeFd });
  const removeData = await removeRes.json();
  check('Gefilterte Variante entfernen OK', removeRes.ok && removeData.photo.hasFiltered === false);

  console.log('\n— Foto-Limit (konfigurierbar) —');
  const patch = await fetch(BASE + `/api/admin/events/${event.id}`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxPhotosPerUser: 2 }),
  });
  check('Limit per Admin auf 2 setzen', patch.ok);

  const overflowA = await uploadPhoto(userA, { withFilter: false });
  check('Upload über Limit (User A hat 2/2) → 409', overflowA.status === 409);
  const withinB = await uploadPhoto(userB, { withFilter: false });
  check('Limit zählt pro User: B hat erst 1/2 → 201', withinB.status === 201);
  const overflowB = await uploadPhoto(userB, { withFilter: false });
  check('Upload über Limit (User B jetzt 2/2) → 409', overflowB.status === 409);

  console.log('\n— Galerie-Freigabe & Sammel-Download —');
  const unlock = await fetch(BASE + `/api/admin/events/${event.id}`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ galleryUnlockAt: 'now' }),
  });
  check('Freigabe per Admin ("now") OK', unlock.ok);

  const listUnlocked = await (await fetch(BASE + `/api/e/${event.sessionId}/photos?uuid=${userA}`)).json();
  check('Nach Freigabe sieht User A alle 4 Fotos (A+B)', listUnlocked.galleryUnlocked === true && listUnlocked.photos.length === 4);
  check('Fremde Fotos sind als nicht-eigen markiert', listUnlocked.photos.some(p => !p.mine));

  const foreignFileAfter = await fetch(BASE + `/api/e/${event.sessionId}/photos/${listUnlocked.photos.find(p => !p.mine).id}/file?uuid=${userA}`);
  check('Fremdes Foto nach Freigabe abrufbar', foreignFileAfter.status === 200);

  const dlRes = await fetch(BASE + `/api/e/${event.sessionId}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uuid: userA,
      items: [
        { photoId: listUnlocked.photos[0].id, variant: 'original' },
        { photoId: listUnlocked.photos[1].id, variant: 'filtered' },
        { photoId: listUnlocked.photos[2].id, variant: 'original' },
      ],
    }),
  });
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  check('Sammel-Download als ZIP', dlRes.ok && dlBuf.slice(0, 4).toString('latin1') === 'PK\x03\x04' && dlBuf.length > 500);
  check('Content-Disposition gesetzt', /attachment; filename=/.test(dlRes.headers.get('content-disposition') || ''));
  check('ZIP enthält 3 Fotos + manifest.csv (4 Einträge)', countZipEntries(dlBuf) === 4, `gefunden: ${countZipEntries(dlBuf)}`);

  console.log('\n— Admin-Export —');
  const exportRes = await fetch(BASE + `/api/admin/events/${event.id}/export.zip`, { headers: auth });
  const exportBuf = Buffer.from(await exportRes.arrayBuffer());
  check('Admin-Export ZIP OK (Fotos + manifest + users)', exportRes.ok && countZipEntries(exportBuf) >= 5, `gefunden: ${countZipEntries(exportBuf)}`);

  console.log('\n— Bildkomprimierung konfigurierbar (Issue 1) —');
  const patchImg = await fetch(BASE + `/api/admin/events/${event.id}`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxImageSide: 2048, jpegQuality: 88 }),
  });
  const patchedImg = (await patchImg.json()).event;
  check('Auflösung & JPEG-Qualität per Admin einstellbar', patchImg.ok && patchedImg.maxImageSide === 2048 && patchedImg.jpegQuality === 88);
  const stateQ = await (await fetch(BASE + `/api/e/${event.sessionId}/state`)).json();
  check('Gast-State enthält Bildeinstellungen', stateQ.event.maxImageSide === 2048 && stateQ.event.jpegQuality === 88);
  const badImg = await fetch(BASE + `/api/admin/events/${event.id}`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jpegQuality: 10 }),
  });
  const badImgData = await badImg.json();
  check('JPEG-Qualität wird auf Minimum 50% begrenzt', badImg.ok && badImgData.event.jpegQuality === 50);

  console.log('\n— Rollen: Veranstalter-Keys (Issue 2) —');
  const keyRes = await fetch(BASE + '/api/admin/keys', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'SV Test' }),
  });
  const { key: accessKey } = await keyRes.json();
  check('Admin generiert Zugangs-Schlüssel', keyRes.status === 201 && /^TTS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(accessKey.key), accessKey.key);

  const orgLogin = await fetch(BASE + '/api/organizer/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey.key.toLowerCase() }),
  });
  const orgData = await orgLogin.json();
  check('Veranstalter-Login mit Schlüssel (Groß-/Kleinschreibung egal)', orgLogin.ok && !!orgData.token);
  const orgAuth = { Authorization: 'Bearer ' + orgData.token };

  const badKeyLogin = await fetch(BASE + '/api/organizer/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'TTS-0000-0000' }),
  });
  check('Unbekannter Schlüssel → 401', badKeyLogin.status === 401);

  const orgCreate = await fetch(BASE + '/api/organizer/events', {
    method: 'POST', headers: { ...orgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Org-Event', eventDate: today, maxPhotosPerUser: 5, maxImageSide: 2400, jpegQuality: 95 }),
  });
  const { event: orgEvent } = await orgCreate.json();
  check('Veranstalter kann Event mit Bildeinstellungen anlegen', orgCreate.status === 201 && orgEvent.maxImageSide === 2400 && orgEvent.jpegQuality === 95);

  const orgList = await (await fetch(BASE + '/api/organizer/events', { headers: orgAuth })).json();
  check('Veranstalter sieht nur eigene Events', orgList.events.length === 1 && orgList.events[0].id === orgEvent.id);

  const adminList2 = await (await fetch(BASE + '/api/admin/events', { headers: auth })).json();
  check('Admin sieht alle Events inkl. Ersteller-Bezeichnung',
    adminList2.events.some(e => e.id === orgEvent.id && e.createdByLabel === 'SV Test') &&
    adminList2.events.some(e => e.id === event.id && !e.createdByLabel));

  const orgPatchForeign = await fetch(BASE + `/api/organizer/events/${event.id}`, {
    method: 'PATCH', headers: { ...orgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gehackt' }),
  });
  check('Veranstalter kann fremdes Event nicht ändern → 404', orgPatchForeign.status === 404);

  const orgTryAdmin = await fetch(BASE + '/api/admin/events', { headers: orgAuth });
  check('Veranstalter-Token gilt nicht für Admin-API → 401', orgTryAdmin.status === 401);

  const orgQr = await fetch(BASE + `/api/organizer/events/${orgEvent.id}/qr.png?token=${encodeURIComponent(orgData.token)}`);
  check('Veranstalter-QR-Code auslieferbar (?token=)', orgQr.ok && (await orgQr.arrayBuffer()).byteLength > 100);

  const revokeRes = await fetch(BASE + `/api/admin/keys/${accessKey.id}`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revoked: true }),
  });
  check('Schlüssel sperren', revokeRes.ok);

  const orgLoginRevoked = await fetch(BASE + '/api/organizer/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey.key }),
  });
  check('Gesperrter Schlüssel → Login 401', orgLoginRevoked.status === 401);
  const orgEventsRevoked = await fetch(BASE + '/api/organizer/events', { headers: orgAuth });
  check('Gesperrter Schlüssel → bestehender Token abgelehnt', orgEventsRevoked.status === 401);

  console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(err => { console.error(err); failed++; })
  .finally(() => {
    server.kill();
    setTimeout(() => {
      try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(failed > 0 ? 1 : 0);
    }, 300);
  });