'use strict';

/**
 * Restore-Test für ThrowToStay:
 *   1) Daten via API erzeugen (Event + User + 1 Foto).
 *   2) Backup mit scripts/backup.mjs erzeugen.
 *   3) Backup auf ein SAUBERES Datenverzeichnis zurückspielen
 *      (simuliert: frischer Server nach Datenverlust).
 *   4) App mit den restaurierten Daten starten und prüfen, dass Event,
 *      Foto-Zähler und Foto-Datei wieder vorhanden + korrekt sind.
 *
 * Beweist damit, dass ein Backup nicht nur erzeugt wird, sondern *nutzbar* ist.
 * Ausführen: node test/restore.mjs   (oder: npm run test:restore)
 */

import { spawn, spawnSync } from 'node:child_process';
import { rmSync, copyFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = path.join(root, 'data-restore-src');
const BAK_DIR = path.join(root, 'data-restore-bak');
const RESTORE_DIR = path.join(root, 'data-restore-out');
const PORT1 = 3744;
const PORT2 = 3745;
const BASE1 = `http://127.0.0.1:${PORT1}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const ADMIN_PASSWORD = 'test-pw';

// 1x1-Test-JPEG
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64'
);

for (const d of [SRC_DIR, BAK_DIR, RESTORE_DIR]) rmSync(d, { recursive: true, force: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

function startServer(dataDir, port) {
  return spawn(process.execPath, [path.join(root, 'src/server.js')], {
    env: { ...process.env, TTS_PORT: String(port), TTS_DATA_DIR: dataDir, ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitFor(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/'); if (r.status < 500) return; } catch { /* noch nicht bereit */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server nicht gestartet');
}

let server = null;
try {
  // ------------------------------------------------ 1) Daten erzeugen
  console.log('\n— 1) Daten erzeugen (Server 1) —');
  server = startServer(SRC_DIR, PORT1);
  await waitFor(BASE1);
  const login = await (await fetch(BASE1 + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })).json();
  const auth = { Authorization: `Bearer ${login.token}` };
  const evRes = await fetch(BASE1 + '/api/admin/events', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Restore', eventDate: new Date().toISOString().slice(0, 10), maxPhotosPerUser: 10 }),
  });
  const { event } = await evRes.json();
  const userUuid = crypto.randomUUID();
  await fetch(BASE1 + `/api/e/${event.sessionId}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: userUuid, firstName: 'Ro', lastName: 'Stor' }),
  });
  const fd = new FormData();
  fd.set('uuid', userUuid);
  fd.set('filterId', 'none');
  fd.set('takenWithFilter', '0');
  fd.set('original', new Blob([JPEG], { type: 'image/jpeg' }), 'original.jpg');
  const up = await fetch(BASE1 + `/api/e/${event.sessionId}/photos`, { method: 'POST', body: fd });
  check('Setup: 1 Foto hochgeladen (201)', up.status === 201);
  server.kill();
  await new Promise(r => setTimeout(r, 600)); // sauber herunterfahren (WAL → DB)

  // ------------------------------------------------ 2) Backup
  console.log('\n— 2) Backup erzeugen —');
  const bak = spawnSync(process.execPath, [path.join(root, 'scripts/backup.mjs')], {
    env: { ...process.env, TTS_DATA_DIR: SRC_DIR, TTS_BACKUP_DIR: BAK_DIR, TTS_BACKUP_KEEP: '7' },
    encoding: 'utf8',
  });
  check('Backup läuft (Exit 0)', bak.status === 0, (bak.stderr || '').slice(0, 300));
  const backups = readdirSync(BAK_DIR).filter(f => f.startsWith('tts-backup-')).sort();
  check('Backup vorhanden (1)', backups.length === 1, backups.join(', '));
  const bakDb = path.join(BAK_DIR, backups[0], 'throwtostay.db');
  const bakPhotos = path.join(BAK_DIR, backups[0], 'photos');

  // ------------------------------------------------ 3) Restore auf sauberes Verzeichnis
  console.log('\n— 3) Restore auf sauberes Datenverzeichnis —');
  mkdirSync(RESTORE_DIR, { recursive: true });
  copyFileSync(bakDb, path.join(RESTORE_DIR, 'throwtostay.db'));
  cpSync(bakPhotos, path.join(RESTORE_DIR, 'photos'), { recursive: true });
  mkdirSync(path.join(RESTORE_DIR, 'tmp'), { recursive: true });
  const restoredFile = path.join(RESTORE_DIR, 'photos', event.sessionId, userUuid);
  check('Restore: Foto-Datei kopiert', (() => { try { return readdirSync(restoredFile).length === 1; } catch { return false; } })());

  // ------------------------------------------------ 4) App mit restaurierten Daten
  console.log('\n— 4) App mit restaurierten Daten (Server 2) —');
  server = startServer(RESTORE_DIR, PORT2);
  await waitFor(BASE2);
  const login2 = await (await fetch(BASE2 + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })).json();
  const auth2 = { Authorization: `Bearer ${login2.token}` };
  const evList = await (await fetch(BASE2 + '/api/admin/events', { headers: auth2 })).json();
  check('Restore: Event vorhanden (1)', evList.events.length === 1, `gefunden: ${evList.events.length}`);
  const state = await (await fetch(`${BASE2}/api/e/${event.sessionId}/state?uuid=${userUuid}`)).json();
  check('Restore: Foto-Zähler = 1', state.user && state.user.photoCount === 1, `count=${state.user && state.user.photoCount}`);

  // Photo-ID + Dateiname direkt aus der restaurierten DB lesen.
  const rdb = new DatabaseSync(path.join(RESTORE_DIR, 'throwtostay.db'));
  const photoRow = rdb.prepare('SELECT id, original_file FROM photos').all()[0];
  rdb.close();
  check('Restore: DB-Zeile für Foto vorhanden', !!photoRow && !!photoRow.original_file);
  if (photoRow) {
    const fileRes = await fetch(`${BASE2}/api/e/${event.sessionId}/photos/${photoRow.id}/file?variant=original&uuid=${userUuid}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    check('Restore: Foto-Datei abrufbar (200, korrekte Bytes)', fileRes.ok && buf.equals(JPEG), `bytes=${buf.length}, erwartet=${JPEG.length}`);
  } else {
    check('Restore: Foto-Datei abrufbar', false, 'keine DB-Zeile');
  }
} catch (err) {
  check('Restore-Test lief durch', false, err.stack || err.message);
} finally {
  if (server) server.kill();
  for (const d of [SRC_DIR, BAK_DIR, RESTORE_DIR]) rmSync(d, { recursive: true, force: true });
}

console.log(`\nRestore-Test: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exitCode = 1;
