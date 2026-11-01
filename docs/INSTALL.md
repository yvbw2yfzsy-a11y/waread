# INSTALL – waread auf dem bestehenden Raspberry Pi installieren

Stand: Oktober 2026 · Zielsystem: Raspberry Pi (ARM64, Linux) mit laufendem Nginx und Craft-Apps

## Lies das zuerst

- **Reihenfolge einhalten.** Die Abschnitte bauen aufeinander auf. Besonders wichtig: Abschnitt 2 (Craft-Zustand festhalten) kommt **vor** jeder Änderung, Abschnitt 13 (Vergleich) **nach** allem.
- **Erst Testnummer, dann Hauptkonto.** Die erste Kopplung (Abschnitt 10) erfolgt mit der **Testnummer**. Dein Hauptkonto kommt erst nach bestandenem Test (Abschnitt 14).
- **Das Craft-System wird nicht angefasst.** Diese Anleitung ändert nichts an `/var/www/craft`, `/var/lib/craft`, `/usr/local/bin/craft-update` oder an Craft-systemd-Einheiten. Abschnitt 13 weist das nach.
- **Kein `apt upgrade`.** Es werden nur die nötigen Pakete installiert. Ein allgemeines System-Upgrade könnte Nginx oder Bibliotheken ändern, auf die das Craft-System baut.
- **Platzhalter** in spitzen Klammern (`<CRAFT-URL>`, `<version>` …) ersetzt du durch deine Werte. Der Port des Web-Dienstes ist standardmäßig **8780**; das ist eine Annahme dieses Pakets (Abschnitt 7), prüfe in Abschnitt 1, ob er frei ist.

> **Zu `deploy/install.sh`:** Das Skript übernimmt die Installationsschritte (Abschnitt 6: Benutzer, Verzeichnisse, Release, Units, Updater, Nginx-Snippet). **Abschnitt 1, 2, 11, 12, 13 und 14 bleiben Pflicht**, denn sie sind Prüfungen und keine Installationsschritte. Lies das Skript vor dem Ausführen; Abschnitt 6 beschreibt, was es tut.

Alle Befehle laufen als normaler Benutzer mit `sudo` auf dem Pi.

---

## Abkürzung: Komplettinstallation mit `install.sh`

Das Skript `install.sh` im **Wurzelordner** des Projekts (nicht `deploy/install.sh`) holt waread von GitHub und erledigt in einem Durchlauf die Abschnitte 3 (Pakete, Node.js), 5 (Bauen), 6 (Installieren), den Passwortteil von 7 und 9 (Starten, `/healthz`). Es läuft als root, lies es vorher:

```bash
curl -fsSLO https://raw.githubusercontent.com/yvbw2yfzsy-a11y/waread/main/install.sh
less install.sh
sudo bash install.sh
```

Es tut, in dieser Reihenfolge:

1. **Voraussetzungen prüfen.** Abbruch bei: kein root, kein systemd, Architektur nicht `aarch64` (oder `x86_64`), kein `nginx`, Port 8780 von einem fremden Programm belegt, weniger als 1000 MB frei auf `/var/tmp` oder 500 MB auf `/opt`. Nur Warnung bei: Uhr nicht synchronisiert, weniger als 1,8 GB Arbeitsspeicher.
2. **Pakete installieren.** Nur die fehlenden aus `ca-certificates curl git openssl ffmpeg build-essential python3 sqlite3`, mit `--no-install-recommends`, ohne `apt upgrade`. Vorher läuft `apt-get -s`: Würde apt etwas entfernen oder `nginx` ändern, bricht das Skript ab, bevor etwas installiert wird. Danach der ffmpeg-Test aus Abschnitt 3.4.
3. **Node.js ab 22.12.** Ein vorhandenes `node` in `/usr/local/bin` oder `/usr/bin` genügt, wenn es neu genug ist. Sonst lädt das Skript das offizielle Archiv von `nodejs.org` nach `/opt/waread/node-22` (SHA-256 gegen die `SHASUMS256.txt` derselben Seite geprüft) und lässt das vorhandene Node unangetastet (Variante C aus 3.3). Die vier Dienste bekommen dann ein Drop-in `/etc/systemd/system/waread-<name>.service.d/waread-node.conf`.
4. **Quelltext holen.** `git fetch --depth 1` von GitHub in ein privates Bauverzeichnis `/var/tmp/waread-build.*`, als Benutzer `nobody`. Es liest die Version aus der Datei `VERSION`.
5. **Bauen und prüfen**, alles als `nobody`, nie als root: Abhängigkeits-Tor (kein `lotusbail` in `package-lock.json`, `baileys` auf eine exakte Version festgelegt), `npm ci`, `npm run build` (mit Sende-Wächter), `npm test` (nicht bei `--skip-tests`), `npm run prune:prod`. Danach gehört der Baum root.
6. **Installieren** mit `deploy/install.sh --no-start` (Abschnitt 6: Benutzer `waread`, Verzeichnisse, Release, Units, Nginx-Ausschnitt), bei eigenem Node mit `--node`.
7. **Passwort.** Abfrage am Terminal, ohne Echo, zweimal, mindestens 10 Zeichen. Der Hash entsteht mit `hash-password.js` als Benutzer `waread` (das Passwort geht nur über stdin, nie als Argument) und ersetzt die Platzhalterzeile in `/etc/waread/config.toml`. Eine schon gesetzte Konfiguration bleibt unberührt.
8. **Starten.** Neustart von `waread-ingest` und `waread-web`, Start der beiden Aufräum-Timer, Warten auf `GET /healthz`. Am Ende steht, was noch von Hand zu tun ist.

**Bleibt deine Aufgabe:** Craft-Ausgangszustand sichern **vor** dem Skript (Abschnitt 2) und danach vergleichen (13), die `include`-Zeile in Nginx (Abschnitt 8; das Skript baut Nginx nicht um), die Kopplung mit der Testnummer (10) und die Prüfungen 11, 12 und 14. Das Skript koppelt nicht, schaltet den Update-Timer nicht ein und ändert nichts am Craft-System.

Optionen (`sudo bash install.sh --help`): `--ref REF` (Branch, Tag oder Commit; Standard `main`), `--repo URL`, `--skip-tests`, `--skip-password` (Platzhalter bleibt, Dienste starten nicht), `--no-start`, `--upgrade`, `--keep-build`.

**Wiederholung und Update.** Das Skript ist wiederholbar. Ist die Version aus dem Repository schon aktiv, entfällt Bauen und Installieren, und es prüft nur noch Units, Nginx-Ausschnitt und startet die Dienste neu. Ist eine **andere** Version aktiv, bricht es ab, solange `--upgrade` fehlt: Ein Update startet die Dienste neu und kann die Datenbank ändern, und für die Datenbank gibt es keinen Rückweg (`docs/MAINTENANCE.md`). Erst sichern, dann mit `--upgrade`. Bei einem Fehler bleibt das Bauverzeichnis zum Nachsehen liegen; es steht in der letzten Zeile.

**Was geprüft ist und was nicht.** Geprüft in einer x86-64-Sandbox mit echtem GitHub, echtem npm, echtem nginx 1.24 und echtem Node 22: der ganze Ablauf auf frischem System (Passwort über ein Pseudo-Terminal), die Wiederholung, das Update (inklusive der Tests), Abbruch bei fehlendem `--upgrade`, belegtem Port, nginx-Änderung durch apt, unbekannter Option, nicht vorhandenem `--ref`, fehlendem Terminal, `--skip-password` und `--no-start`; danach Anmeldung (falsches Passwort 401, richtiges 200, Cookie `Path=/waread/`) über nginx. **Nicht geprüft:** ein Lauf auf einem Pi (arm64, echte Download-Zeiten, ob die vorgebauten Programmteile von `better-sqlite3` und `sharp` für arm64 geladen werden oder kompiliert werden müssen), das Verhalten der Units unter echtem systemd (in der Sandbox ersetzte eine Attrappe `systemctl` und startete die Dienste direkt) und `cron`/`needrestart` auf dem Pi.

---

## 1. Vorab-Prüfung

```bash
uname -m                    # erwartet: aarch64 (64-Bit). Bei armv7l: nicht das Zielsystem
free -h                     # wie viel RAM ist frei? (Budget siehe unten)
df -h /opt /var/lib         # freier Platz; Medien gehören idealerweise auf eine SSD
nginx -v                    # Nginx vorhanden?
timedatectl                 # "System clock synchronized: yes" – WhatsApp reagiert empfindlich auf falsche Uhrzeit
command -v node && node --version    # ist Node.js schon da, und ab 22.12? (siehe Abschnitt 3!)
sudo ss -ltn                # belegte lokale Ports ansehen
```

**Speicher-Rahmen laut Konzept:** Ingest bis 256 MB, Web 128 MB, Umwandlungen 128 MB, zusammen unter etwa 500 MB. Ein Pi mit 2 GB reicht, 4 GB sind komfortabel – abzüglich dem, was die Craft-Apps bereits belegen.

**Port prüfen:** Der Web-Dienst lauscht standardmäßig auf `127.0.0.1:8780` (Annahme dieses Pakets). Prüfe, dass der Port frei ist:

```bash
sudo ss -ltn 'sport = :8780'     # erwartet: nur die Kopfzeile, keine Zeile mit Eintrag
```

Ist er belegt, wähle einen anderen und ändere ihn später an den drei Stellen aus Abschnitt 7.

**Wichtig bei vorhandenem Node.js:** Wenn `node` bereits installiert ist, kann es sein, dass das Craft-System es nutzt. Ersetze oder aktualisiere es **nicht**. Siehe Abschnitt 3, Variante C.

---

## 2. Craft-Ausgangszustand festhalten (VOR jeder Änderung)

Wir legen einen Schnappschuss der Dinge an, die unverändert bleiben müssen. Das Skript ist **rein lesend**.

```bash
cat > ~/craft-snapshot.sh <<'EOF'
#!/usr/bin/env bash
# Nur lesend. Aufruf: sudo bash craft-snapshot.sh <Zielverzeichnis>
set -u
out="${1:?Zielverzeichnis angeben}"
mkdir -p "$out"

# 1) craft-update: Prüfsumme, Besitzer, Rechte, Größe, Zeitstempel
{
  sha256sum /usr/local/bin/craft-update
  stat -c '%n | %U:%G | %a | %s Byte | mtime %y' /usr/local/bin/craft-update
} > "$out/01-craft-update.txt" 2>&1

# 2) Craft-systemd-Einheiten: Struktur inkl. Symlinks (enable-Verknüpfungen)
find /etc/systemd/system /usr/lib/systemd/system -name '*craft*' \
  -printf '%p | typ %y | -> %l\n' 2>/dev/null | sort > "$out/02-craft-units-struktur.txt"

# 3) Craft-systemd-Einheiten: Prüfsummen der Dateien
find /etc/systemd/system /usr/lib/systemd/system -name '*craft*' -type f \
  -exec sha256sum {} + 2>/dev/null | sort -k2 > "$out/03-craft-units-pruefsummen.txt"

# 4) enabled / disabled
systemctl list-unit-files '*craft*' --no-legend --no-pager > "$out/04-craft-units-enabled.txt" 2>&1

# 5) Webroot: Dateiliste mit Größe und Änderungszeit
find /var/www/craft -printf '%p %s %T@\n' 2>/dev/null | sort > "$out/05-craft-webroot.txt"

# 6) Craft-Zustand: nur das Verzeichnis selbst (Inhalt darf sich durch Craft selbst ändern)
stat -c '%n | %U:%G | %a' /var/lib/craft > "$out/06-craft-state-dir.txt" 2>&1

# 7) Nginx: Prüfsummen aller Konfigurationsdateien außer solchen mit "waread" im Namen
find /etc/nginx -type f -not -name '*waread*' -exec sha256sum {} + 2>/dev/null \
  | sort -k2 > "$out/07-nginx-pruefsummen.txt"

echo "Schnappschuss geschrieben nach: $out"
EOF

sudo bash ~/craft-snapshot.sh ~/craft-vorher
ls ~/craft-vorher
```

Zusätzlich den Zustand einer bekannten Craft-App-Seite festhalten (`<CRAFT-URL>` = eine URL, die du kennst):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "<CRAFT-URL>" | tee ~/craft-vorher/08-craft-http-status.txt
systemctl is-active nginx | tee ~/craft-vorher/09-nginx-active.txt
```

Diesen Ordner `~/craft-vorher` **nicht löschen**. Er ist die Vergleichsbasis für Abschnitt 13.

> Das Skript liest nur. Es ruft `craft-update` nicht auf und startet nichts.


---

## 3. Pakete und Node.js

### 3.1 Benötigte Pakete

| Zweck | Paket / Werkzeug |
| --- | --- |
| Laufzeit und Build aller Dienste | Node.js **ab 22.12** (siehe 3.3) und `npm` |
| Audio-Umwandlung (Opus → AAC) im Ingest-Dienst | `ffmpeg` |
| Native Module (`better-sqlite3`, `sharp`): meist werden fertige Binärdateien geladen, sonst wird kompiliert | `build-essential`, `python3` |
| Download der Pakete, Updater | `ca-certificates`, `curl`, `openssl` (3.0 oder neuer, nur für den Updater) |
| optional, nur Diagnose | `sqlite3` (Kommandozeile) |

### 3.2 Erst simulieren, dann installieren

```bash
sudo apt update
sudo apt-get install -s --no-install-recommends ffmpeg build-essential python3 ca-certificates curl openssl sqlite3
```

Lies die Ausgabe. Zeilen mit `Inst <Paket>` zeigen, was installiert oder **aktualisiert** würde. Achte darauf, dass **`nginx` und alles, was nach Craft aussieht, nicht** aktualisiert wird. Wenn doch: nicht fortfahren, sondern prüfen, warum.

Erst danach:

```bash
sudo apt install --no-install-recommends ffmpeg build-essential python3 ca-certificates curl openssl sqlite3
```

### 3.3 Node.js ab 22.12

Die Untergrenze 22.12 steht im Feld `engines` aller `package.json`-Dateien dieses Projekts. Getestet wurde nur mit Node 22.23.4 auf x86_64; auf dem Pi lief bisher nichts.

**Vermutung, nicht geprüft:** Raspberry Pi OS auf Basis von Debian 12 liefert über `apt` nur Node 18, das ist zu alt. Prüfe es mit `apt policy nodejs` und `node --version`.

- **Variante A – Paket der Distribution:** nur wenn `apt policy nodejs` eine Version ab 22.12 zeigt **und** `node` noch nicht installiert war.
- **Variante B – offizielle Paketquelle (z. B. NodeSource):** Anleitung dort befolgen. Das ändert die systemweite Node-Version. Tu das nicht, wenn das Craft-System das vorhandene `node` benutzt.
- **Variante C – getrennte Installation (empfohlen, wenn `node` schon vorhanden ist):** das offizielle Binärarchiv von nodejs.org für `linux-arm64` nach `/opt/waread/node-22/` entpacken (Archiv-Prüfsumme gegen die Angabe auf nodejs.org prüfen; das Verzeichnis `/opt/waread` legt `install.sh` sonst erst später an, du kannst es vorher mit `sudo mkdir -p /opt/waread` erzeugen). Dann gilt:
  1. Zum Bauen (Abschnitt 5) in derselben Shell: `export PATH=/opt/waread/node-22/bin:$PATH`.
  2. `install.sh` mit `--node /opt/waread/node-22/bin/node` aufrufen (Abschnitt 6), damit es diese Version prüft.
  3. Die Units finden das Node über `Environment=PATH=…` und `/usr/bin/env node`. Für vier Units ein Drop-in anlegen, das den Suchpfad ergänzt (`sudo systemctl edit <unit>`, dort einfügen und speichern):

     ```ini
     [Service]
     Environment=PATH=/opt/waread/node-22/bin:/usr/local/bin:/usr/bin:/bin
     ```

     für `waread-ingest.service`, `waread-web.service`, `waread-cleanup.service` und `waread-cleanup-vacuum.service`. Die ausgelieferten Unit-Dateien bleiben unverändert, und das System-Node ebenso.
  4. Der Updater (`waread-update`) braucht irgendein `node` in `/usr/local/bin` oder `/usr/bin` (er liest damit nur `package-lock.json`). Gibt es dort keines, kannst du den Updater nicht benutzen.

Prüfen:

```bash
node --version && npm --version          # bei Variante C nach dem export aus Schritt 1
```

### 3.4 ffmpeg kurz testen

```bash
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=2 -c:a libopus /tmp/waread-t.ogg \
 && ffmpeg -hide_banner -loglevel error -i /tmp/waread-t.ogg -c:a aac /tmp/waread-t.m4a \
 && echo "ffmpeg: Opus -> AAC ok"
rm -f /tmp/waread-t.ogg /tmp/waread-t.m4a
```

Erwartet: `ffmpeg: Opus -> AAC ok`. Fehlt der Opus-Encoder (`libopus`) in deinem ffmpeg, betrifft das nur diesen Test, nicht die spätere Umwandlung; der Test legt dann bloß keine Opus-Datei an. In dem Fall erst nach der ersten echten Sprachnachricht prüfen.

---

## 4. Speicherorte (optional, vor der Installation)

`install.sh` legt alle Verzeichnisse unter `/var/lib/waread` selbst an und setzt die Rechte. Willst du Medien auf eine SSD legen, hänge den Ort **vorher** ein (mit `sudo mkdir -p /var/lib/waread/media` als Einhängepunkt); `install.sh` setzt Besitzer und Rechte auch auf einem vorhandenen Einhängepunkt.

### 4.1 Medien auf eine SSD (empfohlen)

Wenn eine SSD vorhanden ist, hänge `/var/lib/waread/media` dorthin ein (eigenes Dateisystem oder Bind-Mount). Fotos und Sprachnachrichten verursachen die meisten Schreibzugriffe; die SD-Karte fällt sonst als Erstes aus. Optional: verschlüsseltes Dateisystem (LUKS), damit gelöschte Reste auf dem Datenträger nicht lesbar bleiben.

### 4.2 `tmp/` im Arbeitsspeicher

Das ist optional und wird erst **nach** der Installation eingerichtet, weil dafür der Benutzer `waread` existieren muss (Abschnitt 6.1).

---

## 5. Bauen

Das Projekt (`waread-src/`) wird gebaut, bevor es installiert wird: TypeScript zu JavaScript, Frontend-Bündel, Abhängigkeiten. **Baue auf derselben CPU-Architektur und demselben Betriebssystem wie das Ziel** (am einfachsten auf dem Pi selbst, ARM64): `better-sqlite3` und `sharp` bringen native Programmteile mit, ein Build auf x86 funktioniert dort nicht.

Lege den Ordner `waread-src/` auf den Pi (zum Beispiel nach `~/waread-src`) und arbeite **als normaler Benutzer**, nicht als root:

```bash
cd ~/waread-src
node --version                  # ab 22.12
npm install                     # beim ersten Mal; braucht Internetzugang (siehe Hinweis)
npm run build                   # db -> ingest -> web -> frontend -> cleanup
npm test                        # empfohlen, braucht weder Netz noch WhatsApp
npm run prune:prod              # Entwicklungswerkzeuge entfernen (danach gibt es kein npm test mehr)
```

Was dabei passiert:

- `npm install` lädt die Abhängigkeiten für **alle** Teile (npm-Workspaces: `db`, `services/ingest`, `services/web`, `services/web/public`, `cleanup`) in ein gemeinsames `node_modules` im Projektwurzelordner. Wenn für `better-sqlite3` oder `sharp` kein fertiges Paket für ARM64 und deine Node-Version existiert, kompiliert npm lokal (mit `build-essential` und `python3`; das kann auf dem Pi mehrere Minuten dauern).
- `npm run build` baut zuerst `db`, dann den Ingest-Dienst. **Vor dem Ingest-Build läuft automatisch der Sende-Wächter** (`npm run check:no-send`, Skript `prebuild` in `services/ingest`): Er durchsucht den Quelltext des Ingest-Dienstes nach Aufrufen, die Nachrichten senden, Lesebestätigungen auslösen oder Anwesenheit melden könnten. Findet er etwas, bricht der Build ab, und es entsteht kein `dist`. Danach folgen Web-Dienst, Frontend und Cleanup-Dienst.
- Ergebnis: `db/dist`, `services/ingest/dist`, `services/web/dist`, `services/web/public/dist` (Frontend), `cleanup/dist`.

**Hinweis zur Lock-Datei:** Diesem Projekt liegt keine `package-lock.json` bei, weil die npm-Registry in der Entstehungsumgebung gesperrt war. Das erste `npm install` erzeugt sie. **Bewahre sie auf.** `install.sh` und `waread-update` verlangen sie im Release (sie ist die Grundlage für den Vergleich der WhatsApp-Bibliothek beim Update), und spätere Builds sollen `npm ci` statt `npm install` verwenden, damit keine Versionen unbemerkt wechseln. Das heißt auch: Die Versionsbereiche in den `package.json`-Dateien (zum Beispiel `baileys 7.0.0-rc14`, `better-sqlite3 ^12.0.0`) konnten nicht gegen die Registry geprüft werden. Wenn `npm install` eine davon nicht auflösen kann, melde den Fehler, statt die Version zu raten.

Schlägt der Build oder ein Test fehl, installiere **nichts**.

Danach prüfst du die Abhängigkeiten, bevor sie auf das System kommen: [SECURITY_TESTS.md](SECURITY_TESTS.md), Abschnitt 1.2 (Baileys-Version, kein `lotusbail`).

---

## 6. Installieren mit `deploy/install.sh`

```bash
cd ~/waread-src
sudo ./deploy/install.sh --no-start            # Variante C: zusätzlich --node /opt/waread/node-22/bin/node
```

`install.sh` ist wiederholbar und prüft vor jeder Änderung die Voraussetzungen (Node ab 22.12, systemd, `nginx`, den Release-Vertrag aus [deploy/README.md](../deploy/README.md)). Es tut, in dieser Reihenfolge:

1. Systembenutzer `waread` anlegen (ohne Login-Shell), falls er fehlt.
2. Verzeichnisse und Rechte setzen: `/opt/waread` (root), `/etc/waread` (0750 root:waread), `/var/lib/waread` und `db/`, `media/`, `media/avatars/` (0750 waread), `auth/` und `tmp/` (0700 waread, Dateien in `auth/` 0600).
3. `/etc/waread/config.toml` aus `config/config.example.toml` anlegen, **nur wenn sie fehlt**. Eine vorhandene Konfiguration bleibt unverändert.
4. Das Projekt nach `/opt/waread/releases/<version>` kopieren (Version aus der Datei `VERSION`), dem Benutzer root zuordnen und den Symlink `/opt/waread/current` atomar umstellen. Ein bereits vorhandenes Release gleicher Version wird nie überschrieben.
5. Die acht systemd-Units nach `/etc/systemd/system/` legen, den Updater nach `/usr/local/sbin/waread-update`, das Nginx-Snippet nach `/etc/nginx/snippets/waread.conf`.
6. `nginx -t` ausführen. Schlägt der Test fehl, werden die Dienste **nicht** aktiviert.
7. `waread-ingest`, `waread-web`, `waread-cleanup.timer` und `waread-cleanup-vacuum.timer` aktivieren. Der Update-Timer (`waread-update.timer`) bleibt **aus**.
8. Nginx nur neu laden, wenn das Snippet dort schon eingebunden ist.

Es startet die Dienste nicht, solange die Konfiguration aus der Beispieldatei stammt (sie enthält Platzhalter). Es ändert nichts am Craft-System: kein `craft-update`, kein `/var/lib/craft`, kein `/var/www/craft`, keine Craft-Units.

Kontrolle:

```bash
readlink /opt/waread/current                                  # releases/<version>
sudo stat -c '%a %U:%G %n' /opt/waread /etc/waread /etc/waread/config.toml /var/lib/waread /var/lib/waread/*
ls /etc/systemd/system | grep '^waread-'                      # acht Dateien
sudo systemd-analyze verify /etc/systemd/system/waread-ingest.service \
                            /etc/systemd/system/waread-web.service \
                            /etc/systemd/system/waread-cleanup.service \
                            /etc/systemd/system/waread-cleanup-vacuum.service
```

Warnungen lesen. Hinweise auf fehlende Pfade bedeuten meist, dass `current` oder die Node-Installation nicht stimmt. Härtung ansehen (Erwartungswerte in [SECURITY_TESTS.md](SECURITY_TESTS.md), B3):

```bash
for u in waread-ingest waread-web waread-cleanup; do
  echo "== $u"
  systemctl show "$u.service" -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome \
    -p PrivateTmp -p ReadWritePaths -p MemoryMax -p Nice -p IOSchedulingClass
done
```

### 6.1 `tmp/` im Arbeitsspeicher (optional, empfohlen)

Die Ingest-Unit setzt `TMPDIR=/var/lib/waread/tmp`, und die Cleanup-Dienste legen dort ihre Sperrdatei `cleanup.lock` ab. Die Teildateien des Ingest (`*.part`, Vorschau, Sprachumwandlung) liegen **nicht** hier, sondern neben der Zieldatei im Medienordner. Ob Bibliotheken (sharp, ffmpeg) `TMPDIR` für eigene Zwischendateien nutzen, ist UNBEKANNT. Im Arbeitsspeicher (tmpfs) schont das die SD-Karte also nur für das, was tatsächlich dort landet. Die Dienste laufen zu diesem Zeitpunkt noch nicht (`--no-start`).

```bash
echo "tmpfs /var/lib/waread/tmp tmpfs rw,nosuid,nodev,noexec,nofail,size=256m,mode=0700,uid=$(id -u waread),gid=$(id -g waread) 0 0" \
  | sudo tee -a /etc/fstab
sudo findmnt --verify         # Syntax der fstab prüfen
sudo mount /var/lib/waread/tmp
findmnt /var/lib/waread/tmp
```

`nofail` verhindert, dass ein Fehler in dieser Zeile den Start des Pi blockiert. `size=256m` zählt gegen den Arbeitsspeicher; passe den Wert an dein Speicherbudget an.

---

## 7. Konfiguration

```bash
sudo nano /etc/waread/config.toml
```

Alle Schlüssel sind in der Datei kommentiert. **Ersetzen musst du:**

- **Passwort-Hash** (`[web] password_hash`, Platzhalter `PLATZHALTER-ARGON2ID-HASH-HIER-EINTRAGEN`). Der Web-Dienst startet mit dem Platzhalter absichtlich nicht. Hash erzeugen (Eingabe ohne Echo, Mindestlänge 10 Zeichen, das Passwort wird nie als Argument übergeben):

  ```bash
  cd /opt/waread/current
  node services/web/dist/hash-password.js
  ```

  Die Ausgabe (eine Zeile, beginnt mit `$argon2id$`) kommt in Anführungszeichen hinter `password_hash = `. Trage **nie ein Klartext-Passwort** ein. Alternativ `password_hash_file` mit dem Pfad einer Datei (Rechte 0640 root:waread), die den Hash enthält.
- **Port** (`[web] port`). Annahme dieses Pakets: **8780**. Der Wert ist eine Festlegung, keine Vorgabe: Ist der Port auf deinem Pi belegt (Abschnitt 1), wähle einen anderen und ändere ihn **an drei Stellen**: `[web] port`, `update_health_url` in `[update]` und alle Vorkommen von `127.0.0.1:8780` in `/etc/nginx/snippets/waread.conf`. Der Dienst lauscht immer nur auf `127.0.0.1`.

**Ab Version 2 (`docs/VERSION2.md`):** Eine vorhandene `config.toml` behält `hide_deleted_content = true` aus der Erstinstallation. Soll der Text „für alle gelöscht“ markierter Nachrichten sichtbar bleiben, auf `false` stellen. `store_view_once` (Einmal-Medien speichern) bleibt aus, bis das Journal mit `viewonce_probe` gezeigt hat, dass WhatsApp den Schlüssel liefert.

**Prüfen, nicht ändern, solange du nichts Besonderes vorhast:**

- `[web] cookie_path = "/waread/"` muss zum Nginx-Pfad passen (`/waread/`).
- Pfade unter `[paths]` (Standard `/var/lib/waread/...`). Ingest, Web und Cleanup lesen dieselben Schlüssel `db` und `media_dir`.
- Aufbewahrung: Standard **3 Tage**, einstellbar in der Oberfläche (Einstellungen → Aufbewahrung). Den Abschnitt `[retention]` in der Datei lässt du auskommentiert.
- `[update] update_source_url` bleibt **leer**. Es gibt keine eingebaute Update-Quelle (Abschnitt 15 und [MAINTENANCE.md](MAINTENANCE.md)).

Kontrolle:

```bash
sudo stat -c '%a %U:%G %n' /etc/waread/config.toml      # erwartet: 640 root:waread
```

---

---

## 8. Nginx einrichten

Nginx wird **nur ergänzt**, nie umgebaut. Die bestehenden Server-Blöcke der Craft-Apps bleiben unverändert.

### 8.1 Sicherungskopie

```bash
sudo cp -a /etc/nginx ~/nginx-backup-$(date +%Y%m%d-%H%M)
```

### 8.2 Snippet einbinden

`install.sh` hat das Snippet bereits nach `/etc/nginx/snippets/waread.conf` gelegt (Quelle: `deploy/nginx/waread.conf`; ohne `--skip-nginx`). Es enthält drei `location`-Blöcke: `/waread` → `/waread/`, den SSE-Endpunkt `/waread/events` (ungepuffert, Lese-Timeout 1 Stunde) und `/waread/` (UI, API, Medien, `/healthz`; das Präfix wird entfernt). Es ändert keinen Server-Block.

Ein `location` kann in Nginx nur **innerhalb** eines `server { … }`-Blocks stehen. Darum musst du **eine** Zeile in den Server-Block eintragen, über den waread im Heimnetz erreichbar sein soll. Das ist die **eine bewusste Ausnahme** von „bestehende Blöcke bleiben unverändert“. Mach genau diese eine Zeile, nichts sonst, und belege sie mit dem Vergleich in 8.4:

```nginx
server {
    # ...bestehende Einstellungen bleiben unverändert...
    include /etc/nginx/snippets/waread.conf;
}
```

Hast du in Abschnitt 7 einen anderen Port als 8780 gewählt, ersetze vorher alle Vorkommen von `127.0.0.1:8780` in `/etc/nginx/snippets/waread.conf` (zwei `proxy_pass`-Zeilen).

### 8.3 Immer erst prüfen, dann neu laden

```bash
sudo nginx -t
```

Nur wenn beide Zeilen **`syntax is ok`** und **`test is successful`** lauten:

```bash
sudo systemctl reload nginx
```

Bei einem Fehler: **nicht** neu laden. Änderung korrigieren oder die `include`-Zeile entfernen, bis `nginx -t` wieder grün ist. Nie `restart` statt `reload` verwenden; `reload` hält laufende Verbindungen der Craft-Apps am Leben. Die Syntax der Snippet-Datei wurde bei der Entstehung dieses Pakets **nicht** mit einem echten Nginx geprüft; `nginx -t` ist hier der erste echte Test.

### 8.4 Vergleich mit der Sicherung

```bash
sudo diff -r ~/nginx-backup-<datum-uhrzeit> /etc/nginx
```

Erwartet: **nur** die neue `snippets/waread.conf` und die eine `include`-Zeile. Jede weitere Abweichung ist ein Befund.

Nochmals ansehen, ob die Craft-Seite weiter antwortet:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "<CRAFT-URL>"      # gleicher Wert wie in ~/craft-vorher/08-craft-http-status.txt
```

---

## 9. Dienste starten und erste Prüfung

```bash
sudo systemctl start waread-web.service waread-ingest.service
sudo systemctl start waread-cleanup.timer waread-cleanup-vacuum.timer
systemctl is-active waread-web waread-ingest waread-cleanup.timer waread-cleanup-vacuum.timer     # erwartet: je "active"
```

Falls ein Dienst nicht startet: `sudo systemctl status waread-ingest.service --no-pager` und `sudo journalctl -u waread-ingest -n 50 --no-pager`. Die Journale enthalten laut Vorgabe nur Ereignistypen, IDs und Fehlercodes.

Die Datenbank legen der Ingest- und der Web-Dienst beim Start an und führen die Migrationen aus (`runMigrations`, beide dürfen gleichzeitig starten). Datenbank angelegt?

```bash
sudo ls -l /var/lib/waread/db/                     # waread.db, Besitzer waread
sudo -u waread sqlite3 -readonly /var/lib/waread/db/waread.db 'PRAGMA journal_mode;'     # erwartet: wal
```

Der Cleanup-Dienst legt nie eine Datenbank an. Fehlt sie noch, endet sein Lauf mit einem Fehler (Exit 1), bis Ingest oder Web gestartet sind.

Web erreichbar?

```bash
curl -s http://127.0.0.1:8780/healthz                      # direkt am Dienst (dein Port aus Abschnitt 7); erwartet: OK
curl -sI http://127.0.0.1/waread/ | head -n 5              # über Nginx (nach Abschnitt 8)
```

Dann im Browser `http://<Pi-IP>/waread/` öffnen. Es muss die Anmeldeseite erscheinen. Mit dem eingerichteten Passwort anmelden.

Antwortet die direkte Prüfung, Nginx aber mit `502 Bad Gateway`, liegt das mit hoher Wahrscheinlichkeit an einer der **ungetesteten** Netzsperren: `waread-web.service` setzt `IPAddressDeny=any` und `IPAddressAllow=localhost` (das Konzept verbietet dem Web-Dienst jeden ausgehenden Verkehr). Zum Eingrenzen die zwei Zeilen in `/etc/systemd/system/waread-web.service` auskommentieren, `sudo systemctl daemon-reload && sudo systemctl restart waread-web` und erneut prüfen. Ob die Sperre die Ursache war, ist dann belegt; ob sie auf deinem System funktioniert, habe ich nicht prüfen können.

---

## 10. Erste QR-Kopplung (mit der Testnummer)

**Konto A, die Testnummer, wird gekoppelt – nicht dein Hauptkonto.**

1. In waread unter **Einstellungen → „Verbindung anzeigen“** (oder direkt `…/waread/#/connection`) den Status ansehen. Beim ersten Start verbindet sich der Ingest-Dienst **nicht** von selbst (`auto_pair_on_start = false`, Standard seit der Behebung von F03; so entsteht keine ungewollte Kopplungssitzung bei jedem Neustart). Der Status steht auf „QR-Code scannen“ ohne Code. Tippe auf **„Neu verbinden“**: erst dann beginnt die Kopplungssitzung, und der QR-Code erscheint. Er wechselt alle paar Sekunden. Die Seite darf nur nach der Anmeldung erreichbar sein; prüfe das kurz in einem privaten Browserfenster ohne Anmeldung.
2. Auf dem **Handy mit Konto A**: WhatsApp → *Einstellungen → Verknüpfte Geräte → Gerät hinzufügen* und den QR-Code vom Bildschirm scannen.
3. Du kannst den Code nicht vom selben Telefon scannen, auf dem du waread gerade anzeigst. Nimm einen zweiten Bildschirm (Computer oder Tablet). Eine Kopplung per Code mit Telefonnummer gibt es in diesem Paket nicht.
4. Status in waread wird **„verbunden“**.

**Erwartetes Verhalten beim ersten Verbinden:** WhatsApp liefert beim Koppeln den Verlauf nach. Das dauert einige Minuten und erzeugt eine Lastspitze. waread verwirft alles, was älter als die eingestellte Aufbewahrung ist, und lädt aus dem Verlauf keine Medien nach. Beobachte in dieser Zeit den Speicher:

```bash
systemd-cgtop -b -n 1 | grep -E 'waread|Path'
systemctl show waread-ingest.service -p MemoryCurrent -p MemoryMax
```

### Kontowechsel (z. B. von der Testnummer zum Hauptkonto)

1. Am Handy der **alten** Nummer: *Verknüpfte Geräte* → den Pi abmelden.
2. Auf dem Pi:

```bash
sudo systemctl stop waread-ingest.service
sudo find /var/lib/waread/auth -mindepth 1 -delete
```

3. In waread unter *Einstellungen → Speicher leeren* den Umfang **Alles** wählen (sonst bleiben Daten des alten Kontos stehen). Das löscht Nachrichten und Medien und beauftragt den Ingest, auch die gemerkten Anzeigenamen und die Zuordnung Kennung ↔ Telefonnummer (`ingest-state.db`) zu leeren. Der Auftrag bleibt gespeichert, bis der Ingest läuft; er wirkt beim Start in Schritt 4 noch vor dem ersten Verbindungsaufbau (Journal: `state_identity_cleared`). Meldet dich das alte Konto vom Handy ab (Schritt 1) und der Ingest war gerade aktiv, leert er diese Daten schon dabei von selbst.
4. `sudo systemctl start waread-ingest.service` und wie oben neu koppeln.

---

## 11. Verbindung prüfen

| Prüfung | Wie | Erwartet |
| --- | --- | --- |
| Status | Seite „Verbindung“ in den Einstellungen | „verbunden“ |
| Dienste | `systemctl is-active waread-ingest waread-web` | beide `active` |
| Speicher | `systemctl show waread-ingest.service -p MemoryCurrent` (Byte-Wert) | im Leerlauf deutlich unter dem Zielwert 150–250 MB |
| Rechte der Schlüssel | `sudo find /var/lib/waread/auth -type f ! -perm 0600` | keine Ausgabe |
| Text | Von Konto B (zweites Handy) eine Nachricht an A schicken | erscheint in Sekunden in waread, gelb als „neu“ |
| Foto | Von B ein Foto | erst Miniatur, dann Bild; Vollbild und Speichern gehen |
| Sprachnachricht | Von B eine Sprachnachricht | abspielbar in Safari, Vor- und Zurückspulen geht (Range-Anfragen) |
| Aufbewahrung | Ältesten Eintrag in der Liste ansehen | nichts, das älter als die Aufbewahrung ist (Standard 3 Tage) |
| Journal ohne Inhalte | `sudo journalctl -u waread-ingest -n 30 --no-pager` | nur Ereignistypen, IDs, Fehlercodes – keine Texte, Namen, Dateinamen |
| Timer | `systemctl list-timers 'waread*' --no-pager` | `waread-cleanup.timer` und `waread-cleanup-vacuum.timer` mit nächstem Lauf (`waread-update.timer` ist aus) |
| Zeit | `timedatectl` | Uhr synchronisiert |

**Sofort danach:** den **Zweitnummer-Test** durchführen ([SECURITY_TESTS.md](SECURITY_TESTS.md), Abschnitt 3). Erst wenn er bestanden ist, geht es mit Abschnitt 12 weiter.

---

## 12. Verbindungsabbruch und Wiederverbindung bewusst testen

Das Konzept verlangt: Wiederverbindung automatisch, mit wachsender Wartezeit (von etwa 5 Sekunden bis höchstens etwa 10 Minuten), **nie in einer engen Schleife**. Das prüfst du hier aktiv, nicht erst im Störfall. Führe diese Tests **nur mit der Testnummer** durch.

### 12.1 Neustart nur des Ingest-Dienstes

```bash
systemctl show waread-web.service    -p ActiveEnterTimestamp     # Zeit notieren
sudo systemctl restart waread-ingest.service
```

Erwartet: Status wechselt kurz auf „getrennt/verbindet“, dann wieder **„verbunden“ ohne neuen QR-Code**. Der Web-Dienst wurde **nicht** neu gestartet:

```bash
systemctl show waread-web.service -p ActiveEnterTimestamp       # unverändert gegenüber vorher
```

### 12.2 Neustart nur des Web-Dienstes

```bash
systemctl show waread-ingest.service -p ActiveEnterTimestamp     # Zeit notieren
sudo systemctl restart waread-web.service
systemctl show waread-ingest.service -p ActiveEnterTimestamp     # unverändert: WhatsApp-Verbindung blieb bestehen
```

### 12.3 Netzunterbrechung nur für waread

Variante A – nur wenn `nft` **bereits** auf dem Pi vorhanden ist (`command -v nft`). **Installiere dafür kein Firewall-Paket nachträglich:** Das aktiviert unter Umständen einen Dienst, der bestehende Regeln überschreibt. Die Regel betrifft nur Prozesse des Benutzers `waread`; deine SSH-Sitzung bleibt unberührt.

```bash
WUID=$(id -u waread)
sudo nft add table inet waread_test
sudo nft add chain inet waread_test out '{ type filter hook output priority 0 ; policy accept ; }'
sudo nft add rule inet waread_test out meta skuid "$WUID" drop
```

Variante B – ohne Werkzeuge: das Netzkabel des Pi ziehen bzw. die Verbindung des Pi am Router sperren, **nur wenn** deine SSH-Sitzung nicht über diese Verbindung läuft.

Beobachten (2–3 Minuten):

```bash
journalctl -u waread-ingest --since "-5 min" --no-pager | wc -l       # erwartet: wenige Zeilen, nicht hunderte
journalctl -u waread-ingest --since "-5 min" --no-pager | tail -n 20
```

Erwartet: Der Status in waread zeigt „getrennt/verbindet“; die Abstände zwischen Verbindungsversuchen **wachsen**; keine Flut. Während der Unterbrechung sendet B zwei Nachrichten an A (Text und Sprachnachricht).

Aufheben:

```bash
sudo nft delete table inet waread_test         # Variante A
nft list tables | grep waread_test || echo "Regel entfernt"
```

Dann abwarten: Die Verbindung kommt spätestens nach der längsten Wartezeit zurück (bis etwa 10 Minuten). Die während der Pause gesendeten Nachrichten erscheinen **meist** nach (garantiert ist das laut Konzept nicht). Notiere, ob sie angekommen sind. Danach den Zweitnummer-Test wiederholen, inklusive der nachgelieferten Nachrichten (SECURITY_TESTS.md, Abschnitt 3.2).

### 12.4 Neustart des ganzen Pi

```bash
sudo reboot
```

Nach dem Hochfahren: Dienste laufen von selbst (`systemctl is-active waread-ingest waread-web`, `systemctl list-timers 'waread*'`), Status wird „verbunden“ ohne neuen QR-Code, und die tmpfs-Einhängung `/var/lib/waread/tmp` ist da (`findmnt /var/lib/waread/tmp`). Das Craft-System startet unabhängig davon – prüfe, dass es erreichbar ist.

### 12.5 Abmeldung durch das Handy (nur Testnummer)

Am Handy von A: *Verknüpfte Geräte* → Pi abmelden. Erwartet: Der Ingest-Dienst löscht die lokale Sitzung (`auth/`) und wartet im Zustand „QR-Code scannen“ **ohne** QR-Code; es werden **nicht** laufend neue QR-Codes angefordert (Journal: `connection_closed` mit `reason=logged_out`, dann `connection_idle`, keine Schleife). Erst **„Neu verbinden“** in der Oberfläche beginnt eine neue Kopplung. Danach neu koppeln wie in Abschnitt 10.

---

## 13. Prüfschritt: Craft-System unverändert

**Pflichtschritt.** Der Vergleich beweist, dass die Installation das bestehende System nicht verändert hat.

```bash
sudo bash ~/craft-snapshot.sh ~/craft-nachher
diff -r ~/craft-vorher ~/craft-nachher && echo "KEINE ABWEICHUNG"
```

Auswertung je Datei:

| Datei | Erwartung bei Abweichung |
| --- | --- |
| `01-craft-update.txt` | **Keine** Abweichung erlaubt (Prüfsumme, Rechte, Größe, Zeitstempel). Sonst: Befund, sofort untersuchen. |
| `02`, `03`, `04` (Units) | **Keine** Abweichung erlaubt. Craft-Einheiten dürfen weder geändert, entfernt noch umgeschaltet sein. |
| `05-craft-webroot.txt` | Keine Abweichung durch waread. Eine Änderung durch Craft selbst (z. B. dessen eigenes Update) ist möglich; dann erklären (`journalctl -u '*craft*' --since …`). |
| `06-craft-state-dir.txt` | Besitzer und Rechte unverändert. (Der Inhalt von `/var/lib/craft` wird bewusst nicht verglichen, er ändert sich im Betrieb.) |
| `07-nginx-pruefsummen.txt` | **Nur** die in 8.2 bewusst vorgenommene `include`-Zeile darf auftauchen (falls sie nötig war). Alles andere: Befund. |

Zusätzlich:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "<CRAFT-URL>"      # gleich wie in ~/craft-vorher/08-craft-http-status.txt
systemctl is-active nginx                                    # wie in 09-nginx-active.txt
```

Lege das Ergebnis (Datum, „keine Abweichung“ oder erklärte Abweichungen) ab. Wiederhole Abschnitt 13 nach jedem späteren Eingriff in Nginx oder Deployment.

---

## 14. Freigabe für das Hauptkonto

Erst wenn **alle** Punkte erfüllt sind:

- [ ] Abschnitt 11 komplett grün.
- [ ] Zweitnummer-Test bestanden ([SECURITY_TESTS.md](SECURITY_TESTS.md), Abschnitt 3).
- [ ] Abschnitt 12 durchgeführt, Verhalten wie erwartet.
- [ ] Sicherheits-Baseline-Prüfung (SECURITY_TESTS.md, Abschnitt 5) ohne Befund.
- [ ] Abschnitt 13 ohne unerklärte Abweichung.
- [ ] Du hast ein aktuelles Backup deines iPhone (Konzept-Empfehlung) und weißt, wie du den Pi unter *Verknüpfte Geräte* jederzeit abmeldest.

Dann: Kontowechsel (Abschnitt 10, Unterpunkt „Kontowechsel“) und mit dem Hauptkonto koppeln. Das Hauptkonto am besten zuerst nur wenige Tage beobachten ([MAINTENANCE.md](MAINTENANCE.md)).

---

## 15. Manuelles Zurückrollen auf eine vorherige Version

Alle Versionen liegen unter `/opt/waread/releases/<version>/`; `current` zeigt auf die aktive. Der Updater (`waread-update`) schaltet bei einem fehlgeschlagenen Update **selbst** zurück (siehe [MAINTENANCE.md](MAINTENANCE.md)). Von Hand heißt Zurückrollen: den Symlink umstellen und die Dienste neu starten.

```bash
# 1. Was ist aktiv, was ist vorhanden?
readlink /opt/waread/current
ls -1 /opt/waread/releases

# 2. Auf die gewünschte ältere Version zeigen (atomar)
sudo ln -s releases/<ALTE-VERSION> /opt/waread/current.new
sudo mv -T /opt/waread/current.new /opt/waread/current
readlink /opt/waread/current

# 3. Dienste neu starten, damit der alte Code geladen wird
sudo systemctl restart waread-ingest.service waread-web.service

# 4. Kontrolle
systemctl is-active waread-ingest waread-web
```

Der Cleanup-Timer startet bei seinem nächsten Lauf automatisch die gerade aktive Version; es ist nichts weiter zu tun.

**Danach prüfen:** Status „verbunden“, ein Text von B kommt an. Wenn die Bibliotheksversion wechselt, gehört der Zweitnummer-Test dazu.

**Was beim Zurückrollen schiefgehen kann – und wie du damit umgehst:**

- **Datenbankschema.** Hat die neuere Version die Datenbank per Migration verändert, muss die ältere Version das Schema nicht verstehen. Die Datenbankschicht (`db/migrate.ts`) verweigert den Start gegen eine Datenbank mit höherer `user_version` (Fehler „neuere Programmversion nötig“); eine ältere Version läuft also nicht still mit einem Schema, das sie nicht kennt. Zurzeit gibt es nur die Schemaversion 1; Rückwärts-Migrationen gibt es nicht. Notausgang, weil die Daten kurzlebig sind und das iPhone die Quelle der Wahrheit bleibt: Dienste stoppen, nur die Datenbank verwerfen (`/var/lib/waread/db/`), **`auth/` unbedingt behalten**, Dienste starten. Verloren sind die Nachrichten der letzten Tage in waread, nicht in WhatsApp.
- **Sitzungsformat.** Nach einem Wechsel der Bibliotheks-Hauptversion kann die ältere Version die gespeicherte Sitzung unter Umständen nicht lesen; dann bleibt nur neues Koppeln (Abschnitt 10).
- **Fehlende alte Version.** Wurde die gewünschte Version bereits gelöscht (z. B. durch Aufräumen von Hand oder durch das Update-Skript), muss sie aus dem veröffentlichten Release-Paket oder aus dem Quellordner neu eingespielt werden (Abschnitte 5 und 6, bei einem Paket die Prüfsumme nicht vergessen). Lösche deshalb nie von Hand alte Versionen, bevor die neue sich bewährt hat; die vorherige Version sollte mindestens eine Woche erhalten bleiben (Empfehlung).
- **Nginx und Konfiguration** sind von der Versionsumstellung nicht betroffen. Hat die neue Version eine **geänderte `config.toml`-Struktur** verlangt, muss die Datei zur alten Version passen: Kopie vor dem Update anlegen (`sudo cp -a /etc/waread/config.toml /etc/waread/config.toml.vor-<version>`; die Kopie bekommt dieselben Rechte 0640).

Das Zurückrollen betrifft nur `/opt/waread/current` und die waread-Dienste. Das Craft-System bleibt unberührt; im Zweifel Abschnitt 13 danach erneut ausführen.

---

## 16. Annahmen und offene Punkte

Was in dieser Anleitung auf Annahmen beruht oder nicht getestet werden konnte. Nichts davon ist erfunden; was ich nicht wusste, steht hier als offen.

**Annahmen (zum Ändern gedacht):**

1. **Port 8780** für den Web-Dienst ist eine Festlegung dieses Pakets (Abschnitt 7).
2. **Node.js ab 22.12** folgt dem Feld `engines` der Projektdateien; getestet wurde nur mit 22.23.4 auf x86_64.
3. **Abhängigkeitsversionen** (`baileys 7.0.0-rc14`, `better-sqlite3 ^12`, `sharp ^0.35.4` und weitere) stammen aus den Teilergebnissen und konnten nicht gegen die npm-Registry geprüft werden (Abschnitt 5).

**Offen (du musst entscheiden oder prüfen):**

4. **Passwort:** du wählst es und erzeugst den Hash selbst (Abschnitt 7).
5. **Update-Quelle:** es gibt keine eingebaute. Ohne `update_source_url` und öffentlichen Schlüssel macht `waread-update` nichts ([MAINTENANCE.md](MAINTENANCE.md), Abschnitt 5; [deploy/README.md](../deploy/README.md), „Updates“).
6. **Nicht getestet:** die gesamte Kopplung mit einem echten WhatsApp-Konto, die echte Baileys-Bibliothek, das echte `better-sqlite3` (statt eines Ersatzes auf `node:sqlite`), die Nginx-Syntax und die Units unter echtem systemd auf echter ARM64-Hardware. Das alles entscheidet sich beim ersten Lauf mit der Testnummer.
7. **Nicht umgesetzt:** Bearbeiten und Löschen von Nachrichten durch den Absender (werden nicht nachgezogen), Profilbilder (die Oberfläche zeigt Initialen), Kopplung per Telefonnummer, Dateinamen von Dokumenten (die Datenbank speichert keinen).
8. **Passkey-Sperre (Abschnitt 17):** Safari/iOS, Zertifikat und Nginx-HTTPS-Block sind nicht getestet. Die Laufzeit der Passkey-Sitzung (`passkey_session_hours`, Standard 12) ist deine Entscheidung.

---

## 17. Passkey-Sperre (optional)

Mit der Passkey-Sperre öffnet sich die Weboberfläche nur noch, wenn du dich mit einem Passkey anmeldest (am iPhone: Face ID / Touch ID). Das Passwort gilt dann nicht mehr; der Server weist `POST /api/login` bei aktiver Sperre mit `403 passkey_required` ab. Ohne Konfiguration (Schritt 1) ändert sich nichts am bisherigen Betrieb.

> **Grenze, zuerst lesen:** Passkeys funktionieren nur über **HTTPS mit einem Host-Namen**. Mit `http://<Pi-IP>/waread/` gehen sie nicht, auch nicht mit Nginx davor. Das ist eine Vorgabe von WebAuthn, nicht dieses Pakets. Du brauchst also einen Namen im Heimnetz und ein Zertifikat dafür (Schritt 1).
> **Nicht getestet:** Safari/iOS, ein echtes Zertifikat, Nginx. Getestet ist die Logik mit einem Software-Authenticator und echtem Chromium mit dem virtuellen Authenticator (`test/passkey.test.mjs`, `test/passkey-e2e.mjs`). Ob Face ID mit deinem Zertifikat und deinem Namen funktioniert, zeigt erst der erste Versuch am iPhone.

### 17.1 Voraussetzungen schaffen

1. **Namen und Zertifikat.** Einen Namen wählen, der im Heimnetz auf den Pi zeigt (z. B. `waread.heimnetz.example`), und ein Zertifikat für genau diesen Namen bereitstellen. Auf dem iPhone muss das Zertifikat bzw. dessen CA als vertrauenswürdig gelten, sonst baut Safari die Seite nicht als sicheren Kontext auf. Wie du das löst, entscheidest du; dieses Paket legt kein Zertifikat an.
2. **Eigener Nginx-Block.** `deploy/nginx/waread-passkey.example.conf` ist ein **zusätzlicher** `server`-Block für den neuen Namen. Platzhalter ersetzen, nach `/etc/nginx/conf.d/` kopieren. **Keinen bestehenden Block ändern**, auch keinen des Craft-Systems. Danach wie in Abschnitt 8.3: erst `sudo nginx -t`, dann `sudo systemctl reload nginx`. Abschnitt 13 danach erneut ausführen (Craft unverändert).
3. **Konfiguration.** In `/etc/waread/config.toml`, Tabelle `[web]`:

```toml
passkey_rp_id = "waread.heimnetz.example"
passkey_origin = "https://waread.heimnetz.example"
```

`passkey_rp_id` ist nur der Name (klein, ohne Schema, Port oder Pfad, keine IP-Adresse). `passkey_origin` ist genau `https://<Name>` (mit Port, falls nicht 443; ohne Pfad, ohne `/` am Ende). Falsche Werte lehnt der Dienst beim Start mit einer Fehlermeldung ab. Dann `sudo systemctl restart waread-web`.

Optional: `passkey_session_hours` (Standard 12, 1 bis 720) ist die Laufzeit der Sitzung **nach** einer Passkey-Anmeldung. **Das ist eine offene Entscheidung für dich:** kurz heißt häufiger Face ID, lang heißt länger offen, wenn jemand das entsperrte Handy nimmt. Passwort-Sitzungen laufen weiter nach `session_days`.

### 17.2 Passkey fürs iPhone anlegen und Sperre einschalten

1. Auf dem **iPhone** die HTTPS-Adresse öffnen (`https://<Name>/waread/`), mit dem Passwort anmelden.
2. **Einstellungen → Passkey-Sperre → „Passkey auf diesem Gerät erstellen“.** Face ID bestätigen. Der Passkey erscheint in der Liste.
3. **„Sperre aktivieren“** und noch einmal mit Face ID bestätigen. Diese Bestätigung ist Absicht: so ist bewiesen, dass der Passkey funktioniert, **bevor** das Passwort abgeschaltet wird.
4. Mit aktiver Sperre werden alle anderen angemeldeten Geräte abgemeldet. Beim nächsten Öffnen siehst du nur „Mit Passkey anmelden“.

Hinzufügen und Löschen von Passkeys sowie Sperre aufheben verlangen bei aktiver Sperre jeweils eine frische Passkey-Bestätigung. Der letzte Passkey lässt sich bei aktiver Sperre nicht löschen. **Lege einen zweiten Passkey an** (anderes Gerät oder iCloud-Schlüsselbund), wenn du kannst.

### 17.3 Notausstieg (Handy weg, Passkey weg)

Direkt auf dem Pi, als Dienstbenutzer (liest `/etc/waread/config.toml` und ändert nur die Passkey-Datei, bei `unlock` einer defekten Datei zusätzlich deren Umbenennung):

```bash
sudo -u waread node /opt/waread/current/services/web/dist/passkey-admin.js status
sudo -u waread node /opt/waread/current/services/web/dist/passkey-admin.js unlock          # Sperre aus, Passkeys bleiben
sudo -u waread node /opt/waread/current/services/web/dist/passkey-admin.js reset --yes     # alle Passkeys und die Sperre löschen
```

Der Dienst übernimmt die Änderung innerhalb von etwa einer Sekunde, ein Neustart ist nicht nötig. Ist die Datei `passkeys.json` unlesbar oder ungültig, bleibt die Sperre **zu** (der Dienst schließt im Zweifel): dann `unlock` (verschiebt die defekte Datei nach `passkeys.json.broken-<Zeit>`) oder `reset --yes`.

### 17.4 Was die Sperre nicht leistet

- Wer Dateizugriff auf `/var/lib/waread` hat (root, der Benutzer `waread`), umgeht die Sperre. Sie schützt die Weboberfläche, nicht den Pi.
- Sitzungen sind weiterhin zustandslose, signierte Token. Eine einzelne Sitzung lässt sich nicht widerrufen; Ein- und Ausschalten der Sperre macht aber **alle** früheren Sitzungen ungültig.
- Die Sperre betrifft nur den Zugang zur Oberfläche. Sie ändert nichts daran, dass waread nichts an WhatsApp sendet.
