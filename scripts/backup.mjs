#!/usr/bin/env node
'use strict';

/**
 * ThrowToStay Backup (lokal):
 *  - Konsistente DB-Kopie via VACUUM INTO (WAL-safe, kein sqlite3-CLI nötig).
 *  - Komplette (rekursive) Kopie des Foto-Verzeichnisses (data/photos).
 *  - Retention: behält nur die letzten TTS_BACKUP_KEEP Backups (Default 7).
 *
 * Ausführung (als Service-User oder root):
 *   TTS_DATA_DIR=/opt/throwtostay/data \
 *   TTS_BACKUP_DIR=/var/backups/throwtostay \
 *   TTS_BACKUP_KEEP=7 \
 *   node /opt/throwtostay/scripts/backup.mjs
 *
 * WICHTIG: TTS_BACKUP_DIR sollte idealerweise auf einer ANDEREN Platte als
 * TTS_DATA_DIR liegen (sonst schützt das Backup NICHT vor einem Platten-Defekt).
 * TTS_DATA_DIR MUSS exakt dem Datenverzeichnis der laufenden App entsprechen.
 */

import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.TTS_DATA_DIR || path.join(root, 'data');
const BACKUP_DIR = process.env.TTS_BACKUP_DIR || path.join(root, 'backups');
const KEEP = Math.max(1, parseInt(process.env.TTS_BACKUP_KEEP || '7', 10));

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(BACKUP_DIR, `tts-backup-${ts}`);
await fsp.mkdir(target, { recursive: true });

// 1) DB: konsistente Online-Kopie. VACUUM INTO liest den aktuellen Stand
//    (inkl. WAL) und schreibt eine frische, konsistente DB-Datei – sicher,
//    während die App weiterläuft.
const dbPath = path.join(DATA_DIR, 'throwtostay.db');
const dbBackup = path.join(target, 'throwtostay.db');
{
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`VACUUM INTO '${dbBackup.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

// 2) Fotos: komplette (rekursive) Kopie.
await fsp.cp(path.join(DATA_DIR, 'photos'), path.join(target, 'photos'), { recursive: true });

// 3) Kleines Manifest (Zeitstempel + Quell-Pfade) für den Restore.
await fsp.writeFile(
  path.join(target, 'MANIFEST.txt'),
  `ThrowToStay Backup\nErstellt: ${new Date().toISOString()}\nQuell-DB: ${dbPath}\nQuell-Fotos: ${path.join(DATA_DIR, 'photos')}\n`
);

// 4) Retention: nur die letzten KEEP Backups behalten (ältere löschen).
//    ISO-Zeitstempel sortieren lexikografisch korrekt.
const all = (await fsp.readdir(BACKUP_DIR))
  .filter(f => f.startsWith('tts-backup-'))
  .sort();
while (all.length > KEEP) {
  await fsp.rm(path.join(BACKUP_DIR, all.shift()), { recursive: true, force: true });
}

console.log(`Backup erstellt: ${target} (behalten: ${Math.min(all.length, KEEP)})`);
