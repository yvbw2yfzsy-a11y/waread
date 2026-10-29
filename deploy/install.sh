#!/usr/bin/env bash
# install.sh - waread auf dem Raspberry Pi installieren (als root ausführen)
#
# Dieses Skript liegt im Release-Verzeichnis unter deploy/ und installiert genau
# dieses Release. Es
#   1. prüft Voraussetzungen und den "Release-Vertrag" (siehe deploy/README.md),
#   2. legt den Systembenutzer "waread" und alle Verzeichnisse mit festen Rechten an,
#   3. kopiert das Release nach /opt/waread/releases/<version> und setzt /opt/waread/current,
#   4. installiert die systemd-Units, den Updater und das Nginx-Snippet,
#   5. prüft die Nginx-Konfiguration (nginx -t) und aktiviert die Dienste erst danach.
#
# Es fasst NICHTS am Craft-System an: weder /usr/local/bin/craft-update noch
# /var/lib/craft noch /var/www/craft noch dessen systemd-Einheiten. Es legt nur
# Dateien unter /opt/waread, /etc/waread, /var/lib/waread, /etc/systemd/system/waread-*,
# /etc/nginx/snippets/waread.conf und /usr/local/sbin/waread-update an.
#
# Aufruf:  sudo ./deploy/install.sh [--version X.Y.Z] [--skip-nginx] [--no-start] [--node PFAD]
#   --version X.Y.Z  Version überschreiben (sonst Datei VERSION, sonst package.json)
#   --skip-nginx     Nginx-Schritte (nginx -t, Snippet, Reload) auslassen
#   --no-start       Dienste nur aktivieren (für den nächsten Boot), nicht starten
#   --node PFAD      Node-Programm, dessen Version geprüft wird (nur nötig, wenn Node 22 getrennt vom System
#                    installiert ist, z. B. /opt/waread/node-22/bin/node). Die Units starten dann trotzdem
#                    'env node'; sie brauchen ein Drop-in mit dem vollen Pfad (docs/INSTALL.md, Abschnitt 3).
#
# Das Skript ist wiederholbar: Vorhandene Konfiguration, Daten und bereits
# installierte Release-Verzeichnisse werden nie überschrieben.

set -Eeuo pipefail
umask 022

# ---------------------------------------------------------------- Konstanten
readonly WAREAD_USER="waread"
readonly OPT_ROOT="/opt/waread"
readonly RELEASES_DIR="$OPT_ROOT/releases"
readonly CURRENT_LINK="$OPT_ROOT/current"
readonly STATE_DIR="$OPT_ROOT/state"
readonly LOCK_FILE="$STATE_DIR/update.lock"
readonly ETC_DIR="/etc/waread"
readonly CONFIG_FILE="$ETC_DIR/config.toml"
readonly DATA_DIR="/var/lib/waread"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly NGINX_SNIPPET_DST="/etc/nginx/snippets/waread.conf"
readonly UPDATER_DST="/usr/local/sbin/waread-update"

# Gleicher PATH wie in den Units (Environment=PATH=...): Was hier gefunden wird,
# finden auch die Dienste.
readonly SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
# Mindestens Node.js 22.12: so steht es in den engines-Feldern der package.json-Dateien (getestet wurde
# mit 22.23.4). Raspberry Pi OS (Debian Bookworm) liefert per apt nur Node 18,
# Node 22 muss separat installiert werden (docs/INSTALL.md).
readonly MIN_NODE_MAJOR=22
readonly MIN_NODE_MINOR=12
# Standard-Port 8780 ist eine Festlegung dieses Pakets (siehe README); er muss
# zu /etc/waread/config.toml und zu deploy/nginx/waread.conf passen.
readonly DEFAULT_HEALTH_URL="http://127.0.0.1:8780/healthz"

# Release-Vertrag: Diese Dateien/Ordner müssen im Release vorhanden sein.
# (Entsteht durch "npm run build" und "npm run prune:prod"; deploy/make-release.sh packt ihn. Siehe README, "Release-Vertrag".)
readonly REQUIRED_RELEASE_FILES=(
  "services/ingest/dist/index.js"
  "services/web/dist/server.js"
  "services/web/public/dist/index.html"
  "cleanup/dist/cleanup.js"
  "db/dist/client.js"
  "db/schema.sql"
  "config/config.example.toml"
  "package-lock.json"
  "deploy/waread-update"
  "deploy/nginx/waread.conf"
)
readonly REQUIRED_RELEASE_DIRS=("node_modules" "node_modules/@waread/db")

readonly UNITS_TO_INSTALL=(
  waread-ingest.service
  waread-web.service
  waread-cleanup.service
  waread-cleanup.timer
  waread-cleanup-vacuum.service
  waread-cleanup-vacuum.timer
  waread-update.service
  waread-update.timer
)
# Wird aktiviert. waread-update.timer gehört absichtlich NICHT dazu.
readonly UNITS_TO_ENABLE=(
  waread-ingest.service
  waread-web.service
  waread-cleanup.timer
  waread-cleanup-vacuum.timer
)

# ---------------------------------------------------------------- Hilfsfunktionen
log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARNUNG: %s\n' "$*" >&2; }
die()  { printf '[install] FEHLER: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }

# Sicherungsnetz: Kein von diesem Skript verwalteter Pfad darf je das Craft-System berühren.
for _p in "$OPT_ROOT" "$ETC_DIR" "$DATA_DIR" "$SYSTEMD_DIR" "$NGINX_SNIPPET_DST" "$UPDATER_DST"; do
  case "$_p" in *craft*) printf 'Interner Fehler: Pfad %s berührt das Craft-System\n' "$_p" >&2; exit 70 ;; esac
done
unset _p

# Löscht nur Verzeichnisse direkt unter /opt/waread/releases/.
safe_remove_release_tree() {
  local p=$1
  case "$p" in
    "$RELEASES_DIR"/*) ;;
    *) die "Interner Fehler: verweigere Löschen außerhalb von $RELEASES_DIR: $p" ;;
  esac
  case "$p" in *..*|*craft*) die "Interner Fehler: verweigere Löschen von $p" ;; esac
  rm -rf --one-file-system -- "$p"
}

STAGING_DIR=""
cleanup_on_exit() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    safe_remove_release_tree "$STAGING_DIR" || true
  fi
}
trap cleanup_on_exit EXIT

ensure_dir() { # ensure_dir MODE OWNER GROUP PFAD  (setzt Rechte auch bei vorhandenem Verzeichnis)
  install -d -m "$1" -o "$2" -g "$3" "$4"
  chmod "$1" "$4"
  chown "$2:$3" "$4"
}

check_release_contract() { # check_release_contract VERZEICHNIS
  local root=$1 f missing=0
  for f in "${REQUIRED_RELEASE_FILES[@]}"; do
    if [ ! -f "$root/$f" ]; then warn "Im Release fehlt: $f"; missing=1; fi
  done
  for f in "${REQUIRED_RELEASE_DIRS[@]}"; do
    if [ ! -d "$root/$f" ]; then warn "Im Release fehlt Ordner: $f"; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then
    die "Das Release erfüllt den Release-Vertrag nicht (README, Abschnitt \"Release-Vertrag\"). Es wurde nichts installiert."
  fi
}

# ---------------------------------------------------------------- Argumente
VERSION=""
SKIP_NGINX=0
START_NOW=1
NODE_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version)    [ $# -ge 2 ] || die "--version braucht einen Wert"; VERSION=$2; shift 2 ;;
    --skip-nginx) SKIP_NGINX=1; shift ;;
    --no-start)   START_NOW=0; shift ;;
    --node)       [ $# -ge 2 ] || die "--node braucht einen Pfad"; NODE_BIN=$2; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Unbekannte Option: $1 (siehe --help)" ;;
  esac
done

# ---------------------------------------------------------------- Voraussetzungen
[ "$(id -u)" -eq 0 ] || die "Bitte als root ausführen (sudo)."
[ -d /run/systemd/system ] || die "systemd läuft nicht; waread braucht systemd."

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
RELEASE_SRC=$(cd "$SCRIPT_DIR/.." && pwd -P)

for c in install useradd getent flock cmp mktemp tar find systemctl; do
  command -v "$c" >/dev/null 2>&1 || die "Benötigtes Programm fehlt: $c"
done

if [ -z "$NODE_BIN" ]; then NODE_BIN=$(env PATH="$SERVICE_PATH" sh -c 'command -v node' 2>/dev/null || true); fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] \
  || die "Node.js nicht gefunden (gesucht in PATH=$SERVICE_PATH). Die Units starten 'env node'. Getrennte Installation: --node PFAD."
node_version=$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null) \
  || die "$NODE_BIN lässt sich nicht ausführen."
node_major=${node_version%%.*}
node_minor=${node_version#*.}; node_minor=${node_minor%%.*}
{ [ "$node_major" -gt "$MIN_NODE_MAJOR" ] || { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -ge "$MIN_NODE_MINOR" ]; }; } 2>/dev/null \
  || die "Node.js $node_version gefunden, benötigt wird mindestens $MIN_NODE_MAJOR.$MIN_NODE_MINOR (PATH=$SERVICE_PATH)."
if ! env PATH="$SERVICE_PATH" sh -c 'command -v ffmpeg' >/dev/null 2>&1; then
  warn "ffmpeg nicht gefunden (PATH=$SERVICE_PATH). Die Audio-Konvertierung im Ingest-Dienst wird scheitern."
fi

if [ "$SKIP_NGINX" -eq 0 ]; then
  command -v nginx >/dev/null 2>&1 || die "nginx nicht gefunden. Mit --skip-nginx ohne Nginx-Schritte fortfahren."
fi

if [ -z "$VERSION" ]; then
  if [ -r "$RELEASE_SRC/VERSION" ]; then
    VERSION=$(tr -d ' \t\r\n' < "$RELEASE_SRC/VERSION")
  elif [ -r "$RELEASE_SRC/package.json" ]; then
    VERSION=$("$NODE_BIN" -p 'require(process.argv[1]).version' "$RELEASE_SRC/package.json" 2>/dev/null) || VERSION=""
  fi
fi
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Keine gültige Version (erwartet X.Y.Z, gefunden: '${VERSION}'). Mit --version angeben."

check_release_contract "$RELEASE_SRC"
for u in "${UNITS_TO_INSTALL[@]}"; do
  [ -f "$RELEASE_SRC/deploy/systemd/$u" ] || die "Unit-Datei fehlt im Release: deploy/systemd/$u"
done

log "Installiere waread $VERSION aus $RELEASE_SRC"

# ---------------------------------------------------------------- Systembenutzer
if getent passwd "$WAREAD_USER" >/dev/null; then
  shell=$(getent passwd "$WAREAD_USER" | cut -d: -f7)
  case "$shell" in
    /usr/sbin/nologin|/sbin/nologin|/bin/false|/usr/bin/false) ;;
    *) warn "Benutzer $WAREAD_USER hat die Login-Shell '$shell'. Erwartet: /usr/sbin/nologin. Wird nicht verändert." ;;
  esac
  log "Benutzer $WAREAD_USER ist bereits vorhanden"
else
  useradd --system --no-create-home --home-dir "$DATA_DIR" \
          --shell /usr/sbin/nologin --user-group "$WAREAD_USER"
  log "Benutzer $WAREAD_USER angelegt"
fi

# ---------------------------------------------------------------- Verzeichnisse
ensure_dir 0755 root root "$OPT_ROOT"
ensure_dir 0755 root root "$RELEASES_DIR"
ensure_dir 0755 root root "$STATE_DIR"      # Statusdateien des Updaters (root-eigen, lesbar)

# Gleiche Sperre wie waread-update: Installation und Update laufen nie gleichzeitig.
exec 9>"$LOCK_FILE"
chmod 0600 "$LOCK_FILE"
flock -n 9 || die "waread-update oder ein anderer install.sh-Lauf ist aktiv. Bitte später erneut versuchen."

ensure_dir 0750 root "$WAREAD_USER" "$ETC_DIR"

ensure_dir 0750 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR"
ensure_dir 0750 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR/db"
# 0700 statt 0600: Ein Verzeichnis ohne x-Recht ließe sich nicht betreten. Die Dateien
# darin bekommen 0600. Die Sitzungsschlüssel gehören NIE in ein Backup.
ensure_dir 0700 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR/auth"
chown -R "$WAREAD_USER:$WAREAD_USER" "$DATA_DIR/auth"
find "$DATA_DIR/auth" -type d -exec chmod 0700 {} +
find "$DATA_DIR/auth" -type f -exec chmod 0600 {} +
ensure_dir 0750 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR/media"
ensure_dir 0750 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR/media/avatars"
ensure_dir 0700 "$WAREAD_USER" "$WAREAD_USER" "$DATA_DIR/tmp"
log "Verzeichnisse und Rechte gesetzt"

# ---------------------------------------------------------------- Konfiguration
NEW_CONFIG=0
if [ ! -e "$CONFIG_FILE" ]; then
  [ -r "$RELEASE_SRC/config/config.example.toml" ] \
    || die "$CONFIG_FILE fehlt und das Release enthält keine config/config.example.toml."
  install -m 0640 -o root -g "$WAREAD_USER" "$RELEASE_SRC/config/config.example.toml" "$CONFIG_FILE"
  NEW_CONFIG=1
  log "Konfiguration aus config.example.toml angelegt: $CONFIG_FILE"
else
  chown root:"$WAREAD_USER" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
  log "Vorhandene Konfiguration bleibt unverändert (nur Rechte auf 0640 root:$WAREAD_USER gesetzt)"
fi

# ---------------------------------------------------------------- Release kopieren
TARGET_DIR="$RELEASES_DIR/$VERSION"
if [ -e "$TARGET_DIR" ]; then
  log "Release $VERSION ist bereits vorhanden und wird nicht überschrieben (zum Neuinstallieren erst $TARGET_DIR entfernen)."
  check_release_contract "$TARGET_DIR"
else
  STAGING_DIR=$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")
  (cd "$RELEASE_SRC" && tar --exclude=./.git -cf - .) | tar -C "$STAGING_DIR" --no-same-owner -xf -
  # setuid/setgid VOR dem chown prüfen: chown unter Linux löscht diese Bits stillschweigend.
  if [ -n "$(find "$STAGING_DIR" -perm /6000 -print -quit)" ]; then
    die "Das Release enthält setuid/setgid-Dateien. Abbruch."
  fi
  chown -R root:root "$STAGING_DIR"
  chmod -R go-w "$STAGING_DIR"
  chmod -R a+rX "$STAGING_DIR"
  mv -T "$STAGING_DIR" "$TARGET_DIR"
  STAGING_DIR=""
  log "Release nach $TARGET_DIR kopiert"
fi

# ---------------------------------------------------------------- current-Symlink (atomar)
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK existiert, ist aber kein Symlink. Bitte von Hand prüfen."
fi
PREVIOUS=""
if [ -L "$CURRENT_LINK" ]; then PREVIOUS=$(readlink "$CURRENT_LINK" || true); fi
tmp_link="$OPT_ROOT/.current.new.$$"
ln -s "releases/$VERSION" "$tmp_link"
mv -T "$tmp_link" "$CURRENT_LINK"
log "current -> releases/$VERSION${PREVIOUS:+ (vorher: $PREVIOUS)}"

# ---------------------------------------------------------------- Units, Updater, Nginx-Snippet
for u in "${UNITS_TO_INSTALL[@]}"; do
  install -m 0644 -o root -g root "$RELEASE_SRC/deploy/systemd/$u" "$SYSTEMD_DIR/$u"
done
install -m 0755 -o root -g root "$RELEASE_SRC/deploy/waread-update" "$UPDATER_DST"
log "systemd-Units und $UPDATER_DST installiert"

if [ "$SKIP_NGINX" -eq 0 ]; then
  install -d -m 0755 -o root -g root "$(dirname "$NGINX_SNIPPET_DST")"
  install -m 0644 -o root -g root "$RELEASE_SRC/deploy/nginx/waread.conf" "$NGINX_SNIPPET_DST"
  log "Nginx-Snippet abgelegt: $NGINX_SNIPPET_DST"
fi

systemctl daemon-reload

if command -v systemd-analyze >/dev/null 2>&1; then
  # Nur Hinweise, kein Abbruch: z. B. fehlende ffmpeg-/node-Pfade melden sich hier.
  systemd-analyze verify "${UNITS_TO_INSTALL[@]/#/$SYSTEMD_DIR/}" 2>&1 | sed 's/^/[install] verify: /' >&2 || true
fi

# ---------------------------------------------------------------- Nginx-Test (Tor vor der Aktivierung)
if [ "$SKIP_NGINX" -eq 0 ]; then
  if ! nginx_out=$(nginx -t 2>&1); then
    printf '%s\n' "$nginx_out" | sed 's/^/    /' >&2
    die "nginx -t ist fehlgeschlagen. Die waread-Dienste wurden NICHT aktiviert. Nginx-Fehler beheben und install.sh erneut ausführen."
  fi
  log "nginx -t erfolgreich"
fi

# ---------------------------------------------------------------- Dienste aktivieren
systemctl enable "${UNITS_TO_ENABLE[@]}"
if [ "$NEW_CONFIG" -eq 1 ] && [ "$START_NOW" -eq 1 ]; then
  START_NOW=0
  warn "Die Konfiguration wurde gerade aus der Beispieldatei angelegt und enthält Platzhalter. Dienste sind aktiviert, aber noch NICHT gestartet."
fi
if [ "$START_NOW" -eq 1 ]; then
  systemctl restart waread-ingest.service waread-web.service
  systemctl start waread-cleanup.timer waread-cleanup-vacuum.timer
  log "Dienste und Timer gestartet"
fi

# Nginx nur neu laden, wenn das Snippet bereits eingebunden ist (und die Konfiguration erneut besteht).
SNIPPET_INCLUDED=0
if [ "$SKIP_NGINX" -eq 0 ]; then
  nginx_dump=$(nginx -T 2>/dev/null || true)
  if grep -Eq 'include[[:space:]]+[^;]*waread\.conf' <<<"$nginx_dump"; then
    SNIPPET_INCLUDED=1
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      log "Nginx neu geladen"
    else
      warn "nginx -t schlägt jetzt fehl; Nginx wurde NICHT neu geladen."
    fi
  else
    log "Das Snippet ist in Nginx noch nicht eingebunden; kein Reload."
  fi
fi

# ---------------------------------------------------------------- Kurzer Gesundheitscheck (nur Hinweis)
if [ "$START_NOW" -eq 1 ] && command -v curl >/dev/null 2>&1; then
  health_url=${WAREAD_HEALTH_URL:-$DEFAULT_HEALTH_URL}
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 -o /dev/null "$health_url" 2>/dev/null; then ok=1; break; fi
    sleep 3
  done
  if [ "$ok" -eq 1 ]; then
    log "GET $health_url antwortet"
  else
    warn "GET $health_url antwortet nicht. Prüfen: journalctl -u waread-web -n 50 (Port in config.toml = 8780?)"
  fi
fi

# ---------------------------------------------------------------- Zusammenfassung
cat <<EOF

[install] Fertig. waread $VERSION ist installiert.

Nächste Schritte:
EOF
if [ "$NEW_CONFIG" -eq 1 ]; then
  cat <<EOF
  1. $CONFIG_FILE bearbeiten (Platzhalter ersetzen, z. B. Passwort-Hash), dann starten:
       systemctl start waread-ingest waread-web waread-cleanup.timer waread-cleanup-vacuum.timer
EOF
fi
if [ "$SKIP_NGINX" -eq 0 ] && [ "$SNIPPET_INCLUDED" -eq 0 ]; then
  cat <<EOF
  - Nginx: In den gewünschten server-Block eintragen
       include $NGINX_SNIPPET_DST;
    dann:  nginx -t && systemctl reload nginx
EOF
fi
cat <<EOF
  - Automatische Updates sind AUS. Erst update_source_url eintragen, "waread-update --check"
    von Hand testen, dann:  systemctl enable --now waread-update.timer
EOF
