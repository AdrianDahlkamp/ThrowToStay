'use strict';

/**
 * Public-API der Event-App (kein Login – Zugriff über die unratbare Session-ID
 * in der QR-URL plus die UUID des Browsers).
 *
 * Ablauf:
 *  1. Browser generiert beim ersten Aufruf eine UUID und speichert sie im LocalStorage.
 *  2. POST /register      – Vor-/Nachname speichern (Upsert pro Event).
 *  3. POST /photos        – Foto-Upload: immer das Original, optional die
 *                           gefilterte Variante. Beide werden getrennt gespeichert,
 *                           der Filter wird also NICHT ins Original eingebrannt.
 *  4. GET  /photos        – eigene Fotos sofort; die Galerie aller User erst ab
 *                           gallery_unlock_at (Standard: Folgetag 08:00 Uhr).
 *  5. POST /download      – Mehrfach-Auswahl als ZIP.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');
const multer = require('multer');
const util = require('../util');

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB pro Bilddatei
const MAX_ZIP_ITEMS = 500;

function createPublicRouter({ db, dataDir }) {
  const router = express.Router();
  const photosRoot = path.join(dataDir, 'photos');

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, path.join(dataDir, 'tmp')),
      filename: (req, file, cb) => cb(null, `up-${util.generateId()}`),
    }),
    // fieldArrayIndexLimit aktiviert die opt-in-DoS-Abwehr (CVE-2026-82333):
  // überdimensionierte Array-Indizes in Multipart-Fieldnamen werden verworfen,
  // statt den Node-Event-Loop einzufrieren. Die App nutzt keine Array-Fields,
  // 100 ist großzügiger Headroom.
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 10, fieldArrayIndexLimit: 100 },
  });

  // ---------------------------------------------------------------- Helpers

  function getEventBySession(sessionId) {
    return db.prepare('SELECT * FROM events WHERE session_id = ?').get(sessionId);
  }

  function getUserByUuid(eventId, uuid) {
    if (!uuid || !util.isValidUuid(uuid)) return null;
    return db.prepare('SELECT * FROM users WHERE event_id = ? AND uuid = ?').get(eventId, uuid.trim());
  }

  function photoCountForUser(userId) {
    return db.prepare('SELECT COUNT(*) AS c FROM photos WHERE user_id = ?').get(userId).c;
  }

  function isGalleryUnlocked(event) {
    return Date.now() >= Date.parse(event.gallery_unlock_at);
  }

  function eventStatePayload(event, user) {
    const unlocked = isGalleryUnlocked(event);
    return {
      event: {
        name: event.name,
        eventDate: event.event_date,
        maxPhotosPerUser: event.max_photos_per_user,
        maxImageSide: event.max_image_side,
        jpegQuality: event.jpeg_quality,
        galleryUnlockAt: event.gallery_unlock_at,
        galleryUnlocked: unlocked,
      },
      user: user
        ? { firstName: user.first_name, lastName: user.last_name, photoCount: photoCountForUser(user.id) }
        : null,
    };
  }

  function photoToJson(photo, owner, mine) {
    return {
      id: photo.id,
      createdAt: photo.created_at,
      takenWithFilter: !!photo.taken_with_filter,
      filterId: photo.filter_id || null,
      hasFiltered: !!photo.filtered_file,
      mine: !!mine,
      owner: { firstName: owner.first_name, lastName: owner.last_name },
    };
  }

  function storedPathFor(event, ownerUuid, filename) {
    return path.join(photosRoot, event.session_id, ownerUuid, filename);
  }

  /** Verschiebt eine hochgeladene Datei an ihren endgültigen Ort (inkl. UUID im Pfad). */
  async function persistUpload(tmpPath, event, ownerUuid, baseName, variant) {
    const buf = await fsp.readFile(tmpPath);
    const ext = util.sniffImageExtension(buf);
    if (!ext) throw Object.assign(new Error('Nur JPEG-, PNG- oder WEBP-Bilder werden akzeptiert.'), { status: 400 });
    const dir = path.join(photosRoot, event.session_id, ownerUuid);
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${baseName}-${variant}.${ext}`;
    await fsp.writeFile(path.join(dir, filename), buf);
    await fsp.unlink(tmpPath).catch(() => {});
    return { filename, ext };
  }

  // ------------------------------------------------------------- Endpunkte

  // Status des Events + des eingeloggten (per UUID bekannten) Users.
  router.get('/:sessionId/state', (req, res) => {
    const event = getEventBySession(req.params.sessionId);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden. Bitte QR-Code erneut scannen.' });
    const user = getUserByUuid(event.id, req.query.uuid);
    res.json(eventStatePayload(event, user));
  });

  // Erstbesuch: UUID + Vor-/Nachname registrieren (Upsert, Name ist änderbar).
  router.post('/:sessionId/register', express.json(), (req, res) => {
    const event = getEventBySession(req.params.sessionId);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });

    const { uuid, firstName, lastName } = req.body || {};
    if (!util.isValidUuid(uuid)) return res.status(400).json({ error: 'Ungültige Nutzer-Kennung.' });
    const first = String(firstName || '').trim().slice(0, 60);
    const last = String(lastName || '').trim().slice(0, 60);
    if (!first || !last) return res.status(400).json({ error: 'Bitte Vor- und Nachnamen angeben.' });

    const existing = getUserByUuid(event.id, uuid);
    if (existing) {
      db.prepare('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?').run(first, last, existing.id);
    } else {
      db.prepare(
        'INSERT INTO users (id, event_id, uuid, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(util.generateId(), event.id, uuid.trim(), first, last, util.nowIso());
    }
    const user = getUserByUuid(event.id, uuid);
    res.json(eventStatePayload(event, user));
  });

  // Foto-Upload: original (Pflicht) + filtered (optional, wenn Filter gewählt war).
  router.post('/:sessionId/photos', upload.fields([
    { name: 'original', maxCount: 1 },
    { name: 'filtered', maxCount: 1 },
  ]), async (req, res, next) => {
    try {
      const event = getEventBySession(req.params.sessionId);
      if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });

      const user = getUserByUuid(event.id, req.body.uuid);
      if (!user) return res.status(403).json({ error: 'Unbekannter Nutzer. Bitte Seite neu laden und Namen eingeben.' });

      const count = photoCountForUser(user.id);
      if (count >= event.max_photos_per_user) {
        return res.status(409).json({ error: `Das Limit von ${event.max_photos_per_user} Fotos ist erreicht.` });
      }
      if (!req.files || !req.files.original || !req.files.original[0]) {
        return res.status(400).json({ error: 'Kein Foto empfangen.' });
      }

      const takenWithFilter = req.body.takenWithFilter === '1';
      const filterId = String(req.body.filterId || 'none').slice(0, 32);
      const baseName = `${Date.now()}-${photoCountForUser(user.id) + 1}-${photoIdShort()}`;

      const original = await persistUpload(req.files.original[0].path, event, user.uuid, baseName, 'original');
      // Die Filter-Variante wird immer gespeichert, wenn sie mitgesendet wird
      // (der Client erzeugt sie bei jeder Aufnahme) – so sind beide Varianten
      // zum Download verfügbar, unabhängig von der gewählten Standard-Ansicht.
      let filtered = null;
      if (req.files.filtered && req.files.filtered[0]) {
        filtered = await persistUpload(req.files.filtered[0].path, event, user.uuid, baseName, 'filtered');
      }

      const id = util.generateId();
      db.prepare(
        `INSERT INTO photos (id, event_id, user_id, original_file, filtered_file, filter_id, taken_with_filter, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, event.id, user.id, original.filename,
        filtered ? filtered.filename : null,
        filtered ? filterId : null,
        takenWithFilter ? 1 : 0,
        util.nowIso()
      );

      const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
      res.status(201).json({
        photo: photoToJson(photo, user, true),
        photoCount: photoCountForUser(user.id),
        maxPhotosPerUser: event.max_photos_per_user,
      });
    } catch (err) {
      next(err);
    }
  });

  function photoIdShort() {
    return util.generateId().slice(0, 8);
  }

  // Fotoliste: vor der Freigabe nur eigene Fotos, danach alle des Events.
  router.get('/:sessionId/photos', (req, res) => {
    const event = getEventBySession(req.params.sessionId);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });
    const user = getUserByUuid(event.id, req.query.uuid);
    const unlocked = isGalleryUnlocked(event);

    const rows = db.prepare(
      `SELECT p.*, u.uuid AS owner_uuid, u.first_name, u.last_name
       FROM photos p JOIN users u ON u.id = p.user_id
       WHERE p.event_id = ?
       ORDER BY p.created_at ASC, p.id ASC`
    ).all(event.id);

    const photos = rows
      .filter(r => unlocked || (user && r.owner_uuid === user.uuid))
      .map(r => photoToJson(r, r, !!(user && r.owner_uuid === user.uuid)));

    res.json({
      galleryUnlocked: unlocked,
      galleryUnlockAt: event.gallery_unlock_at,
      photos,
    });
  });

  // Bilddatei ausliefern (variant=original|filtered).
  router.get('/:sessionId/photos/:photoId/file', async (req, res, next) => {
    try {
      const event = getEventBySession(req.params.sessionId);
      if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });
      const user = getUserByUuid(event.id, req.query.uuid);
      const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND event_id = ?').get(req.params.photoId, event.id);
      if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden.' });

      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(photo.user_id);
      const mine = !!(user && user.id === photo.user_id);
      if (!isGalleryUnlocked(event) && !mine) {
        return res.status(403).json({ error: 'Die Galerie ist noch nicht freigeschaltet.' });
      }

      const wantFiltered = req.query.variant === 'filtered';
      const filename = wantFiltered ? photo.filtered_file : photo.original_file;
      if (!filename || !util.isSafeStoredFilename(filename)) {
        return res.status(404).json({ error: 'Diese Variante existiert nicht.' });
      }

      const filePath = storedPathFor(event, owner.uuid, filename);
      const download = req.query.download === '1';
      const base = util.sanitizeFilename(
        `ThrowToStay-${photo.created_at.slice(0, 10)}-${photo.id.slice(0, 8)}`,
        'foto'
      );
      res.setHeader(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${base}${wantFiltered ? '-filter' : ''}"`
      );
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  });

  // Filter nachträglich ändern (nur der Besitzer): neue gefilterte Variante hochladen
  // oder mit filterId="none" die gefilterte Variante entfernen.
  router.post('/:sessionId/photos/:photoId/refilter', upload.single('filtered'), async (req, res, next) => {
    try {
      const event = getEventBySession(req.params.sessionId);
      if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });
      const user = getUserByUuid(event.id, req.body.uuid);
      if (!user) return res.status(403).json({ error: 'Unbekannter Nutzer.' });

      const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND event_id = ?').get(req.params.photoId, event.id);
      if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(photo.user_id);
      const isOwner = photo.user_id === user.id;

      const filterId = String(req.body.filterId || '').slice(0, 32);
      if (!filterId) return res.status(400).json({ error: 'filterId fehlt.' });

      if (filterId === 'none') {
        // Entfernen der Filter-Variante: immer nur der Besitzer.
        if (!isOwner) return res.status(403).json({ error: 'Nur der Besitzer kann die Filter-Variante entfernen.' });
        if (photo.filtered_file) {
          await fsp.unlink(storedPathFor(event, owner.uuid, photo.filtered_file)).catch(() => {});
        }
        db.prepare('UPDATE photos SET filtered_file = NULL, filter_id = NULL WHERE id = ?').run(photo.id);
      } else {
        // Erzeugen/Ersetzen der Filter-Variante: der Besitzer immer, jeder
        // weitere Gast nach Galerie-Freigabe (die Fotos sind dann öffentlich).
        if (!isOwner && !isGalleryUnlocked(event)) {
          return res.status(403).json({ error: 'Die Galerie ist noch nicht freigeschaltet.' });
        }
        if (!req.file) return res.status(400).json({ error: 'Gefiltertes Bild fehlt.' });
        const baseName = photo.original_file.replace(/-original\.[a-z0-9]+$/i, '');
        // Die Datei gehört zum Foto: immer im Ordner des Besitzers speichern.
        const filtered = await persistUpload(req.file.path, event, owner.uuid, baseName, 'filtered');
        db.prepare('UPDATE photos SET filtered_file = ?, filter_id = ? WHERE id = ?')
          .run(filtered.filename, filterId, photo.id);
      }

      const updated = db.prepare('SELECT * FROM photos WHERE id = ?').get(photo.id);
      res.json({ photo: photoToJson(updated, owner, isOwner) });
    } catch (err) {
      next(err);
    }
  });

  // Mehrfach-Auswahl als ZIP herunterladen.
  router.post('/:sessionId/download', express.json(), async (req, res, next) => {
    try {
      const event = getEventBySession(req.params.sessionId);
      if (!event) return res.status(404).json({ error: 'Event nicht gefunden.' });
      const user = getUserByUuid(event.id, (req.body || {}).uuid);
      const unlocked = isGalleryUnlocked(event);
      if (!unlocked && !user) return res.status(403).json({ error: 'Die Galerie ist noch nicht freigeschaltet.' });

      const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, MAX_ZIP_ITEMS) : [];
      if (items.length === 0) return res.status(400).json({ error: 'Keine Bilder ausgewählt.' });

      const manifestRows = ['datei;foto-id;uuid;vorname;nachname;aufgenommen;variante;filter'];
      const zip = archiver('zip', { zlib: { level: 9 } });
      zip.on('error', err => next(err));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${util.sanitizeFilename(`fotos-${event.name}-${event.event_date}`, 'fotos')}.zip"`
      );
      zip.pipe(res);

      let index = 0;
      for (const item of items) {
        const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND event_id = ?').get(item.photoId, event.id);
        if (!photo) continue;
        const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(photo.user_id);
        const mine = !!(user && user.id === photo.user_id);
        if (!unlocked && !mine) continue; // vor der Freigabe nur eigene Fotos

        const wantFiltered = item.variant === 'filtered';
        const filename = wantFiltered ? photo.filtered_file : photo.original_file;
        if (!filename || !util.isSafeStoredFilename(filename)) continue;

        const ext = path.extname(filename);
        const stamp = photo.created_at.slice(0, 16).replace(/[:T-]/g, '');
        const entryName = util.sanitizeFilename(
          `${String(++index).padStart(3, '0')}-${owner.last_name}-${owner.first_name}-${stamp}-${wantFiltered ? 'filter' : 'original'}`
        ) + ext;

        zip.file(storedPathFor(event, owner.uuid, filename), { name: entryName });
        manifestRows.push(
          `${entryName};${photo.id};${owner.uuid};${owner.first_name};${owner.last_name};${photo.created_at};${wantFiltered ? 'filter' : 'original'};${photo.filter_id || '-'}`
        );
      }

      // Manifest: ordnet jede Datei der UUID und dem Namen zu.
      zip.append('\uFEFF' + manifestRows.join('\r\n') + '\r\n', { name: 'manifest.csv' });
      await zip.finalize();
      // Antwort endet, sobald der Archiv-Stream fertig ist.
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPublicRouter };