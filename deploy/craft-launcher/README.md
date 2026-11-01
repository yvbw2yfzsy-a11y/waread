# waread auf der Pi-Startseite (optional)

Dieser Ordner enthält eine erweiterte Fassung von `craft-update`. Sie zeigt auf der Startseite „Pi Apps“ (`/var/www/craft/index.html`) eine Karte für waread mit eigenem Logo. Ein Tipp auf die Karte öffnet waread im Browser.

**Nichts davon installieren `install.sh` oder `waread-update`.** Die waread-Skripte fassen `craft-update` weiterhin nicht an (`deploy/README.md`, „Craft-Garantie“). Die erweiterte Fassung spielst du selbst ein.

## Was sich gegenüber `craft-update_9` ändert

- Neue Liste `LOCAL_APPS` für lokale Apps. `craft-update` lädt sie nicht, installiert sie nicht und aktualisiert sie nicht, die Startseite verlinkt sie nur. Heruntergeladen wird weiterhin ausschließlich aus `APPS`.
- Die waread-Karte erscheint nur, wenn `/opt/waread/current` ein Symlink ist und darin `services/web/dist/server.js` liegt (`install.sh` und `waread-update` halten den Symlink so). Die Version steht im Namen des Release-Ordners, auf den er zeigt (`v0.2.0`). Passt der Name nicht zu `X.Y.Z`, steht „Version unbekannt“.
- **Die Installationsverzeichnisse bleiben getrennt.** `craft-update` liest nur `/opt/waread/current` und aus `/etc/waread/config.toml` den einen Schlüssel `passkey_origin`. Es schreibt nichts nach `/opt/waread`, `/etc/waread` oder `/var/lib/waread`, und waread legt nichts in `/var/www/craft` oder `/var/lib/craft` an.
- Logo: das Auge aus `services/web/public/static/icon-512.png` auf vollflächigem Logo-Grün (RGB 20 74 58), 256×256 WebP, eingebettet in `ICON_B64`. Dieselbe Farbe ist die Akzentfarbe der Karte (`ACCENT`).
- Einsortiert ist die Karte unter „Weitere“. Die Suche der Startseite findet sie auch über „whatsapp“.
- **Ziel der Karte:** `./waread/` (Pfad auf dem Host der Startseite). Ist in `/etc/waread/config.toml` `web.passkey_origin` gesetzt (Passkey-Betrieb mit eigenem Hostnamen), zeigt die Karte stattdessen auf `<passkey_origin>/waread/`. Beides lässt sich mit `WAREAD_URL` festlegen.
- Für „Zuletzt aktualisiert“ in der Fußzeile zählt waread nicht mit. Ist waread nicht installiert, erzeugt die Fassung dieselbe `index.html` wie `craft-update_9` (Byte für Byte).
- Im Protokoll steht eine Zeile `waread: installiert v0.2.0, Karte verlinkt auf …`. Zeigt die Karte auf `./waread/` und leitet Nginx `/waread/` nicht weiter, folgt ein `HINWEIS`. Die Karte bleibt dann sichtbar, führt aber ins Leere (404).

## Dateien

| Datei | Zweck |
|---|---|
| `craft-update_10-noIcons` | die erweiterte Fassung ohne die Bilder der Craft-Apps und des Pi-Logos (dort steht der Platzhalter `too much text and token wast. …`); das waread-Logo ist enthalten |
| `merge-icons.sh` | holt die echten Bilder aus deiner vollständigen alten Fassung und schreibt die vollständige neue |

Beide Dateien kommen aus diesem Repository. Auf den Pi gelangen sie, wie du sonst Dateien dorthin bringst (`git clone`, `scp`). `install.sh` legt sie nirgends ab.

## Einspielen

1. **waread installieren und prüfen** (`docs/INSTALL.md`, bis einschließlich Abschnitt 13). Erst danach `craft-update` tauschen, sonst zeigt `01-craft-update.txt` im Prüfschritt 13 eine Abweichung. Sie wäre gewollt, aber verwirrend.

2. **Nginx.** Welcher Weg gilt, hängt davon ab, wie du waread erreichst.

   **Nur Passwort, waread unter `http://<Pi>/waread/`:** den waread-Ausschnitt in den Server-Block der Craft-Seite einbinden. Der Befehl ist wiederholbar und trägt die Zeile nur einmal ein:

   ```bash
   grep -q 'snippets/waread.conf' /etc/nginx/conf.d/craft.conf || sudo sed -i '/gzip_types/a\    include /etc/nginx/snippets/waread.conf*;' /etc/nginx/conf.d/craft.conf
   ```

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Die Zeile entspricht dem `include` aus `docs/INSTALL.md`, Abschnitt 8.2, nur mit einem `*` am Ende. Das `*` ist Absicht: Gibt es die Datei nicht, ignoriert Nginx die Zeile. Wird waread später entfernt, startet Nginx also trotzdem, und die Craft-Apps bleiben erreichbar. `install.sh` erkennt die Zeile ebenfalls als eingebunden.

   **Passkey-Sperre (eigener Hostname mit HTTPS):** im Craft-Block nichts ändern. waread hat dann seinen eigenen `server`-Block (`deploy/nginx/waread-passkey.example.conf`, `docs/INSTALL.md`, Abschnitt 17), und die Karte findet den Namen selbst über `passkey_origin` aus `/etc/waread/config.toml`. Ein Include im Craft-Block wäre zwecklos: Unter `http://<Pi>/waread/` kann sich bei aktiver Sperre niemand anmelden, denn das Passwort ist abgeschaltet, und ein Passkey braucht HTTPS und einen Namen.

3. **Vollständige Fassung erzeugen.** `craft-update_10-noIcons`, `merge-icons.sh` und deine vollständige alte `craft-update_9` liegen im selben Ordner auf dem Pi:

   ```bash
   bash merge-icons.sh craft-update_9 craft-update_10-noIcons craft-update_10
   ```

   Das Skript bricht ab und legt nichts an, wenn für einen Platzhalter kein Bild in der alten Fassung steht.

4. **Installieren und einmal laufen lassen:**

   ```bash
   sudo install -m 755 craft-update_10 /usr/local/bin/craft-update
   ```

   ```bash
   sudo systemctl start craft-update.service && journalctl -u craft-update.service -n 30
   ```

5. **Prüfen:** `http://<Pi>/` öffnen, im Abschnitt „Weitere“ die Karte „waread“ antippen. Im Protokoll steht `waread: installiert v…, Karte verlinkt auf …`, und es steht kein `HINWEIS`. Bei Passkey-Betrieb muss als Ziel dein HTTPS-Name dort stehen.

Nach einer späteren Installation oder einem Update von waread zeigt die Karte die neue Version erst beim nächsten Lauf von `craft-update`. Sofort geht es mit `sudo systemctl start craft-update.service`.

## Einstellungen im Skript

| Name | Standard | Bedeutung |
|---|---|---|
| `WAREAD_URL` | leer = automatisch | Ziel der Karte. Leer: `<passkey_origin>/waread/`, falls in der waread-Konfiguration gesetzt, sonst `./waread/`. Festlegen: die ganze URL eintragen, z. B. `https://waread.heimnetz.example/waread/`. Bei einem Ziel mit `://` entfällt der Nginx-Hinweis im Protokoll. |
| `WAREAD_CONF` | `/etc/waread/config.toml` | Daraus wird nur die Zeile `passkey_origin = "https://Name[:Port]"` gelesen: nicht auskommentiert, mit doppelten Anführungszeichen, genau in dieser Form. Alles andere wird ignoriert und ergibt `./waread/`. |
| `WAREAD_HOME` | `/opt/waread` | Wo `current` liegt. Nur zum Lesen. |
| `CATEGORY` | (waread nicht eingetragen → „Weitere“) | Andere Kategorie: `[waread]=office` in das Feld `CATEGORY` schreiben. |

## Sicherheit: Passkey-Sperre und gemeinsamer Ursprung

**Was die Passkey-Sperre absichert** (GESICHERT, Quelltext gelesen: `services/web/src/app.ts`, `auth.ts`, `routes/auth.ts`, `routes/passkeys.ts`): den **Login**. Bei aktiver Sperre weist `POST /api/login` jedes Passwort mit `403 passkey_required` ab, hinein kommt nur, wer einen Passkey bestätigt. Danach ist die Sitzung ein signiertes Cookie (`passkey_session_hours`, Standard 12 Stunden). **Lesen** (Chats, Nachrichten, Suche, Medien) prüft nur dieses Cookie, nicht erneut den Passkey. Eine frische Passkey-Bestätigung verlangen nur: Passkey hinzufügen, Passkey löschen, Sperre ausschalten. Die Sperre ist ab Werk **aus**; ohne Einrichtung gilt das Passwort.

**Was das für die Craft-Apps bedeutet:**

- *waread mit eigenem Hostnamen (Passkey-Betrieb):* Passkeys gehen nur über HTTPS mit Namen (`docs/INSTALL.md`, Abschnitt 17), also in einem eigenen Origin. Das Cookie gilt nur für diesen Host (kein `Domain`-Attribut) und ist `SameSite=Strict`, und das Backend sendet keine CORS-Header. Eine Craft-Seite unter `http://<Pi>/…` kann die Sitzung deshalb nicht mitschicken und keine Antwort lesen. waread ist dann gegenüber den Craft-Apps abgeschirmt, solange der `server`-Block dieses Namens nur waread ausliefert (so steht es im Beispiel).
- *waread im Craft-Origin (`./waread/`, nur Passwort):* Craft-Apps und waread teilen Host und Port, also den Origin. `web.cookie_path = "/waread/"` sorgt nur dafür, dass der Browser das Cookie nicht an Craft-Seiten schickt. Ruft das JavaScript einer Craft-Seite per `fetch('/waread/api/…')` die waread-API auf, geht die Anfrage mit Cookie hinaus, und die Antwort ist lesbar, solange du in diesem Browser bei waread angemeldet bist. Praktisch betrifft das nur einen bösartigen oder manipulierten Craft-Web-Build; `craft-update` prüft eine Prüfsumme aus demselben Release, nicht die Herkunft. Wer das nicht will, nimmt den Weg mit eigenem Hostnamen.

Der Teil „eigener Origin, Craft-Seite kommt nicht heran“ stützt sich auf den Quelltext und die Browser-Regeln (Bindung des Cookies an den Host, `SameSite`, Same-Origin-Policy). Mit einer echten Craft-Seite und einem echten waread-Backend ist er nicht ausprobiert.

## Was geprüft wurde und was nicht

**Geprüft** in einer Linux-Sandbox (Ubuntu 24.04, bash 5.2, nginx 1.24.0, Chromium über Playwright), nicht auf einem Pi:

- Karte, Version, Link und Logo erscheinen (hell, dunkel, Handy-Breite), keine Konsolenfehler, die Suche findet die Karte über „whatsapp“. Das Logo lädt in 256×256.
- Klick auf die Karte führt über ein echtes Nginx mit dem waread-Ausschnitt zu einem Attrappen-Backend: Präfix `/waread/` wird entfernt, `/waread` leitet mit 301 auf `/waread/`.
- **Zum ersten Mal mit einem echten Nginx geprüft:** die Syntax von `deploy/nginx/waread.conf` (`nginx -t`, Neuladen).
- Die Zeile `include …/waread.conf*;` ohne vorhandene Datei: `nginx -t`, Start und Neuladen bestehen.
- Ohne waread ist die erzeugte `index.html` byte-gleich zu der von `craft-update_9`.
- Grenzfälle: kein `current`, `current` zeigt ins Leere, `current` ist ein Verzeichnis statt Symlink, Versionsname ohne `X.Y.Z`, absolute URL mit `&` und `"` (wird maskiert), Nginx-Hinweis bei fehlender, auskommentierter und vorhandener Zeile, `nginx -T` ohne Ausgabe, kein `nginx` im `PATH`.
- Ziel aus `passkey_origin`: gesetzt, mit Port, auskommentiert, `http://` statt `https://`, Einschleusversuch (`"><script>`), einfache Anführungszeichen, Kommentar am Zeilenende mit CRLF, Pfad im Origin, doppelter Schlüssel, Einrückung, fest gesetztes `WAREAD_URL`, fehlende Konfiguration. Bei absolutem Ziel wird `nginx` nicht aufgerufen.
- `bash -n` und `shellcheck`: keine neuen Meldungen gegenüber `craft-update_9` (die eine vorhandene Info SC2012 bleibt).
- `merge-icons.sh`: Normalfall (14 Bilder), Abbruch ohne Ausgabedatei bei fehlendem Bild, Platzhalter-Fassung als „alte“ Datei, Ausgabe gleich Eingabe, falsche Argumentzahl. Der Normalfall lief mit einer von mir erzeugten Ersatz-Fassung (gleicher Aufbau, Testbilder), nicht mit deiner echten `craft-update_9`.

**Nicht geprüft:**

- Ein Lauf auf dem Pi mit deiner echten `craft-update_9` und echten Craft-Bildern.
- Der Download-Teil. `curl` war in den Tests durch eine Attrappe ersetzt. Dieser Teil ist unverändert, aber nicht erneut gelaufen.
- Das echte waread-Backend hinter dem Ausschnitt (Anmeldung, Cookie, SSE). Getestet wurde nur ein Attrappen-Backend.
- Den Passkey-Betrieb selbst (HTTPS-Block, Zertifikat, Safari/iOS). Auch `docs/INSTALL.md`, Abschnitt 17, nennt ihn ungetestet.
- Die Absicherung deiner `craft-update.service` ist unbekannt. Sperrt sie `/opt` (z. B. `InaccessiblePaths=`), erscheint die Karte nicht (VERMUTUNG). Prüfen im Protokoll: Fehlt die Zeile `waread: installiert …`, obwohl waread läuft, ist das die erste Stelle zum Nachsehen.
- Läuft `craft-update` aus `cron`, ist `nginx` evtl. nicht im `PATH`. Dann entfällt nur der Nginx-Hinweis, die Karte erscheint trotzdem.
