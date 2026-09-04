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

// Token-Gültigkeitsdauer. Damit ist ein (z. B. per ?token=) geleaktes Token nur
// noch für eine begrenzte Zeit brauchbar, statt dauerhaft.
const ADMIN_TOKEN_TTL_SECONDS = 8 * 3600;          // 8 Stunden
const ORGANIZER_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 Tage

/**
 * Admin-Session-Token: "<expHex>.<hmac>". expHex = Ablaufzeitpunkt (Epoch s,
 * hex), hmac über "admin-v2:<expHex>". Zeitlich begrenzt, ohne DB-Treffer
 * verifizierbar.
 */
function createAdminToken(secret, ttlSeconds = ADMIN_TOKEN_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const expHex = exp.toString(16);
  const mac = crypto.createHmac('sha256', secret).update(`admin-v2:${expHex}`).digest('hex');
  return `${expHex}.${mac}`;
}

function verifyAdminToken(secret, token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expHex = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^[0-9a-f]{1,16}$/.test(expHex) || !mac) return false;
  const exp = parseInt(expHex, 16);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`admin-v2:${expHex}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Veranstalter-Session-Token: "<keyId>.<expHex>.<hmac>", ohne Datenbank-Treffer
 * verifizierbar (ob der Key gesperrt ist, wird je Request in der DB geprüft).
 */
function createOrganizerToken(secret, keyId, ttlSeconds = ORGANIZER_TOKEN_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const expHex = exp.toString(16);
  const mac = crypto.createHmac('sha256', secret).update(`organizer-v2:${keyId}:${expHex}`).digest('hex');
  return `${keyId}.${expHex}.${mac}`;
}

function verifyOrganizerToken(secret, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [keyId, expHex, mac] = parts;
  if (!keyId || !/^[0-9a-f]{1,16}$/.test(expHex) || !mac) return null;
  const exp = parseInt(expHex, 16);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  const expected = crypto.createHmac('sha256', secret).update(`organizer-v2:${keyId}:${expHex}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(mac));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return keyId;
}

/** Verhindert Path-Traversal: nur unsere eigenen generierten Dateinamen zulassen. */
function isSafeStoredFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

/**
 * CSV-Zelle sicher formatieren. Neutralisiert CSV-Formel-Injection (Zellen, die
 * mit =, +, -, @, TAB oder CR beginnen, würden Excel/Sheets als Formel ausführen)
 * und bindet Zellen mit Trennzeichen/Anführungszeichen/Umbrüchen korrekt ein.
 */
function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-\t\r@]/.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Kleiner in-Memory-Rate-Limiter für Login-Fehlversuche pro IP (verhindert
 * Brute-Force). Map räumt inaktive Einträge selbst auf (unref = hält den
 * Prozess im Test nicht am Leben). Liefert isBlocked / recordFail / reset.
 */
function createLoginRateLimiter({ maxFails = 5, blockMs = 30_000, entryTtlMs = 10 * 60_000 } = {}) {
  const fails = new Map(); // ip -> { count, blockedUntil, lastSeen }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of fails) {
      const stillBlocked = e.blockedUntil && now < e.blockedUntil;
      if (!stillBlocked && now - (e.lastSeen || 0) > entryTtlMs) fails.delete(ip);
    }
  }, 60_000).unref();
  return {
    isBlocked(ip) {
      const e = fails.get(ip);
      if (e && e.blockedUntil && Date.now() < e.blockedUntil) {
        return { blocked: true, waitSecs: Math.ceil((e.blockedUntil - Date.now()) / 1000) };
      }
      return { blocked: false };
    },
    recordFail(ip) {
      const now = Date.now();
      const e = fails.get(ip) || { count: 0, blockedUntil: 0, lastSeen: now };
      e.lastSeen = now;
      e.count += 1;
      if (e.count >= maxFails) {
        e.blockedUntil = now + blockMs;
        e.count = 0;
        fails.set(ip, e);
        return { blocked: true, remaining: 0 };
      }
      fails.set(ip, e);
      return { blocked: false, remaining: maxFails - e.count };
    },
    reset(ip) {
      fails.delete(ip);
    },
  };
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
  csvCell,
  createLoginRateLimiter,
};