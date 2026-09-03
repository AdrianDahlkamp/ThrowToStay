'use strict';

/**
 * Geteilte Event-Logik für Admin- und Veranstalter-Routen:
 * Anlegen, Aktualisieren und (inkl. Dateien) Löschen von Events.
 */

const fsp = require('fs/promises');
const path = require('path');
const util = require('../util');

const SELECT_EVENT_STATS = `
  SELECT e.*,
         (SELECT COUNT(*) FROM users  u WHERE u.event_id = e.id) AS user_count,
         (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count
  FROM events e`;

function eventToJson(e) {
  return {
    id: e.id,
    sessionId: e.session_id,
    name: e.name,
    eventDate: e.event_date,
    maxPhotosPerUser: e.max_photos_per_user,
    maxImageSide: e.max_image_side,
    jpegQuality: e.jpeg_quality,
    galleryUnlockAt: e.gallery_unlock_at,
    galleryUnlocked: Date.now() >= Date.parse(e.gallery_unlock_at),
    createdAt: e.created_at,
    createdBy: e.created_by || null,
    createdByLabel: e.created_by_label || null,
    userCount: e.user_count,
    photoCount: e.photo_count,
  };
}

function getEventWithStats(db, id) {
  return db.prepare(
    `SELECT e.*,
            (SELECT COUNT(*) FROM users  u WHERE u.event_id = e.id) AS user_count,
            (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count,
            (SELECT k.label FROM user_keys k WHERE k.id = e.created_by) AS created_by_label
     FROM events e WHERE e.id = ?`
  ).get(id);
}

function listEventsFor(db, createdBy /* null = alle (Admin) */) {
  const where = createdBy ? 'WHERE e.created_by = ?' : '';
  const params = createdBy ? [createdBy] : [];
  return db.prepare(
    `SELECT e.*,
            (SELECT COUNT(*) FROM users  u WHERE u.event_id = e.id) AS user_count,
            (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id) AS photo_count,
            (SELECT k.label FROM user_keys k WHERE k.id = e.created_by) AS created_by_label
     FROM events e ${where} ORDER BY e.created_at DESC`
  ).all(...params);
}

/**
 * Validiert die Event-Felder aus dem Request-Body und legt das Event an.
 * createdBy: Key-ID des Veranstalters oder null (Admin).
 */
function createEvent(db, body, createdBy = null) {
  const name = String((body || {}).name || '').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('Bitte einen Event-Namen angeben.'), { status: 400 });

  const date = String((body || {}).eventDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('Bitte ein gültiges Event-Datum angeben.'), { status: 400 });
  }

  let maxPhotos = parseInt((body || {}).maxPhotosPerUser, 10);
  if (!Number.isFinite(maxPhotos)) maxPhotos = 30;
  maxPhotos = Math.min(Math.max(maxPhotos, 1), 1000);

  let unlockAt;
  try {
    unlockAt = util.computeGalleryUnlockAt(date); // Folgetag, 08:00 Uhr
  } catch {
    throw Object.assign(new Error('Ungültiges Event-Datum.'), { status: 400 });
  }

  const { maxImageSide, jpegQuality } = parseImageSettings(body);

  const id = util.generateId();
  db.prepare(
    `INSERT INTO events (id, session_id, name, event_date, max_photos_per_user, gallery_unlock_at, created_at, created_by, max_image_side, jpeg_quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, util.generateSessionId(), name, date, maxPhotos, unlockAt, util.nowIso(), createdBy, maxImageSide, jpegQuality);

  return getEventWithStats(db, id);
}

/** Bild-Einstellungen validieren (Auflösung + JPEG-Qualität). */
function parseImageSettings(body) {
  let maxImageSide = parseInt((body || {}).maxImageSide, 10);
  if (!Number.isFinite(maxImageSide)) maxImageSide = 1600;
  maxImageSide = Math.min(Math.max(maxImageSide, 640), 4096);

  let jpegQuality = parseInt((body || {}).jpegQuality, 10);
  if (!Number.isFinite(jpegQuality)) jpegQuality = 92;
  jpegQuality = Math.min(Math.max(jpegQuality, 50), 100);

  return { maxImageSide, jpegQuality };
}

/**
 * Event-Felder aktualisieren (Name, Datum, Limits, Freigabe, Bildeinstellungen).
 * galleryUnlockAt: ISO-Datum oder "now" für sofortige Freigabe.
 */
function updateEventFields(db, e, body) {
  const b = body || {};

  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : e.name;
  if (!name) throw Object.assign(new Error('Der Event-Name darf nicht leer sein.'), { status: 400 });

  let eventDate = e.event_date;
  let unlockAt = e.gallery_unlock_at;
  if (b.eventDate !== undefined) {
    eventDate = String(b.eventDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      throw Object.assign(new Error('Ungültiges Event-Datum.'), { status: 400 });
    }
    try {
      unlockAt = util.computeGalleryUnlockAt(eventDate);
    } catch {
      throw Object.assign(new Error('Ungültiges Event-Datum.'), { status: 400 });
    }
  }
  if (b.galleryUnlockAt !== undefined) {
    if (b.galleryUnlockAt === 'now') {
      unlockAt = util.nowIso();
    } else {
      const t = Date.parse(b.galleryUnlockAt);
      if (Number.isNaN(t)) throw Object.assign(new Error('Ungültiger Freigabe-Zeitpunkt.'), { status: 400 });
      unlockAt = new Date(t).toISOString();
    }
  }

  let maxPhotos = e.max_photos_per_user;
  if (b.maxPhotosPerUser !== undefined) {
    maxPhotos = parseInt(b.maxPhotosPerUser, 10);
    if (!Number.isFinite(maxPhotos)) throw Object.assign(new Error('Ungültiges Foto-Limit.'), { status: 400 });
    maxPhotos = Math.min(Math.max(maxPhotos, 1), 1000);
  }

  const { maxImageSide, jpegQuality } = parseImageSettings({
    maxImageSide: b.maxImageSide !== undefined ? b.maxImageSide : e.max_image_side,
    jpegQuality: b.jpegQuality !== undefined ? b.jpegQuality : e.jpeg_quality,
  });

  db.prepare(
    `UPDATE events SET name = ?, event_date = ?, max_photos_per_user = ?, gallery_unlock_at = ?, max_image_side = ?, jpeg_quality = ? WHERE id = ?`
  ).run(name, eventDate, maxPhotos, unlockAt, maxImageSide, jpegQuality, e.id);

  return getEventWithStats(db, e.id);
}

/** Event samt Fotos/Dateien löschen (Users/Photos via CASCADE). */
async function deleteEventCascade(db, dataDir, e) {
  const files = db.prepare(
    `SELECT p.original_file, p.filtered_file, u.uuid
     FROM photos p JOIN users u ON u.id = p.user_id
     WHERE p.event_id = ?`
  ).all(e.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(e.id);

  const photosRoot = path.join(dataDir, 'photos');
  for (const row of files) {
    for (const f of [row.original_file, row.filtered_file]) {
      if (f && util.isSafeStoredFilename(f)) {
        await fsp.unlink(path.join(photosRoot, e.session_id, row.uuid, f)).catch(() => {});
      }
    }
  }
  await fsp.rm(path.join(photosRoot, e.session_id), { recursive: true, force: true }).catch(() => {});
}

module.exports = {
  eventToJson,
  getEventWithStats,
  listEventsFor,
  createEvent,
  updateEventFields,
  deleteEventCascade,
  parseImageSettings,
};