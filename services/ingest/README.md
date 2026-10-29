# waread-ingest – WhatsApp-Empfangsdienst

Rein **empfangender** Dienst für das private Projekt „waread": hält eine Verbindung als „verknüpftes Gerät", schreibt eingehende Nachrichten in die gemeinsame SQLite-Datenbank und lädt Medien herunter (Vorschaubild, Sprachnachricht Opus → AAC). Er **sendet nichts** an WhatsApp zurück: keine Nachricht, keine Lesebestätigung, kein „online", kein „abgespielt". Das fehlt im Code, es ist keine Einstellung.

Node.js (≥ 22.12) + TypeScript, `better-sqlite3` (FTS5), Baileys, `sharp`, `ffmpeg`.

---

## 1. Zuerst lesen: was geprüft ist und was nicht

**Automatisch geprüft (in dieser Entwicklungsumgebung gelaufen)**

- Typprüfung von `src/` und `test/` (`tsc`, strict, `noUnusedLocals`, `noUncheckedIndexedAccess`).
- Testsuite (`npm test`): Sende-Wächter, Verbindungslogik (QR, Backoff, Abmeldung, Sofort-Neustart, veraltete Sockets), Nachrichten-Normalisierung, Datenbankschicht samt FTS5, Aufbewahrung, Medien-Warteschlange (Parallelität, Limits, Wiederholung, Stillstand, Prüfsumme, Neustart-Wiederherstellung), Auth-Speicher, Sperrdatei, Konfiguration, Logging, Gesamtweg „Ereignis → Datenbank → Datei".
- Mit **echtem** `sharp` (Vorschau, EXIF, Dekompressionsbombe) und **echtem** `ffmpeg` (Opus → AAC, Zeitlimit, nice 15, nie zwei gleichzeitig).
- Zusätzlich einmalig von Hand: 15 absichtlich eingebaute Fehler (u. a. `readMessages`, `sendPresenceUpdate`, `sock['sendMessage']`, Verbindungs-Neuaufbau nach Abmeldung, fehlende Prüfsumme) wurden von der Suite jeweils bemerkt. Diese Prüfung gehört nicht zum Paket.

**NICHT geprüft – bitte nicht als belegt lesen**

| Was | Warum / Folge |
| --- | --- |
| Installation der Abhängigkeiten | Die npm-Registry war in der Entwicklungsumgebung gesperrt. `baileys` und `better-sqlite3` wurden **nie installiert oder gebaut**. |
| Baileys-API | Aus dem Quelltext gelesen (WhiskeySockets/Baileys, Commit `81345be`, Version 7.0.0-rc14), **nicht** gegen die installierte Bibliothek gebaut. `loadWaLib` prüft beim Start, ob alle benötigten Exporte da sind, und bricht sonst mit einer Liste der fehlenden Namen ab. |
| npm-Paketname und Version | Der Quellbaum nennt sich `"baileys"`; den Namen `@whiskeysockets/baileys` kenne ich nur aus der Erinnerung. Der Dienst versucht beide Namen. Ob `7.0.0-rc14` unter einem der Namen in der Registry liegt, ist **ungeprüft**. |
| `better-sqlite3` | Die Tests laufen mit einem Adapter auf `node:sqlite` (`test/support/nodeSqliteAdapter.ts`), auch für das gemeinsame Modul `@waread/db`. Unterschiede (Typumwandlung, Fehlertexte, Zeitverhalten) sind nicht ausgeschlossen. `package.json` nennt `^12.0.0`; die Version ist **ungeprüft**. Nach dem ersten `npm install` entsteht `package-lock.json` im Projektordner; sie festhalten (SECURITY_TESTS.md, 1.2). |
| Echte WhatsApp-Verbindung | Weder QR noch Kopplung noch Empfang noch Medien-Download gegen WhatsApp wurden ausprobiert. |
| Verhalten am Raspberry Pi | Arbeitsspeicher (Ziel: unter 150–250 MB im Leerlauf), CPU-Last und SD-Karten-Verschleiß wurden **nicht gemessen**. |
| Zweitnummern-Test | Kann nur mit zwei echten Konten erfolgen (Abschnitt 5). Nicht durchgeführt. |
| Go/whatsmeow | Nicht getestet, nicht eingesetzt. Es wurde nicht von Node abgewichen. |

---

## 2. Die Sende-Sperre – was sie leistet und was nicht

**Leistet (im Code und per Test abgesichert):**

1. **Enge Hülle.** Nur `src/waLib.ts` lädt die Bibliothek. Nach außen gibt es `WaSocket` mit genau `ev.on`, `ev.off` und `end`. Das rohe Socket-Objekt verlässt die Datei nie, Sende-, Lese- und Presence-Methoden sind für den übrigen Code nicht erreichbar.
2. **Medien-Download** läuft über `downloadContentFromMessage` (HTTP-Abruf des verschlüsselten Blobs, lokale Entschlüsselung). Die Wiederhol-Anfrage an das Telefon (`updateMediaMessage`) ist bewusst **nicht** angebunden: abgelaufene Medien (HTTP 403/404/410) werden `expired`.
3. **`test/no-send-calls.test.ts`** (läuft in `npm test` und als `prebuild` vor `npm run build`) zerlegt alle Quelldateien per TypeScript-AST und schlägt fehl bei:
   - jedem Bezeichner oder bezeichnerartigen String, dessen Wortbestandteile `read`, `presence` oder `send` sind (`readMessages`, `sendPresenceUpdate`, `sock['sendMessage']`, `read_receipt` …),
   - Namen auf einer Sperrliste ausgehender Aktionen ohne diese Wörter (`logout`, `chatModify`, `relayMessage`, `query`, `groupMetadata`, `requestPairingCode`, `updateMediaMessage` …),
   - jeder Verwendung des rohen Sockets in `waLib.ts` außer `raw.ev.on`, `raw.ev.off`, `raw.end`,
   - dem Wort „baileys" in jeder anderen Datei als `waLib.ts`, sowie jedem dynamischen `import()`/`require()` außerhalb von `waLib.ts` außer `better-sqlite3`.
   Der Wächter prüft sich selbst mit Negativtests. Einzige Ausnahme: `readFileSync` (Node-Dateizugriff). Jede Ergänzung der Ausnahmeliste (`test/support/scanForbidden.ts`) ist eine Sicherheitsentscheidung.
4. Neu/angehört (`seen_at`, `played_at`) sind rein lokale Spalten; dieser Dienst setzt sie nie.

**Leistet NICHT:**

- Er kann nicht beweisen, was die **Bibliothek selbst** sendet (nächster Abschnitt). Das ist Sache des Zweitnummern-Tests.
- Er sagt nichts über künftige Bibliotheksversionen. **Test nach jedem Update wiederholen.**
- **Es gibt keine Zusage, dass das Konto nicht gesperrt wird**, und keine, dass sich die inoffizielle Schnittstelle nicht ändert. Der Dienst verringert nur die Angriffsfläche (nie senden, eine Verbindung, ruhiges Wiederverbinden, keine Massenabfragen). Wie hoch das Sperrrisiko ist, ist nicht belastbar bezifferbar.

### Interner Verkehr der Bibliothek (nicht abschaltbar, aus dem Quelltext gelesen)

Auch ohne jeden eigenen Aufruf sendet Baileys selbst. Diese Liste stammt aus dem Quelltext (Commit `81345be`), **nicht** aus einer Beobachtung zur Laufzeit:

| Was | Wo (Quelle) | Anmerkung |
| --- | --- | --- |
| **Presence `unavailable`** beim Öffnen der Verbindung | `Socket/chats.ts`, `connection === 'open'` | `markOnlineOnConnect: false` ändert nur `available` → `unavailable`; **eine Presence-Meldung wird trotzdem gesendet**. Nicht abschaltbar, ohne die Bibliothek zu verändern. |
| IQ `active` (passiv/aktiv) | `Socket/socket.ts`, nach `CB:success` | |
| **Zustellbestätigungen** (graue Doppelhaken) | `Socket/messages-recv.ts` (`sendReceipt`) | Ohne `type` = zugestellt. Da wir nicht „online" sind (`isOnline` false), erwarte ich `type: 'inactive'`. Nur Lesen des Quelltextes, **ungeprüft**. Dazu `sender`, `peer_msg` und `hist_sync` je nach Nachrichtenart. |
| Wiederholungs-Quittungen und Platzhalter-Anfragen (`requestPlaceholderResend`) | `messages-recv.ts` | Wenn eine Nachricht nicht entschlüsselt werden konnte. |
| Acks, Pre-Key-Uploads, Keep-Alive-Pings (`w:p`) | `socket.ts` | Protokollpflicht. |
| Init-Abfragen (`fireInitQueries`, Standard) | `chats.ts` | Nicht abgeschaltet, da unklar, was sonst fehlt. |

Die ausführlichere Liste je Phase (mit Zeilenangaben, Einschränkungen und dem Zähler für ausgehende Knoten) steht in `docs/VERKEHR.md`.

Alles davon sind keine Lesebestätigungen und keine Nachrichten, aber eben **nicht „nichts"**. Die Aussage „der Dienst sendet nichts" gilt für den **eigenen Code**.

---

## 3. Aufbau

```
services/ingest/
  src/
    index.ts          Prozess: umask 077, Config, Verzeichnisse, Sperre, Start/Ende, Signale
    service.ts        Verdrahtung Verbindung <-> Handler <-> Warteschlange (testbar)
    connection.ts     Verbindung, QR, Status, Backoff, Abmeldung, Steuerkanal
    waLib.ts          EINZIGE Stelle mit Bibliotheksbezug: Hülle, Logger-Filter, Import-Prüfung
    authStore.ts      Sitzungsschlüssel in SQLite (auth/auth.db), statt vieler JSON-Dateien
    messageHandler.ts Normalisierung (rein) + Schreiben in die Datenbank + Aufbewahrung
    mediaQueue.ts     Download-Warteschlange (2 parallel), Limits, Wiederholung, Wiederanlauf
    media/thumbnail.ts  sharp: kurze Kante 200 px, JPEG, EXIF/GPS weg, 50-MP-Grenze
    media/audio.ts      ffmpeg: Opus -> AAC (.m4a), nice 15, 1 gleichzeitig, Zeitlimit
    media/limiter.ts    kleine Parallelitätsbremse
    jobStore.ts       PRIVATER Zustand: Medien-Aufträge samt Schlüssel, Namen, LID<->Nummer
    dbClient.ts       Zwischenschicht gegen den gemeinsamen Vertrag db/client.ts (Abschnitt 7)
    lock.ts           Sperrdatei mit PID-Fingerabdruck
    config.ts / log.ts / sqlite.ts / timing.ts
  test/               Tests; test/support/ enthält Wächter, node:sqlite-Adapter, Fakes
```

**Ablauf einer Nachricht:** Ereignis `messages.upsert` → `normalizeMessage` (rein) → Aufbewahrung nach **WhatsApp-Zeitstempel** → eine Transaktion: Chat, Nachricht, Suchindex, `media`-Zeile, Ereignis `new_message` → nach dem Commit: Auftrag an die Warteschlange → Download nach `<media>/<chat>/<UTC-Datum>/<id>.<ext>` über `.part` + atomares Umbenennen, SHA-256-Prüfung → Vorschau/Umwandlung → `ready` + Ereignis `media_ready`.

**Zustand, der Neustarts überlebt:** `ingest-state.db` (Datei 0600, neben der gemeinsamen Datenbank). Das gemeinsame Schema hat keinen Platz für Medienschlüssel; ohne sie ließe sich ein nach Absturz hängender Download nicht fortsetzen. Der Schlüssel wird nach Abschluss des Auftrags gelöscht. Dort liegen außerdem Anzeigenamen mit Rangfolge (Kontakt > Chat/Gruppe > Push-Name) und die Zuordnung LID ↔ Telefonnummer.

---

## 4. Verhalten der Verbindung

| Ereignis | Verhalten |
| --- | --- |
| Start ohne gespeicherte Kopplung | Standard (`auto_pair_on_start = false`): keine Verbindung, Status `needs_qr` mit Grund `not_paired`. Die QR-Sitzung beginnt erst auf „Neu verbinden“ (`connection.command = connect`). Mit `true` beginnt sie bei jedem Start von selbst. |
| QR nicht gescannt, Sitzung läuft ab | Status `needs_qr` / Grund `qr_expired`, **kein** neuer Versuch von selbst; Web schreibt `connect` |
| Kopplung erfolgreich, Server verlangt Neustart (515) | sofort neu verbinden; höchstens 3-mal je 10 Minuten, danach Backoff |
| Verbindungsabbruch (408, 428, 503, 500, unbekannt) | Backoff 5 s · 2ⁿ, höchstens 10 min, Streuung nur **nach unten**; Zähler wird nach 10 min stabiler Verbindung zurückgesetzt (`stable_after_seconds = 600`); Sofort-Neustart (515) höchstens 3-mal je 10 min |
| Medien-Download mit fremdem Ziel (F01) | Vor dem Abruf prüft die Hülle `waLib.ts` das vom Absender stammende Ziel: nur `https`, Host unter `whatsapp.net`, kein Port, keine Zugangsdaten, `directPath` als einfacher Pfad. Sonst Status `failed`, Code `bad_target` (ohne Wiederholung, ohne URL im Journal). Ob WhatsApp weitere Hosts nutzt, ist UNBEKANNT; tritt `bad_target` bei echten Medien auf, nicht die Prüfung lockern, sondern den Host belegen. Rest: Weiterleitungen eines WhatsApp-Hosts folgt die Bibliothek. |
| Datenbank länger als 5 s gesperrt (Cleanup-Stapel, VACUUM; F02) | Die Nachricht geht nicht verloren: sie wartet im Speicher und wird nach 5 s, 15 s, 45 s und 2 min erneut gespeichert (ein Lauf blockiert höchstens einmal). Erst danach, bei mehr als 500 wartenden oder beim Herunterfahren mit noch bestehender Sperre, zählt der Dienst sie als verloren (`message_lost` im Journal mit Grund, `msg_lost_total` in der Statuszeile). Die Wartezeit des Treibers (`busy_timeout`) bleibt bei 5 s, weil der Treiber synchron blockiert. Gilt auch für Verlaufspakete. Offen: Ein Neustart des Dienstes mit wartenden Nachrichten im Speicher verliert sie, soweit die Sperre dann noch besteht. |
| Zugangsdaten lassen sich nicht speichern (F08; Datenträger voll, E/A-Fehler) | Journal `creds_save_failed` (nur Fehlercode), kontrolliertes Herunterfahren mit Exit-Code 1; systemd startet den Dienst neu und gibt nach 5 Fehlstarts in 5 min sichtbar auf. Nicht abgedeckt: ein Fehler beim Schreiben der Signal-Schlüssel innerhalb der Bibliothek (sie fängt ihn selbst). |
| Abgemeldet (401) | Sitzung wird gelöscht, **kein** Wiederverbinden, Status `needs_qr` / `logged_out`, wartet auf `connect` |
| Ersetzt (440), verboten (403), Multidevice (411) | **kein** Wiederverbinden (440: sonst Ping-Pong mit der anderen Instanz; 403: nicht gegen eine Sperre anrennen), Status `disconnected` mit Grund |
| `SIGTERM` / `SIGINT` | Socket lokal beenden (**kein** Abmelden am Konto), Warteschlange anhalten, Datenbanken schließen, Sperre freigeben |

Statuswerte: `connecting`, `connected`, `disconnected`, `needs_qr`. Der Dienst hat keine Direktverbindung zum Web-Dienst; die Verständigung läuft nur über die Datenbank (Abschnitt 6).

---

## 5. Zweitnummern-Test (Kurzfassung)

Quelle: Konzept, Abschnitt „Prüfung an einer Zweitnummer". Vor dem ersten Einsatz mit dem Hauptkonto, nach Neustart, nach Wiederverbindung und **vor jedem Update der Bibliothek**.

1. Konto A (Testnummer) mit dem Pi verknüpfen, Konto B ist ein zweites Handy.
2. B schickt an A: Text, Foto, Sprachnachricht und eine Gruppennachricht.
3. In der App alles öffnen, abspielen, speichern; danach **10 Minuten** warten.
4. Auf B prüfen: nur graue Doppelhaken, **kein** blaues Mikrofon; Nachrichteninfo „zugestellt", nicht „gelesen"/„abgespielt".
5. Wiederholen nach Dienst-Neustart, nach erzwungener Wiederverbindung (Netz kurz trennen), nach Update.
6. *(Konzept, Schritt 6: Zähler ausgehender Meldungsarten mit Alarm.)* **Nicht umgesetzt**, siehe Abschnitt 8.

Beobachten, nicht annehmen: Zeigt A während des Tests „online"? Erscheint auf A die Benachrichtigung am iPhone weiter? Das Konzept benennt beides als im Spike zu messen.

---

## 6. Schnittstellen zu den anderen Diensten

Der gemeinsame Vertrag legt Tabellen fest, nicht die Schlüssel- und Ereignisnamen. Beim Zusammenführen festgelegt (und von Web-Dienst und Cleanup genauso gelesen): alle Namen stehen in `src/config.ts` (`SETTING_KEYS`) bzw. an den `pushEvent`-Stellen.

`settings`, **Ingest schreibt:** `connection.status`, `connection.qr` (leer, wenn keiner aktiv), `connection.qr_seq`, `connection.reason`, `connection.updated_at`, `connection.connected_since`.
**Ingest liest:** `retentionDays` und `retentionMediaDays` (ganze Tage 1–365, 30 s Zwischenspeicher; sonst Wert aus `[retention]` in `config.toml`; geschrieben vom Web-Dienst über `PUT /api/settings`) und `downloadRules` (JSON `{image|voice|video|document: {mode: 'auto'|'off', maxMb}}`, 15 s Zwischenspeicher; fehlt oder ist ein Eintrag ungültig, gelten die Werte `auto_download_*` und `max_mb_*` aus `config.toml`; siehe `src/downloadPolicy.ts`).
**Steuerkanal:** Der Web-Dienst schreibt `connection.command = 'connect'` (`POST /api/connect`); der Ingest prüft alle 3 s, quittiert durch Leeren des Werts, ignoriert den Befehl bei laufendem Socket und unbekannte Befehle. Nach einer Abmeldung oder einem abgelaufenen QR wartet der Dienst im Status `needs_qr` ohne QR auf diesen Befehl. Der Dienst meldet nie von sich aus ab.

`events_outbox` (alle Zeitstempel Unix-**Sekunden**; der Web-Dienst liest die Tabelle und leitet die Ereignisse als SSE weiter, Cleanup und Web schreiben eigene Ereignisse `cleanup_done` bzw. `message_updated`):

| `type` | `payload_json` |
| --- | --- |
| `connection_status` | `{state, since?, reason, hasQr, qrSeq, updatedAt}` – enthält den QR **nicht** (Kopplungsgeheimnis, soll nicht dauerhaft in der Warteschlange liegen); der Web-Dienst liest den maßgeblichen Zustand und den QR aus `settings` |
| `new_message` | `{chatId, messageId, type}` – nur für Live-Nachrichten, nicht für Verlauf |
| `history_synced` | `{stored}` – einmal je Verlaufspaket |
| `media_ready` | `{messageId, status}` (`ready`, `failed`, `expired`); der Web-Dienst ergänzt Chat und Pfade beim Weiterleiten |

---

## 7. Anbindung an `db/client.ts`

`src/dbClient.ts` ist eine dünne Schicht über dem gemeinsamen Workspace-Paket `@waread/db` (`db/client.ts`): Es re-exportiert `openDb`, `runMigrations`, `upsertChat`, `insertMessageIfNotExists`, `setMediaStatus`, `getSetting`, `setSetting`, `pushEvent` samt Typen. Alle anderen Module des Ingest importieren die Datenbank nur von dort. Schema, Migrationen und die Suchindex-Trigger kommen aus `db/` und werden nicht mehr im Ingest nachgebaut. Drei Hilfen stehen zusätzlich in `dbClient.ts`, weil sie nicht im Vertrag stehen und reines SQL gegen die Vertragstabellen sind: `ensureMediaRow`, `listMediaIdsByStatus`, `messageExists`.

**Suchindex:** `messages_fts` wird von Triggern in `db/schema.sql` über die Zuordnungstabelle `messages_fts_map` gepflegt. Der Ingest schreibt oder löscht keine FTS-Zeilen von Hand (der frühere Umgang mit verwaisten Zeilen ist entfallen).

---

## 8. Offene Punkte, Annahmen, Lücken (bewusst offen gelassen)

**Funktional nicht umgesetzt**

- **Zähler ausgehender Meldungsarten** (Konzept, Zweitnummern-Test Schritt 6). Möglicher Weg, **nicht geprüft**: Bibliotheks-Logger auf Stufe `trace`; Baileys schreibt ausgehende Frames nur dann als XML ins Log, wenn `logger.level === 'trace'` (`Socket/socket.ts`, Zeile ~160), und formatiert dafür **jeden** Frame zu Text (CPU). Im Spike klären, ob das tragbar ist.
- **Bearbeitungen und Löschungen** („Nachricht bearbeitet/gelöscht") werden ignoriert; `edited`/`deleted` bleiben 0.
- **Profilbilder** (`avatar_path`) werden nicht geladen (das wäre eine Abfrage an WhatsApp).
- **Kopplung per Code mit Telefonnummer** (`requestPairingCode`) fehlt; nur QR. Wer das iPhone selbst als Bildschirm nutzt, braucht einen zweiten Bildschirm.
- **Nachladen per Tipp** („Medium jetzt laden") gibt es nicht. Ist `auto_download_<art> = false`, bleibt der Status dauerhaft `pending`; die Oberfläche kann das von „wird geladen" nicht unterscheiden.
- **Einmal-Ansehen-Medien** werden bewusst nicht gespeichert (`system`-Nachricht mit Hinweis).
- Ist die Warteschlange voll (`max_queue_length`, Standard 500), wird das Medium `failed` und **nicht** später nachgeholt.
- Sticker werden als `image` gespeichert.

**Lücken im Vertrag / Annahmen**

- **Zeiteinheit** ist im Vertrag nicht genannt; verwendet werden überall Unix-**Sekunden**.
- **`messages.sender`** enthält eine Anzeigebezeichnung („Anna", „+49…", bei eigenen Nachrichten „Ich"), keine JID.
- **Dateiname und Seitenzahl** von Dokumenten haben im Schema keinen Platz: Die FTS-Spalte `filename` bleibt leer. Der bereinigte Originalname steckt nur im Dateinamen auf der Platte (`<id>__<name>`).
- **`media.file_path` / `thumbnail_path`** sind **absolute** Pfade; der Vertrag nennt nicht, ob absolut oder relativ.
- **`settings`-Schlüssel und Ereignisnamen** sind eine Festlegung beim Zusammenführen (Abschnitt 6), kein Vorgabewert des Vertrags.
- **403 → `expired`**: Ob 403 bei abgelaufenen Medien auftritt, ist eine Annahme (404/410 wie in Baileys). Ein echter Zugriffsfehler würde so ebenfalls als abgelaufen gelten.
- **Nachrichten-ID ist global eindeutig** (`messages.id` ist der Primärschlüssel). Käme dieselbe ID in einem zweiten Chat vor, zählt die zweite Nachricht als Duplikat und geht verloren; die erste bleibt unverändert (Test F18/C4). Dass WhatsApp-IDs über Chats hinweg kollidieren, ist nicht gemessen; das Schema ist ein gemeinsamer Vertrag und wurde nicht geändert.
- **Namen** (Kontakte, Gruppen, Zuordnung LID↔Nummer) liegen in `ingest-state.db` ohne Ablauf; sie unterliegen **nicht** der Aufbewahrung der Nachrichten. Geleert werden sie (F14) bei einer Abmeldung durch das Konto (Fehlercode 401) und durch „Speicher leeren → Alles“ in der Oberfläche (Auftrag `ingest.state_command = clear_identity` in der settings-Tabelle, abgearbeitet von `src/stateCommand.ts`, beim Start sofort, danach alle 3 Sekunden). Datei 0600, nicht in Sicherungen aufnehmen.

**Datenschutz-Hinweis zu Medien-Pfaden:** Chat-ID (enthält die Telefonnummer) bildet einen Verzeichnisnamen unter `media/`. Die Dateinamen von Dokumenten stehen im Dateisystem, nicht im Journal.

---

## 9. Konfiguration (`/etc/waread/config.toml`, überschreibbar mit `WAREAD_CONFIG`)

Maßgeblich ist `config/config.example.toml` im Projektordner (Abschnitte `[paths]`, `[retention]`, `[ingest]`); die Standardwerte stehen in `src/config.ts` (`defaultConfig`). Fehlt die Datei, gelten die Standardwerte. Unbekannte Abschnitte (anderer Dienste, `[update]`) werden ignoriert, ungültige Werte brechen den Start mit klarer Meldung ab (der Dateiinhalt wird nicht zitiert). Standardgrenzen für Downloads: Bild 10 MB, Sprachnachricht 10 MB, Video 50 MB, Dokument 20 MB; Videos werden standardmäßig nicht automatisch geladen. `tmp_dir` wird vom Ingest nicht benutzt (Teildateien liegen als `.part` neben dem Ziel). `[retention]` ist nur der Rückfall des Ingest, wenn in `settings` nichts steht.

---

## 10. Betrieb

**Rechte:** Der Prozess setzt `umask 077`. `auth/` ist 0700, `auth.db`, `ingest-state.db` und `ingest.lock` sind 0600. `/var/lib/waread/auth` gehört **nicht** in Sicherungen. Sitzungsdateien dürfen nie auf einen zweiten Rechner kopiert und dort gleichzeitig benutzt werden (zwei Verbindungen mit denselben Schlüsseln führen zu Abmeldungen).

**Sperrdatei:** `auth/ingest.lock` mit PID, `boot_id` und Prozess-Startzeit; eine zweite Instanz beendet sich mit Code 75. Verwaiste Sperren (Prozess tot, anderer Boot, wiederverwendete PID) werden übernommen.

**Logging:** JSON je Zeile auf stdout (→ journald). Nur Ereignisname, IDs, Zähler, Fehlername/-code/-status. **Nie** Nachrichtentexte, Unterschriften, Dateinamen, Namen, Nummern, Pfade, QR-Werte, Fehlermeldungen (diese können Inhalte zitieren). Felder mit verdächtigen Namen werden maskiert; der Logger der Bibliothek verwirft alle Objekte. Alle 10 min eine `stats`-Zeile (RSS, Warteschlange).

**systemd-Einheit:** `deploy/systemd/waread-ingest.service` (`User=waread`, `Nice=15`, `IOSchedulingClass=idle`, `MemoryHigh=384M`, `MemoryMax=512M`, `NoNewPrivileges`, `ProtectSystem=strict`). Hält eine andere Instanz die Sperre, beendet sich der Dienst mit Code 75; die Unit startet ihn dann nach `RestartSec=15` erneut, bis `StartLimitBurst=5` in 300 s erreicht ist (`RestartPreventExitStatus=75` ist **nicht** gesetzt). Die Speichergrenzen sind ungetestete Startwerte.

`/var/www/craft`, `/var/lib/craft`, `craft-update` und deren Einheiten werden nicht berührt.

**Bauen:** im Projektordner (nicht in diesem Unterordner): `npm ci` (bzw. erstes `npm install`) → `npm run build` (führt vorher den Sende-Wächter aus) → `npm test` → `npm run prune:prod`. `sharp` und `better-sqlite3` bringen vorgebaute Binärdateien für arm64 mit, **wenn** die Registry sie anbietet; sonst ist ein Compiler nötig. Beides ist ungeprüft. Siehe `docs/INSTALL.md`, Abschnitt 5, und `deploy/README.md`.

---

## 11. Entwicklung

Im Projektordner (npm-Workspaces, ein gemeinsames `node_modules`):

```bash
npm install                          # beim ersten Mal; erzeugt package-lock.json
npm run verify -w waread-ingest      # Typprüfung (src + test) und alle Tests dieses Dienstes
npm test -w waread-ingest            # nur Tests (inkl. Sende-Wächter)
npm run check:no-send                # nur der Sende-Wächter
npm run build -w waread-ingest       # prebuild = Sende-Wächter, dann tsc nach dist/
```

Tests brauchen weder Netz noch WhatsApp noch `better-sqlite3`; sie benutzen `node:sqlite` (Node ≥ 22.5; gibt eine Experimental-Warnung aus) und die Programme `ffmpeg`/`ffprobe` (Tests mit `ffmpeg` werden übersprungen, wenn es fehlt).

**Nach einem Bibliotheks-Update:** (1) `npm run verify -w waread-ingest`, (2) Zweitnummern-Test (Abschnitt 5, ausführlich `docs/SECURITY_TESTS.md`), (3) in diesem README die Abschnitte 1 und 2 gegen die neue Version prüfen (Paketname, Exporte, interner Verkehr).
