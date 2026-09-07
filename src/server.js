'use strict';

/**
 * ThrowToStay – Server für Event-Fotos.
 *
 * Start:        npm start            (HTTP, Standard-Port 3742)
 * HTTPS-Start:  npm run start:https  (Selbstsigniertes Zertifikat wird automatisch
 *                                    erzeugt – nötig, damit Smartphones per QR-Code
 *                                    die Kamera nutzen dürfen, da getUserMedia
 *                                    nur unter HTTPS/localhost verfügbar ist.)
 *
 * Umgebungsvariablen:
 *   TTS_PORT          Port (Standard 3742)
 *   TTS_DATA_DIR      Datenverzeichnis (Standard ./data)
 *   ADMIN_PASSWORD    Admin-Passwort (PFLICHT, kein Standard – Server startet sonst nicht)
 *   TTS_HTTPS         "1" oder Start-Argument --https für HTTPS
 *
 *   WICHTIG: ADMIN_PASSWORD MUSS gesetzt sein (kein Standard-Passwort mehr).
 *   Ohne die Variable startet der Server NICHT (Fail-Fast).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const express = require('express');
const { openDb } = require('./db');
const util = require('./util');
const { createPublicRouter } = require('./routes/public');
const { createAdminRouter } = require('./routes/admin');
const { createOrganizerRouter } = require('./routes/organizer');
const { purgeExpiredEvents, sweepOrphans } = require('./routes/event-helpers');

// ------------------------------------------------------------ Konfiguration

const PORT = parseInt(process.env.TTS_PORT, 10) || 3742;
const DATA_DIR = path.resolve(process.env.TTS_DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const USE_HTTPS = process.env.TTS_HTTPS === '1' || process.argv.includes('--https');

// Sicherheit: kein Standard-Passwort. In Production MUSS ADMIN_PASSWORD explizit
// gesetzt sein (Systemd-Service, .env oder Export). Sonst startet der Server nicht.
if (!process.env.ADMIN_PASSWORD) {
  console.error(
    'FEHLER: Die Umgebungsvariable ADMIN_PASSWORD ist nicht gesetzt.\n'
    + 'Setze sie auf ein starkes, eindeutiges Passwort, z. B.:\n'
    + '  export ADMIN_PASSWORD=***\n'
    + '(Systemd: Environment=ADMIN_PASSWORD=*** / .env-Datei).\n'
    + 'Ein Standard-Passwort wird aus Sicherheitsgründen NICHT verwendet.'
  );
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ------------------------------------------------------------ Datenbank

const db = openDb(DATA_DIR);
const adminSecret = util.loadOrCreateAdminSecret(DATA_DIR);

// ------------------------------------------------------------ Express-App

const app = express();
// trust proxy nur für das konkrete Zoraxy-Gateway (10.12.95.250): X-Forwarded-*
// wird nur von diesem Peer akzeptiert – von außen ist XFF-Spoofing unmöglich,
// und der Login-Rate-Limit-Key (req.ip) kann nicht mehr per XFF gedreht werden.
app.set('trust proxy', '10.12.95.250');
app.disable('x-powered-by');

// ------------------------------------------------------------ Security-Header
// Clickjacking (X-Frame-Options + CSP frame-ancestors), MIME-Sniffing, Referrer,
// Kamera nur im eigenen Kontext. CSP ist auf die App abgestimmt: keine
// Inline-Scripts (nur externe /js/*.js), Fonts lokal self-gehostet (/fonts/),
// blob:/data: für Kamera-Canvas.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

app.use('/api/admin', createAdminRouter({ db, dataDir: DATA_DIR, adminSecret, adminPassword: ADMIN_PASSWORD }));
app.use('/api/organizer', createOrganizerRouter({ db, dataDir: DATA_DIR, adminSecret }));
app.use('/api/e', createPublicRouter({ db, dataDir: DATA_DIR }));

// Frontend-Dateien (HTML/JS/CSS) nie im Browser cachen: Nach UI-Änderungen muss
// sofort die neue Version greifen – sonst trifft gecachtes altes JS auf die neue
// HTML-Seite und die App bricht ab. (API- und Foto-Dateien dürfen gecacht werden.)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-cache');
  next();
});

// Start-Seite: direkt zum Veranstalter-Login (User-Login), nicht zum Admin.
app.get('/', (req, res) => {
  res.redirect('/organizer');
});

// Statische Frontend-Dateien
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// /e/<sessionId> → Kamera-App der Veranstaltung
app.get('/e/:sessionId', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'event.html'));
});

// /admin → Admin-Panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// /organizer → Veranstalter-Panel (Login mit Admin-generiertem Schlüssel)
app.get('/organizer', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'organizer.html'));
});

// JSON-Fehlerhandler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  // Multer-Fehler (Upload zu groß, zu viele Dateien etc.) sind Client-Fehler.
  if (err && err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  }
  if (status >= 500) {
    // Nur serverseitig loggen; interne Details (Dateipfade, SQL, Stack) niemals
    // ans Client liefern.
    console.error(err);
    return res.status(500).json({ error: 'Interner Serverfehler. Bitte später erneut versuchen.' });
  }
  // 4xx: App-Meldung ist kontrolliert und client-tauglich (Multer-Fehler übersetzen).
  const message = err && err.name === 'MulterError'
    ? 'Upload abgelehnt (Datei zu groß oder ungültig).'
    : (err && err.message) || 'Fehler.';
  res.status(status).json({ error: message });
});

// ------------------------------------------------------------ HTTPS (optional)

function ensureSelfSignedCert(dir) {
  const certFile = path.join(dir, 'selfsigned.crt');
  const keyFile = path.join(dir, 'selfsigned.key');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return { certFile, keyFile };
  const cn = 'ThrowToStay';
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-subj', `/CN=${cn}`,
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  console.log('Selbstsigniertes Zertifikat erzeugt:', certFile);
  return { certFile, keyFile };
}

// ------------------------------------------------------------ DSGVO-Retention
// Hintergrund-Job (stündlich): löscht Events, deren Speicherdauer abgelaufen ist
// (Event-Datum + retention_days). Nur bei retention_days > 0 (0 = manuell).
// Ein Fehler bricht den Server NICHT ab – er wird protokolliert und beim
// nächsten Lauf erneut versucht.
const RETENTION_CHECK_MS = 60 * 60 * 1000; // stündlich
const purgeTimer = setInterval(() => {
  purgeExpiredEvents(db, DATA_DIR)
    .then(n => { if (n > 0) console.log(`Retention: ${n} Event(s) automatisch gelöscht.`); })
    .catch(err => console.error('Retention-Job fehlgeschlagen:', err.message));
}, RETENTION_CHECK_MS);
purgeTimer.unref();
// Einmalig beim Start, damit abgelaufene Events auch nach Neustart weg sind.
purgeExpiredEvents(db, DATA_DIR)
  .then(n => { if (n > 0) console.log(`Retention: ${n} Event(s) beim Start automatisch gelöscht.`); })
  .catch(err => console.error('Retention-Job (Start) fehlgeschlagen:', err.message));

// Datenkonsistenz beim Start: verwaiste Dateien (z. B. nach einem Crash)
// entfernen, bevor der Server Requests annimmt (keine Race-Kondition).
sweepOrphans(db, DATA_DIR)
  .then(n => { if (n > 0) console.log(`Konsistenz: ${n} verwaiste Datei(en) beim Start entfernt.`); })
  .catch(err => console.error('Konsistenz-Sweep (Start) fehlgeschlagen:', err.message));

// ------------------------------------------------------------ Start

if (USE_HTTPS) {
  const { certFile, keyFile } = ensureSelfSignedCert(DATA_DIR);
  const server = https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    app
  );
  server.listen(PORT, () => {
    console.log(`ThrowToStay läuft per HTTPS auf https://localhost:${PORT} (Daten: ${DATA_DIR})`);
    console.log('Hinweis: Bei selbstsigniertem Zertifikat zeigt das Handy eine Warnung – einmal bestätigen.');
  });
} else {
  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`ThrowToStay läuft auf http://localhost:${PORT} (Daten: ${DATA_DIR})`);
    console.log('Für die Kamera auf Smartphones (QR-Zugang) HTTPS verwenden: npm run start:https');
  });
}