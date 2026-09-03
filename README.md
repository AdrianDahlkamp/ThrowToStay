# ThrowToStay 📸

Event-Fotobox als Webanwendung: Gäste scannen einen QR-Code, landen direkt in einer
Kamera-App im Browser, machen Fotos – und am Folgetag ab **08:00 Uhr** öffnet die
gemeinsame Galerie aller Gäste.

## Features

- **QR-Zugang**: Jedes Event bekommt eine zufällige Session-ID, die Teil der URL ist
  (`/e/<SESSION-ID>`). Der Admin-Panel erzeugt dazu einen QR-Code zum Verteilen/Drucken.
- **Nutzerkennung**: Beim ersten Aufruf generiert der Browser eine UUID und speichert sie
  dauerhaft im LocalStorage. Danach einmalig Vorname + Nachname eingeben.
- **Foto-Speicherung mit UUID**: Alle Fotos landen auf dem Server unter
  `data/photos/<event>/<uuid>/…` – jedes Bild ist damit eindeutig einem Gast zuordenbar
  (zusaätzlich als `manifest.csv` in jedem ZIP-Export).
- **Foto-Limit**: Standardmäßig max. 30 Fotos pro Gast – pro Event konfigurierbar im
  Admin-Panel.
- **Bildqualität konfigurierbar**: Auflösung (längste Seite, Standard 1600 px) und
  JPEG-Qualität (Standard 92 %) sind je Event im Admin-/Veranstalter-Panel einstellbar.
- **Drei Rollen**: **Admin** (Passwort, volle Kontrolle inkl. Schlüsselverwaltung),
  **Veranstalter** („User“ – meldet sich mit einem vom Admin generierten
  Zugangs-Schlüssel unter `/organizer` an und kann eigene Events anlegen/verwalten) und
  **Gast** (scannt den QR-Code und macht Fotos).
- **Galerie-Freigabe**: Vor der Freigabe sieht jeder Gast nur die eigenen Fotos. Am
  Folgetag um 08:00 Uhr (berechnet aus dem Event-Datum, manuell überschreibbar) sieht
  jeder Gast die gesamte Galerie aller Gäste des Events.
- **Namens-Overlay**: In der Galerie steht unten rechts auf jedem Bild der Name in
  Schreibschrift (Google-Font „Great Vibes“). Das Overlay ist rein kosmetisch (CSS) und
  wird **nicht** in die Bilddateien eingebrannt.
- **Einweg-Kamera-Filter**: Ein hochwertiger „Throwaway“-Look (Blitz-Belichtung,
  Halation um Lichter, angehobene Schwarzwerte, warmer Stich, Filmkorn, Vignette) –
  auswählbar bei der Aufnahme (mit Live-Vorschau) und auch nachträglich. Der Filter wird
  **nicht** ins Original eingebrannt: Original und gefilterte Version werden als getrennte
  Dateien gespeichert.
- **Zoom & Blitz**: Zoom-Slider (nativ über die Kamera, sonst digitaler Crop) und Blitz –
  als LED-Torch, wo das Gerät sie unterstützt, sonst als heller Screen-Flash-Fallback.
- **Kamera-Ansicht ohne Scrollen**: Feste Vollbild-Ansicht, alles ohne Scrollen sichtbar.
- **Anzeige & Download beider Varianten**: In der Galerie wird standardmäßig das Bild so
  angezeigt, wie es gemacht wurde. Zwei kleine runde Buttons pro Bild schalten zwischen
  „ohne Filter“ (Kreis-Icon) und „mit Filter“ (Funkeln-Icon) um; der Download-Button
  speichert immer die aktuell angezeigte Variante. In der Galerie wird der Nachname nur
  als Anfangsbuchstabe angezeigt („Adrian D.“).
- **Mehrfach-Auswahl**: Über „Auswählen“ werden die runden Buttons zu einer
  Mehrfachauswahl pro Variante – pro Bild frei entscheiden: NUR ohne Filter, NUR mit
  Filter oder beide. Dann als ZIP herunterladen (inkl. Manifest mit UUID/Zuordnung).

## Setup

Voraussetzung: Node.js ≥ 22.5 (nutzt das eingebaute `node:sqlite`), für HTTPS-Modus `openssl`.

```bash
npm install
npm start          # HTTP auf Port 3742
```

oder mit HTTPS (empfohlen, wenn Gäste per QR-Code mit dem Handy zugreifen – die
Browser-Kamera `getUserMedia` funktioniert nur unter HTTPS bzw. localhost):

```bash
npm run start:https   # erzeugt bei Bedarf ein selbstsigniertes Zertifikat unter data/
```

Beim ersten Aufruf des selbstsignierten Zertifikats zeigt das Handy eine Warnung –
einmal bestätigen. Für einen sauberen Auftritt ein echtes Zertifikat hinter einen
Reverse Proxy (z. B. Caddy/nginx) legen.

### Konfiguration (Umgebungsvariablen)

| Variable          | Bedeutung                                   | Standard               |
| ----------------- | ------------------------------------------- | ---------------------- |
| `TTS_PORT`        | Port des Servers                             | `3742`                 |
| `TTS_DATA_DIR`    | Datenordner (DB + Fotos)                     | `./data`               |
| `ADMIN_PASSWORD`  | Passwort für den Admin-Bereich               | `throwtostay-admin` ⚠️  |
| `TTS_HTTPS` / `--https` | HTTPS statt HTTP starten               | aus                    |

⚠️ Unbedingt ein eigenes `ADMIN_PASSWORD` setzen:

```bash
ADMIN_PASSWORD="mein-sicheres-passwort" npm start
```

## Bedienung

### Admin (`/admin`)

1. Mit `ADMIN_PASSWORD` anmelden. (Die Startseite `/` leitet zum Veranstalter-Login
   weiter – der Admin-Bereich liegt unter `/admin`.)
2. Event anlegen: **nur den Namen eingeben** – das Datum wird automatisch auf heute
   gesetzt, das Foto-Limit auf 30 (Standard). Es gibt hier bewusst keine
   Expert-Einstellungen; die werden erst je Event angepasst.
3. **Zugangs-Schlüssel für Veranstalter generieren** (mit Bezeichnung, z. B. Vereinsname)
   – Veranstalter melden sich damit unter `/organizer` an und verwalten ihre eigenen
   Events. Schlüssel sind sperbar (Login/Token sofort ungültig) und löschbar (nur
   solange keine Events zugeordnet sind).
4. QR-Code + Event-URL pro Event anzeigen, kopieren (Kopieren-Icon) oder als PNG
   herunterladen (Download-Icon).
5. Einstellungen je Event in zwei **Tabs**: „Einstellungen“ (Name, Datum) und
   „Expert-Einstellungen“ (Foto-Limit, **max. Bildgröße (px, längste Seite)**,
   **JPEG-Qualität (%)**, Galerie-Freigabe). Alle vier Expert-Felder tragen einen
   **Tooltip** mit Erklärung. Speichern = Disketten-Icon, „Galerie vorab freigeben“
   / „Galerie sperren“ schaltet die Freigabe.
6. „Teilnehmer anzeigen“ (Debug, im Expert-Tab) zeigt die Teilnehmerliste mit UUID +
   Fotoanzahl; „Alles exportieren (ZIP)“ lädt alle Fotos beider Varianten inkl.
   `manifest.csv` und `users.csv` herunter.

### Veranstalter (`/organizer`)

Mit Zugangs-Schlüssel anmelden → eigene Events anlegen und verwalten (QR-Code, Limits,
Bildqualität, Freigabe, Teilnehmerliste, Export). Einfacher Workflow: Event-Name
eingeben → Event entsteht mit Datum = heute und Standard-Limit 30, der QR-Code ist
sofort verfügbar. Einstellungen je Event liegen in zwei Tabs („Einstellungen“ /
„Expert-Einstellungen“), identisch zum Admin-Panel. Keine Schlüssel-Verwaltung,
keine fremden Events sichtbar.

### Gäste (`/e/<SESSION-ID>`)

1. QR-Code scannen → Namen eingeben (UUID liegt schon im LocalStorage).
2. Kamera: Filter auswählen (Live-Vorschau), Auslöser drücken → Upload von
   Original + gefilterter Variante; Zähler zeigt `x / 30` (Limit).
3. Galerie-Tab: eigene Fotos sofort; nach Freigabe alle Fotos aller Gäste.
4. Pro Foto: runder Kreis-Button = Variante ohne Filter, runder Funkeln-Button = mit
   Filter (umschaltbar), Download-Button für die angezeigte Variante.
5. „Auswählen“ → mehrere Fotos markieren → „Als ZIP herunterladen“.
6. Eigene Fotos: in der Großansicht den Filter auch nachträglich ändern oder entfernen.

## Architektur

```
src/server.js               Express-Server (HTTP/HTTPS, statisches Frontend, Fehlerbehandlung)
src/db.js                   SQLite-Schema (events, user_keys, users, photos) via node:sqlite
src/util.js                 Session-IDs, Zugangs-Schlüssel, Freigabe-Berechnung, Tokens
src/routes/public.js        Event-API: State/Registrierung, Upload, Galerie, Datei-Auslieferung,
                            Re-Filter, Sammel-Download-ZIP
src/routes/admin.js         Admin-API: Login, Events-CRUD, Veranstalter-Keys, QR, Export
src/routes/organizer.js     Veranstalter-API: Login mit Schlüssel, eigene Events verwalten
src/routes/event-helpers.js Geteilte Event-Logik (Anlegen/Aktualisieren/Löschen)
public/event.html + js/event.js             Kamera-App & Galerie
public/admin.html + js/admin.js             Admin-Panel (inkl. Schlüssel-Verwaltung)
public/organizer.html + js/organizer.js     Veranstalter-Panel
public/js/filters.js        Einweg-Kamera-Filter (CSS-Livevorschau + Canvas-Pipeline)
public/css/app.css          Gemeinsames Styling
test/smoke.mjs              Smoke-Tests aller Kernabläufe (npm test)
```

Die Foto-Dateien liegen bewusst als UUID-Pfadstruktur auf der Platte:
`data/photos/<event-session>/<user-uuid>/<zeitstempel>-<nr>-original.jpg` (bzw. `-filtered.jpg`).

## Tests

```bash
npm test
```

Prüft: Admin-Login, Event-Erstellung, QR-Auslieferung, Registrierung, Upload beider
Varianten (inkl. UUID-Ordner auf der Platte), Galerie-Sperre vor Freigabe, Re-Filter
(Besitzer vs. Fremde), konfigurierbares Foto-Limit pro User, konfigurierbare
Bildkomprimierung, Veranstalter-Keys (Anlegen, Login, Isolation, Sperren),
Freigabe-Logik, Sammel-Download-ZIP und Admin-Export.

## Bekannte Grenzen

- Die UUID ist an den Browser/LocalStorage gebunden: Löscht ein Gast seine Browserdaten
  oder wechselt das Gerät, entsteht eine neue Kennung (Fotos bleiben auf dem Server und
  sind über das Admin-Export-Manifest trotzdem zuordenbar, solange der Name stimmt).
- Ein Gerät = eine UUID: Teilen sich mehrere Gäste ein Gerät, landen ihre Fotos unter
  derselben Kennung (Namen sind pro Event frei wählbar/änderbar).
- Die Galerie-Freigabe „Folgetag 08:00 Uhr“ rechnet mit der lokalen Serverzeit.