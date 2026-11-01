#!/usr/bin/env bash
# install.sh - waread auf dem Raspberry Pi komplett installieren: von GitHub holen, bauen, installieren, starten
#
# Aufruf als root. Am besten erst herunterladen und lesen, dann ausführen:
#   curl -fsSLO https://raw.githubusercontent.com/yvbw2yfzsy-a11y/waread/main/install.sh
#   sudo bash install.sh [Optionen]
#
# Dieses Skript im Wurzelordner macht aus einem leeren Pi ein laufendes waread. Es ruft dabei deploy/install.sh
# auf (dort: Benutzer, Verzeichnisse, Units, Nginx-Ausschnitt). Ablauf in acht Schritten:
#   1. Voraussetzungen prüfen (root, systemd, Architektur, nginx, Port, Uhr, Speicher, Platz)
#   2. Pakete per apt nachinstallieren (ffmpeg, git, Build-Werkzeuge ...), ohne apt upgrade
#   3. Node.js ab 22.12 bereitstellen (vorhandenes nutzen, sonst offizielles Archiv nach /opt/waread/node-22)
#   4. Quelltext von GitHub holen (git, flach, als unprivilegierter Benutzer "nobody")
#   5. Bauen und prüfen: npm ci, npm run build (mit Sende-Wächter), npm test, Abhängigkeits-Tor, npm run prune:prod
#   6. Installieren mit deploy/install.sh (Benutzer waread, /opt/waread, /etc/waread, /var/lib/waread, Units)
#   7. Anmeldepasswort abfragen und als Argon2id-Hash in /etc/waread/config.toml eintragen
#   8. Dienste starten und /healthz prüfen
# Was NICHT passiert: Nginx wird nicht umgebaut (die include-Zeile trägst du selbst ein), kein apt upgrade,
# keine WhatsApp-Kopplung, kein Update-Timer. Das Craft-System wird nicht angefasst.
#
# Optionen:
#   --ref REF        Branch, Tag oder voller Commit-Hash, der von GitHub geholt wird (Standard: main)
#   --repo URL       anderes Repository (Standard: https://github.com/yvbw2yfzsy-a11y/waread.git)
#   --skip-tests     npm test auslassen (Standard: Tests laufen; schlägt einer fehl, wird nichts installiert)
#   --skip-password  kein Passwort abfragen: Platzhalter bleibt, Dienste werden nicht gestartet
#   --no-start       alles einrichten, die Dienste aber nicht starten
#   --upgrade        erlaubt, eine bereits installierte ANDERE Version zu ersetzen (startet die Dienste neu)
#   --keep-build     das Bauverzeichnis /var/tmp/waread-build.* nach Erfolg nicht löschen
#   -h, --help       diese Hilfe
#
# Das Skript ist wiederholbar: Vorhandenes wird erkannt und übersprungen. Eine vorhandene Konfiguration, Daten und
# eine bereits installierte Release-Version werden nie überschrieben.

set -Eeuo pipefail
umask 022

# ---------------------------------------------------------------- Konstanten
readonly REPO_DEFAULT="https://github.com/yvbw2yfzsy-a11y/waread.git"
readonly REF_DEFAULT="main"
readonly OPT_ROOT="/opt/waread"
readonly RELEASES_DIR="$OPT_ROOT/releases"
readonly CURRENT_LINK="$OPT_ROOT/current"
readonly NODE_DIR="$OPT_ROOT/node-22"
readonly ETC_DIR="/etc/waread"
readonly CONFIG_FILE="$ETC_DIR/config.toml"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly LOCK_FILE="/var/lock/waread-install.lock"
# Gleicher PATH wie in den Units (Environment=PATH=...): Was hier gefunden wird, finden auch die Dienste.
readonly SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
readonly MIN_NODE_MAJOR=22
readonly MIN_NODE_MINOR=12
readonly DEFAULT_PORT=8780
readonly TOTAL_STEPS=8
# Benötigte Pakete (docs/INSTALL.md, Abschnitt 3.1). Bewusst ohne nginx: das gehört dem bestehenden System.
readonly APT_PACKAGES=(ca-certificates curl git openssl ffmpeg build-essential python3 sqlite3)
# Units, die Node über Environment=PATH=... finden müssen (waread-update.service gehört nicht dazu).
readonly NODE_UNITS=(waread-ingest waread-web waread-cleanup waread-cleanup-vacuum)

# ---------------------------------------------------------------- Hilfsfunktionen
START_TS=$(date +%s)
STEP=0
log()  { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup] WARNUNG: %s\n' "$*" >&2; }
die()  { printf '[setup] FEHLER: %s\n' "$*" >&2; exit 1; }
step() { STEP=$((STEP + 1)); printf '\n[setup] === Schritt %d/%d: %s ===\n' "$STEP" "$TOTAL_STEPS" "$*"; }

usage() {
  cat <<'EOF'
Aufruf (als root):  sudo bash install.sh [Optionen]
  --ref REF        Branch, Tag oder voller Commit-Hash von GitHub (Standard: main)
  --repo URL       anderes Repository (Standard: https://github.com/yvbw2yfzsy-a11y/waread.git)
  --skip-tests     npm test auslassen
  --skip-password  kein Passwort abfragen (Platzhalter bleibt, Dienste werden nicht gestartet)
  --no-start       Dienste nicht starten
  --upgrade        eine bereits installierte andere Version ersetzen (startet die Dienste neu)
  --keep-build     Bauverzeichnis nach Erfolg nicht löschen
  -h, --help       diese Hilfe
Beschreibung der acht Schritte: Kopf dieser Datei und docs/INSTALL.md.
EOF
}

on_error() { printf '[setup] FEHLER: Abbruch in Zeile %s (Exit-Code %s).\n' "$2" "$1" >&2; }
trap 'on_error $? $LINENO' ERR

BUILD_DIR=""
FINISHED=0
KEEP_BUILD=0
# Löscht nur Verzeichnisse, die dieses Skript selbst mit mktemp angelegt hat.
remove_build_dir() {
  case "$1" in
    /var/tmp/waread-build.??????) rm -rf --one-file-system -- "$1" ;;
    *) warn "verweigere Löschen von $1" ;;
  esac
}
cleanup_on_exit() {
  if [ -n "$BUILD_DIR" ] && [ -d "$BUILD_DIR" ]; then
    if [ "$FINISHED" -eq 1 ] && [ "$KEEP_BUILD" -eq 0 ]; then
      remove_build_dir "$BUILD_DIR"
    else
      log "Bauverzeichnis bleibt zum Nachsehen: $BUILD_DIR (Löschen: sudo rm -rf $BUILD_DIR)"
    fi
  fi
}
trap cleanup_on_exit EXIT

# Sicherungsnetz wie in deploy/install.sh: Kein von diesem Skript verwalteter Pfad darf das Craft-System berühren.
for _p in "$OPT_ROOT" "$NODE_DIR" "$ETC_DIR" "$SYSTEMD_DIR" "$LOCK_FILE"; do
  case "$_p" in *craft*) printf 'Interner Fehler: Pfad %s berührt das Craft-System\n' "$_p" >&2; exit 70 ;; esac
done
unset _p

# ---------------------------------------------------------------- Argumente
REPO=$REPO_DEFAULT
REF=$REF_DEFAULT
RUN_TESTS=1
ASK_PASSWORD=1
START=1
UPGRADE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)           [ $# -ge 2 ] || die "--ref braucht einen Wert"; REF=$2; shift 2 ;;
    --repo)          [ $# -ge 2 ] || die "--repo braucht einen Wert"; REPO=$2; shift 2 ;;
    --skip-tests)    RUN_TESTS=0; shift ;;
    --skip-password) ASK_PASSWORD=0; shift ;;
    --no-start)      START=0; shift ;;
    --upgrade)       UPGRADE=1; shift ;;
    --keep-build)    KEEP_BUILD=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "Unbekannte Option: $1 (siehe --help)" ;;
  esac
done
[[ $REF =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "Ungültiger Wert für --ref: '$REF'"
[[ $REPO =~ ^[A-Za-z0-9] ]] || die "Ungültiger Wert für --repo: '$REPO'"

# ---------------------------------------------------------------- Schritt 1: Voraussetzungen
avail_mb() { df -Pk "$1" | awk 'NR == 2 { print int($4 / 1024) }'; }

check_prerequisites() {
  step "Voraussetzungen prüfen"
  [ "$(id -u)" -eq 0 ] || die "Bitte als root ausführen: sudo bash install.sh"
  [ -d /run/systemd/system ] || die "systemd läuft nicht; waread braucht systemd."
  command -v apt-get >/dev/null 2>&1 || die "apt-get fehlt. Das Skript ist für Raspberry Pi OS (Debian) gedacht."
  case "$(uname -m)" in
    aarch64) NODE_ARCH=arm64 ;;
    x86_64)  NODE_ARCH=x64 ;;
    *) die "Architektur $(uname -m) wird nicht unterstützt. Erwartet: aarch64 (64-Bit Raspberry Pi OS). Bei armv7l ist das nicht das Zielsystem (docs/INSTALL.md, Abschnitt 1)." ;;
  esac
  command -v nginx >/dev/null 2>&1 \
    || die "nginx nicht gefunden. waread lauscht nur auf 127.0.0.1 und ist ohne Nginx nicht erreichbar. Zuerst: sudo apt install nginx"

  # Nur ein Lauf gleichzeitig.
  exec 8>"$LOCK_FILE"
  flock -n 8 || die "Ein anderer install.sh-Lauf ist aktiv."

  # Port (docs/INSTALL.md, Abschnitt 1). Belegt durch waread-web selbst ist in Ordnung (Wiederholung).
  if command -v ss >/dev/null 2>&1 && [ -n "$(ss -ltnH "sport = :$DEFAULT_PORT" 2>/dev/null)" ]; then
    systemctl is-active --quiet waread-web.service 2>/dev/null \
      || die "Port $DEFAULT_PORT ist von einem anderen Programm belegt. Siehe docs/INSTALL.md, Abschnitt 1 und 7 (anderen Port wählen)."
  fi

  local sync mem
  sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
  [ "$sync" = "yes" ] || warn "Die Uhr ist nicht als synchronisiert gemeldet (timedatectl). Falsche Uhrzeit lässt TLS-Downloads und WhatsApp scheitern."
  mem=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  if [ "${mem:-0}" -lt 1800 ]; then
    warn "Nur ${mem} MB Arbeitsspeicher. Der Bau kann am Speicher scheitern; im Zweifel Swap anlegen (waread selbst braucht unter 500 MB)."
  fi
  # Gemessen (x86-64): Bau samt Entwicklungspaketen etwa 180 MB, Node-Archiv entpackt etwa 200 MB, fertiges Release etwa 100 MB.
  # Die Grenzen lassen Luft für ein Kompilieren der nativen Module und ein zweites Release beim Update.
  [ "$(avail_mb /var/tmp)" -ge 1000 ] || die "Auf /var/tmp sind weniger als 1000 MB frei. Der Bau braucht dort Platz."
  [ "$(avail_mb /opt)" -ge 500 ] || die "Auf /opt sind weniger als 500 MB frei."
  log "Architektur $(uname -m), nginx vorhanden, Port $DEFAULT_PORT frei oder von waread belegt."
}

# ---------------------------------------------------------------- Schritt 2: Pakete
install_packages() {
  step "Pakete installieren (ohne apt upgrade)"
  local p status sim
  local -a missing=()
  for p in "${APT_PACKAGES[@]}"; do
    status=$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true)
    [[ $status == *"install ok installed"* ]] || missing+=("$p")
  done
  if [ ${#missing[@]} -eq 0 ]; then
    log "Alle Pakete sind schon da: ${APT_PACKAGES[*]}"
  else
    log "Es fehlen: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    apt-get update
    # Erst simulieren (docs/INSTALL.md, Abschnitt 3.2): nichts entfernen, nginx und Craft nicht anfassen.
    sim=$(apt-get -s install --no-install-recommends "${missing[@]}") || die "apt-get -s install ist fehlgeschlagen."
    if grep -E '^Remv ' <<<"$sim"; then
      die "apt würde Pakete entfernen (oben). Abbruch, nichts wurde installiert."
    fi
    if grep -Ei '^Inst (lib)?nginx|^Inst [^ ]*craft' <<<"$sim"; then
      die "apt würde nginx oder etwas von Craft ändern (oben). Abbruch, nichts wurde installiert."
    fi
    apt-get install -y --no-install-recommends "${missing[@]}"
  fi
  local c
  for c in runuser flock curl git sha256sum tar ffmpeg; do
    command -v "$c" >/dev/null 2>&1 || die "Benötigtes Programm fehlt: $c"
  done

  # Kurztest der Sprachumwandlung (docs/INSTALL.md, Abschnitt 3.4). Nur eine Warnung: betrifft erst Sprachnachrichten.
  local t
  t=$(mktemp -d /var/tmp/waread-ffmpeg.XXXXXX)
  if ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=2 -c:a libopus "$t/t.ogg" \
     && ffmpeg -hide_banner -loglevel error -i "$t/t.ogg" -c:a aac "$t/t.m4a"; then
    log "ffmpeg: Opus -> AAC ok"
  else
    warn "ffmpeg konnte Opus nicht nach AAC umwandeln. Sprachnachrichten wären davon betroffen (docs/INSTALL.md, Abschnitt 3.4)."
  fi
  rm -rf --one-file-system -- "$t"
}

# ---------------------------------------------------------------- Schritt 3: Node.js
NODE_BIN=""
NODE_ISOLATED=0

node_version_ok() { # node_version_ok PFAD: 0, wenn Version >= 22.12
  local v major minor
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}
  minor=${v#*.}; minor=${minor%%.*}
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
  [ "$major" -gt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

download_node() {
  local base="https://nodejs.org/dist/latest-v22.x" tmp line file sum dir
  tmp=$(mktemp -d /var/tmp/waread-node.XXXXXX)
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" \
    || die "Konnte die Prüfsummenliste von nodejs.org nicht laden."
  line=$(grep -E "  node-v22\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -n 1 || true)
  [ -n "$line" ] || die "Kein Node-22-Archiv für linux-$NODE_ARCH in der Prüfsummenliste gefunden."
  sum=${line%% *}
  file=${line##* }
  [[ $file =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(arm64|x64)\.tar\.gz$ && $sum =~ ^[0-9a-f]{64}$ ]] \
    || die "Unerwartete Zeile in der Prüfsummenliste: $line"
  log "Lade $file von nodejs.org"
  curl -fL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 -o "$tmp/$file" "$base/$file" \
    || die "Download von $file fehlgeschlagen."
  (cd "$tmp" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c --quiet -) \
    || die "Prüfsumme von $file stimmt NICHT. Abbruch."
  tar -xzf "$tmp/$file" -C "$tmp" --no-same-owner
  dir="$tmp/${file%.tar.gz}"
  [ -x "$dir/bin/node" ] || die "Das Archiv enthält kein bin/node."
  node_version_ok "$dir/bin/node" || die "Das heruntergeladene Node ist keine Version ab $MIN_NODE_MAJOR.$MIN_NODE_MINOR."
  install -d -m 0755 -o root -g root "$OPT_ROOT"
  chown -R root:root "$dir"
  rm -rf --one-file-system -- "$NODE_DIR"
  mv "$dir" "$NODE_DIR"
  rm -rf --one-file-system -- "$tmp"
}

ensure_node() {
  step "Node.js ab $MIN_NODE_MAJOR.$MIN_NODE_MINOR bereitstellen"
  local sys
  sys=$(env PATH="$SERVICE_PATH" sh -c 'command -v node' 2>/dev/null || true)
  if [ -n "$sys" ] && node_version_ok "$sys"; then
    NODE_BIN=$sys
    log "System-Node genügt: $NODE_BIN ($("$NODE_BIN" --version)). Es wird nichts nachgeladen."
  else
    [ -z "$sys" ] || log "Das vorhandene Node ($sys, $("$sys" --version 2>/dev/null || echo '?')) ist zu alt und bleibt unangetastet."
    if [ -x "$NODE_DIR/bin/node" ] && node_version_ok "$NODE_DIR/bin/node"; then
      log "Eigenes Node ist schon da: $NODE_DIR ($("$NODE_DIR/bin/node" --version))"
    else
      download_node
    fi
    NODE_BIN="$NODE_DIR/bin/node"
    NODE_ISOLATED=1
    log "Eigenes Node: $NODE_BIN ($("$NODE_BIN" --version)). Die Units bekommen dafür ein Drop-in (Schritt 6)."
  fi
}

# ---------------------------------------------------------------- Schritt 4: Quelltext von GitHub
SRC_DIR=""
BUILD_PATH=""
VERSION=""
COMMIT=""
SKIP_BUILD=0

# Führt einen Befehl als unprivilegierter Benutzer "nobody" aus: Die Lebenszyklus-Skripte der npm-Pakete laufen nie als root.
as_builder() {
  runuser -u nobody -- env "HOME=$BUILD_DIR/home" "TMPDIR=$BUILD_DIR/tmp" "PATH=$BUILD_PATH" \
    GIT_TERMINAL_PROMPT=0 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false "$@"
}

fetch_source() {
  step "Quelltext von GitHub holen"
  BUILD_PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  BUILD_DIR=$(mktemp -d /var/tmp/waread-build.XXXXXX)
  SRC_DIR="$BUILD_DIR/src"
  mkdir "$BUILD_DIR/home" "$BUILD_DIR/tmp" "$SRC_DIR"
  chown -R nobody: "$BUILD_DIR"
  chmod 0700 "$BUILD_DIR"

  log "Hole $REPO ($REF)"
  as_builder git init -q "$SRC_DIR"
  as_builder git -C "$SRC_DIR" remote add origin "$REPO"
  as_builder git -C "$SRC_DIR" fetch -q --depth 1 origin "$REF" \
    || die "Konnte $REPO ($REF) nicht von GitHub holen. Netzwerk? Rechtschreibung von --ref? Privates Repository?"
  as_builder git -C "$SRC_DIR" checkout -q --detach FETCH_HEAD
  COMMIT=$(as_builder git -C "$SRC_DIR" rev-parse --short HEAD)

  [ -r "$SRC_DIR/VERSION" ] || die "Im Repository fehlt die Datei VERSION."
  VERSION=$(tr -d ' \t\r\n' < "$SRC_DIR/VERSION")
  [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION ist keine gültige Version (X.Y.Z): '$VERSION'"
  [ -f "$SRC_DIR/deploy/install.sh" ] || die "Im Repository fehlt deploy/install.sh."
  log "Stand: Commit $COMMIT, Version $VERSION"

  # Schon installiert? Gleiche Version aktiv: nicht neu bauen. Andere Version aktiv: nur mit --upgrade.
  local cur active=""
  cur=$(readlink "$CURRENT_LINK" 2>/dev/null || true)
  case "$cur" in releases/*) active=${cur#releases/} ;; esac
  if [ -n "$active" ] && [ "$active" = "$VERSION" ] && [ -d "$RELEASES_DIR/$VERSION" ]; then
    SKIP_BUILD=1
    log "waread $VERSION ist bereits installiert und aktiv: Bauen entfällt, Schritt 6 prüft nur noch Units und Nginx-Ausschnitt."
  elif [ -n "$active" ] && [ "$active" != "$VERSION" ]; then
    [ "$UPGRADE" -eq 1 ] || die "Aktiv ist waread $active, das Repository liefert $VERSION. Ein Update startet die Dienste neu und kann die Datenbank ändern; ein Rückweg für die Datenbank fehlt (docs/MAINTENANCE.md). Erst sichern, dann mit --upgrade wiederholen."
    log "Aktualisierung von $active auf $VERSION (--upgrade)."
  fi
}

# ---------------------------------------------------------------- Schritt 5: Bauen und prüfen
build_source() {
  step "Bauen und prüfen"
  if [ "$SKIP_BUILD" -eq 1 ]; then
    log "Übersprungen (Version $VERSION ist bereits installiert)."
    return 0
  fi
  [ -f "$SRC_DIR/package-lock.json" ] || die "package-lock.json fehlt. Ohne Lock-Datei wird nicht installiert (docs/INSTALL.md, Abschnitt 5)."

  # Abhängigkeits-Tor, Teil 1 (docs/SECURITY_TESTS.md, 1.2): kein bekannter Schad-Fork, Baileys exakt festgelegt.
  if grep -qi 'lotusbail' "$SRC_DIR/package-lock.json"; then
    die "STOPP: 'lotusbail' (bekannter manipulierter Baileys-Fork) steht in package-lock.json."
  fi
  grep -Eq '"baileys"[[:space:]]*:[[:space:]]*"[0-9]' "$SRC_DIR/services/ingest/package.json" \
    || die "STOPP: 'baileys' ist in services/ingest/package.json nicht auf eine exakte Version festgelegt."

  log "npm ci (lädt alle Abhängigkeiten; kann auf dem Pi mehrere Minuten dauern)"
  (cd "$SRC_DIR" && as_builder npm ci --no-audit --no-fund)
  [ ! -e "$SRC_DIR/node_modules/lotusbail" ] || die "STOPP: node_modules/lotusbail ist vorhanden."

  log "npm run build (db, ingest mit Sende-Wächter, web, frontend, cleanup)"
  (cd "$SRC_DIR" && as_builder npm run build)

  if [ "$RUN_TESTS" -eq 1 ]; then
    log "npm test (prüft u. a., dass die nativen Module auf dieser Architektur laufen)"
    (cd "$SRC_DIR" && as_builder npm test)
  else
    warn "npm test wurde ausgelassen (--skip-tests)."
  fi

  log "npm run prune:prod (Entwicklungswerkzeuge entfernen)"
  (cd "$SRC_DIR" && as_builder npm run prune:prod)

  # Ab hier gehört der Baum root: deploy/install.sh läuft als root und darf nicht von "nobody" veränderbar sein.
  rm -rf --one-file-system -- "${BUILD_DIR:?}/home" "${BUILD_DIR:?}/tmp"
  chown -R root:root "$BUILD_DIR"
  chmod -R go-w "$SRC_DIR"
  log "Gebaut: Version $VERSION, Commit $COMMIT"
}

# ---------------------------------------------------------------- Schritt 6: Installieren
write_node_dropins() {
  local u d
  for u in "${NODE_UNITS[@]}"; do
    d="$SYSTEMD_DIR/$u.service.d"
    install -d -m 0755 -o root -g root "$d"
    printf '[Service]\nEnvironment=PATH=%s:%s\n' "$NODE_DIR/bin" "$SERVICE_PATH" > "$d/waread-node.conf"
    chmod 0644 "$d/waread-node.conf"
  done
  systemctl daemon-reload
  log "Drop-ins für ${NODE_UNITS[*]} geschrieben (PATH enthält $NODE_DIR/bin)."
}

install_release() {
  step "Installieren mit deploy/install.sh"
  local installer
  local -a args=(--no-start)
  [ "$NODE_ISOLATED" -eq 0 ] || args+=(--node "$NODE_BIN")
  if [ "$SKIP_BUILD" -eq 1 ]; then
    installer="$RELEASES_DIR/$VERSION/deploy/install.sh"
  else
    installer="$SRC_DIR/deploy/install.sh"
  fi
  log "Starte $installer ${args[*]}"
  log "(Dessen Abschnitt 'Nächste Schritte' am Ende erledigt dieses Skript selbst, Schritte 7 und 8.)"
  bash "$installer" "${args[@]}" 8>&-
  if [ "$NODE_ISOLATED" -eq 1 ]; then write_node_dropins; fi
}

# ---------------------------------------------------------------- Schritt 7: Passwort
CONFIG_READY=0

# Ersetzt die Platzhalterzeile durch den Hash. Schreibt in eine Datei im selben Verzeichnis und benennt um.
write_password_hash() { # write_password_hash HASH
  local hash=$1 tmp line found=0
  # Muster in einer Variablen mit einfachen Anführungszeichen: sonst expandiert Bash "$-" im Zeichenvorrat als Shell-Optionen.
  # shellcheck disable=SC2016  # Absicht: nichts expandieren
  local re='^\$argon2id\$[A-Za-z0-9+/=,.$-]+$'
  [[ $hash =~ $re ]] || die "Unerwartete Ausgabe von hash-password.js (kein Argon2id-Hash)."
  tmp=$(mktemp "$ETC_DIR/.config.toml.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == 'password_hash = "PLATZHALTER'* ]]; then
      printf 'password_hash = "%s"\n' "$hash"
      found=1
    else
      printf '%s\n' "$line"
    fi
  done < "$CONFIG_FILE" > "$tmp"
  if [ "$found" -ne 1 ]; then rm -f "$tmp"; die "Die Platzhalterzeile für password_hash wurde in $CONFIG_FILE nicht gefunden."; fi
  chown root:waread "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$CONFIG_FILE"
}

read_secret() { # read_secret PROMPT VARIABLE: liest ohne Echo vom Terminal
  local __v
  printf '%s' "$1" >/dev/tty
  IFS= read -rs __v </dev/tty
  printf '\n' >/dev/tty
  printf -v "$2" '%s' "$__v"
}

set_password() {
  step "Anmeldepasswort festlegen"
  if ! grep -q '^password_hash = "PLATZHALTER' "$CONFIG_FILE"; then
    CONFIG_READY=1
    log "In $CONFIG_FILE steht schon ein Passwort-Hash. Nichts zu tun."
    return 0
  fi
  if [ "$ASK_PASSWORD" -eq 0 ]; then
    warn "Passwortabfrage ausgelassen (--skip-password). Der Web-Dienst startet mit dem Platzhalter absichtlich nicht."
    return 0
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    warn "Kein Terminal für die Passwortabfrage. Passwort später von Hand setzen (docs/INSTALL.md, Abschnitt 7)."
    return 0
  fi
  local pw1="" pw2="" hash="" tries=0
  while :; do
    read_secret "Neues Anmeldepasswort für waread (mindestens 10 Zeichen): " pw1
    read_secret "Passwort wiederholen: " pw2
    if [ "$pw1" != "$pw2" ]; then printf 'Die Eingaben stimmen nicht überein.\n' >/dev/tty
    elif [ "${#pw1}" -lt 10 ]; then printf 'Zu kurz (mindestens 10 Zeichen).\n' >/dev/tty
    else break; fi
    tries=$((tries + 1))
    [ "$tries" -lt 3 ] || { unset pw1 pw2; die "Dreimal keine gültige Eingabe. Passwort später von Hand setzen (docs/INSTALL.md, Abschnitt 7)."; }
  done
  # Das Passwort geht nur über eine Pipe (stdin) an das Werkzeug, nie als Argument. Es läuft als Dienstbenutzer.
  if ! hash=$(cd "$CURRENT_LINK" && printf '%s' "$pw1" | runuser -u waread -- "$NODE_BIN" services/web/dist/hash-password.js); then
    unset pw1 pw2
    die "hash-password.js ist fehlgeschlagen (Meldung oben)."
  fi
  unset pw1 pw2
  write_password_hash "$hash"
  CONFIG_READY=1
  log "Passwort-Hash in $CONFIG_FILE eingetragen (Rechte 0640 root:waread)."
}

# ---------------------------------------------------------------- Schritt 8: Dienste
HEALTH_OK=0

start_services() {
  step "Dienste starten und prüfen"
  if [ "$START" -eq 0 ]; then
    log "Nicht gestartet (--no-start)."
    return 0
  fi
  if [ "$CONFIG_READY" -eq 0 ]; then
    log "Nicht gestartet: In der Konfiguration steht noch der Platzhalter für das Passwort."
    return 0
  fi
  local port
  port=$(sed -n 's/^port[[:space:]]*=[[:space:]]*\([0-9]\{2,5\}\).*/\1/p' "$CONFIG_FILE" | head -n 1)
  port=${port:-$DEFAULT_PORT}
  # restart: startet beim ersten Mal, lädt bei einer Aktualisierung den neuen Code.
  # "8>&-": Die Sperrdatei (Datei-Nr. 8) wird nicht an gestartete Prozesse vererbt, sonst hielte ein Dienst die Sperre fest.
  systemctl restart waread-ingest.service waread-web.service 8>&- \
    || warn "systemctl restart meldet einen Fehler. Prüfen: sudo systemctl status waread-ingest waread-web --no-pager"
  systemctl start waread-cleanup.timer waread-cleanup-vacuum.timer 8>&- \
    || warn "Die Aufräum-Timer ließen sich nicht starten (systemctl list-timers 'waread*')."
  log "Warte auf http://127.0.0.1:$port/healthz (bis zu 60 Sekunden)"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then HEALTH_OK=1; break; fi
    sleep 2
  done
  if [ "$HEALTH_OK" -eq 1 ]; then
    log "GET /healthz antwortet."
  else
    warn "GET http://127.0.0.1:$port/healthz antwortet nicht. Prüfen: sudo journalctl -u waread-web -n 50 --no-pager. Bei 502 später über Nginx siehe docs/INSTALL.md, Abschnitt 9 (IPAddressDeny)."
  fi
}

# ---------------------------------------------------------------- Zusammenfassung
summary() {
  local u state secs n=0 ngx included=0
  secs=$(( $(date +%s) - START_TS ))
  ngx=$(nginx -T 2>/dev/null || true)
  if [ -n "$ngx" ] && grep -Eq '^[[:space:]]*include[[:space:]]+[^;#]*waread\.conf' <<<"$ngx"; then included=1; fi

  printf '\n[setup] ====================================================================\n'
  if [ "$HEALTH_OK" -eq 1 ]; then
    log "Fertig: waread $VERSION läuft (Dauer: $((secs / 60)) min $((secs % 60)) s)."
  else
    log "Installiert: waread $VERSION (Dauer: $((secs / 60)) min $((secs % 60)) s). Die Dienste laufen noch nicht, siehe oben."
  fi
  log "Release:        $CURRENT_LINK -> $(readlink "$CURRENT_LINK" 2>/dev/null || echo '?')"
  log "Konfiguration:  $CONFIG_FILE"
  log "Daten:          /var/lib/waread (db/, media/, auth/)"
  if [ "$included" -eq 1 ]; then
    log "Nginx:          /etc/nginx/snippets/waread.conf ist in einen server-Block eingebunden."
  else
    log "Nginx:          /etc/nginx/snippets/waread.conf liegt bereit, ist aber noch NICHT in einen server-Block eingebunden."
  fi
  for u in waread-ingest waread-web waread-cleanup.timer waread-cleanup-vacuum.timer; do
    state=$(systemctl is-active "$u" 2>/dev/null || true)
    log "  $u: ${state:-unbekannt}"
  done

  printf '\nNächste Schritte (von Hand):\n'
  if [ "$CONFIG_READY" -eq 0 ]; then
    n=$((n + 1))
    printf '  %d. Passwort setzen (docs/INSTALL.md, Abschnitt 7). Das Werkzeug fragt ohne Echo; die Ausgabezeile\n' "$n"
    printf '     kommt als  password_hash = "..."  in %s:\n' "$CONFIG_FILE"
    printf '         cd %s && sudo -u waread %s services/web/dist/hash-password.js\n' "$CURRENT_LINK" "$NODE_BIN"
  fi
  if [ "$HEALTH_OK" -eq 0 ]; then
    n=$((n + 1))
    if [ "$CONFIG_READY" -eq 1 ] && [ "$START" -eq 1 ]; then
      printf '  %d. Dienste prüfen: sudo journalctl -u waread-web -u waread-ingest -n 50 --no-pager\n' "$n"
    else
      printf '  %d. Dienste starten:\n' "$n"
      printf '         sudo systemctl start waread-ingest waread-web waread-cleanup.timer waread-cleanup-vacuum.timer\n'
    fi
  fi
  if [ "$included" -eq 0 ]; then
    n=$((n + 1))
    printf '  %d. Nginx: In den server-Block, über den waread im Heimnetz erreichbar sein soll, die Zeile\n' "$n"
    printf '         include /etc/nginx/snippets/waread.conf;\n'
    printf '     eintragen, dann  sudo nginx -t && sudo systemctl reload nginx\n'
    printf '     (docs/INSTALL.md, Abschnitt 8; bei Passkey-Betrieb stattdessen Abschnitt 17).\n'
  fi
  n=$((n + 1))
  printf '  %d. Im Browser http://<Pi-IP>/waread/ öffnen und mit dem Passwort anmelden.\n' "$n"
  n=$((n + 1))
  printf '  %d. WhatsApp koppeln, ZUERST mit der Testnummer (docs/INSTALL.md, Abschnitt 10), dann der Zweitnummer-Test\n' "$n"
  printf '     (docs/SECURITY_TESTS.md, Abschnitt 3). Erst danach das Hauptkonto.\n'
}

# ---------------------------------------------------------------- Ablauf
check_prerequisites
install_packages
ensure_node
fetch_source
build_source
install_release
set_password
start_services
summary
FINISHED=1
