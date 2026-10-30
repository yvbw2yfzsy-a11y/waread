# MERGE_NOTES – Zusammenführung der sieben Teilergebnisse

Stand: 29. Oktober 2026. Dieses Dokument hält fest, was beim Zusammenführen von waread geprüft, geändert und entschieden wurde, was ich angenommen habe und was offen bleibt. Es unterscheidet bewusst zwischen **geprüft** (ein Befehl lief und ich habe die Ausgabe gesehen), **angenommen** (nicht überprüft) und **offen**.

## 1. Ergebnis in Kürze

Aus den sieben Teilergebnissen (db, Ingest, Web-Backend, Frontend, Cleanup, Deploy, Dokumentation) ist ein Projektbaum `waread-src/` mit einem gemeinsamen npm-Workspace entstanden. Er baut mit `npm run build` und besteht seine Tests in der Bauumgebung. Es bleibt bei **Node.js + TypeScript + Baileys** (keine Teilaufgabe hat whatsmeow verwendet; es gab keinen Anlass, die Entscheidung zu ändern).

| Bereich | Ordner | Ergebnis |
| --- | --- | --- |
| Datenbank | `db/` | Workspace-Paket `@waread/db`; 24 Tests grün |
| Ingest | `services/ingest/` | 230 Tests grün, davon 32 Prüfungen des Sende-Wächters |
| Web-Backend | `services/web/` | 233 Prüfungen im Smoke-Test grün; optionaler Browsertest 16/16 |
| Frontend | `services/web/public/` | Typprüfung mit TypeScript 6.0.3 und 7.0.2 fehlerfrei; ausgeliefert wird `public/dist/` |
| Cleanup | `cleanup/` | 20 Tests grün |
| Deployment | `deploy/` | `install.sh`, `waread-update`, `make-release.sh`, 8 Units, Nginx-Ausschnitt |
| Dokumentation | `docs/`, READMEs | `INSTALL.md`, `MAINTENANCE.md`, `SECURITY_TESTS.md`, `TEST_CHECKLIST.md`, dieses Dokument |
| Konfiguration | `config/config.example.toml` | aus den tatsächlich gelesenen Schlüsseln zusammengesetzt und gegen die drei Lader geprüft |

Alle Zahlen stammen aus dem letzten Lauf auf dem fertigen Baum (siehe Abschnitt 7).

## 2. Die fünf Abschlussprüfungen

**1. Kein Sende-, Lese- oder Presence-Aufruf im Ingest, und ein automatischer Test dafür.**
Der Test `services/ingest/test/no-send-calls.test.ts` (Aufruf `npm run check:no-send`) prüft per Syntaxbaum jeden Bezeichner im Quellcode von `services/ingest/src` auf die Wörter `read`, `presence`, `send` und auf eine Liste ausgehender Bibliotheksfunktionen; zusätzlich prüft er, dass die Hülle `waLib.ts` nur `ev.on`, `ev.off` und `end` des Sockets benutzt und dass nur `waLib.ts` die Bibliothek einbindet. Er läuft in `npm test` und als `prebuild` vor jedem Bau. **Sabotageprobe auf dem fertigen Baum:** In einer Kopie habe ich an `services/ingest/src/timing.ts` die Zeile `export const probe = (s: any) => s.readMessages([])` angehängt. Ergebnis: `npm run check:no-send` Exit-Code 1 (31 von 32 Prüfungen grün, eine rot: „Wort "read" in "readMessages"“), `npm run build -w waread-ingest` Exit-Code 1, und es entstand kein `dist/`. Auf dem unveränderten Baum: 32 von 32 grün. **Grenzen:** Der Test sieht nur den eigenen Quelltext von `services/ingest/src`. Was Baileys intern an WhatsApp sendet (die unvermeidlichen Zustellquittungen, Schlüssel- und Verbindungsverkehr), kann er nicht belegen; dafür ist der Zweitnummer-Test da (`docs/SECURITY_TESTS.md`), und er ist **nicht durchgeführt**. Es gibt keinen Zähler für ausgehende Meldungsarten (das Konzept nennt ihn als „sofern die Bibliothek das zulässt“). Die Verbindungsoption `markOnlineOnConnect: false` steht in `services/ingest/src/waLib.ts` und wird von `test/waLib.test.ts` geprüft.

**2. Keine Datei berührt das Craft-System.**
Eine Suche über den ganzen Baum nach „craft“ findet nur Schutzmaßnahmen: Kommentare, die das Berühren ausschließen, und Sperren in `install.sh` und `waread-update`, die jeden Pfad mit „craft“ verweigern. Alle Pfade, Units und Namen beginnen mit `waread` (`/opt/waread`, `/etc/waread`, `/var/lib/waread`, `/usr/local/sbin/waread-update`, `/etc/nginx/snippets/waread.conf`, `waread-*.service`/`.timer`). Der Nginx-Ausschnitt wird nur abgelegt; eingebunden wird er von Hand, bestehende Server-Blöcke werden nicht angefasst. **Grenze:** Das habe ich am Quelltext und in einer Probeinstallation mit Attrappen für `systemctl` und `nginx` geprüft, nicht auf einem Pi, auf dem Craft läuft. Die Probeinstallation lief auf dem Baum vor den letzten Änderungen (Kommentare in `install.sh`, IP-Sperren in den Units, `secure_delete`); die geänderten Units sind mit `systemd-analyze verify` geprüft, die Skripte mit `bash -n`.

**3. Datenbankschema, API-Aufrufe und Erwartungen des Frontends passen zusammen.**
Der Web-Dienst läuft im Smoke-Test (233 Prüfungen) gegen das echte Modul `db/dist/client.js` mit dem echten Schema und den echten Triggern. Der Browsertest `services/web/test/e2e-frontend.mjs` lässt das gebaute Frontend, den echten Web-Dienst und das echte Datenbankmodul hinter einem Proxy zusammenarbeiten, der Nginx nachahmt (`/waread/x` → `/x`): 16 von 16 Prüfungen (Login, Chatliste, Nachrichten, Vorschaubild, Sprachnachricht, Live-Nachricht per SSE, Download-Regeln speichern, „Neu verbinden“, QR, keine CSP-Verletzungen, keine fehlgeschlagenen Anfragen). Ingest und Cleanup laufen gegen dasselbe Schema (230 bzw. 20 Tests). Gefundene und behobene Abweichungen stehen in Abschnitt 3. **Bleibende Lücken** (alle dokumentiert, keine versteckt): Der Originaldateiname eines Dokuments hat im Schema keinen Platz; `storageLimitMb` wird gespeichert und angezeigt, aber von keinem Dienst durchgesetzt; Bearbeitungen und Löschungen von Nachrichten werden nicht verarbeitet; Profilbilder, Kopplung per Telefonnummer und manuelles Nachladen von Medien fehlen. Alles gegen ein simuliertes Backend und ohne echtes WhatsApp.

**4. Der Update-Mechanismus enthält keine erfundene Quelle.**
In `config/config.example.toml` steht `update_source_url = ""`. Ohne Eintrag tut `waread-update` nichts (Status `not-configured`, Exit-Code 2). Es ist weder eine Adresse noch ein Schlüssel mitgeliefert (`update_pubkey_file` verweist nur auf einen Dateinamen). Das einzige konkrete URL-Muster im Projekt, ein GitHub-Beispiel in `deploy/README.md`, habe ich entfernt; die Suche nach `https://` im Baum findet nur Platzhalter, Testdaten und den `wa.me`-Link der Oberfläche. Signaturprüfung (Ed25519) ist Standard und Pflicht, der Timer `waread-update.timer` wird von `install.sh` nicht aktiviert.

**5. Die Installationsanleitung passt zu den endgültigen Dateien und Befehlen.**
`docs/INSTALL.md` ist gegen `deploy/install.sh`, die npm-Skripte, `config/config.example.toml` und die Unit-Namen neu zusammengesetzt. Ein Skript hat alle in den Dokumenten genannten Pfade `deploy/…`, `docs/…`, `services/…`, `cleanup/…`, `db/…`, `config/…` gegen den Baum und alle `npm run …`-Aufrufe gegen die `package.json`-Dateien geprüft; alle Unit-Namen gegen `deploy/systemd/`. Alle Treffer stimmen. **Grenze:** Das prüft Namen, nicht, ob die Schritte auf einem Pi funktionieren; die Anleitung wurde nirgends auf einem Pi ausgeführt.

## 3. Abweichungen vom Vertrag und wie ich sie aufgelöst habe

Wenn zwei Teilergebnisse sich widersprachen, habe ich die Variante gewählt, die dem dokumentierten Vertrag (Prompt, Konzept) näher liegt, und möglichst wenig geändert.

| # | Bereich | Abweichung | Entscheidung |
| --- | --- | --- | --- |
| 1 | db ↔ Web, Cleanup, Ingest | Die Teilergebnisse gingen von `messages_fts.rowid == messages.rowid` aus. Das Schema in `db/` verknüpft über `messages_fts_map(fts_rowid, message_id)`. | Web: Suche joint über die Zuordnungstabelle. Cleanup und Web löschen keine FTS-Zeilen von Hand (Trigger räumen auf). Ingest: eigene Zwischenimplementierung der Datenbank durch Re-Exporte von `@waread/db` ersetzt. |
| 2 | Konzept ↔ db | Das Konzept setzt `secure_delete` voraus; `openDb` setzte es nicht. | `PRAGMA secure_delete = ON` in `db/client.ts` ergänzt, Test ergänzt (24/24). Gilt je Verbindung. |
| 3 | Ingest ↔ Web | Verbindungsstatus und QR liefen im Web über Outbox-Ereignisse, der Ingest schreibt sie in `settings`. Das Ereignis `connection_status` trug `status`, der Web-Vertrag verlangt `state`. | Maßgeblich ist `settings` (`connection.*`); das Ereignis ist nur der Anstoß. Nutzlast des Ingest auf `state`/`since` angepasst. Der QR geht nie in Outbox oder SSE. |
| 4 | Ingest ↔ Web | Nach Abmeldung oder abgelaufenem QR versucht der Ingest nichts mehr, das Frontend konnte aber keine neue Kopplung auslösen. | `POST /api/connect` im Web, Steuerkanal `connection.command` in `settings`, Ingest fragt alle 3 s ab und quittiert. Ergänzung über den Vertrag hinaus. |
| 5 | Ingest ↔ Web ↔ Cleanup | Schlüsselnamen in `settings` unterschieden sich (`retention.messages_days` im Ingest, `retentionDays` im Web). | Einheitlich die Namen der Web-API: `retentionDays`, `retentionMediaDays`, `downloadRules`, `storageLimitMb`. Ingest liest sie (Tage mit 30 s, Download-Regeln mit 15 s Zwischenspeicher). |
| 6 | Ingest ↔ Web | Download-Regeln aus der Oberfläche wirkten nicht auf den Ingest. | `downloadPolicy.ts`: gespeicherte Regeln haben Vorrang vor `config.toml`; ungültige Einträge fallen auf die Konfiguration zurück. |
| 7 | Web | Standard-Pfad des Frontends und Datenbankmodul stimmten nicht zum Baum. | Standard `services/web/public/dist`, Datenbankmodul `db/dist/client.js`. Ersatzdatenbank `stub-db-client.cjs` gelöscht. |
| 8 | Frontend ↔ Nginx | Absolute URLs (`/api/...`) funktionieren nicht unter `/waread/`. | Alle URLs relativ (`apiUrl()`), `index.html` wird nach `dist/` kopiert, Nginx entfernt das Präfix. |
| 9 | Frontend ↔ Web | Typen und Formen (`voice` ↔ `audio`, `hasThumbnail`, `?thumb=1`, Download-Regel-Schlüssel, „Neu verbinden“, `history_synced`) | Abbildung in `src/api.ts` auf die tatsächliche API; „Neu verbinden“ ruft `POST /api/connect`. |
| 10 | Cleanup | Eigene Datenbank-Hülle, Pfade nur per Flag oder Umgebungsvariable. | Nutzt `@waread/db` (`openExistingDb` legt nie eine leere Datenbank an); liest `[paths]` aus der Konfigurationsdatei (Rangfolge: Flag, Umgebungsvariable, Konfiguration, Standard). Tests laufen gegen das echte Schema. |
| 11 | Deploy | Einstiegspunkte, Node-Mindestversion und Release-Vertrag passten nicht zu den gebauten Dateien. | Einstiegspunkte `services/ingest/dist/index.js`, `services/web/dist/server.js`, `cleanup/dist/cleanup.js`; Node ≥ 22.12 mit `--node PFAD`; Pflichtlisten in `install.sh`, `waread-update`, `make-release.sh` abgestimmt (`install.sh` und `make-release.sh` prüfen zusätzlich Dateien unter `deploy/`). |
| 12 | Deploy | **Fehler im Bibliothekstor:** Die Ausgabe des Vergleichs enthielt bei zwei Paketnamen immer `NONE`, so dass eine Bibliotheksänderung unbemerkt blieb. | Ausgabe auf `wa-lib=name@version,…` (sortiert) geändert; mit drei Lock-Dateien (gleich, geändert, ohne Paket) geprüft. |
| 13 | Deploy ↔ Konzept | Das Konzept verbietet dem Web-Dienst jeden ausgehenden Verkehr; die Unit tat es nicht. | `IPAddressDeny=any` und `IPAddressAllow=localhost` in `waread-web.service`, `IPAddressDeny=any` in Cleanup und VACUUM. **Auf keinem Pi getestet**; Rückfallanweisung steht in `deploy/README.md`. |
| 14 | Deploy | `make-release.sh` fehlte (`install.sh` verwies auf ein nicht vorhandenes `build-release.sh`). | `deploy/make-release.sh` neu: prüft den Vertrag, packt den gebauten Baum, schreibt `latest.manifest`; signiert wird nicht (privater Schlüssel gehört nicht auf den Build-Rechner). |
| 15 | Docs ↔ Baum | Mehrere Dokumente beschrieben Zwischenstände (Stub-Datenbank, Annahmelisten, GitHub-Beispiel, „Befehl unbekannt“). | Alle READMEs und `docs/` auf den Endstand gebracht; der Code-Scan hat jetzt den echten Befehl `npm run check:no-send`. Dort, wo ein Anspruch nicht umgesetzt ist (Scan auf dem Pi, Zähler ausgehender Meldungen), steht das ausdrücklich im Text. |

## 4. Was ich für die Zusammenführung neu geschrieben habe

Nur Klebecode und Lücken, kein bestehendes Modul ohne Not: die Re-Exporte in `services/ingest/src/dbClient.ts`, `downloadPolicy.ts`, den Steuerkanal und die Settings-Anbindung in Ingest und Web, `routes/status.ts` (neu geschrieben), `ConnectionState.syncFromSettings`, die `EventPump`-Anbindung für `history_synced`, den Browsertest, die Workspace-`package.json`-Dateien mit Build-Skripten, `config/config.example.toml`, `deploy/make-release.sh` und die Dokumentation.

## 5. Annahmen (nicht überprüft)

- **Port 8780** für den Web-Dienst ist eine Festlegung dieses Pakets, kein Vorgabewert. Er steht in `config.toml`, im Nginx-Ausschnitt und in `update_health_url`; bei Änderung alle drei anpassen.
- **Node.js ≥ 22.12** (Feld `engines`). Auf Raspberry Pi OS (Bookworm) liefert `apt` nur Node 18; Node 22 muss separat installiert werden.
- **Versionsangaben der Abhängigkeiten** stammen aus dem Gedächtnis der Teilaufgaben und sind **nicht gegen die npm-Registry geprüft**: `baileys 7.0.0-rc14` (ein Vorabstand), `better-sqlite3 ^12.0.0`, `sharp ^0.35.4`, `smol-toml`, `hash-wasm ^4.11.0`, `qrcode ^1.5.3`, `esbuild ^0.28.2`. Es gibt **keine** `package-lock.json`; der erste `npm install` erzeugt sie.
- Die **Baileys-API** wurde von der Ingest-Teilaufgabe aus dem Quelltext gelesen, nicht gegen die installierte Bibliothek gebaut. `loadWaLib` bricht beim Start mit einer Liste fehlender Exporte ab, wenn etwas nicht passt.
- **Zeitstempel** sind projektweit Unix-Sekunden.
- Die **IP-Sperren** in den Units (Punkt 13) und alle **Speichergrenzen** (`MemoryMax`) sind ungetestete Startwerte.
- Dass die gespeicherte Sitzung nach einem Neustart ohne neuen QR-Scan wieder aufgenommen wird und WhatsApp verpasste Nachrichten nachliefert, ist eine Erwartung, kein Befund.

## 6. Offene Punkte für dich

1. **Update-Quelle:** Soll es automatische Updates geben, brauchst du einen eigenen Server für drei Dateien (Manifest, Signatur, Tarball), einen Ed25519-Schlüssel und den Eintrag `update_source_url`. Ohne das bleibt der Mechanismus inaktiv. Er hält nur an, wenn sich `baileys` in `package-lock.json` ändert; Änderungen an dessen Abhängigkeiten und am Ingest-Code erkennt er nicht.
2. **Passwort:** In `config.toml` steht ein Platzhalter für den Argon2id-Hash. Erzeuge ihn mit `node services/web/dist/hash-password.js` (Mindestlänge 10 Zeichen). Ohne gültigen Hash startet der Web-Dienst nicht.
3. **Port:** Bleibt es bei 8780?
4. **whatsmeow oder Baileys:** Alle Teilergebnisse nutzen Baileys; die Entscheidung gilt weiter. Die Alternative ist nicht vorbereitet.
5. **Zweitnummer-Test:** Er ist die einzige Prüfung, die zeigt, ob Baileys intern Lesebestätigungen oder Online-Status sendet. Er ist nicht durchgeführt und vor dem Hauptkonto zwingend (`docs/SECURITY_TESTS.md`).
6. **Veralteter Verbindungsstatus:** Stirbt der Ingest hart (ohne Meldung), zeigt die Oberfläche weiter „verbunden“. Es gibt keinen Heartbeat.
7. **Speicherlimit:** `storageLimitMb` wird nur angezeigt. Das Konzept nennt ein Limit (Start 2 GB, älteste Medien zuerst); umgesetzt ist es nirgends.
8. **Aufbewahrung im Rückfall:** `[retention]` in `config.toml` wirkt nur im Ingest als Rückfall; der Cleanup nimmt ohne gespeicherte Einstellung den Standard 3 Tage.
9. **Cleanup löscht mit eigenem SQL** statt mit `deleteExpired` aus `@waread/db`, weil die Vorgabe „Dateien zuerst, dann Datenbank“ das verlangt. Das Wissen über das Löschen steckt damit an zwei Stellen.
10. **Nicht umgesetzt:** Bearbeitungen und Löschungen von Nachrichten, Profilbilder, Kopplung per Telefonnummer, Dokument-Dateinamen, manuelles Nachladen von Medien, Zähler ausgehender Meldungsarten, Scan auf dem Pi vor dem Umschalten von `current`.
11. **`After=time-sync.target`** ist in den Units nicht gesetzt; auf einem Pi ohne Echtzeituhr rechnet ein früher Lauf mit falscher Uhrzeit.

## 7. Teststand der Bauumgebung (letzter Lauf auf dem fertigen Baum)

| Lauf | Ergebnis |
| --- | --- |
| `npm run build` (db, ingest mit Sende-Wächter, web, frontend, cleanup) | Exit-Code 0 |
| `npm run typecheck` (alle Pakete, TypeScript 6.0.3) | Exit-Code 0 |
| TypeScript 7.0.2 für Web und Frontend | Exit-Code 0 |
| `npm test` | db 24/24, Ingest 230/230 (32 davon Sende-Wächter), Web 233/233, Cleanup 20/20; 0 übersprungen |
| `node --no-warnings services/web/test/e2e-frontend.mjs` (Playwright, Chromium) | 16/16 |
| Sabotageprobe Sende-Wächter | siehe Abschnitt 2, Punkt 1 |

**Was diese Läufe nicht belegen:** Sie liefen auf x86-64 mit Node 22.23.4 und mit einem lokalen Ersatzpaket `better-sqlite3` (`0.0.0-test-shim`, bildet die benutzte API auf `node:sqlite` ab; nicht Teil des Projekts), weil die npm-Registry gesperrt war. Echt waren SQLite (FTS5, WAL, Trigger), `sharp` und `ffmpeg`. **Nie ausgeführt:** echtes `better-sqlite3`, echtes Baileys, `hash-wasm`, `qrcode`, Nginx, systemd, ein Raspberry Pi (arm64), eine WhatsApp-Kopplung, Safari/iPhone.
