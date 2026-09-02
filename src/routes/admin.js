'use strict';

/**
 * Admin-API: Events anlegen/verwalten, QR-Codes erzeugen, Limits konfigurieren,
 * Galerie-Freigabe steuern, Teilnehmer einsehen und alles exportieren.
 *
 * Auth: Passwort (ENV ADMIN_PASSWORD) gegen einen HMAC-Session-Token,
 * der als Bearer-Header ODER als ?token=-Parameter (für <img>/QR) akzeptiert wird.
 */

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const archiver = require('archiver');
const util = require('../util');

function createAdminRouter({ db, dataDir, adminSecret, adminPassword }) {
  const router = express.Router();
  const photosRoot = path.join(dataDir, 'photos');

  // ------------------------------------------------------------- Auth-Check

  function tokenFromReq(req) {
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return req.query.token;
  }

  // Mini-Rate-Limit für Fehlversuche beim Login.
  const loginFails = new Map(); // ip -> { count, blockedUntil }

  function requireAdmin(req, res, next) {
    if (util.verifyAdminToken(adminSecret, tokenFromReq(req))) return next();
    res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  router.post('/login', express.json(), (req, res) => {
    const ip = req.ip || 'unbekannt';
    const entry = loginFails.get(ip) || { count: 0, blockedUntil: 0 };
    if (Date.now() < entry.blockedUntil) {
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte kurz warten.' });
    }
    const password = String((req.body || {}).password || '');
    if (password !== adminPassword) {
      entry.count += 1;
      if (entry.count >= 5) {
        entry.blockedUntil = Date.now() + 60_000;
        entry.count = 0;
      }
      loginFails.set(ip, entry);
      return res.status(401).json({ error: 'Falsches Passwort.' });
    }
    loginFails.delete(ip);
    res.json({ token: util.createAdminToken(adminSecret) });
  });

  router.use(requireAdmin);

  // ------------------------------------------------------------- Events

  function eventToJson(e) {
    return {
      id: e.id,
      sessionId: e.session_id,
      name: e.name,
      eventDate: e.event_date,
      maxPhotosPerUser: e.max_photos_per_user,
      galleryUnlockAt: e.gallery_unlock_at,
      galleryUnlocked: Date.now() >= Date.parse(e.gallery_unlock_at),
      createdAt: e.created_at,
      userCount: e.user_count,
      photoCount: e.photo_count,
    };
  }

  router.get('/events', (req, res) => {
    const rows = db.prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM users  u WHERE u.event_id = e.id) AS user_count,
              (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count
       FROM events e ORDER BY e.created_at DESC`
    ).all();
    res.json({ events: rows.map(eventToJson) });
  });

  router.post('/events', express.json(), (req, res) => {
    const { name, eventDate } = req.body || {};
    const trimmedName = String(name || '').trim().slice(0, 80);
    if (!trimmedName) return res.status(400).json({ error: 'Bitte einen Event-Namen angeben.' });

    const date = String(eventDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bitte ein gültiges Event-Datum angeben.' });

    let maxPhotos = parseInt((req.body || {}).maxPhotosPerUser, 10);
    if (!Number.isFinite(maxPhotos)) maxPhotos = 30;
    maxPhotos = Math.min(Math.max(maxPhotos, 1), 1000);

    let unlockAt;
    try {
      unlockAt = util.computeGalleryUnlockAt(date); // Folgetag, 08:00 Uhr
    } catch {
      return res.status(400).json({ error: 'Ungültiges Event-Datum.' });
    }

    const id = util.generateId();
    db.prepare(
      `INSERT INTO events (id, session_id, name, event_date, max_photos_per_user, gallery_unlock_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, util.generateSessionId(), trimmedName, date, maxPhotos, unlockAt, util.nowIso());

    const e = db.prepare(
      `SELECT e.*, 0 AS user_count, 0 AS photo_count FROM events e WHERE e.id = ?`
    ).get(id);
    res.status(201).json({ event: eventToJson(e) });
  });

  router.patch('/events/:id', express.json(), (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });
    const body = req.body || {};

    const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : e.name;
    if (!name) return res.status(400).json({ error: 'Der Event-Name darf nicht leer sein.' });

    let eventDate = e.event_date;
    let unlockAt = e.gallery_unlock_at;
    if (body.eventDate !== undefined) {
      eventDate = String(body.eventDate).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
        return res.status(400).json({ error: 'Ungültiges Event-Datum.' });
      }
      try {
        unlockAt = util.computeGalleryUnlockAt(eventDate);
      } catch {
        return res.status(400).json({ error: 'Ungültiges Event-Datum.' });
      }
    }
    // Optional: Freigabe-Zeitpunkt manuell überschreiben (ISO-Datum oder "jetzt").
    if (body.galleryUnlockAt !== undefined) {
      if (body.galleryUnlockAt === 'now') {
        unlockAt = util.nowIso();
      } else {
        const t = Date.parse(body.galleryUnlockAt);
        if (Number.isNaN(t)) return res.status(400).json({ error: 'Ungültiger Freigabe-Zeitpunkt.' });
        unlockAt = new Date(t).toISOString();
      }
    }

    let maxPhotos = e.max_photos_per_user;
    if (body.maxPhotosPerUser !== undefined) {
      maxPhotos = parseInt(body.maxPhotosPerUser, 10);
      if (!Number.isFinite(maxPhotos)) return res.status(400).json({ error: 'Ungültiges Foto-Limit.' });
      maxPhotos = Math.min(Math.max(maxPhotos, 1), 1000);
    }

    db.prepare(
      'UPDATE events SET name = ?, event_date = ?, max_photos_per_user = ?, gallery_unlock_at = ? WHERE id = ?'
    ).run(name, eventDate, maxPhotos, unlockAt, e.id);

    const updated = db.prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM users  u WHERE u.event_id = e.id) AS user_count,
              (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count
       FROM events e WHERE e.id = ?`
    ).get(e.id);
    res.json({ event: eventToJson(updated) });
  });

  router.delete('/events/:id', async (req, res, next) => {
    try {
      const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ error: 'Event nicht gefunden.' });

      // Dateien zuerst einsammeln ( CASCADE löscht die DB-Zeilen gleich mit ).
      const files = db.prepare(
        `SELECT p.original_file, p.filtered_file, u.uuid FROM photos p JOIN users u ON u.id = p.user_id WHERE p.event_id = ?`
      ).all(e.id);
      db.prepare('DELETE FROM events WHERE id = ?').run(e.id);

      for (const row of files) {
        for (const f of [row.original_file, row.filtered_file]) {
          if (f && util.isSafeStoredFilename(f)) {
            await fsp.unlink(path.join(photosRoot, e.session_id, row.uuid, f)).catch(() => {});
          }
        }
      }
      await fsp.rm(path.join(photosRoot, e.session_id), { recursive: true, force: true }).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

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
        usersCsv.push(`${u.uuid};${u.first_name};${u.last_name};${u.created_at};${u.photo_count}`);
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
          manifest.push(`${entryName};${r.id};${r.uuid};${r.first_name};${r.last_name};${r.created_at};${variant};${r.filter_id || '-'}`);
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