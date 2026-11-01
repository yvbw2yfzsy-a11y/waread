# waread – Deployment

Alles, was für Installation und Betrieb auf dem Raspberry Pi nötig ist: systemd-Units, Nginx-Snippet, Installationsskript und ein eigenständiger Updater. Nichts davon berührt das Craft-Apps-System (`/var/www/craft`, `/var/lib/craft`, `/usr/local/bin/craft-update`, deren Units).

## Inhalt

| Datei | Zweck |
|---|---|
| `install.sh` | Benutzer, Verzeichnisse, Release kopieren, `current`-Symlink, Units, `nginx -t`, Dienste aktivieren |
| `make-release.sh` | aus dem gebauten Baum ein Update-Paket erzeugen: `waread-<version>.tar.gz` und `latest.manifest` (unsigniert) |
| `waread-update` | Updater (nach `/usr/local/sbin/waread-update` installiert), unabhängig von `craft-update` |
| `systemd/waread-ingest.service` | WhatsApp-Ingest (Baileys, nur lesend) |
| `systemd/waread-web.service` | Web-Backend + Frontend, nur 127.0.0.1 |
| `systemd/waread-cleanup.service` + `.timer` | Aufräumen, stündlich um :17 |
| `systemd/waread-cleanup-vacuum.service` + `.timer` | VACUUM, sonntags ca. 04:30 Europe/Berlin |
| `systemd/waread-update.service` + `.timer` | Update, täglich ca. 03:00 Europe/Berlin, **ab Werk nicht aktiviert** |
| `nginx/waread.conf` | Snippet für `/waread/`, wird von Hand eingebunden |
| `craft-launcher/` | optional: erweiterte Fassung von `craft-update` mit waread-Karte auf der Pi-Startseite; wird von `install.sh` **nicht** installiert (`craft-launcher/README.md`) |

## Voraussetzungen auf dem Pi

- Linux mit systemd, Nginx bereits vorhanden.
- Node.js ab Version **22.12** (so steht es in den `engines`-Feldern; `MIN_NODE_MAJOR`/`MIN_NODE_MINOR` in `install.sh`), auffindbar als `node` in `/usr/local/bin` oder `/usr/bin` (die Units starten `/usr/bin/env node` mit `PATH=/usr/local/bin:/usr/bin:/bin`). Ein per nvm im Home-Verzeichnis installiertes Node wird **nicht** gefunden. Liegt Node 22 an anderer Stelle, hilft `install.sh --node PFAD` für die Versionsprüfung, und die Units brauchen ein Drop-in mit dem vollen Pfad (docs/INSTALL.md, Abschnitt 3). Raspberry Pi OS (Bookworm) liefert per `apt` nur Node 18. Gebaut und getestet wurde mit Node 22.23.4 in einer x86-64-Sandbox, **nicht** auf einem Pi.
- `ffmpeg`, `flock` (util-linux), `curl`, GNU `tar`.
- Für Updates zusätzlich `openssl` ab 3.0 (Ed25519-Prüfung mit `pkeyutl -rawin`).

## Release-Vertrag

Ein Release ist der **gebaute** Projektbaum. Die Aufgabenstellung legte nur die Quelltext-Struktur fest; die Form des Releases ist eine Festlegung beim Zusammenführen und ist in `install.sh`, `waread-update` und `make-release.sh` hinterlegt (`REQUIRED_RELEASE_FILES`, `REQUIRED_RELEASE_DIRS`).

| # | Festlegung | Wo es steckt |
|---|---|---|
| A1 | Gebaute Einstiegspunkte: `services/ingest/dist/index.js`, `services/web/dist/server.js`, `services/web/public/dist/index.html`, `cleanup/dist/cleanup.js`, `db/dist/client.js`; außerdem `db/schema.sql` und `config/config.example.toml` | `ExecStart=`/`AssertPathExists=` in den Units, `REQUIRED_RELEASE_FILES` in `install.sh`, `waread-update` und `make-release.sh` (`install.sh` und `make-release.sh` prüfen zusätzlich Dateien unter `deploy/`) |
| A2 | `cleanup/dist/cleanup.js --vacuum` führt ein VACUUM aus und beendet sich; ohne Argument wird normal aufgeräumt | `waread-cleanup-vacuum.service` |
| A3 | Das Release enthält fertig installierte **Produktions-**`node_modules` (`npm run prune:prod`, für arm64 gebaut, inkl. `better-sqlite3` und `sharp`, mit `node_modules/@waread/db`) und `package-lock.json` im Wurzelverzeichnis. Weder `install.sh` noch `waread-update` führen `npm` aus. | `REQUIRED_RELEASE_DIRS`, Bibliothekstor, `make-release.sh` |
| A4 | Die Version steht in der Datei `VERSION` (oder in `package.json`), Format `X.Y.Z` ohne Zusätze wie `-rc1` | `install.sh` (oder `--version`), `make-release.sh` |
| A5 | Die Dienste lesen `/etc/waread/config.toml` selbst und **tolerieren die Tabelle `[update]`** (sie lesen nur ihre eigenen Abschnitte). Das Backend lauscht auf `127.0.0.1:8780` (Port ist Festlegung dieses Pakets) | Units, Nginx-Snippet, `update_health_url` |
| A6 | Das Backend sieht Pfade ohne Präfix (`/healthz`, `/events`, `/api/login`); das Frontend benutzt relative URLs, Nginx entfernt `/waread/` | `nginx/waread.conf` |
| A7 | Das Arbeitsverzeichnis `/opt/waread/current` ist unkritisch | `WorkingDirectory=` |
| A8 | Das Release enthält auch `deploy/` (Units, Nginx-Snippet, `waread-update`, `install.sh`) und `config/config.example.toml`; `install.sh` liest sie von dort | `install.sh` |

### Release bauen (auf einem arm64-Rechner mit Debian/Raspberry Pi OS und Node 22)

```sh
npm ci                         # bzw. beim allerersten Mal npm install; das erzeugt package-lock.json
npm run build                  # inkl. Code-Scan (prebuild), siehe docs/SECURITY_TESTS.md
npm test
npm run prune:prod             # entfernt Entwicklungswerkzeuge aus node_modules
deploy/make-release.sh         # schreibt release-out/waread-<version>.tar.gz und latest.manifest
```

`make-release.sh` prüft den Release-Vertrag, verweigert einen Baum mit `typescript`/`tsx` in `node_modules` und ändert nichts am Projektbaum. Nach `prune:prod` ist der Baum nicht mehr zum Weiterentwickeln geeignet (neu `npm ci`).

## Installation

Das Release (gebaut, siehe A1–A4) liegt entpackt irgendwo auf dem Pi, `install.sh` kopiert es von dort:

```sh
sudo ./deploy/install.sh              # Version aus VERSION oder package.json
sudo ./deploy/install.sh --version 1.0.0
sudo ./deploy/install.sh --skip-nginx # ohne Nginx-Schritte
sudo ./deploy/install.sh --no-start   # Dienste nur aktivieren
```

Was passiert, in dieser Reihenfolge:

1. Prüfung von Root, systemd, Node-Version, `ffmpeg` (nur Warnung), Release-Vertrag. Bei einer Verletzung wird nichts installiert.
2. Benutzer `waread` (`--system --no-create-home --shell /usr/sbin/nologin`, Heimatverzeichnis `/var/lib/waread`), falls nicht vorhanden.
3. Verzeichnisse mit festen Rechten (Tabelle unten). `/etc/waread/config.toml` wird aus `config/config.example.toml` angelegt, **nur wenn sie fehlt**; eine vorhandene Konfiguration wird nie überschrieben.
4. Release nach `/opt/waread/releases/<version>` (über ein Staging-Verzeichnis, `mv` am Ende), `current` atomar umschalten. Ein schon vorhandenes Release-Verzeichnis wird nicht überschrieben.
5. Units nach `/etc/systemd/system/`, Updater nach `/usr/local/sbin/waread-update`, Snippet nach `/etc/nginx/snippets/waread.conf`, `systemctl daemon-reload`.
6. `nginx -t`. Schlägt er fehl, bricht das Skript ab **bevor** Dienste aktiviert werden.
7. `systemctl enable` für Ingest, Web und die beiden Aufräum-Timer (nicht für `waread-update.timer`), dann Start. Wurde die Konfiguration gerade erst aus der Beispieldatei erzeugt, werden die Dienste nur aktiviert und **nicht gestartet**; sie enthält dann Platzhalter.
8. Nginx wird nur neu geladen, wenn das Snippet bereits eingebunden ist, und erneut nach `nginx -t`.

| Pfad | Besitzer | Rechte |
|---|---|---|
| `/opt/waread`, `releases/`, `state/` | root | 0755 |
| `/etc/waread` | root:waread | 0750 |
| `/etc/waread/config.toml` | root:waread | 0640 |
| `/var/lib/waread`, `db/`, `media/`, `media/avatars/` | waread | 0750 |
| `/var/lib/waread/auth/` | waread | **0700** (Dateien darin 0600) |
| `/var/lib/waread/tmp/` | waread | 0700 |

Zu `auth/`: Die Vorgabe nennt „Rechte 0600“. Für ein Verzeichnis geht das nicht, denn ohne x-Recht lässt es sich nicht betreten, nicht einmal vom Besitzer. Deshalb 0700 für das Verzeichnis und 0600 für die Dateien. Die Sitzungsschlüssel gehören nie in ein Backup.

`/var/lib/waread/tmp/` ist ein gewöhnliches Verzeichnis. Wer dort ein tmpfs möchte, trägt es selbst in `/etc/fstab` ein, mit numerischer `uid`/`gid` von `waread` (`id waread`) und `mode=0700`. Dort liegt auch die Sperrdatei `cleanup.lock`, das Verzeichnis muss für `waread` beschreibbar sein.

## Nginx einbinden

`install.sh` legt nur die Datei ab. In den server-Block, über den waread im Heimnetz erreichbar sein soll:

```nginx
include /etc/nginx/snippets/waread.conf;
```

Danach `nginx -t && systemctl reload nginx`. Bestehende Server-Blöcke werden nie angefasst. Zu wissen:

- Der Port 8780 ist ein Standardwert dieses Pakets und steht an drei Stellen: `config.toml` (Web-Port), `nginx/waread.conf` und `update_health_url`. Bei Änderung alle drei anpassen.
- `proxy_redirect / /waread/;` setzt den Präfix bei Weiterleitungen mit absolutem Pfad wieder an. Sendet das Backend bereits `/waread/...`, die Zeile entfernen.
- Für `waread` ist `access_log off`, damit URLs (Suchbegriffe, Medienpfade) nicht in Logdateien landen. Wer Zugriffe protokollieren will, entfernt die beiden Zeilen.
- Die Sperre auf das Heimnetz (`allow`/`deny`) ist auskommentiert, weil sich die richtigen Adressbereiche nicht erraten lassen. Geräte im LAN können auch globale IPv6-Adressen haben und würden sonst ausgesperrt.
- Das Rate-Limit auf `/api/login` ist Sache des Backends. `limit_req_zone` kann ein Snippet im server-Block nicht definieren.
- `/waread/events` (SSE) hat 1 Stunde Lese-Timeout und keine Pufferung. Das Backend sollte regelmäßig einen Keepalive senden.

## Dienste und Timer

| Unit | Läuft | Aktiviert durch `install.sh` |
|---|---|---|
| `waread-ingest.service` | dauerhaft | ja |
| `waread-web.service` | dauerhaft | ja |
| `waread-cleanup.timer` → `.service` | stündlich um :17 (+0–2 min) | ja |
| `waread-cleanup-vacuum.timer` → `.service` | sonntags 04:30 Europe/Berlin (+0–10 min) | ja |
| `waread-update.timer` → `.service` | täglich 03:00 Europe/Berlin (+0–15 min) | **nein** |

Alle Dienste laufen als `waread` mit `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/waread`, `PrivateTmp`, `ProtectHome` und `MemoryMax`. Ingest, Cleanup und VACUUM haben zusätzlich `Nice=15` und `IOSchedulingClass=idle`. `UMask=0077` sorgt dafür, dass neue Dateien nur für `waread` lesbar sind.

Netz: `waread-web.service` hat `IPAddressDeny=any` und `IPAddressAllow=localhost` (das Konzept verbietet dem Web-Dienst jeden ausgehenden Verkehr), Cleanup und VACUUM haben `IPAddressDeny=any`. Der Ingest-Dienst hat keine IP-Sperre, weil er zu WhatsApp verbinden muss (die Zieladressen sind nicht festgelegt). **Diese Zeilen sind nicht auf einem Pi getestet.** Antwortet die Oberfläche nach dem Einspielen mit 502, zuerst die zwei Zeilen in `waread-web.service` auskommentieren.

Die Speichergrenzen sind ungetestete Startwerte: Ingest `MemoryHigh=384M`/`MemoryMax=512M`, Web `192M`/`256M`, Cleanup und VACUUM `256M`. Zeigt `systemctl status` OOM-Kills oder zähe Antworten, hier nachziehen. Bewusst nicht gesetzt sind `MemoryDenyWriteExecute` (bricht den V8-JIT), `SystemCallFilter` und `RestrictAddressFamilies` (ohne Test auf dem Gerät zu riskant). `IOSchedulingClass=idle` wirkt nach meinem Wissen nur mit passendem I/O-Scheduler (z. B. BFQ); das habe ich auf dem Pi nicht geprüft.

Aufräumen und VACUUM nutzen dieselbe Sperrdatei (`flock`) und laufen nie gleichzeitig; der spätere Lauf wartet bis zu 30 bzw. 60 Minuten.

### Sitzung abschirmen (F11)

Web, Cleanup und VACUUM haben `InaccessiblePaths=/var/lib/waread/auth`. Die WhatsApp-Sitzung gehört allein dem Ingest-Dienst; wer den netzseitig erreichbaren Web-Dienst übernimmt, soll sie nicht über das gemeinsame Benutzerkonto `waread` lesen können. Ein Quelltext-Test belegt, dass weder Web noch Cleanup `auth_dir` verwenden. Die Direktive steht bewusst ohne `-`: Fehlt der Pfad, scheitert der Start laut statt ungeschützt zu laufen (`install.sh` legt `auth/` vorher an).

Eine bestehende Installation übernimmt geänderte Units nicht von allein: `install.sh` erneut ausführen (es ist wiederholbar) oder die Dateien nach `/etc/systemd/system/` kopieren und `systemctl daemon-reload` ausführen.

**Nicht auf einem Pi getestet.** Prüfen nach dem Einspielen:

```bash
sudo systemctl daemon-reload && sudo systemctl restart waread-web
systemctl status waread-web waread-ingest        # beide active (running)? Oberfläche im Browser noch erreichbar?
# Probe der Direktive in Kombination mit dem Rest der Härtung (Wegwerf-Unit, kein Eingriff in waread-web):
sudo systemd-run --pipe --wait -p User=waread -p ProtectSystem=strict -p ReadWritePaths=/var/lib/waread \
  -p InaccessiblePaths=/var/lib/waread/auth /bin/ls -la /var/lib/waread/auth
```

Erwartung (VERMUTUNG, nach der Beschreibung in `man systemd.exec`): `Permission denied` oder ein leeres Verzeichnis statt der Sitzungsdateien. Siehst du Dateinamen aus `auth/`, wirkt die Direktive nicht, und die Abschirmung besteht nicht. Startet `waread-web` nach der Änderung nicht mehr, zuerst `journalctl -u waread-web -b` lesen; die Zeile `InaccessiblePaths=` lässt sich testweise auskommentieren.

Wirkungsgrenze (GESICHERT aus der Konstruktion): Der Schutz gilt nur gegen Zugriffe **aus dem Dienst heraus**. Wer Root-Rechte auf dem Pi hat oder den Dienst-Prozess mit anderen Mitteln verlässt, wird dadurch nicht aufgehalten. Alle Dienste laufen weiter als derselbe Benutzer `waread`; ein eigener Benutzer für den Ingest wäre die gründlichere Lösung, ist hier aber nicht umgesetzt.

### Uhrzeit (F20)

`waread-ingest.service` ist nach `time-sync.target` geordnet und zieht es mit `Wants=` hinein. Ein Raspberry Pi ohne Echtzeituhr startet mit der Zeit des letzten Herunterfahrens; eine falsche Uhr kann TLS-Verbindungen scheitern lassen und damit zusätzliche Verbindungsversuche auslösen (VERMUTUNG, nicht gemessen).

Laut `man systemd-time-wait-sync.service` hält erst dieser Dienst Units, die nach `time-sync.target` laufen, bis zur Synchronisation zurück. Ob er auf deinem Pi aktiv ist, ist UNBEKANNT. Prüfen mit `systemctl is-enabled systemd-time-wait-sync.service` und `timedatectl show -p NTPSynchronized`. **`install.sh` schaltet ihn bewusst nicht ein**: Er wirkt auf alle Units, die nach `time-sync.target` geordnet sind, und damit möglicherweise auch auf andere Dienste desselben Pi (auch Craft). Wer ihn aktivieren will, tut das selbst und weiß, was er damit verzögert.

## Updates

### Voraussetzung

Automatische Updates funktionieren nur mit einer **erreichbaren, vertrauenswürdigen Quelle, die ein Manifest mit Prüfsumme liefert**. Diese Quelle gibt es in diesem Paket nicht, du musst sie selbst betreiben (ein Server, der drei Dateien per `https://` ausliefert: Manifest, Signatur, Tarball). **Es ist bewusst keine konkrete Adresse hinterlegt.** Ohne `update_source_url` bricht `waread-update` mit Exit-Code 2 ab und setzt den Status `not-configured`.

Ein Update installiert neuen Code mit Zugriff auf die WhatsApp-Sitzungsschlüssel. Deshalb ist die Signaturprüfung standardmäßig **Pflicht**: Eine Prüfsumme von derselben Quelle wie der Tarball schützt nur vor Übertragungsfehlern, nicht vor einer manipulierten Quelle. Mit `update_require_signature = false` lässt sie sich abschalten; bei jedem Lauf gibt es dann eine Warnung.

### Konfiguration

In `/etc/waread/config.toml` ergänzen. Die Tabelle `[update]` wird nur von `waread-update` gelesen; die Anwendung selbst muss sie tolerieren (A5). Das Skript sucht die Schlüssel unabhängig von der Tabelle.

```toml
[update]
# PLATZHALTER: Hier die Adresse der Manifest-Datei der eigenen, vertrauenswürdigen
# Update-Quelle eintragen (nur https://). Leer = keine Updates.
update_source_url = ""

# Öffentlicher Ed25519-Schlüssel (PEM) zum Prüfen der Manifest-Signatur.
update_pubkey_file = "/etc/waread/update-pubkey.pem"

# true (Standard) = Signatur Pflicht. Nicht empfohlen: false.
update_require_signature = true

# Obergrenze für den Tarball in MiB.
update_max_download_mb = 300

# Gesundheitsprüfung nach dem Update; nur Loopback erlaubt. Muss zum Web-Port passen.
update_health_url = "http://127.0.0.1:8780/healthz"
```

### Manifest, Tarball, Signatur

Unter `update_source_url` liegt eine Textdatei mit genau diesen Zeilen (`#`-Kommentare erlaubt):

```
version=1.4.0
tarball=waread-1.4.0.tar.gz
sha256=<64 Hex-Zeichen, Kleinbuchstaben>
```

- `tarball` ist nur ein Dateiname und wird relativ zum Verzeichnis der Manifest-URL aufgelöst.
- Die Signatur steht unter `<update_source_url>.sig` (roh, Ed25519 über die Manifest-Datei).
- Der Tarball enthält die Release-Dateien direkt im Wurzelverzeichnis (siehe A1–A4); `deploy/make-release.sh` erzeugt Tarball und Manifest im richtigen Format.
- Die URL darf kein `?` und kein `#` enthalten. Nur `https://` ist erlaubt.

Schlüssel und Signatur erzeugen, auf deinem Entwicklungsrechner, nicht auf dem Pi:

```sh
openssl genpkey -algorithm ed25519 -out waread-update.key       # privat, geheim halten
openssl pkey -in waread-update.key -pubout -out waread-update-pub.pem
openssl pkeyutl -sign -inkey waread-update.key -rawin -in latest.manifest -out latest.manifest.sig
```

Den öffentlichen Schlüssel einmalig auf den Pi: `sudo install -m 0644 waread-update-pub.pem /etc/waread/update-pubkey.pem`.

Welchen Server du für die drei Dateien benutzt, entscheidest du. Dieses Paket enthält dafür weder eine Adresse noch Zugangsdaten; Quellen, die eine Anmeldung oder ein Token verlangen, werden nicht unterstützt.

### Ablauf und Absicherungen

1. Manifest holen, Signatur prüfen. Danach `version`, `tarball` und `sha256` streng validieren (`version` nur `X.Y.Z`, damit sie nie als Pfad missbraucht werden kann).
2. Nur eine **neuere** Version wird installiert. Gleiche Version = nichts zu tun, ältere Version = Downgrade, wird verweigert (schützt vor einem wiedereingespielten alten, gültig signierten Manifest).
3. Tarball laden (Größenobergrenze), SHA-256 prüfen, Platzbedarf prüfen. Vor dem Entpacken werden Pfade mit `..`/absolute Pfade sowie Gerätedateien abgelehnt; nach dem Entpacken setuid/setgid-Dateien und Symlinks, die aus dem Release herauszeigen. Der Release-Vertrag und, falls vorhanden, `VERSION` werden geprüft.
4. **WhatsApp-Bibliothek:** Die Version des Pakets `baileys` (und des früheren Namens `@whiskeysockets/baileys`) in `package-lock.json` wird mit der des laufenden Releases verglichen (alle Vorkommen, auch verschachtelte). Änderungen an Abhängigkeiten von `baileys` erkennt dieses Tor **nicht**. Unterscheiden sie sich oder lässt sich eine Seite nicht ermitteln, wird **nichts aktiviert**: Status `manual-review`, Exit-Code 3, deutliche Meldung im Journal. Das neue Release wird verworfen und bei erneutem Lauf nicht noch einmal heruntergeladen.
5. `current` atomar umschalten (neuer Symlink, dann `rename`), `waread-ingest` und `waread-web` neu starten (nur, wenn aktiviert oder aktiv), bis zu 90 s auf `GET /healthz` = 200 warten, danach 20 s beobachten, ob ein Dienst neu startet oder ausfällt.
6. Schlägt irgendetwas ab dem Umschalten fehl (auch bei `SIGTERM` oder Timeout), schaltet das Skript auf die vorherige Version zurück, startet neu, prüft erneut und verwirft das gescheiterte Release. Diese Version wird danach nicht automatisch wiederholt (`--retry`).
7. Es bleiben die drei neuesten Releases sowie `current` und die vorherige Version erhalten.

Ändert ein neues Release die Deployment-Dateien (Units, Nginx-Snippet, `waread-update` selbst), warnt das Skript, installiert sie aber **nicht**. Dafür das neue `deploy/install.sh` von Hand ausführen.

### Bedienung

```sh
sudo waread-update --check                       # nur prüfen, ändert nichts
sudo waread-update                               # Update ausführen
sudo waread-update --approve-library-change 1.5.0  # nach manueller Prüfung freigeben
sudo waread-update --retry                       # gescheiterte Version erneut versuchen
cat /opt/waread/state/update.status              # state=ok|up-to-date|manual-review|rolled-back|failed|not-configured
journalctl -u waread-update                      # Protokoll
```

`--approve-library-change` verlangt die genaue Zielversion. Eine Freigabe für eine andere Version wird ignoriert.

Exit-Codes: `0` aktuell oder erfolgreich, `1` Fehler oder Rollback, `2` Aufruf/Konfiguration, `3` manuelle Prüfung nötig. `1` und `3` lassen die Unit bewusst als „failed“ erscheinen (`systemctl --failed`).

Timer erst aktivieren, wenn die Quelle konfiguriert und `--check` von Hand erfolgreich war:

```sh
sudo systemctl enable --now waread-update.timer
```

### Grenzen, die du kennen solltest

- **Rollback betrifft nur den Code, nicht die Datenbank.** Migriert ein neues Release das Schema (`PRAGMA user_version` steigt) und schlägt danach der Healthcheck fehl, bringt das Zurückschalten die alte Version nicht mit der Datenbank zusammen: Die Datenbankschicht (`db/migrate.ts`) verweigert das Öffnen einer Datenbank mit neuerer `user_version`. Die alte Version läuft also nicht mit einem unpassenden Schema weiter, sondern steht still. Das Skript sichert die Datenbank nicht und führt keine Rückwärts-Migrationen aus. Notausgang und Reihenfolge: docs/INSTALL.md, Abschnitt 15. Offen: ob künftige Releases rückwärtskompatible Migrationen einhalten.
- `/healthz` prüft nur, ob das Web-Backend antwortet. Ob die WhatsApp-Verbindung des Ingest steht, erkennt das Skript nur indirekt (Dienst bleibt aktiv, startet nicht neu).
- Ein Neustart von `waread-ingest` unterbricht die Verbindung kurz. Ich erwarte, dass die gespeicherte Sitzung unter `/var/lib/waread/auth/` ohne neuen QR-Scan wieder aufgenommen wird und WhatsApp zwischenzeitlich eingegangene Nachrichten nachliefert. Beides habe ich nicht getestet.
- Manuell zurückschalten, falls nötig:

  ```sh
  sudo ln -s releases/<alte-version> /opt/waread/current.new
  sudo mv -T /opt/waread/current.new /opt/waread/current
  sudo systemctl restart waread-ingest waread-web
  ```

## Abweichungen von der Aufgabenstellung

1. **Zusätzliche Datei `systemd/waread-cleanup-vacuum.service`.** Ein Timer startet immer genau eine Unit. Ohne eigene Unit würde der zweite Timer nur den stündlichen Aufräumlauf wiederholen und nie ein VACUUM auslösen.
2. **`auth/` mit 0700 statt 0600**, siehe oben.
3. **Kein `Restart=on-failure` bei den Oneshot-Units** (Cleanup, VACUUM, Update). Der nächste Timerlauf ist der Wiederholungsversuch. Ingest und Web haben `Restart=on-failure` (`RestartSec=15` bzw. `5`) mit Start-Limit (5 Fehlstarts in 5 Minuten, danach „failed“).
4. **Signaturprüfung standardmäßig Pflicht**, nicht nur „Prüfsumme/Signatur“.
5. **Zustandsdateien des Updaters unter `/opt/waread/state/`** (root-eigen), nicht unter `/var/lib/waread`. Der Updater läuft als root; in einem Verzeichnis, das `waread` beschreiben darf, könnte ein kompromittierter Dienst ihm per Symlink fremde Dateien unterschieben.
6. **Updater unter `/usr/local/sbin/waread-update`** (der Name `craft-update` liegt in `/usr/local/bin`, es gibt keine Überschneidung).
7. **Nginx:** `access_log off` für den waread-Pfad (siehe oben).

## Craft-Garantie

Die optionale Karte auf der Pi-Startseite (`craft-launcher/`) ändert daran nichts: Sie ist eine erweiterte Fassung von `craft-update`, die du selbst einspielst. `install.sh` und `waread-update` installieren sie nicht und fassen `craft-update` weiterhin nicht an. Die erweiterte Fassung liest nur `/opt/waread/current` und aus `/etc/waread/config.toml` den Schlüssel `passkey_origin` (für das Ziel des Links), und sie schreibt nichts in waread-Verzeichnisse.

`install.sh` und `waread-update` schreiben ausschließlich nach `/opt/waread`, `/etc/waread`, `/var/lib/waread`, `/etc/systemd/system/waread-*`, `/etc/nginx/snippets/waread.conf` und `/usr/local/sbin/waread-update`. Beide Skripte löschen ausschließlich Verzeichnisse unterhalb von `/opt/waread/releases/` und verweigern jeden Löschpfad, der `craft` enthält. `install.sh` bricht außerdem beim Start ab, falls einer seiner eigenen Zielpfade `craft` enthielte. Nginx wird nur mit `nginx -t` geprüft und nur dann neu geladen, wenn das Snippet bereits eingebunden ist; ein Reload lädt die bestehende Konfiguration unverändert neu.

**Was die Skripte außerdem tun (F24), ohne Craft-Dateien zu schreiben:**

- `install.sh` legt den Systembenutzer `waread` an (`useradd`) und ändert dabei `/etc/passwd`, `/etc/group` und ggf. `/etc/shadow` des gemeinsamen Systems.
- `systemctl daemon-reload` liest **alle** Unit-Dateien des Systems neu ein, auch die von Craft. Die Craft-Dienste werden dadurch weder gestartet noch gestoppt. `systemctl enable/restart/start/stop` bezieht sich nur auf `waread-*`-Units.
- `nginx -T` liest die gesamte Nginx-Konfiguration einschließlich der Craft-Blöcke (nur lesend, um zu prüfen, ob das Snippet schon eingebunden ist).
- `systemctl reload nginx` betrifft den **gemeinsamen** Nginx-Prozess. Ein Reload startet neue Worker mit der unveränderten Konfiguration; bestehende Verbindungen laufen weiter, sie werden nicht abgebrochen. Schlägt `nginx -t` vorher fehl, wird nicht neu geladen.
- Die Prüfungen laufen als root; Craft-Pfade werden nicht gelesen und nicht beschrieben, außer was `nginx -T` ohnehin mit ausgibt.

## Was geprüft wurde und was nicht

Geprüft (in einer Linux-Sandbox als root, mit Attrappen für `systemctl` und `nginx`, einem lokalen HTTP-Server als Update-Quelle und einem Attrappen-`/healthz`):

- `install.sh`: Rechte aller Verzeichnisse, Benutzeranlage, Wiederholbarkeit, Abbruch bei fehlschlagendem `nginx -t` **vor** `systemctl enable`, frische Konfiguration (aktivieren, nicht starten), Vertragsverletzung, ungültige Version, setuid-Datei.
- `waread-update`: aktuell, nicht konfiguriert, `--check`, erfolgreiches Update mit Pruning, Baileys-Änderung (Stopp, kein erneuter Download, Freigabe mit falscher und richtiger Version), Rollback bei 500er-`/healthz`, `--retry`, Rollback bei `SIGTERM` nach dem Umschalten, Rollback bei Neustart im Beobachtungsfenster, falsche Prüfsumme, falsche Signatur, Downgrade, Tarball mit `..`, Symlink aus dem Release heraus, setuid-Datei, fehlende `node_modules`, abweichende `VERSION`, `package-lock.json` ohne Baileys-Eintrag, Loopback-Pflicht für `update_health_url`, Pfadtrick in `version`, belegte Sperre, `update_require_signature = false`.
- `systemd-analyze verify` für alle Units, `systemd-analyze calendar` für die drei `OnCalendar`-Ausdrücke, `bash -n` für beide Skripte.

**Nicht** geprüft:

- Verhalten der Units unter echtem systemd (Sandboxing-Direktiven, `flock` im `ExecStart`, `systemctl` aus dem Updater unter `ProtectSystem=strict`, `InvocationID`-Auswertung). Auf einem echten Pi als Erstes `systemctl status waread-*` und `journalctl -u waread-*` ansehen.
- Die Nginx-Syntax von `waread.conf` (in der Sandbox gab es kein Nginx).
- `shellcheck` (nicht installierbar).
- Alles auf echter Hardware (arm64, Debian/Raspberry Pi OS), mit echtem Node-Code, echten Speichergrenzen und echter WhatsApp-Verbindung.
- Eine echte Update-Quelle im Internet (nur ein lokaler HTTP-Server mit Testdateien).
