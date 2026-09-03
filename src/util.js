'use strict';

/**
 * Gemeinsame Hilfsfunktionen für ThrowToStay.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Crockford-Base32-Alphabet ohne leicht verwechselbare Zeichen (I, L, O, U). */
const SESSION_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Zufällige, QR-taugliche Session-ID (10 Zeichen ≈ 50 Bit Entropie). */
function generateSessionId() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (const b of bytes) out += SESSION_ALPHABET[b % SESSION_ALPHABET.length];
  return out;
}

/** Zugangs-Schlüssel für Veranstalter, z. B. "TTS-4F9K-M2QX" (8 Zeichen ≈ 40 Bit). */
function generateAccessKey() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += SESSION_ALPHABET[b % SESSION_ALPHABET.length];
  return `TTS-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

function generateId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Galerie-Freigabe: nächster Kalendertag nach dem Event-Datum, um 08:00 Uhr
 * (lokale Serverzeit). Das Event-Datum ist ein ISO-Datum "YYYY-MM-DD".
 */
function computeGalleryUnlockAt(eventDate) {
  const d = new Date(`${eventDate}T08:00:00`);
  if (Number.isNaN(d.getTime())) throw new Error('Ungültiges Event-Datum');
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Dateinamen für ZIP-Einträge/Downloads: nur A-Z, a-z, 0-9, -, _ . */
function sanitizeFilename(name, fallback = 'datei') {
  const s = String(name || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[ÄÖÜ]/g, m => ({ 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue' }[m]))
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

/**
 * Prüft die Magic Bytes eines Uploads und liefert die passende Dateiendung.
 * Erlaubt: JPEG, PNG, WEBP. Gibt null zurück, wenn nichts passt.
 */
function sniffImageExtension(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // WEBP: "RIFF" .... "WEBP"
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** UUID-Eingabe validieren (der Client nutzt crypto.randomUUID()). */
function isValidUuid(u) {
  return typeof u === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u.trim());
}

/** Admin-Session-Token: HMAC über ein zufälliges Secret, das in data/ liegt. */
function loadOrCreateAdminSecret(dataDir) {
  const file = path.join(dataDir, 'admin-secret');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch { /* neu anlegen */ }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function createAdminToken(secret) {
  return crypto.createHmac('sha256', secret).update('admin-session-v1').digest('hex');
}

function verifyAdminToken(secret, token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = createAdminToken(secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Veranstalter-Session-Token: "<keyId>.<hmac>", ohne Datenbank-Treffer
 * verifizierbar (ob der Key gesperrt ist, wird je Request in der DB geprüft).
 */
function createOrganizerToken(secret, keyId) {
  const mac = crypto.createHmac('sha256', secret).update(`organizer-v1:${keyId}`).digest('hex');
  return `${keyId}.${mac}`;
}

function verifyOrganizerToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [keyId, mac] = token.split('.');
  if (!keyId || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(`organizer-v1:${keyId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(mac));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return keyId;
}

/** Verhindert Path-Traversal: nur unsere eigenen generierten Dateinamen zulassen. */
function isSafeStoredFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

module.exports = {
  generateSessionId,
  generateAccessKey,
  generateId,
  nowIso,
  computeGalleryUnlockAt,
  sanitizeFilename,
  sniffImageExtension,
  isValidUuid,
  loadOrCreateAdminSecret,
  createAdminToken,
  verifyAdminToken,
  createOrganizerToken,
  verifyOrganizerToken,
  isSafeStoredFilename,
};