'use strict';

/**
 * Datenbank-Layer für ThrowToStay (node:sqlite, eingebautes SQLite).
 *
 * Tabellen:
 *  - events:  Event mit Session-ID (Teil der QR-URL), Datum, Foto-Limit pro User,
 *             Zeitpunkt der Galerie-Freigabe (Standard: Folgetag 08:00 Uhr).
 *  - users:   Teilnehmer pro Event (UUID aus dem Browser-LocalStorage + Name).
 *  - photos:  Metadaten jedes Fotos; Dateien liegen unter data/photos/<session>/<uuid>/.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  event_date          TEXT NOT NULL,
  max_photos_per_user INTEGER NOT NULL DEFAULT 30,
  gallery_unlock_at   TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  uuid       TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, uuid)
);

CREATE TABLE IF NOT EXISTS photos (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_file     TEXT NOT NULL,
  filtered_file     TEXT,
  filter_id         TEXT,
  taken_with_filter INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_id);
CREATE INDEX IF NOT EXISTS idx_photos_user  ON photos(user_id);
CREATE INDEX IF NOT EXISTS idx_users_event  ON users(event_id);
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'throwtostay.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };