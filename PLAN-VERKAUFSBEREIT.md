# ThrowToStay → Verkaufsfertig

Ziel: eine absolut verkaufsfertige App — **sicher, zuverlässig, datenschutzkonform, easy to use, idiotensicher, responsive und stabil mit genug Fallbacks**.

Stand: `develop`-Branch (aus `main`/`7e32fbb` + Fixes). Production = `main` (tts.at-veranstaltungen.de).

Diese Datei ist ein lebender Fahrplan. Status: ⬜ offen · 🔶 in Arbeit · ✅ erledigt · ❓ zu klären.

---

## 1. Audit-Ergebnisse (Auf dem aktuellen Stand)

### 1.1 Sicherheit — insgesamt **gut**
| Bereich | Status | Anmerkung |
|---|---|---|
| Auth & Rollen | ✅ | Admin (Passwort→HMAC 8h), Organizer (Schlüssel→HMAC 7d, nur eigene Events), Gast (Session-ID + Browser-UUID). Constant-time Vergleich. |
| Rate-Limiting | ✅ | Login-Limiter pro IP (6 Fehlversuche→Block). ⚠️ In-memory (reset bei Neustart). |
| Input-Validierung | ✅ | Name/Datum/Limits/Qualität alles geclamped, Datum-Regex, UUID-Validierung. |
| Dateisicherheit | ✅ | Temp-Dir, zufällige Namen, Magic-Bytes (nur JPEG/PNG/WEBP), Path-Traversal-Schutz. |
| Krypto/Secrets | ✅ | Secret 32 Bytes (0600), HMAC-Tokens mit Expiry. `ADMIN_PASSWORD` Fail-Fast (kein Default). |
| TLS | ✅ | Zoraxy terminiert TLS; `trust proxy` nur für Zoraxy-IP. ⚠️ HSTS nicht gesetzt. |
| Deps | ✅ | 5 Dependencies, schlank, aktuell (Node 22). |
| XSS/SQLi/Leak | ✅ | CSP (keine Inline-Scripts), `frame-ancestors 'none'`, Prepared Statements, Fehlerhandler ohne Leaks. |

**Sicherheits-Lücken (priorisiert):**
1. ✅ `ADMIN_PASSWORD`-Default **entfernt** (Fail-Fast: Server startet ohne die Variable NICHT; `.env` + `.env.example`).
2. ⬜ **HSTS** auf Zoraxy setzen (prüfen, falls nicht da).
3. ✅ `?token=` in Query-String **eliminiert** → Bearer-only (Admin + Organizer); neuer Smoke-Test `?token=`→401.

### 1.2 Datenschutz (DSGVO) — insgesamt **die größte Lücke**
| Bereich | Status | Anmerkung |
|---|---|---|
| Dateninventar | ✅ | Vor-/Nachname (**optional** = anonym möglich) + **Fotos** (personenbezogen!) + Browser-UUID. |
| Datenminimierung | ✅ | Name optional (Gäste dürfen **anonym** beitreten); UUID pseudonymisiert; Retention begrenzt die Speicherung. |
| Retention | ✅ | **Konfigurierbare Auto-Löschung** pro Event (`retention_days`, Default 30; stündlicher Hintergrund-Job, `0` = manuell). |
| Recht auf Löschung (Art. 17) | 🔶 | **Per E-Mail-Prozess** (Gast → Veranstalter/Admin, manuell + dokumentiert); Veranstalter löscht Events/Fotos. Kein In-App-Endpoint (Schlank-Entscheidung). |
| Recht auf Auskunft (Art. 15) | 🔶 | **Per E-Mail-Prozess** (dokumentiert in Datenschutzerklärung). Kein In-App-Endpoint (Schlank-Entscheidung). |
| Einwilligung/Transparenz | ✅ | **Datenschutzerklärung** (`/datenschutz.html`) + **Consent-Schritt** im Onboarding (vor der Kamera); Link in der Box. |
| Fotos als Daten | ⚠️ | Gespeichert + geteilt (Galerie ab Freigabe) + downloadbar; **Consent des Gastes** jetzt vorhanden (Consent des *Abgebildeten* ist bei Party-Fotos praktisch nicht abbildbar → in Erklärung als „Galerie für alle Gäste" transparent gemacht). |
| Hosting-Standort | ✅ | EU/Deutschland (10.12.95.137, hinter Zoraxy) — in Datenschutzerklärung dokumentiert. |
| Verarbeitungsdoku | 🔶 | Datenschutzerklärung deckt Daten/Rechtsgrundlage/Retention/Rechte ab; formelle AVV/TVA optional (je nach Kundengruppe). |

**DSGVO-Lücken (priorisiert):**
1. ✅ **Datenschutzerklärung + Einwilligung** (Consent-Schritt vor der Kamera, Link zur Erklärung).
2. ✅ **Retention-Policy** (konfigurierbare Auto-Löschung nach N Tagen, pro Event).
3. 🔶 **Recht auf Löschung** — per E-Mail-Prozess (dokumentiert); kein In-App-Endpoint (Schlank).
4. 🔶 **Recht auf Auskunft** — per E-Mail-Prozess (dokumentiert); kein In-App-Endpoint (Schlank).
5. ✅ **Hosting-Standort** (EU) + Transparenz in Datenschutzerklärung.

### 1.3 Zuverlässigkeit & Stabilität — insgesamt **gut, mit Datenverlust-Risiken**
| Bereich | Status | Anmerkung |
|---|---|---|
| Upload-Pipeline (Client) | ✅ | Queue serialisiert Uploads, Retry-Banner, Filter-Variante best-effort im Hintergrund. |
| Fehlerbehandlung (Client) | ✅ | Diskrete Toasts, Retry-Banner, Kamera-Retry-Button. |
| Fehlerbehandlung (Server) | ✅ | JSON-Fehlerhandler (5xx generisch, 4xx kontrolliert), `console.error`. |
| Datenverlust | ✅ | **Atomare Uploads** (File + DB konsistent, Cleanup bei jedem Fehler) + **Backup** (nightly, DB + Fotos). |
| Kamera-Fehler | ✅ | Retry-Button, Fehlermeldung. |
| Netzwerk-Fehler | ✅ | Fetch-Timeout (AbortController: 15 s API / 90 s Upload) + diskrete Offline-Anzeige (dauerhaftes Banner, kein Toast). |
| Browser | ⚠️ | Kein PWA/Service-Worker; CSP + Permissions-Policy vorhanden. |
| Konkreuz | ✅ | Foto-Limit: Check + Insert atomar via `BEGIN IMMEDIATE` (kein Race bei parallelen Uploads); Dateiname mit Zufallssuffix. |
| Limits | ✅ | 20 MB/Datei, 2 Dateien, 39/User, 20000/Event. |
| Temp-Dir | ✅ | `data/tmp` wird beim Start geleert (Orphan-Sweep) + bei jedem Fehl-Upload (in-request Cleanup). |

**Stabilitäts-Risiken (priorisiert):**
1. ✅ **File-Write + DB-Insert atomar machen** (Cleanup bei jedem Fehler + Startup-Orphan-Sweep → kein Datenverlust).
2. ✅ **Backup** (DB via `VACUUM INTO` + Fotos, nightly per systemd-Timer, Retention 7; lokal, später Cloud).
3. ✅ **Timeout + Offline-Erkennung** (Client: AbortController-Timeout + Offline-Banner).
4. ✅ **Temp-Dir-Aufräumen** (`data/tmp` beim Start + in-request; periodic optional).
5. ✅ **Foto-Limit-Race** (Check + Insert atomar via `BEGIN IMMEDIATE`).

### 1.4 UX, Responsive & Idiotensicher — insgesamt **gut**
| Bereich | Status | Anmerkung |
|---|---|---|
| Onboarding | ✅ | Name-Abfrage (Vor-/Nachname), klar. |
| Feedback | ✅ | Toasts, Foto-Counter, Retry-Banner, Shutter-Animation. |
| Fehlermeldungen | ✅ | Gast-freundlich, kein Tech-Jargon. |
| Idiotensicher/Guardrails | ⚠️ | Event-/Foto-Löschung: Confirm vorhanden, aber **kein Undo**; Löschung mit Fotos ist final. |
| Responsive | ⚠️ | Mobile-first, aber nur **2 Breakpoints** (700/720px); Touch-Targets teils < 44px. |
| Performance | ✅ | Raster-Thumbnails (512px), Caching (Fotos), `100dvh`. |
| Barrierefreiheit | ⚠️ | event.html gut (13 aria/role/alt); admin/organizer dünn (je 1). |
| Sprache/Konsistenz | ✅ | **Kein „Fotobox"** im Code (Regel eingehalten). |
| Organizer/Admin-UX | ✅ | Wizard (5 Schritte), klare Schritte. |

**UX-Lücken (priorisiert):**
1. ⬜ **Guardrails**: Event-Löschung (Bestätigung per Wort-Eingabe, da Fotos final gelöscht werden); Undo wo möglich.
2. ⬜ **Responsive**: Touch-Targets ≥ 44px, Tablet-Breakpoint ergänzen.
3. ⬜ **A11y**: aria/role in admin/organizer ergänzen.
4. ⬜ **Klareres Feedback** nach erfolgreichem Upload („Foto gespeichert").

---

## 2. Die 3 größten Hebel (höchster Impact)

1. **DSGVO** (1.2) — ohne Consent/Retention/Löschung ist die App nicht verkäufbar (Rechtsrisiko).
2. **Kein Datenverlust** (1.3) — atomare Uploads + Backup; „keine verlorene Fotos" ist eine Kernanforderung.
3. **Idiotensicher** (1.4) — Guardrails bei destruktiven Aktionen; Gäste sollen eine sorglose Party erleben.

---

## 3. Fahrplan (Phasen)

> Reihenfolge: Fundament → Sicherheit → DSGVO → Stabilität → UX → Abnahme.
> Jede Phase ist deploybar (develop → main).

### Phase 0 — Fundament & Ablösung 🔶
- ✅ `develop`-Branch angelegt (aus `main`).
- ⬜ **Develop-Server** (eingerichtet von dir): eigener Test-Server für `develop`. → Deploy-Skript für `develop` analog zu `update.sh` (trackt `origin/develop` statt `main`).
- ⬜ **CI**: GitHub Actions (Smoke-Test bei jedem Push nach `develop`/`main`).
- ⬜ **Smoke-Flake** fixen: Timezone-Boundary („Freigabe = Folgetag 08:00") schlägt 00–08 Uhr CEST fehl (UTC-vs-lokal-Mitternacht).
- ⬜ **Tests erweitern** (laufend, nicht blockierend): Unit (event-helpers, util) + E2E (Upload-Flow).
- ⬜ **Doku**: Betriebs-Doku (Deploy, Backups) + Architektur-Skizze.

### Phase 1 — Sicherheit  *(erst, Server ist bereits extern erreichbar)*
- ✅ `ADMIN_PASSWORD`: **kein Default**; Start scheitert, wenn nicht gesetzt (`.env` + Check + `.env.example`).
- ✅ **`?token=` eliminieren**: Bearer-only (Admin + Organizer). Client war schon vollständig Bearer-basiert (QR/Downloads per `api()`+Blob) — nur Server-`tokenFromReq` + Smoke-Test angepasst. Neuer Test: `?token=`→401.
- ⬜ **HSTS** auf **Zoraxy** setzen (Infrastruktur, nicht App): `Strict-Transport-Security: max-age=31536000; includeSubDomains` — nur am TLS-Terminierungspunkt. ❓ prüfen, ob schon da.
- ⬜ Dependency-Updates: manuell, bei Bedarf (5 Deps). ❓ `npm outdated` hier nicht möglich (npm-Cache read-only) → auf Develop-Server prüfen.

### Phase 2 — Datenschutz (DSGVO, schlank) ✅ (Kern fertig)
- ✅ **Datenschutzerklärung**: `/datenschutz.html` (EU-Standort, welche Daten, Retention, Rechte, Kontakt) + Link im Onboarding.
- ✅ **Einwilligung**: Consent-Schritt (Schritt 0) im Onboarding **vor** der Kamera; „Weiter" erst nach Haken.
- ✅ **Anonyme Gäste**: Name optional; „Ohne Namen beitreten"-Button; Anzeige „Gast"; Server akzeptiert leere Namen (Datenminimierung).
- ✅ **Retention**: `retention_days` pro Event (Default 30, `0` = manuell) + stündlicher Auto-Löschung-Job; Feld im Expert-Panel (Admin + Veranstalter).
- ✅ **Löschung & Auskunft (Art. 15/17)**: **per E-Mail-Prozess** — in Datenschutzerklärung dokumentiert (Gast → Veranstalter). Kein In-App-Endpoint (Schlank-Entscheidung).
- ❓ **Gast löschet letztes Foto**: offen — Phase 4 (UX) klären; Standard = Löschung nur Veranstalter.
- 🔶 **Verarbeitungsdokumentation**: Datenschutzerklärung deckt Kern ab; formelle AVV optional.

### Phase 3 — Zuverlässigkeit & Stabilität  ✅ *(App-Level fertig; HA = eigener Infra-Track)*
- ✅ **Atomare Uploads**: Datei + DB konsistent (Cleanup bei jedem Fehler + Startup-Orphan-Sweep → kein Datenverlust).
- ✅ **Backup**: nightly `data/` (DB via `VACUUM INTO` + Fotos) → **lokal** (anderer Pfad/Disk), Retention 7, systemd-Timer (`scripts/backup.mjs`); später **Cloud** für Production. Restore-Test.
- ⬜ **HA**: Proxmox-HA für den Server (Infrastruktur-Ebene, eigener Track — nicht App-Backup).
- ✅ **Timeout + Offline**: Client (fetch-Timeout via AbortController, `navigator.onLine`, dauerhaftes Offline-Banner).
- ✅ **Temp-Dir-Aufräumen**: `data/tmp` bei Start (Orphan-Sweep) + in-request Cleanup (periodic optional).
- ✅ **Foto-Limit-Race**: Check + Insert atomar via `BEGIN IMMEDIATE` (parallele Uploads überschreiten das Limit nicht).

### Phase 4 — UX & Idiotensicher
- ⬜ **Guardrails**: Event-Löschung per Wort-Eingabe („EVENT" tippen), da Fotos final; Foto-Löschung nur Veranstalter (Gast max. letztes Foto, s. o.).
- ⬜ **Klareres Feedback**: „Foto gespeichert" nach erfolgreichem Upload.
- ⬜ **Responsive**: Touch-Targets ≥ 44px, Tablet-Breakpoint (~768/1024px).
- ⬜ **A11y**: aria/role/fokus-States in admin/organizer ergänzen.

### Phase 5 — Finale Abnahme
- ⬜ **Checkliste** durchgehen (alle Punkte dieser Datei ✅).
- ⬜ **Tests**: Smoke + E2E grün, Smoke-Flake behoben.
- ⬜ **Go-Live**: `develop` → `main` (Production) deployen, Live-Verifikation.

---

## 4. Entscheidungen (getroffen ✅)
1. **Deploy-Flow**: eigener **Develop-Server** zum Testen (du richtest ein); `main` = Production. `update.sh` (Production) trackt `origin/main`; neues Skript für Develop trackt `origin/develop`.
2. **DSGVO**: **schlank** — Erklärung + Einwilligung + Retention. Löschung & Auskunft **per E-Mail** (prozesshaft, dokumentiert), nicht in der App.
3. **Löschung**: **nur Veranstalter** löscht Fotos. Offen: darf der Gast sein **letztes** Foto selbst löschen?
4. **`?token=`**: **so sicher wie möglich** → eliminieren (Bearer + client-seitiger QR + fetch-Downloads).
5. **Backup**: anfangs **lokal** (nightly), später **Cloud** für Production. **Proxmox-HA** für den Server (eigener Track).
6. **Reihenfolge**: **Sicherheit zuerst** (Server ist extern erreichbar, aktuell nur Freunde/Bekannte).
