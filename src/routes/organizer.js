'use strict';

/**
 * Veranstalter-API ("User"-Rolle): Veranstalter erhalten vom Admin einen
 * Zugangs-Schlüssel (z. B. "TTS-4F9K-M2QX") und können damit eigene Events
 * anlegen und verwalten – ohne Admin-Rechte (keine Key-Verwaltung, keine
 * fremden Events).
 *
 * Auth: Login mit Schlüssel → HMAC-Session-Token (Bearer-Header oder ?token=).
 */

const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const archiver = require('archiver');
const util = require('../util');
const helpers = require('./event-helpers');

function createOrganizerRouter({ db, dataDir, adminSecret }) {
  const router = express.Router();
  const photosRoot = path.join(dataDir, 'photos');

  // ------------------------------------------------------------- Auth

  function tokenFromReq(req) {
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return req.query.token;
  }

  /** Token verifizieren und zugehörigen Key laden (null = ungültig). */
  function authenticate(token) {
    const keyId = util.verifyOrganizerToken(adminSecret, token);
    if (!keyId) return null;
    const k = db.prepare('SELECT * FROM user_keys WHERE id = ?').get(keyId);
    if (!k || k.revoked) return null;
    return k;
  }

  // Rate-Limit für Login-Fehlversuche (Brute-Force-Schutz, Parität mit dem
  // Admin-Login). Schlüssel sind 8 Zeichen aus 20 Buchstaben (≈ 25 Mrd.) und
  // damit praktisch nicht zu raten – der Limiter ist Defense-in-Depth.
  const loginLimiter = util.createLoginRateLimiter();

  router.post('/login', express.json(), (req, res) => {
    const ip = req.ip || 'unbekannt';
    const blk = loginLimiter.isBlocked(ip);
    if (blk.blocked) {
      return res.status(429).json({ error: `Zu viele Fehlversuche – bitte ${blk.waitSecs} Sekunden warten.` });
    }
    const raw = String((req.body || {}).key || '').trim().toUpperCase();
    if (!raw) return res.status(400).json({ error: 'Bitte einen Schlüssel eingeben.' });
    const k = db.prepare('SELECT * FROM user_keys WHERE key = ?').get(raw);
    if (!k) {
      loginLimiter.recordFail(ip);
      return res.status(401).json({ error: 'Unbekannter Schlüssel.' });
    }
    if (k.revoked) {
      loginLimiter.recordFail(ip);
      return res.status(401).json({ error: 'Dieser Schlüssel wurde gesperrt.' });
    }
    loginLimiter.reset(ip);
    res.json({
      token: util.createOrganizerToken(adminSecret, k.id),
      organizer: { label: k.label },
    });
  });

  function requireOrganizer(req, res, next) {
    const k = authenticate(tokenFromReq(req));
    if (!k) return res.status(401).json({ error: 'Nicht angemeldet oder Schlüssel gesperrt.' });
    req.organizerKey = k;
    next();
  }

  router.use(requireOrganizer);

  /** Eigenes Event laden (404/403 bei fremdem Event). */
  function ownEvent(req) {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e || e.created_by !== req.organizerKey.id) return null;
    return e;
  }

  // ------------------------------------------------------------- Events

  router.get('/events', (req, res) => {
    res.json({ events: helpers.listEventsFor(db, req.organizerKey.id).map(helpers.eventToJson) });
  });

  router.post('/events', express.json(), (req, res) => {
    try {
      const e = helpers.createEvent(db, req.body, req.organizerKey.id);
      res.status(201).json({ event: helpers.eventToJson(e) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch('/events/:id', express.json(), (req, res) => {
    const e = ownEvent(req);
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
      const e = ownEvent(req);
      if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
      await helpers.deleteEventCascade(db, dataDir, e);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------- Sonstiges

  router.get('/events/:id/users', (req, res) => {
    const e = ownEvent(req);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
    const rows = db.prepare(
      `SELECT u.first_name, u.last_name, u.created_at, COUNT(p.id) AS photo_count
       FROM users u LEFT JOIN photos p ON p.user_id = u.id
       WHERE u.event_id = ?
       GROUP BY u.id ORDER BY u.created_at ASC`
    ).all(e.id);
    res.json({
      users: rows.map(r => ({
        firstName: r.first_name,
        lastName: r.last_name,
        photoCount: r.photo_count,
        registeredAt: r.created_at,
      })),
    });
  });

  router.get('/events/:id/qr.png', async (req, res, next) => {
    try {
      const e = ownEvent(req);
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

  router.get('/events/:id/export.zip', async (req, res, next) => {
    try {
      const e = ownEvent(req);
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

module.exports = { createOrganizerRouter };