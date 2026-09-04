'use strict';

/**
 * Admin-API: Events anlegen/verwalten, Zugangs-Schlüssel für Veranstalter
 * generieren, QR-Codes erzeugen, Limits und Bildkomprimierung konfigurieren,
 * Galerie-Freigabe steuern, Teilnehmer einsehen und alles exportieren.
 *
 * Auth: Passwort (ENV ADMIN_PASSWORD) gegen einen HMAC-Session-Token,
 * der als Bearer-Header ODER als ?token=-Parameter (für <img>/QR) akzeptiert wird.
 */

const express = require('express');
const path = require('path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const archiver = require('archiver');
const util = require('../util');
const helpers = require('./event-helpers');

function createAdminRouter({ db, dataDir, adminSecret, adminPassword }) {
  const router = express.Router();
  const photosRoot = path.join(dataDir, 'photos');

  // ------------------------------------------------------------- Auth-Check

  function tokenFromReq(req) {
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return req.query.token;
  }

  function requireAdmin(req, res, next) {
    if (util.verifyAdminToken(adminSecret, tokenFromReq(req))) return next();
    res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  // Zeitlich sicherer Passwortvergleich: beide Seiten mit SHA-256 auf fixe
  // Länge (32 B) bringen und constant-time vergleichen (kein Timing-Leak).
  function passwordMatches(input, expected) {
    const a = crypto.createHash('sha256').update(String(input)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // Mini-Rate-Limit für Login-Fehlversuche (Brute-Force-Schutz, geteilter
  // Helfer aus util.js; räumt inaktive IP-Einträge selbst auf).
  const loginLimiter = util.createLoginRateLimiter();

  router.post('/login', express.json(), (req, res) => {
    const ip = req.ip || 'unbekannt';
    const blk = loginLimiter.isBlocked(ip);
    if (blk.blocked) {
      return res.status(429).json({ error: `Zu viele Fehlversuche – bitte ${blk.waitSecs} Sekunden warten.` });
    }
    // Whitespace (z. B. aus Passwort-Managern/Clipboard) nicht mitzählen.
    const password = String((req.body || {}).password || '').trim();
    if (!passwordMatches(password, adminPassword)) {
      const r = loginLimiter.recordFail(ip);
      if (r.blocked) {
        return res.status(429).json({ error: 'Zu viele Fehlversuche – bitte 30 Sekunden warten.' });
      }
      return res.status(401).json({ error: `Falsches Passwort (noch ${r.remaining} Versuche).` });
    }
    loginLimiter.reset(ip);
    res.json({ token: util.createAdminToken(adminSecret) });
  });

  router.use(requireAdmin);

  // ------------------------------------------------------------- Events

  router.get('/events', (req, res) => {
    res.json({ events: helpers.listEventsFor(db, null).map(helpers.eventToJson) });
  });

  router.post('/events', express.json(), (req, res) => {
    try {
      const e = helpers.createEvent(db, req.body, null);
      res.status(201).json({ event: helpers.eventToJson(e) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch('/events/:id', express.json(), (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
    try {
      const updated = helpers.updateEventFields(db, e, req.body);
      res.json({ event: helpers.eventToJson(updated) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete('/events/:id', async (req, res, next) => {
    try {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
      await helpers.deleteEventCascade(db, dataDir, e);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------- Veranstalter-Keys

  router.get('/keys', (req, res) => {
    const rows = db.prepare(
      `SELECT k.*,
              (SELECT COUNT(*) FROM events e WHERE e.created_by = k.id) AS event_count
       FROM user_keys k ORDER BY k.created_at DESC`
    ).all();
    res.json({
      keys: rows.map(r => ({
        id: r.id,
        key: r.key,
        label: r.label,
        revoked: !!r.revoked,
        createdAt: r.created_at,
        eventCount: r.event_count,
      })),
    });
  });

  router.post('/keys', express.json(), (req, res) => {
    const label = String((req.body || {}).label || '').trim().slice(0, 60);
    const id = util.generateId();
    const key = util.generateAccessKey();
    const createdAt = util.nowIso();
    db.prepare('INSERT INTO user_keys (id, key, label, revoked, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(id, key, label, createdAt);
    res.status(201).json({ key: { id, key, label, revoked: false, createdAt, eventCount: 0 } });
  });

  router.patch('/keys/:id', express.json(), (req, res) => {
    const k = db.prepare('SELECT * FROM user_keys WHERE id = ?').get(req.params.id);
    if (!k) return res.status(404).json({ error: 'Schlüssel nicht gefunden.' });
    const revoked = (req.body || {}).revoked ? 1 : 0;
    db.prepare('UPDATE user_keys SET revoked = ? WHERE id = ?').run(revoked, k.id);
    res.json({ ok: true, revoked: !!revoked });
  });

  router.delete('/keys/:id', (req, res) => {
    const k = db.prepare('SELECT * FROM user_keys WHERE id = ?').get(req.params.id);
    if (!k) return res.status(404).json({ error: 'Schlüssel nicht gefunden.' });
    const events = db.prepare('SELECT COUNT(*) AS c FROM events WHERE created_by = ?').get(k.id).c;
    if (events > 0) {
      return res.status(409).json({
        error: `Der Schlüssel ist noch ${events} Event(s) zugeordnet. Events löschen oder Schlüssel nur sperren.`,
      });
    }
    db.prepare('DELETE FROM user_keys WHERE id = ?').run(k.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- Sonstiges

  // Teilnehmerliste eines Events.
  router.get('/events/:id/users', (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
    const rows = db.prepare(
      `SELECT u.uuid, u.first_name, u.last_name, u.created_at, COUNT(p.id) AS photo_count
       FROM users u LEFT JOIN photos p ON p.user_id = u.id
       WHERE u.event_id = ?
       GROUP BY u.id ORDER BY u.created_at ASC`
    ).all(e.id);
    res.json({
      users: rows.map(r => ({
        uuid: r.uuid,
        firstName: r.first_name,
        lastName: r.last_name,
        photoCount: r.photo_count,
        registeredAt: r.created_at,
      })),
    });
  });

  // QR-Code mit der Event-URL (z. B. https://host:port/e/SESSIONID).
  router.get('/events/:id/qr.png', async (req, res, next) => {
    try {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
      const origin = `${req.protocol}://${req.get('host')}`;
      const url = `${origin}/e/${e.session_id}`;
      const buf = await QRCode.toBuffer(url, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  // Komplett-Export eines Events: alle Varianten aller Fotos + manifest.csv + users.csv.
  router.get('/events/:id/export.zip', async (req, res, next) => {
    try {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });

      const rows = db.prepare(
        `SELECT p.*, u.uuid, u.first_name, u.last_name
         FROM photos p JOIN users u ON u.id = p.user_id
         WHERE p.event_id = ? ORDER BY p.created_at ASC`
      ).all(e.id);

      const manifest = ['datei;foto-id;uuid;vorname;nachname;aufgenommen;variante;filter'];
      const userRows = db.prepare(
        `SELECT u.uuid, u.first_name, u.last_name, u.created_at,
                (SELECT COUNT(*) FROM photos p WHERE p.user_id = u.id) AS photo_count
         FROM users u WHERE u.event_id = ? ORDER BY u.created_at ASC`
      ).all(e.id);
      const usersCsv = ['uuid;vorname;nachname;registriert-am;fotoanzahl'];
      for (const u of userRows) {
        usersCsv.push([u.uuid, u.first_name, u.last_name, u.created_at, u.photo_count]
          .map(util.csvCell).join(';'));
      }

      const zip = archiver('zip', { zlib: { level: 9 } });
      zip.on('error', err => next(err));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${util.sanitizeFilename(`export-${e.name}-${e.event_date}`, 'export')}.zip"`
      );
      zip.pipe(res);

      let index = 0;
      for (const r of rows) {
        for (const variant of ['original', 'filtered']) {
          const filename = variant === 'filtered' ? r.filtered_file : r.original_file;
          if (!filename || !util.isSafeStoredFilename(filename)) continue;
          const stamp = r.created_at.slice(0, 16).replace(/[:T-]/g, '');
          const entryName = util.sanitizeFilename(
            `${String(++index).padStart(4, '0')}-${r.last_name}-${r.first_name}-${stamp}-${variant}`
          ) + path.extname(filename);
          zip.file(path.join(photosRoot, e.session_id, r.uuid, filename), { name: entryName });
          manifest.push([entryName, r.id, r.uuid, r.first_name, r.last_name, r.created_at, variant, r.filter_id || '-']
            .map(util.csvCell).join(';'));
        }
      }
      zip.append('\uFEFF' + manifest.join('\r\n') + '\r\n', { name: 'manifest.csv' });
      zip.append('\uFEFF' + usersCsv.join('\r\n') + '\r\n', { name: 'users.csv' });
      await zip.finalize();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAdminRouter };