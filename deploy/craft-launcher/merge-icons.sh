#!/usr/bin/env bash
# merge-icons.sh - die eingebetteten Bilder aus dem vollständigen craft-update in die Fassung ohne Bilder übernehmen
#
# craft-update_10-noIcons enthält statt der Bilder der Craft-Apps und des Pi-Logos nur den Platzhalter
# "too much text and token wast. ..." (Ausnahme: das waread-Logo steht echt darin). Dieses Skript holt die
# echten Werte aus deiner vollständigen alten Fassung (z. B. craft-update_9) und schreibt die vollständige neue.
#
# Aufruf:  ./merge-icons.sh ALT_VOLLSTÄNDIG NEU_OHNE_BILDER AUSGABE
#   ./merge-icons.sh craft-update_9 craft-update_10-noIcons craft-update_10
#
# Es liest nur die beiden ersten Dateien und schreibt nur AUSGABE (erst in eine Zwischendatei, am Ende umbenannt).
# Es bricht ab, ohne AUSGABE anzulegen, wenn für einen Platzhalter kein Bild in der alten Fassung steht oder die
# Ausgabe die Syntaxprüfung (bash -n) nicht besteht.

set -Eeuo pipefail

PH='too much text and token wast. here is normaly a base hard coded picture'

die() { printf '[merge-icons] FEHLER: %s\n' "$*" >&2; exit 1; }

[ $# -eq 3 ] || die "Aufruf: $0 ALT_VOLLSTÄNDIG NEU_OHNE_BILDER AUSGABE"
old=$1 new=$2 out=$3
[ -r "$old" ] || die "Nicht lesbar: $old"
[ -r "$new" ] || die "Nicht lesbar: $new"
[ "$old" != "$out" ] || die "AUSGABE muss eine neue Datei sein, nicht $old"
[ "$new" != "$out" ] || die "AUSGABE muss eine neue Datei sein, nicht $new"
[ ! -d "$out" ] || die "AUSGABE ist ein Verzeichnis: $out"

# 1. Bilder aus der alten Fassung einsammeln (ganze Zeilen). Echte Werte, keine Platzhalter.
declare -A icon=()
logo=''
inside=0
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    '# ICONS-BEGIN'*) inside=1; continue ;;
    '# ICONS-END'*)   inside=0; continue ;;
  esac
  if [[ $line == LOGO_B64=\'* ]]; then
    logo=$line
  elif (( inside )) && [[ $line =~ ^\ \ \[([a-z0-9_-]+)\]=\' ]]; then
    icon[${BASH_REMATCH[1]}]=$line
  fi
done < "$old"
[[ -n $logo && $logo != *"$PH"* ]] || die "In $old steht kein echtes LOGO_B64 (Platzhalter oder fehlt)."

# 2. Neue Fassung durchgehen und jeden Platzhalter durch die Zeile aus der alten Fassung ersetzen.
tmp=$(mktemp "$out.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
missing=0 replaced=0
inside=0
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    '# ICONS-BEGIN'*) inside=1 ;;
    '# ICONS-END'*)   inside=0 ;;
  esac
  if [[ $line == "LOGO_B64='$PH'" ]]; then
    line=$logo
    replaced=$(( replaced + 1 ))
  elif (( inside )) && [[ $line =~ ^\ \ \[([a-z0-9_-]+)\]=\'"$PH"\'$ ]]; then
    k=${BASH_REMATCH[1]}
    if [[ -n ${icon[$k]:-} && ${icon[$k]} != *"$PH"* ]]; then
      line=${icon[$k]}
      replaced=$(( replaced + 1 ))
    else
      printf '[merge-icons] FEHLER: In %s steht kein Bild für "%s".\n' "$old" "$k" >&2
      missing=1
    fi
  fi
  printf '%s\n' "$line"
done < "$new" > "$tmp"
[ "$missing" -eq 0 ] || die "Es fehlen Bilder (siehe oben). $out wurde nicht angelegt."

# 3. Prüfen: kein Platzhalter mehr übrig, Syntax in Ordnung.
if grep -qF -- "$PH" "$tmp"; then die "Platzhalter übrig. $out wurde nicht angelegt."; fi
bash -n "$tmp" || die "Syntaxfehler in der Ausgabe. $out wurde nicht angelegt."

chmod 0755 "$tmp"
mv -f -- "$tmp" "$out"
trap - EXIT
printf '[merge-icons] %d Bilder übernommen, geschrieben: %s\n' "$replaced" "$out"
