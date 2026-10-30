#!/usr/bin/env bash
# make-release.sh - aus dem GEBAUTEN Projektbaum ein Update-Paket (Tarball + Manifest) erzeugen
#
# Läuft auf dem Rechner, auf dem gebaut wurde (nicht auf dem Pi nötig, außer du baust dort). Voraussetzung:
#   npm ci && npm run build && npm run prune:prod
# und zwar auf derselben CPU-Architektur und libc wie der Pi (arm64, Debian/Raspberry Pi OS), weil
# better-sqlite3 und sharp native Programmteile mitbringen.
#
# Aufruf:  deploy/make-release.sh [AUSGABEVERZEICHNIS]      (Standard: ./release-out)
#
# Erzeugt in AUSGABEVERZEICHNIS:
#   waread-<version>.tar.gz   die Release-Dateien direkt im Wurzelverzeichnis des Tarballs
#   latest.manifest           version=, tarball=, sha256=   (Format: deploy/README.md, "Manifest, Tarball, Signatur")
# Das Manifest wird hier NICHT signiert; der private Schlüssel gehört nicht auf diesen Rechner (Befehl unten).
# Hochladen musst du beide Dateien (und die .sig) selbst an die Stelle, auf die update_source_url zeigt.
#
# Das Skript ändert nichts am Projektbaum und berührt nichts außerhalb des Ausgabeverzeichnisses.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT=${1:-"$ROOT/release-out"}

die() { printf '[make-release] FEHLER: %s\n' "$*" >&2; exit 1; }

[ -r "$ROOT/VERSION" ] || die "VERSION fehlt in $ROOT"
VERSION=$(tr -d ' \t\r\n' < "$ROOT/VERSION")
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION ist keine gültige Version (X.Y.Z): '$VERSION'"

# Derselbe Release-Vertrag wie in install.sh und waread-update.
required_files=(
  "services/ingest/dist/index.js"
  "services/web/dist/server.js"
  "services/web/public/dist/index.html"
  "cleanup/dist/cleanup.js"
  "db/dist/client.js"
  "db/schema.sql"
  "config/config.example.toml"
  "package-lock.json"
  "deploy/install.sh"
  "deploy/waread-update"
  "deploy/nginx/waread.conf"
)
missing=0
for f in "${required_files[@]}"; do
  [ -f "$ROOT/$f" ] || { printf '[make-release] fehlt: %s\n' "$f" >&2; missing=1; }
done
for d in node_modules node_modules/@waread/db; do
  [ -d "$ROOT/$d" ] || { printf '[make-release] fehlt Ordner: %s\n' "$d" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || die "Der Baum ist nicht gebaut (npm ci && npm run build && npm run prune:prod) oder unvollständig."

# Entwicklungswerkzeuge dürfen nicht im Paket sein: nach "npm run prune:prod" gibt es sie nicht mehr.
if [ -d "$ROOT/node_modules/typescript" ] || [ -d "$ROOT/node_modules/tsx" ]; then
  die "Entwicklungsabhängigkeiten (typescript/tsx) sind noch in node_modules. Erst: npm run prune:prod"
fi

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd -P)
TARBALL="waread-$VERSION.tar.gz"
[ ! -e "$OUT/$TARBALL" ] || die "$OUT/$TARBALL existiert schon (Version erhöhen oder Datei entfernen)."

# Das Ausgabeverzeichnis liegt standardmäßig im Projektbaum und wird dann ausgeschlossen.
excludes=(--exclude=./.git)
case "$OUT" in "$ROOT"/*) excludes+=("--exclude=./${OUT#"$ROOT"/}") ;; esac
tar "${excludes[@]}" -czf "$OUT/$TARBALL" -C "$ROOT" .

SHA=$(sha256sum "$OUT/$TARBALL" | cut -d' ' -f1)
printf 'version=%s\ntarball=%s\nsha256=%s\n' "$VERSION" "$TARBALL" "$SHA" > "$OUT/latest.manifest"

printf '[make-release] fertig:\n  %s\n  %s\n' "$OUT/$TARBALL" "$OUT/latest.manifest"
cat <<MSG

Manifest signieren (auf dem Rechner mit dem privaten Schlüssel):
  openssl pkeyutl -sign -inkey waread-update.key -rawin -in "$OUT/latest.manifest" -out "$OUT/latest.manifest.sig"
Dann alle drei Dateien dorthin hochladen, wo update_source_url hinzeigt (siehe deploy/README.md).
MSG
