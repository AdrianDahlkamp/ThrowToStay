'use strict';

/**
 * ThrowToStay – Event-Fotobox-Server.
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
 *   ADMIN_PASSWORD    Admin-Passwort (Standard "throwtostay-admin" – unbedingt ändern!)
 *   TTS_HTTPS         "1" oder Start-Argument --https für HTTPS
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

// ------------------------------------------------------------ Konfiguration

const PORT = parseInt(process.env.TTS_PORT, 10) || 3742;
const DATA_DIR = path.resolve(process.env.TTS_DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'throwtostay-admin';
const USE_HTTPS = process.env.TTS_HTTPS === '1' || process.argv.includes('--https');

if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNUNG: ADMIN_PASSWORD ist nicht gesetzt – es wird das Standard-Passwort verwendet.');
}

// ------------------------------------------------------------ Datenbank

const db = openDb(DATA_DIR);
const adminSecret = util.loadOrCreateAdminSecret(DATA_DIR);

// ------------------------------------------------------------ Express-App

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

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
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Interner Serverfehler.' });
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