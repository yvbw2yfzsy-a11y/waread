# waread-web – Web-Backend & API

Rein lesender HTTP-Dienst für waread. Er liest die SQLite-Datenbank, schreibt nur lokale Zustände (gesehen / angehört,
Einstellungen, Löschbefehle), liefert den REST-/SSE-Vertrag aus dem Projekt-Prompt und das gebaute Frontend aus
`public/dist/`. Er sendet **nichts** an WhatsApp und kennt die WhatsApp-Verbindung nur über Ereignisse des Ingest-Dienstes.

`routes.md` beschreibt die Schnittstelle für das Frontend. Dieses Dokument beschreibt Aufbau, Betrieb, Entscheidungen
und die offenen Punkte.

## 1. Teststatus (bitte zuerst lesen)

Das npm-Registry (`registry.npmjs.org`) war in der Bauumgebung gesperrt. Es konnte **kein** Paket aus dem Registry installiert werden; getestet wurde mit lokal vorhandenen Beständen.

| Was | Stand |
|---|---|
| TypeScript-Typprüfung (`npm run typecheck -w waread-web`, strict, `noUncheckedIndexedAccess`) | **ausgeführt, fehlerfrei** |
| HTTP-Schicht, Auth-Sitzungen, Rate-Limit, Range, Suche, Einstellungen, Speicher, SSE, statische Dateien, Logs, Verbindungsstatus und QR aus `settings`, `POST /api/connect` | **347 Prüfungen in `test/smoke.mjs`, alle bestanden**, gegen den echten Server auf 127.0.0.1 und das **gemeinsame Datenbankmodul `db/dist/client.js`** (echtes Schema, echte Trigger und Migrationen) |
| Datenbanktreiber | `better-sqlite3` war **nicht installierbar**. Der Smoke-Test lief in der Bauumgebung gegen ein lokales Ersatzpaket gleichen Namens (`0.0.0-test-shim`, ein Adapter auf `node:sqlite`, nur Testwerkzeug, nicht Teil des Projekts). Unterschiede zum echten Treiber (Typumwandlung, Fehlertexte, Zeitverhalten) sind nicht ausgeschlossen. |
| Frontend im Zusammenspiel (`test/e2e-frontend.mjs`, optional, braucht Playwright mit Chromium) | In der Bauumgebung **16 von 16** Prüfungen bestanden (Login, Chatliste, Nachrichten, Suche, Einstellungen, Verbindung/QR, Unterpfad `/waread/`, keine Konsolenfehler). Nicht Teil von `npm test`. |
| Passkey-Sperre (WebAuthn, `test/passkey.test.mjs`) | **168 Prüfungen, alle bestanden**: CBOR, WebAuthn-Prüfung (Registrierung und Anmeldung, viele Fehlerfälle), Konfiguration, HTTP-Ablauf, Neustart, defekte Datei, CLI. Gegen einen **Software-Authenticator**, den dieses Paket selbst schreibt (`test/support/softAuthenticator.mjs`). Die Prüfungen wurden durch gezielte Sabotage des eigenen Codes auf Aussagekraft geprüft (siehe unten). |
| Passkey-Sperre im echten Browser (`test/passkey-e2e.mjs`, optional) | Chromium mit virtuellem Authenticator (Chrome DevTools Protocol): Passwort-Login, Passkey anlegen, Sperre ein, nächstes Öffnen nur mit Passkey, Sperre aus, Passkey entfernen. **18 von 18**. Nicht Teil von `npm test`. |
| Passkey auf Safari/iOS, mit echtem Zertifikat, hinter Nginx | **NICHT getestet** |
| Echte Argon2id-Prüfung (`hash-wasm`) | **NICHT getestet** – Paket nicht installierbar. Ohne das Paket schlägt der Login **geschlossen** fehl (`503 auth_unavailable`); das wurde geprüft. |
| `hash-password`-Hilfsprogramm | **NICHT getestet** (braucht `hash-wasm`); nur die Fehlerpfade (Paket fehlt, Passwort zu kurz) wurden ausgeführt. |
| QR-Rendering aus Rohtext (`qrcode`) | **NICHT getestet**; getestet sind nur der Fehlerpfad (503) und die Weitergabe fertiger SVG-/Daten-URLs. |
| Nginx davor, HTTPS, Pi/ARM, Safari | **NICHT getestet** |
| Last, parallele Schreiber (Ingest + Web gleichzeitig auf einer WAL-Datenbank) | **NICHT getestet** |
| Speicher im Leerlauf | früher gemessen ≈ 67 MB RSS (Node 22.23.4, x86_64, ohne `hash-wasm`/`better-sqlite3`). Auf dem Pi nicht gemessen. |

Die Versionsbereiche in `package.json` (`hash-wasm ^4.11.0`, `qrcode ^1.5.3`, `smol-toml ^1.3.0`) stammen aus dem Gedächtnis und wurden **nicht** gegen das Registry geprüft. `npm install` im Projektordner erzeugt die Lock-Datei. Die API von `hash-wasm` (`argon2Verify({password, hash})`, `argon2id({… outputType:'encoded'})`) ist ebenfalls aus dem Gedächtnis und beim ersten Lauf zu bestätigen.

**Empfohlener erster Schritt auf der Zielumgebung** (im Projektordner):

```bash
npm install
npm run build
node services/web/dist/hash-password.js   # Passwort-Hash erzeugen (siehe 4.)
npm test -w waread-web                    # Smoke-Test gegen das gemeinsame Datenbankmodul
```

Läuft der Smoke-Test mit dem echten `better-sqlite3` anders als mit dem Adapter, ist das ein Befund über den Adapter, nicht zwingend über den Web-Dienst. Der Pfad des Datenbankmoduls lässt sich mit `SMOKE_DB_MODULE=/pfad/zu/db/dist/client.js` überschreiben (Standard: `db/dist/client.js`).

## 2. Abweichungen von der Aufgabenstellung

1. **Kein Fastify, sondern `node:http`.** Die Aufgabe nennt Fastify nur als Beispiel („z. B."). Weil Pakete nicht installierbar waren,
   wäre Fastify-Code weder kompilierbar noch prüfbar gewesen. Stattdessen: ein kleiner eigener Router (`src/http.ts`), Cookies,
   Range-Auslieferung, SSE – alles ohne Fremdpakete und mit den Tests oben geprüft. Laufzeit-Abhängigkeiten: nur `smol-toml`
   (Konfiguration) sowie `hash-wasm` und `qrcode`, die erst bei Bedarf geladen werden. Eine spätere Umstellung auf Fastify betrifft nur
   `http.ts`, `files.ts`, `app.ts` und die dünnen Handler in `routes/`; Abfragen, Auth-Logik und Event-Pumpe bleiben.
2. **`media_ready`** liefert statt Dateisystempfaden relative API-Pfade (`api/media/<id>`), **`message_updated`** ist eine Obermenge des
   Vertrags (zusätzlich `chatId`, `edited`, `text`, alle Felder immer gesetzt). Gründe: keine Serverpfade im Browser, und Bearbeitungen wären
   sonst unsichtbar. Details in `routes.md`.
3. **Zusätzliche Endpunkte/Parameter**, die das Frontend braucht, im Vertrag aber fehlen: `GET /api/chats/:id/avatar`,
   `GET /api/media/:id?thumb=1`, `beforeId` bei den Nachrichten, `limit` bei der Suche.
4. **`GET /api/qr`** liefert immer eine Daten-URL (`data:image/svg+xml;base64,…`), nie rohes SVG (Vertrag: „SVG oder Daten-URL").
5. **Zusatzdateien** außerhalb der Liste: `src/hash-password.ts` (Passwort-Hash erzeugen, sonst kann niemand den Dienst einrichten),
   `test/smoke.mjs`, `test/e2e-frontend.mjs`, `src/*.ts`-Hilfsmodule.

## 3. Aufbau

```
services/web/
  package.json  tsconfig.json  README.md  routes.md
  src/
    server.ts          Prozess-Einstieg (Konfiguration laden, DB öffnen, lauschen, sauber beenden)
    app.ts             Router + Request-Verteilung + http.Server (ohne Seiteneffekte beim Import)
    auth.ts            Argon2id-Prüfung, Session-Token, Login-Rate-Limit
    sse.ts             Hub, Outbox-Pumpe, GET /events
    routes/            auth, status (status + qr), chats, messages, media, search, settings, storage, health
    http.ts files.ts   Router, Cookies, Header; Range/ETag/Dateiauslieferung/statische Dateien
    queries.ts         alle SQL-Abfragen und Abbildung auf API-Objekte
    db.ts              einziger Berührungspunkt zum Vertrag db/client (Laufzeit-Import)
    connection.ts      Verbindungsstatus und QR; maßgeblich ist die settings-Tabelle (syncFromSettings)
    config.ts log.ts sqlite.ts emit.ts context.ts hash-password.ts
  test/                smoke.mjs, e2e-frontend.mjs (optional, siehe 1.)
  public/              Frontend-Quellen (npm-Workspace waread-frontend); ausgeliefert wird nur public/dist/
```

Build-Ausgabe: `dist/` (flach, `rootDir` = `src`). Start: `node dist/server.js`.

### Wie der Dienst zur Datenbank kommt

Das gemeinsame Modul `db/` (Workspace-Paket `@waread/db`) wird **zur Laufzeit** per Pfad geladen (`src/db.ts`), nicht beim Kompilieren eingebunden. Standardsuche (relativ zu `services/web`): `../../db/dist/client.js`, `../../db/client.js`, `../../dist/db/client.js`; überschreibbar mit `paths.db_module`. Fehlen Funktionen des Vertrags, nennt die Fehlermeldung sie beim Start. `better-sqlite3` wird über das gemeinsame `node_modules` im Projektordner aufgelöst. Das Frontend wird aus `services/web/public/dist/` ausgeliefert (`web.public_dir`, Standard `../public/dist` relativ zum gebauten `dist/` des Web-Dienstes).

## 4. Konfiguration

Datei `/etc/waread/config.toml` (Ort überschreibbar mit der Umgebungsvariable `WAREAD_CONFIG`). Der Dienst liest nur die Abschnitte
`[web]` und `[paths]`; unbekannte Abschnitte anderer Dienste (`[ingest]`, `[retention]`, `[update]`) werden ignoriert. Alle Schlüssel stehen kommentiert in `config/config.example.toml`.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `web.port` | **Pflicht** | TCP-Port auf `127.0.0.1` (1024–65535); muss zum Nginx-Eintrag passen. Die Adresse ist fest `127.0.0.1` und **nicht** konfigurierbar. |
| `web.password_hash` **oder** `web.password_hash_file` | **genau eines Pflicht** | Argon2id-Hash im PHC-Format (`$argon2id$…`). Die Datei-Variante (Rechte 0600/0640, lesbar für `waread`) hält den Hash aus der Hauptkonfiguration heraus. Alles andere als `$argon2id$` wird beim Start abgelehnt. |
| `web.session_days` | `30` | Lebensdauer der Sitzung (1–365). |
| `web.session_secret_file` | `/var/lib/waread/session.key` | Zufallsgeheimnis für die Sitzungssignatur; wird beim ersten Start mit Rechten 0600 angelegt. Nicht in Backups aufnehmen. Ist die Datei nicht schreibbar, läuft der Dienst mit flüchtigem Geheimnis weiter (Sitzungen enden dann bei jedem Neustart; Warnung im Log). |
| `web.cookie_path` | `/` (Code-Standard); `"/waread/"` in `config.example.toml` | Pfad des Cookies. **Hinter Nginx `"/waread/"`**, damit das Cookie nicht an die Craft-Apps auf demselben Host gesendet wird. |
| `web.cookie_secure` | `"auto"` | `"auto"` = Secure, wenn der lokale Nginx `X-Forwarded-Proto: https` meldet; sonst `true`/`false`. |
| `web.login_max_attempts` / `web.login_window_minutes` | `5` / `15` | Rate-Limit pro Client-IP (im Speicher; Neustart setzt zurück). |
| `web.check_origin` | `false` | Optional: Bei POST/PUT muss `Origin` zum Host passen (zusätzlich zu SameSite=Strict). Nur aktivieren, wenn Nginx `Host` bzw. `X-Forwarded-Host` durchreicht, sonst scheitern alle schreibenden Anfragen mit 403. |
| `web.hide_deleted_content` | `false` | `true`: Text/Medien als „für alle gelöscht“ markierter Nachrichten nicht ausliefern (nicht suchbar, kein Medienabruf); die Oberfläche zeigt nur „Vom Absender gelöscht“. `false` (Standard ab Version 2): Inhalt bleibt lesbar und wird beschriftet. Der Ingest erkennt Löschungen über `messages.update`. Eine vorhandene `config.toml` behält ihren alten Wert (frühere Fassungen: `true`). |
| `web.passkey_rp_id` **und** `web.passkey_origin` | nicht gesetzt = Passkeys aus | Beides zusammen oder gar nichts. `rp_id`: Host-Name in Kleinbuchstaben (keine IP). `origin`: genau `https://<Host>[:Port]` (nur `localhost` darf `http` sein), der Host muss `rp_id` sein oder darunter liegen. Fehler werden beim Start gemeldet. |
| `web.passkey_file` | `/var/lib/waread/passkeys.json` | Zustand der Passkeys und der Sperre (Rechte 0600, atomar geschrieben). Unlesbar oder ungültig: die Sperre bleibt zu. |
| `web.passkey_session_hours` | `12` | Laufzeit der Sitzung nach Passkey-Anmeldung (1–720). Offene Entscheidung des Betreibers. |
| `web.public_dir` | `<Projekt>/services/web/public/dist` | Ordner des gebauten Frontends (`index.html`, `app.js`, `styles.css`). |
| `web.log_level` | `"info"` | `debug` \| `info` \| `warn` \| `error`. |
| `web.max_sse_clients` | `16` | Gleichzeitige SSE-Verbindungen. |
| `paths.db` | `/var/lib/waread/db/waread.db` | SQLite-Datei. |
| `paths.media_dir` | `/var/lib/waread/media` | Wurzel der Medien (Auslieferung und Löschung sind auf diesen Baum beschränkt). |
| `paths.db_module` | Standardsuche | Pfad zu `db/dist/client.js` (siehe oben). |

Passwort-Hash erzeugen (das Passwort wird nie als Argument übergeben):

```bash
cd /opt/waread/current   # bzw. der Projektordner
node services/web/dist/hash-password.js                       # interaktiv, ohne Echo, mit Wiederholung
printf '%s' "$PASSWORT" | node services/web/dist/hash-password.js   # oder per Pipe
```
Ausgabe: der Hash in einer Zeile (Argon2id, m = 19456 KiB, t = 2, p = 1, Salz 16 Byte). Mindestlänge des Passworts: 10 Zeichen.

## 5. Sicherheitsmodell (in normaler Sprache)

**Anmeldung.** Es gibt genau ein Passwort. Der Server speichert nur den Argon2id-Hash. Die Prüfung nutzt `hash-wasm` (WebAssembly),
damit auf dem Pi nichts nativ kompiliert werden muss. Argon2 braucht absichtlich viel Speicher (hier ≈ 19 MiB je Prüfung). Deshalb laufen
Prüfungen **nacheinander**, und es werden höchstens vier gleichzeitig angenommen (eine läuft, der Rest wartet; weitere bekommen `503 busy`); parallele Logins können so den `MemoryMax` des Dienstes nicht sprengen.
Fehlt das Paket oder ist der konfigurierte Hash unbrauchbar, wird der Login mit `503` verweigert – es gibt keinen Notfallzugang und keinen Fallback.
Pro Client-IP sind 5 Versuche in 15 Minuten erlaubt; jeder Versuch wird **vor** der Prüfung gezählt, damit gleichzeitige Anfragen das Limit nicht umgehen.
Die IP stammt vom **letzten** `X-Forwarded-For`-Eintrag und nur, wenn die Verbindung vom lokalen Nginx (Loopback) kommt; ein vom Client vorangestellter
Wert hebelt die Sperre nicht aus (getestet). Ein erfolgreicher Login setzt den Zähler der IP zurück.

**Sitzung.** Nach dem Login setzt der Server ein signiertes Token (`waread_session`: HttpOnly, SameSite=Strict, Secure bei HTTPS). Der Signaturschlüssel
wird aus dem persistierten Zufallsgeheimnis **und** dem Passwort-Hash abgeleitet: Wer das Passwort ändert, beendet damit sofort alle Sitzungen.
Es gibt bewusst keinen serverseitigen Sitzungsspeicher; dadurch löscht „Logout" nur das Cookie, ein gestohlenes Token bliebe bis zum Ablauf gültig
(Heimnetz, Einzelbenutzer – bewusst akzeptiert, siehe 7.).

**Passkey-Sperre (optional).** Ist sie aktiv, nimmt der Server kein Passwort mehr an (`POST /api/login` → `403 passkey_required`, ohne den Hash zu prüfen); angemeldet wird nur mit WebAuthn
(`/api/passkey/login/*`). Die Prüfung (`src/webauthn.ts`, `src/cbor.ts`) ist eigener Code auf `node:crypto`, weil das npm-Registry in der Bauumgebung gesperrt war: nur ES256 (P-256), `none`-Attestation
(die Attestation wird nicht bewertet), Benutzerverifikation (UV) und Anwesenheit (UP) Pflicht, RP-ID und Origin aus der Konfiguration (nie aus der Anfrage), Challenge zufällig, einmalig, 180 s, an den Zweck gebunden,
Signaturzähler streng steigend, sobald einer der Werte ungleich 0 ist (synchronisierte Passkeys melden nach allgemeiner Kenntnis oft dauerhaft 0; am iPhone hier nicht geprüft). Eine Passkey-Anmeldung ist rate-limitiert wie der Passwort-Login. Das Ein- und Ausschalten der Sperre erneuert eine
Epoche im Schlüssel der Sitzungssignatur und macht dadurch **alle** früheren Sitzungen ungültig; offene SSE-Verbindungen werden beendet. Sicherheitsrelevante Änderungen (Sperre einschalten oder ausschalten, Passkey hinzufügen
oder löschen) verlangen bei aktiver Sperre eine frische Passkey-Bestätigung („Freigabe“: einmalig, 120 s, an Zweck und Sitzung gebunden); das Einschalten verlangt sie immer. Notausstieg:
`node services/web/dist/passkey-admin.js status|unlock|reset --yes` am Server (siehe `docs/INSTALL.md`, Abschnitt 17). Grenzen: Wer `/var/lib/waread` beschreiben kann, hebt die Sperre auf.
Safari/iOS ist nicht getestet.

**Schreibende Anfragen.** SameSite=Strict verhindert, dass fremde Seiten das Cookie mitsenden. Zusätzlich verlangen alle Bodies `application/json`
(Formular-Posts anderer Seiten scheitern mit 415). Optional prüft `web.check_origin` den `Origin`-Header.

**Content-Security-Policy** (auf **jeder** Antwort): `default-src 'self'`, keine Skripte/Styles außer von der eigenen Origin, keine externen Ressourcen,
`object-src 'none'`, `frame-ancestors 'none'`, dazu `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
`Cross-Origin-Resource-Policy: same-origin`. Mediendateien tragen zusätzlich `default-src 'none'; sandbox`. Es gibt keine Link-Vorschau-Funktion.
Konsequenz für das Frontend: keine Inline-Styles/-Skripte (siehe `routes.md`).

**Medien.** Nur über `GET /api/media/:id` mit gültiger Sitzung. Der Dateipfad aus der Datenbank wird gegen `paths.media_dir` aufgelöst, **inklusive
Auflösung von Symlinks**; Pfade außerhalb (`../`, Symlinks) ergeben 404 (beides getestet). Inline ausgeliefert werden nur Bild-, Audio- und Videotypen aus einer festen
Liste und nur passend zum Nachrichtentyp; alles andere, insbesondere Dokumente und SVG, kommt als `attachment` mit `application/octet-stream`.

**Logs.** Es werden nur Ereignisname, IDs, Codes und Zahlen geloggt – nie Texte, Dateinamen, Suchbegriffe oder Fehlermeldungen von SQLite (die können Suchbegriffe
enthalten); bei Fehlern nur Name und Code. Der Test prüft, dass Nachrichtentext, Suchbegriffe, Passwort, Hash und QR-Inhalt nicht im Log auftauchen.
Beim Login-Fehlschlag und bei Sperren wird die Client-IP protokolliert.

**Netz.** Lauscht ausschließlich auf `127.0.0.1` (fest im Code, getestet). Der Dienst bietet kein HTTPS an; das ist Sache von Nginx.

### Version 2 im Sicherheitsmodell

Neue Routen (alle nur mit Sitzung, Beschreibung in `routes.md`): `GET api/messages/:id/versions`, `POST api/messages/:id/protect`, `POST api/media/:id/load`,
`PUT api/chats/:id/mute`; `POST api/storage/clear` kennt `includeProtected`. Eingaben sind streng geprüft (Boolean statt Wahrheitswert-Strings; `includeProtected`
nur mit genau `true`). Der Web-Dienst bleibt ohne ausgehenden Verkehr: „Medium jetzt laden“ legt nur eine Zeile in `ingest_commands` ab (Nachrichten-ID, nur für
vorhandene, ladbare Medien; ein wartender Befehl pro Nachricht), der Ingest führt sie aus. Das Schild schützt vor jedem Löschen ausser `includeProtected: true`.
Antworten enthalten weiter keine Dateisystempfade; der Dokumentname kommt aus dem Dateinamen ohne Nachrichten-ID.

## 6. Festlegungen beim Zusammenführen und offene Abstimmungspunkte

Der Prompt-Vertrag ließ Folgendes offen. Das Web-Backend hatte dafür Annahmen getroffen; hier der Stand nach dem Zusammenführen mit `db/`, Ingest, Cleanup, Frontend und Deploy.

**An `db/`**
1. *Erledigt.* Die Suche joint über `messages_fts_map` (`messages_fts f JOIN messages_fts_map x ON x.fts_rowid = f.rowid JOIN messages m ON m.id = x.message_id`). Die frühere Annahme `messages_fts.rowid == messages.rowid` war falsch und ist ersetzt.
2. `markSeen` gibt nur **neu markierte** IDs zurück, `markPlayed` ist idempotent; das Web erzeugt daraus `message_updated`-Ereignisse. Vom Smoke-Test gegen das echte Datenbankmodul ausgeführt.
3. `deleteExpired` wird für `storage/clear` mit `scope` `all`/`media` benutzt (Grenze `Number.MAX_SAFE_INTEGER` bzw. `0`).
4. `queries.ts › deleteChatData` löscht einen Chat direkt per SQL in einer Transaktion (Medien, Nachrichten). Den Suchindex räumen die Trigger aus `db/schema.sql` mit auf; das Web löscht keine FTS-Zeilen von Hand. Offen (kein Fehler): Schema-Wissen steht damit auch im Web; eine Funktion `deleteChat` in `db/client.ts` wäre sauberer.
5. `runMigrations` wird beim Start auch vom Web-Dienst aufgerufen; es nutzt `BEGIN IMMEDIATE` und ist damit gegen gleichzeitigen Start mit dem Ingest sicher, und es verweigert Datenbanken mit neuerer `user_version`. Das Web setzt zusätzlich `busy_timeout = 5000`.
6. `pushEvent` serialisiert die Payload als JSON, `pullEventsSince` liefert sie geparst und aufsteigend nach `id`.
7. `media.file_path`/`thumbnail_path` sind vom Ingest geschriebene **absolute** Pfade; die Auslieferung löst sie gegen `paths.media_dir` auf und verlangt, dass das Ergebnis darin liegt. `media` hat keinen Spaltenwert für den Originaldateinamen; Downloads heißen wie die Datei auf der Platte (`<id>__<bereinigter Name>`).
8. Zeitstempel sind überall Unix-**Sekunden**. Der Web-Dienst rechnet nie um, vergleicht aber `before`/`from`/`to` mit `wa_timestamp`.

**An den Ingest-Dienst**
9. *Erledigt.* **QR-Code und Status** liegen in der `settings`-Tabelle (`connection.status`, `connection.qr`, `connection.qr_seq`, `connection.reason`, `connection.updated_at`, `connection.connected_since`); `connection_status`-Ereignisse in der Outbox sind nur der Anstoß, den Zustand neu zu lesen (`ConnectionState.syncFromSettings`). Der QR gelangt nie in die Outbox und nie per SSE. Die ältere Konvention (Outbox-Ereignis `qr`) versteht das Web weiter, der Ingest erzeugt sie nicht mehr. Roher Baileys-Text wird (falls `qrcode` installiert ist) zu SVG gerendert.
10. **Verbindung neu starten:** `POST /api/connect` schreibt `connection.command = 'connect'`; der Ingest holt den Befehl ab (alle 3 s) und quittiert durch Leeren. Nach `logged_out` oder abgelaufenem QR wartet der Ingest ohne QR auf diesen Befehl. **Offen:** Es gibt keinen Heartbeat. Stirbt der Ingest hart (ohne Meldung), zeigt das Web den letzten Zustand weiter an.
11. **Ereignis-Payloads:** Für `new_message` zählt nur `message.id` (alternativ `messageId`), für `message_updated` und `media_ready` nur `messageId`; der Rest wird aus der Datenbank gelesen. Der Ingest schreibt `new_message {chatId, messageId, type}`, `history_synced {stored}`, `connection_status`, `media_ready {messageId, status}`; der Cleanup schreibt `cleanup_done`. Beim SSE-Weiterleiten ergänzt das Web fehlende Felder.

**An Ingest und Cleanup (Einstellungen)**
12. Schlüssel in `settings`: `retentionDays`, `retentionMediaDays`, `storageLimitMb` (jeweils Ganzzahl als Text) und `downloadRules` (JSON-Text). Fehlt ein Schlüssel, gelten `3`, `3`, `0` (kein Limit) und die Standardregeln aus `routes.md`. Ingest und Cleanup lesen genau diese Namen. `storageLimitMb` wird vom Web angezeigt und gespeichert, aber **von keinem Dienst als hartes Limit durchgesetzt** (offen).
13. Medien-Aufbewahrung darf die Nachrichten-Aufbewahrung nicht überschreiten (die Medienzeile verweist auf die Nachricht); das Web lehnt solche Einstellungen ab.

**An Deploy/Nginx**
14. Nginx entfernt das Präfix (`proxy_pass http://127.0.0.1:8780/;` mit Schrägstrich am Ende), der Dienst lauscht unter `/`. Erledigt in `deploy/nginx/waread.conf`.
15. Nginx setzt `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`; für `/events`: `proxy_http_version 1.1`, `proxy_buffering off`, langer `proxy_read_timeout` (der Dienst sendet alle 25 s einen Heartbeat). Erledigt, aber nicht gegen ein echtes Nginx getestet.
16. Cookie-Pfad: `web.cookie_path = "/waread/"` in der Beispielkonfiguration.
17. systemd: `deploy/systemd/waread-web.service` (`ReadWritePaths=/var/lib/waread`, `MemoryMax=256M`, `IPAddressDeny=any` mit `IPAddressAllow=localhost`; die IP-Sperre ist nicht auf einem Pi getestet). Argon2-Prüfung und Mediendateien beim Streamen sind **nicht gemessen**. Ohne `hash-wasm` startet der Dienst, verweigert aber jeden Login (`503`). Laufzeitabhängigkeiten stehen im Release (`npm run prune:prod`).

---

## 7. Bekannte Grenzen

- **Logout ist nur clientseitig** (kein serverseitiger Widerruf, siehe oben). Abhilfe: Passwort ändern beendet alle Sitzungen.
- **Statusanzeige kann veralten**, wenn der Ingest ohne Meldung stirbt (Punkt 10).
- **Rate-Limit im Speicher:** Neustart des Dienstes setzt die Sperren zurück.
- **Suche:** `ß` wird nicht zu `ss` gefaltet (Eigenschaft des `unicode61`-Tokenizers im Schema); „Anna" findet über die Spalte `chat_name` ggf. alle Nachrichten dieses Chats, falls die db-Schicht den Chatnamen so indexiert.
- **SSE-Ausfall:** Die Outbox behält die letzten ≈ 1000 Ereignisse; bei längerer Trennung muss das Frontend neu laden (steht in `routes.md`).
- **`storage/clear`** konkurriert nicht mit dem Ingest: Lädt der Ingest während des Löschens gerade eine Datei, kann diese nach dem Löschen noch fertig werden (Datei ohne passende Nachricht). Behebung wäre Sache des Cleanup (Waisen-Aufräumen).
- Es gibt keine Paginierung der Chatliste und keine Gesamtzahl-Angaben; bei 3 Tagen Aufbewahrung wurde das als unnötig bewertet.
- Node ≥ 22.12 ist deklariert (`engines`); getestet wurde nur mit Node 22.23.4.

## 8. Nützliche Befehle

Im Projektordner:

```bash
npm run typecheck -w waread-web    # tsc ohne Ausgabe
npm run build -w waread-web        # services/web/dist/
npm start -w waread-web            # node dist/server.js  (WAREAD_CONFIG=… für anderen Konfigurationspfad)
npm test -w waread-web             # Smoke-Test (nach dem Build von db und web), siehe 1.
curl -s http://127.0.0.1:8780/healthz   # → OK  (Port = web.port)
```
