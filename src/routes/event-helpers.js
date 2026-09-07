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

// Foto-Limit pro Gast – Wegwerfkamera-Logik:
//   27 = Klassiker (Kodak Fun Saver, die Standard-Einwegkamera)
//   39 = Maximum (Kodak Fun Saver 39)
// Dazwischen frei wählbar (z. B. eine bestimmte Zahl für ein Hochzeitsspiel).
const DEFAULT_PHOTOS_PER_USER = 27;
const MAX_PHOTOS_PER_USER = 39;

function eventToJson(e) {
  return {
    id: e.id,
    sessionId: e.session_id,
    name: e.name,
    eventDate: e.event_date,
    maxPhotosPerUser: e.max_photos_per_user,
    maxImageSide: e.max_image_side,
    jpegQuality: e.jpeg_quality,
    hideFilterButtons: !!e.hide_filter_buttons,
    retentionDays: e.retention_days ?? 30,
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
  if (!Number.isFinite(maxPhotos)) maxPhotos = DEFAULT_PHOTOS_PER_USER;
  maxPhotos = Math.min(Math.max(maxPhotos, 1), MAX_PHOTOS_PER_USER);

  let unlockAt;
  try {
    unlockAt = util.computeGalleryUnlockAt(date); // Folgetag, 08:00 Uhr
  } catch {
    throw Object.assign(new Error('Ungültiges Event-Datum.'), { status: 400 });
  }
  // Optional: Freigabe-Zeitpunkt explizit mit angeben ("now" = sofort).
  if (body && body.galleryUnlockAt !== undefined) {
    if (body.galleryUnlockAt === 'now') {
      unlockAt = util.nowIso();
    } else {
      const t = Date.parse(body.galleryUnlockAt);
      if (Number.isNaN(t)) throw Object.assign(new Error('Ungültiger Freigabe-Zeitpunkt.'), { status: 400 });
      unlockAt = new Date(t).toISOString();
    }
  }

  const { maxImageSide, jpegQuality } = parseImageSettings(body);
  const hideFilterButtons = (body && body.hideFilterButtons) ? 1 : 0;
  const retentionDays = parseRetentionDays(body);

  const id = util.generateId();
  db.prepare(
    `INSERT INTO events (id, session_id, name, event_date, max_photos_per_user, gallery_unlock_at, created_at, created_by, max_image_side, jpeg_quality, hide_filter_buttons, retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, util.generateSessionId(), name, date, maxPhotos, unlockAt, util.nowIso(), createdBy, maxImageSide, jpegQuality, hideFilterButtons, retentionDays);

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
 * DSGVO-Retention validieren: nach wie vielen TAGEN NACH DEM EVENT-DATUM die
 * Daten automatisch gelöscht werden. 0 = keine Auto-Löschung (manuell).
 * Standard 30, Obergrenze 365.
 */
function parseRetentionDays(body) {
  let days = parseInt((body || {}).retentionDays, 10);
  if (!Number.isFinite(days)) days = 30;
  return Math.min(Math.max(days, 0), 365);
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
    if (!Number.isFinite(maxPhotos) || maxPhotos < 1 || maxPhotos > MAX_PHOTOS_PER_USER)
      throw Object.assign(new Error(`Ungültiges Foto-Limit (1–${MAX_PHOTOS_PER_USER}).`), { status: 400 });
    maxPhotos = Math.min(Math.max(maxPhotos, 1), MAX_PHOTOS_PER_USER);
  }

  const { maxImageSide, jpegQuality } = parseImageSettings({
    maxImageSide: b.maxImageSide !== undefined ? b.maxImageSide : e.max_image_side,
    jpegQuality: b.jpegQuality !== undefined ? b.jpegQuality : e.jpeg_quality,
  });

  // Wegwerfkamera-Modus: Filter-Buttons in der Kamera ausblenden (Option).
  const hideFilterButtons = b.hideFilterButtons !== undefined
    ? (b.hideFilterButtons ? 1 : 0)
    : (e.hide_filter_buttons ? 1 : 0);

  // DSGVO-Retention: nur aktualisieren, wenn explizit angeben (sonst Beibehalten).
  const retentionDays = b.retentionDays !== undefined
    ? parseRetentionDays(b)
    : (e.retention_days ?? 30);

  db.prepare(
    `UPDATE events SET name = ?, event_date = ?, max_photos_per_user = ?, gallery_unlock_at = ?, max_image_side = ?, jpeg_quality = ?, hide_filter_buttons = ?, retention_days = ? WHERE id = ?`
  ).run(name, eventDate, maxPhotos, unlockAt, maxImageSide, jpegQuality, hideFilterButtons, retentionDays, e.id);

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

/**
 * DSGVO-Retention: löscht Events, deren Speicherdauer abgelaufen ist.
 * Ablaufzeitpunkt = Event-Datum (23:59 Uhr) + retention_days Tage.
 * Nur Events mit retention_days > 0 (0 = keine Auto-Löschung, manuell).
 * Gibt die Anzahl automatisch gelöschter Events zurück.
 */
async function purgeExpiredEvents(db, dataDir) {
  const now = Date.now();
  const rows = db.prepare(
    'SELECT id, session_id, event_date, retention_days FROM events WHERE retention_days > 0'
  ).all();
  let deleted = 0;
  for (const e of rows) {
    const expiryMs = Date.parse(e.event_date + 'T23:59:59') + e.retention_days * 86400000;
    if (now > expiryMs) {
      await deleteEventCascade(db, dataDir, e);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Datenkonsistenz beim Start: entfernt „verwaiste" Dateien, die durch einen
 * Crash (z. B. zwischen Datei-Write und DB-Insert) ohne DB-Zeile zurückbleiben.
 *  1) data/tmp: komplett leeren (nur transient; Reste = abgebrochene Uploads).
 *  2) data/photos: Dateien löschen, die keine zugehörige DB-Zeile haben
 *     (Thumbnails werden per Konvention aus original_file abgeleitet).
 * Läuft NUR beim Start (bevor der Server Requests annimmt) → keine Race-Kondition
 * mit laufenden Uploads. Gibt die Anzahl gelöschter Orphan-Dateien zurück.
 */
async function sweepOrphans(db, dataDir) {
  const photosRoot = path.join(dataDir, 'photos');
  const tmpDir = path.join(dataDir, 'tmp');

  // 1) data/tmp leeren.
  try {
    for (const f of await fsp.readdir(tmpDir)) await fsp.unlink(path.join(tmpDir, f)).catch(() => {});
  } catch { /* tmp-Dir fehlt – egal */ }

  // 2) Bekannte Dateinamen aus der DB (original + filtered) ableiten.
  const known = new Set();
  for (const r of db.prepare('SELECT original_file, filtered_file FROM photos').all()) {
    if (r.original_file) known.add(r.original_file);
    if (r.filtered_file) known.add(r.filtered_file);
  }
  // Thumbnails: Konvention "…-original.jpg" -> "…-original-thumb.jpg".
  for (const f of [...known]) {
    const dot = f.lastIndexOf('.');
    if (dot > 0) known.add(f.slice(0, dot) + '-thumb' + f.slice(dot));
  }

  let removed = 0;
  let sessions = [];
  try { sessions = await fsp.readdir(photosRoot); } catch { return removed; }
  for (const session of sessions) {
    let uuidDirs = [];
    try { uuidDirs = await fsp.readdir(path.join(photosRoot, session)); } catch { continue; }
    for (const udir of uuidDirs) {
      let files = [];
      try { files = await fsp.readdir(path.join(photosRoot, session, udir)); } catch { continue; }
      for (const f of files) {
        if (known.has(f)) continue;
        await fsp.unlink(path.join(photosRoot, session, udir, f)).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}

module.exports = {
  eventToJson,
  getEventWithStats,
  listEventsFor,
  createEvent,
  updateEventFields,
  deleteEventCascade,
  parseImageSettings,
  purgeExpiredEvents,
  sweepOrphans,
};