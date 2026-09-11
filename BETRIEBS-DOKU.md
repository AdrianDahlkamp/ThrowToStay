# ThrowToStay — Betriebs-Dokumentation

> Lebende Doku für Betrieb, Wartung, Backup und Sicherheit der **ThrowToStay Event-App**.
> Stand: nach Go-Live-Vorbereitung. Änderungen bitte hier nachtragen.

---

## 1. Überblick

| | |
|---|---|
| **App** | ThrowToStay (Event-App) — Node.js/Express 5, SQLite (WAL, `node:sqlite`), Vanilla-JS-Frontend, 5 npm-Abhängigkeiten. |
| **Laufzeit** | Node 22 (`/usr/bin/node`). |
| **Server** | `10.12.95.137` (Proxmox-Gastsystem). App läuft **intern** auf Port **3742** (plain HTTP). |
| **TLS / Domain** | **Zoraxy** (Reverse-Proxy, TLS-Terminierung) → `https://tts.at-veranstaltungen.de` → `http://10.12.95.137:3742`. |
| **Daten** | `/opt/throwtostay/data` — DB + Fotos (einzige kritische Daten). |
| **Service** | systemd `throwtostay` (User `throwtostay`), `Restart=on-failure`. |
| **Rollen** | Gast (Event-Link/QR), Veranstalter (8-Char-Key), Admin (ENV-Passwort). |

**Kernprinzipien:** keine Fotos dürfen verloren gehen · Gäste sollen eine „sorglose Party" haben (Fehler laufen im Hintergrund, keine Toast-Flut) · Sicherheit & DSGVO haben Vorrang.

---

## 2. Zugänge & Logins

| Rolle | URL (extern) | Zugriff | Gültigkeit |
|---|---|---|---|
| **Gast** | `https://tts.at-veranstaltungen.de/e/<sessionId>` | per Event-Link / QR-Code | Session-Id + Browser-UUID |
| **Veranstalter** | `https://tts.at-veranstaltungen.de/organizer` | 8-stelliger Event-Key | HMAC, 7 Tage |
| **Admin** | `https://tts.at-veranstaltungen.de/admin` | `ADMIN_PASSWORD` aus `.env` | HMAC, 8 Stunden |

- **Admin-Passwort** liegt in `/opt/throwtostay/.env` (`ADMIN_PASSWORD`). Es ist der **Master-Zugriff** — sicher aufbewahren (Passwort-Manager). Es gibt **keinen Standard** — fehlt es, startet der Server nicht (bewusst).
- **Veranstalter-Keys** werden im Organizer-UI pro Event erzeugt/gezeigt.
- Alle Auth-Endpunkte sind **Bearer-only** (kein `?token=` im URL, kein Session-Cookie).

---

## 3. Deployment

### Branch-Strategie
- **`main`** = Production (was auf dem Server läuft).
- **`develop`** = Entwicklung (alle Features/Tests, bevor sie in Production gehen).
- `main` ist Vorfahre von `develop` → **fast-forward** Go-Live möglich (kein Merge-Konflikt).

### Normaler Deploy (Production)
Auf dem Server (als root):
```bash
bash /opt/throwtostay/scripts/update.sh
```
Verhalten: ff-only-Merge von `origin/main` · npm-Update nur bei `package.json`-Änderung · `chown` auf Service-User · Service-Restart · Health-Check (15×) · **automatischer Rollback** auf den vorherigen guten Stand bei jedem Fehler.

### Hotfix-Procedure (dringende Fixes, wie z. B. der Kamera-Fix)
1. Fix auf **`develop`** machen → Smoke-Test (`node test/smoke.mjs`) → commit + push `develop`.
2. Fix auf **`main`** cherry-picken → commit + push `main`.
3. Auf dem Server: `bash /opt/throwtostay/scripts/update.sh`.
4. Verifizieren (Health-Check + ggf. ausgelieferte Datei prüfen).

### Manueller Rollback
```bash
# Letzter bekannt-guter Stand auf main:
git -C /opt/throwtostay reset --hard origin/main
chown -R throwtostay:throwtostay /opt/throwtostay/src /opt/throwtostay/public
systemctl restart throwtostay
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3742/event.html   # → 200
```
(`update.sh` macht genau das automatisch, wenn ein Deploy fehlschlägt.)

### Go-Live (develop → main)
```bash
# Lokal: develop nach main (fast-forward)
git push origin develop:main        # oder: main auf develop-Stand bringen
# Auf dem Server:
bash /opt/throwtostay/scripts/update.sh
```
**Vor dem Go-Live:** (a) Backup auf externes Gerät, (b) HSTS auf Zoraxy, (c) grünes Licht.

---

## 4. Backup (auf externes Gerät)

> **Entscheidung:** Backups gehen auf ein **externes Gerät** (lokal auf derselben Platte = nur logischer Schutz, wenig Sinn). Die DB + Fotos sind die einzigen kritischen Daten.
>
> **Status: Ziel-Gerät wird noch eingerichtet (nach hinten verschoben).** Bis es steht, gibt es **keine automatische Sicherung** — manuelle Backup-Läufe per `backup.mjs` sind aber jederzeit möglich (§4.2). **Vor dem Go-Live** einmalig manuell sichern (§12). Geplanter Rhythmus nach Einrichtung: **täglich**.

### 4.1 Backup-Script
`/opt/throwtostay/scripts/backup.mjs` erzeugt eine **konsistente, restorable** Kopie:
- **DB:** `VACUUM INTO` (WAL-sicher, kein `sqlite3`-CLI nötig, läuft, während die App weiterläuft).
- **Fotos:** komplette rekursive Kopie von `data/photos`.
- **Manifest:** `MANIFEST.txt` (Zeitstempel + Quell-Pfade).
- Ergebnis: Verzeichnis `tts-backup-<Zeitstempel>/` mit `throwtostay.db` + `photos/` + `MANIFEST.txt`.

### 4.2 Workflow (empfohlen: täglich + nach jedem Event)
```bash
# 1) Backup lokal erzeugen:
TTS_DATA_DIR=/opt/throwtostay/data \
TTS_BACKUP_DIR=/opt/throwtostay/backups \
TTS_BACKUP_KEEP=1 \
node /opt/throwtostay/scripts/backup.mjs
# → erzeugt /opt/throwtostay/backups/tts-backup-<ts>/

# 2) Auf das externe Gerät übertragen (je nach Ziel, s. 4.3):
#    <Transfer-Befehl>

# 3) (optional) lokale Kopie aufräumen, damit kein Platz verbraucht wird:
rm -rf /opt/throwtostay/backups/tts-backup-<ts>
```

### 4.3 Übertragung auf das externe Gerät
*(Ziel-Gerät wird noch eingerichtet — konkreter Befehl wird hier eingetragen, sobald das Ziel steht. Die Varianten zur Orientierung:)*

- **A — NAS / anderer Rechner (SSH erreichbar):**
  ```bash
  rsync -az /opt/throwtostay/backups/tts-backup-<ts>/ user@nas.example:/backup/throwtostay/
  ```
- **B — Externe Platte (per Mount-Point am Server angebunden, z. B. `/mnt/backup`):**
  ```bash
  rsync -az /opt/throwtostay/backups/tts-backup-<ts>/ /mnt/backup/throwtostay/
  ```
- **C — S3-kompatible Cloud (rclone):**
  ```bash
  rclone copy /opt/throwtostay/backups/tts-backup-<ts>/ <remote>:<bucket>/throwtostay/
  ```

> **Regel:** Mindestens ein gültiges, **externes** Backup, bevor ein Event stattfindet / bevor ein Go-Live deployed wird.

---

## 5. Restore (aus einem Backup)

> Nur nötig, wenn Daten verloren/korrumpiert sind oder der Server neu aufgesetzt wird. **Immer vorher den aktuellen Stand sichern.**

```bash
# 1) Service stoppen
systemctl stop throwtostay

# 2) Aktuellen Stand sichern (Sicherheitsnetz)
cp -a /opt/throwtostay/data "/opt/throwtostay/data.before-restore-$(date +%Y%m%d%H%M%S)"

# 3) Backup-Inhalt in das Datenverzeichnis kopieren
#    <backup> = Pfad zum tts-backup-<ts>/ (throwtostay.db + photos/)
cp -a <backup>/throwtostay.db <backup>/photos /opt/throwtostay/data/

# 4) Ownership setzen (Service muss lesen/schreiben können)
chown -R throwtostay:throwtostay /opt/throwtostay/data

# 5) Service starten
systemctl start throwtostay

# 6) Health-Check
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3742/event.html   # → 200
```
Falls es doch schiefgeht: Schritt 2 rückgängig machen (`data` wieder aus `data.before-restore-…` kopieren) und den alten Stand starten.

---

## 6. Monitoring & Health

| Zweck | Befehl (auf dem Server) |
|---|---|
| **Health (intern)** | `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3742/event.html` → `200` = gesund |
| **Service-Status** | `systemctl status throwtostay` |
| **Logs (letzte Zeilen)** | `journalctl -u throwtostay -n 100 --no-pager` |
| **Port aktiv?** | `ss -ltnp \| grep 3742` |
| **Plattenplatz** | `df -h /opt` (Daten leben unter `/opt/throwtostay/data`) |
| **Extern (über Zoraxy)** | `curl -sI https://tts.at-veranstaltungen.de/e/` → HTTP 200/302 |

**Hinweis:** Es gibt keinen dedizierten `/health`-Endpunkt; `event.html` (200) ist der Health-Check. Root `/` → `302` → `/organizer`.

---

## 7. DSGVO / Betrieb

- **Einwilligung:** Gäste bestätigen die Datenschutzerklärung (`/datenschutz.html`) über eine Pflicht-Checkbox, bevor sie teilnehmen.
- **Retention:** pro Event `retention_days` (Default **30**, `0` = manuell, max 365). Ein stündlicher Hintergrund-Job **und** einmal beim Server-Start löschen Events, deren Speicherdauer abgelaufen ist (`Event-Datum + retention_days`).
- **Löschung / Auskunft (Art. 15/17): per E-Mail-Prozess** (bewusste „schlanke" Entscheidung, kein In-App-Endpoint):
  - *Löschungsanfrage (Gast → Veranstalter):* Veranstalter öffnet das Event im Organizer-UI → betroffenes Foto (`Fotos verwalten` → Papierkorb) oder das ganze Event löschen.
  - *Auskunftsanfrage:* Teilnehmer-/Fotodaten pro Event aus dem Organizer-UI; Ergebnis per E-Mail an den Gast.
- **Verarbeitungsdokumentation:** Datenschutzerklärung deckt Daten, Rechtsgrundlage, Retention und Betroffenenrechte ab. Formelle AVV/TVA optional (je nach Kundengruppe).

---

## 8. Sicherheit (Kurzüberblick)

- **Admin** = ENV-Passwort → HMAC-Tokens (8 h). **Veranstalter** = 8-Char-Key → HMAC (7 d). **Gäste** = Session-Id + Browser-UUID.
- **Schutz-Mechanismen:** Constant-Time-Vergleich, magic-byte-Sniffing beim Upload, Dateinamen-Sanitizing, in-memory Rate-Limiting (6 Fehlversuche → Block), CSP (kein Inline-JS), Prepared Statements, Bearer-only-Auth.
- **Upload-Limits:** `MAX_UPLOAD_BYTES` = 20 MB, max 20.000 Fotos/Event, max 500 Dateien pro ZIP-Download.
- **Zoraxy:** TLS-Terminierung + (empfohlen) **HSTS** (siehe §11). App selbst läuft intern plain-HTTP (bewusst, TLS nur am Proxy).

---

## 9. Wichtige Pfade & Env-Keys

| Pfad / Key | Bedeutung |
|---|---|
| `/opt/throwtostay` | App-Root (git-Checkout, User `throwtostay`). |
| `/opt/throwtostay/data` | **Datenverzeichnis** (DB + Fotos). |
| `/opt/throwtostay/data/throwtostay.db` | SQLite-DB (+ `-wal`/`-shm` dazu). |
| `/opt/throwtostay/data/photos` | Foto-Dateien (Original, Thumb, Filter-Variante). |
| `/opt/throwtostay/.env` | Env-Keys: `ADMIN_PASSWORD`, `TTS_PORT` (3742), `TTS_HTTPS` (0). |
| `/opt/throwtostay/scripts/` | `update.sh` (Deploy), `backup.mjs` (Backup). |
| systemd `throwtostay` | Service (`User=throwtostay`, `EnvironmentFile=/opt/throwtostay/.env`). |

**Foto-Varianten pro Aufnahme:** `-original.<ext>` (DB) · `-original-thumb.<ext>` (abgeleitet) · `-filtered.<ext>` (nur, wenn mit Filter).

---

## 10. Troubleshooting

| Symptom | Diagnose / Maßnahme |
|---|---|
| **Service startet nicht** | `journalctl -u throwtostay -n 50`. Häufigste Ursache: `ADMIN_PASSWORD` in `.env` fehlt (Server startet dann bewusst nicht). |
| **Intern nicht erreichbar** | `curl http://127.0.0.1:3742/event.html`. Port aktiv? `ss -ltnp \| grep 3742`. |
| **Extern (TLS) nicht erreichbar** | Zoraxy prüfen: Zertifikat gültig? Proxy-Regel weist `tts.at-veranstaltungen.de` auf `10.12.95.137:3742`? |
| **Uploads hängen / Fehler** | Dateigröße (max 20 MB)? Rate-Limit? Plattenplatz (`df -h /opt`)? |
| **Kamera (Huawei)** zoomt extrem | Bereits gefixt: Auflösungs-Hint entfernt (Commit `b7a9195`/`dac247c`). Ohne Fix wählt Multi-Kamera-Huawei den Telephoto-Sensor. |
| **Daten korrumpiert / verloren** | Restore aus letztem Backup (s. §5). Vorher aktuellen Stand sichern. |
| **Event wird unerwartet gelöscht** | Retention prüfen: `retention_days` des Events (Default 30). Für zu behaltende Events auf `0` (manuell) setzen. |

---

## 11. HSTS auf Zoraxy (einmalig)

Siehe die separate **HSTS-Anleitung** (Schritt-für-Schritt für die Zoraxy-Konfiguration). Kurz: `Strict-Transport-Security`-Header am TLS-Server-Block (443) von `tts.at-veranstaltungen.de` setzen.

---

## 12. Checkliste: nach jedem Event / vor Go-Live

- [ ] **Einmaliges Backup vor Go-Live** (manuell, §4.2) → an einem sicheren (externen) Ort aufbewahren; tägliches externes Backup folgt, sobald das Ziel-Gerät steht.
- [ ] **Health-Check** grün (s. §6).
- [ ] **Plattenplatz** ausreichend (`df -h /opt`).
- [ ] **Retention** der Events sinnvoll gesetzt (keine ungewollte Auto-Löschung).
- [ ] **Admin-Passwort** sicher aufbewahrt (nicht im Chat/Repositoy liegen).
- [ ] **DSGVO:** Datenschutzerklärung erreichbar, Retention korrekt.
