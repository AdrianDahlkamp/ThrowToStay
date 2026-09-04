#!/usr/bin/env bash
#
# ThrowToStay-Update: zieht den aktuellen Stand von main (GitHub) und setzt ihn um.
#
# Ausführung (als root auf dem Server):
#   bash /opt/throwtostay/scripts/update.sh
#
# Verhalten:
#   - ff-only Merge (kein Force, keine lokalen Commits überschrieben)
#   - npm-Abhängigkeiten NUR aktualisieren, wenn sich package*.json geändert haben
#   - Ownership von src/public auf den Service-User setzen (Service kann lesen)
#   - Service neu starten + Health-Check
#   - Bei jedem Fehler: automatischer Rollback auf den vorherigen (guten) Commit
#
set -uo pipefail

APP_DIR=/opt/throwtostay
SERVICE=throwtostay
APP_USER=throwtostay
PORT=3742

# root darf Git auf dem Repo betreiben, das dem Service-User gehört:
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || \
  git config --global --add safe.directory "$APP_DIR"

cd "$APP_DIR" || { echo "!! $APP_DIR nicht gefunden."; exit 1; }

# Liefert 0, wenn die App auf 127.0.0.1:$PORT antwortet (sonst 1).
wait_healthy() {
  local i
  for i in $(seq 1 15); do
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/event.html"; then return 0; fi
    sleep 1
  done
  return 1
}

# Rollback auf den letzten guten Stand (best-effort).
BEFORE=""
rollback() {
  echo "!! Fehler – Rollback auf ${BEFORE:0:7}"
  git reset --hard "$BEFORE" >/dev/null 2>&1
  chown -R "$APP_USER:$APP_USER" src public 2>/dev/null
  systemctl restart "$SERVICE" 2>/dev/null
  if wait_healthy; then
    echo "Rollback OK – $SERVICE läuft wieder auf $(git rev-parse --short HEAD)."
  else
    echo "!! Rollback konnte den Service NICHT wieder starten – jetzt manuell prüfen!"
    systemctl --no-pager -n 30 status "$SERVICE" 2>&1 || true
  fi
  echo "Hinweis: origin/main zeigt weiter auf den fehlerhaften Commit – dort den Fix committen und update erneut ausführen."
}

BEFORE=$(git rev-parse HEAD)

# Working Tree: lokale Änderungen an TRACKED Dateien blockieren (nichts
# überschreiben). Untracked-Dateien stören nicht (Konflikte fängt der Merge).
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "!! Working Tree hat lokale Änderungen – Update abgebrochen (manuell klären):"
  git status --short
  exit 1
fi

git fetch -q origin main || { echo "!! git fetch fehlgeschlagen."; exit 1; }
AFTER=$(git rev-parse origin/main)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "Bereits aktuell auf ${BEFORE:0:7} – nichts zu tun."
  exit 0
fi

echo "Update: ${BEFORE:0:7} -> ${AFTER:0:7}"

# 1) Code aktualisieren (nur Fast-Forward).
git merge --ff-only origin/main >/dev/null 2>&1 || { rollback; exit 1; }

# 2) npm-Abhängigkeiten nur bei package-Änderung.
if ! git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json; then
  echo "npm-Abhängigkeiten aktualisieren …"
  npm ci >/dev/null 2>&1 || { rollback; exit 1; }
fi

# 3) App-Code für den Service-User lesbar machen (git legt Dateien als root an).
chown -R "$APP_USER:$APP_USER" src public 2>/dev/null

# 4) Neustart + Health-Check.
systemctl restart "$SERVICE"
if wait_healthy; then
  echo "OK – $SERVICE läuft auf $(git rev-parse --short HEAD)."
  exit 0
fi

rollback
exit 1
