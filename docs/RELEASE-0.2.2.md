# Release 0.2.2

Stand: 1. November 2026. Vorgänger: 0.2.1. Gewissheitsstufen: **GEPRÜFT** (ein Befehl oder Test lief, die Ausgabe wurde gesehen), **GELESEN** (im Quelltext), **UNGEPRÜFT**.

Dieses Release räumt auf: Es entfernt Code, der nichts tat oder doppelt vorhanden war, und behebt einen kleinen Fehler. Es ändert nichts am Schema der gemeinsamen Datenbank, braucht keine Änderung an `config.toml` und stellt keine zusätzlichen Anfragen an WhatsApp.

## 1. Inhalt

### Fehler

| Fund | Ursache | Änderung |
| --- | --- | --- |
| Antwortet jemand auf eine **Umfrage** der Versionen `pollCreationMessageV4` oder `V5`, fehlen im Kurzzitat Titel und Typ. GEPRÜFT mit einer nachgestellten Nachricht (V1 bis V3 zeigten „📊 Umfrage: …“, V4 und V5 nichts). Mit echtem WhatsApp nicht gesehen. | Die Liste der Umfragefelder stand zweimal im Quelltext (Inhaltstypen und Zitat). Die Zitat-Fassung kannte nur V1 bis V3. | Eine Liste (`POLL_KEYS` in `messageHandler.ts`). Neue Tests für alle fünf Fassungen; vor der Korrektur schlugen V4 und V5 fehl. |

### Entfernt

Jede Zeile wurde vor dem Löschen im ganzen Baum gesucht (Quelltext, Tests, Skripte, Dokumente). Danach liefen Typprüfung mit `noUnusedLocals`, alle Tests und die Browsertests.

| Was | Warum es weg kann |
| --- | --- |
| `searchMessages` mit `toFtsMatch`, `SearchFilters`, `MessageHit` im Paket `db/` | Zweite Fassung der Suche. Der Web-Dienst benutzt seine eigene (`services/web/src/queries.ts`, `buildFtsQuery`), mit anderer Rückgabeform und zusätzlicher Normalisierung. Aufgerufen wurde die Fassung in `db/` nur von den eigenen Tests. |
| `updateMessageText` in `db/` | Alter Name. Rief `applyMessageEdit` auf und setzte `edited=1` auch dann, wenn sich der Text nicht geändert hatte. Kein Aufrufer. |
| `listMessageVersions`, `countProtected`, `pruneEvents` in `db/` | Kein Aufrufer. Der Web-Dienst liest Versionen und Schild-Zahlen mit eigenem SQL und leert die Outbox selbst (`sse.ts`). |
| `ensureMediaRow` im Ingest (zwei Aufrufe) | Ohne Wirkung: `insertMessageIfNotExists` legt die `media`-Zeile für Medientypen schon an, und `setMediaStatus` legt sie bei Bedarf an. |
| Re-Export von `nextBackoffMs`, `statusCodeOf`, `BackoffOptions`, `Scheduler` in `connection.ts` (Ingest) | Alle Nutzer importieren aus `timing.ts`. |
| `applyQr`, `applyStatus` und die Sonderbehandlung des Outbox-Ereignisses `qr` im Web-Dienst | Der Ingest erzeugt kein `qr`-Ereignis mehr. `applyStatus` wurde unmittelbar danach von `syncFromSettings` überschrieben; das Ereignis ist nur der Anstoß. Ein `qr`-Ereignis wird weiter verworfen und nie weitergereicht (Smoke-Test „SSE leitet qr NIE weiter“). |
| Zweite Content-Type-Prüfung in `readJson` | `app.ts` prüft den Content-Type vorher für jede schreibende Anfrage (Smoke-Test: 415 bei Formular, `text/plain` und ohne Header). |
| `nullLogger`; doppeltes `cookieSecure` und `setSessionCookie` im Web-Dienst | Nirgends benutzt bzw. zweimal geschrieben; jetzt eine Fassung (`routes/auth.ts`). |
| `EVENTS` und `SSE_EVENT_NAMES` im Frontend; `isObj` stand dreimal | Die Liste wurde nirgends gelesen (und war veraltet). Eine gemeinsame Fassung in `util.ts`. |
| CSS `.glass-btn` und `.seen-pill` | Keine Stelle in TypeScript oder `index.html` verwendet die Klassen. |
| Konfigurationsschlüssel `paths.tmp_dir` | Wurde gelesen und geprüft, aber nirgends benutzt (die Unit setzt `TMPDIR`, Teildateien liegen neben dem Ziel). |
| `better-sqlite3` und `@types/better-sqlite3` in `cleanup/package.json` | `cleanup.ts` importiert sie nicht; die Datenbank kommt über `@waread/db`. |
| Eigene Sekundenuhr in `avatars.ts` | Ersetzt durch `nowSec` aus `sqlite.ts`. |

### Absichtlich nicht angefasst

Mehrere Hilfen stehen in mehr als einem Dienst (`safeSegment` in Ingest und Web, `removeFiles` in Cleanup und Web, `validRule` in Ingest und Web, die Logger, die Konfigurationslader). Das ist gewollt: Jeder Dienst ist ein eigener Prozess mit eigenem Paket; außer dem gemeinsamen Datenbankpaket teilen sie keinen Code. Entfernt sind Doppelungen innerhalb eines Dienstes, wo dieselbe Logik an zwei Stellen stand (Cookie-Helfer, `isObj`, Umfragefelder).

## 2. Daten und Datenschutz

- Das Schema der gemeinsamen Datenbank ist unverändert (`user_version` bleibt 2). Keine neuen Dateien, keine neuen Einstellungen.
- `config.toml` braucht keine Änderung. Steht dort noch `tmp_dir = …` unter `[paths]`, wird es ignoriert (bisher wurde es gelesen, aber nicht benutzt). Die Beispielkonfiguration enthält die Zeile nicht mehr.

## 3. Verkehr

Keiner zusätzlich. Der Sende-Wächter (`npm run check:no-send`) ist unverändert und grün (34 von 34); die Hülle `waLib.ts` ist unverändert.

## 4. Bauen und einspielen

Wie in `docs/RELEASE-0.2.0.md`, Abschnitte 2 und 3. `config.toml` bleibt unverändert. Nach dem Einspielen den Ingest neu starten (macht `waread-update`).

- Diese Version hat eine neue Versionsnummer (`VERSION`, alle `package.json`). Ohne sie würde `install.sh` eine bereits installierte Version 0.2.1 nicht ersetzen.
- `package-lock.json`: neue Versionsnummern der eigenen Pakete und zwei Einträge weniger im Abschnitt des Pakets `cleanup`. Die WhatsApp-Bibliothek und alle übrigen Pakete sind unverändert, das Bibliothekstor (`docs/MAINTENANCE.md`, Abschnitt 5.3) greift daher nicht.

## 5. Prüfen nach dem Einspielen

| Was | Erwartung |
| --- | --- |
| `systemctl is-active waread-ingest waread-web` | beide `active` |
| `curl -s http://127.0.0.1:8780/healthz` | `OK` |
| Oberfläche öffnen, einen Chat öffnen, Einstellungen speichern | wie vorher |
| `journalctl -u waread-ingest -u waread-web -o cat` | keine neuen Warnungen |
| Von einem zweiten Konto auf eine Umfrage antworten | Das Zitat in der Antwort zeigt „📊 Umfrage: Titel“ (**nicht live geprüft**) |

## 6. Tests

Sende-Wächter 34, DB-Paket 41, Ingest 453, Web-Smoke 347, Passkey 168, Cleanup 38, Frontend 21. Gemessen mit Node 22.23.4 auf x86_64, alle grün; `npm run build` und `npm run typecheck` ohne Fehler. Optionale Browsertests (Playwright, Chromium): `e2e-frontend.mjs` 16/16, `e2e-frontend-v2.mjs` 54/54, `passkey-e2e.mjs` 18/18.

Gegenüber 0.2.1: DB-Paket 2 weniger (die Tests für Sonderzeichen und Filter gehörten zur entfernten Suchfunktion; der Web-Smoke-Test prüft beides gegen die echte Suche), Ingest 5 mehr (Zitat von Umfragen).

Gegenprobe für das Datenbankpaket: Wird jeder der sechs Trigger aus `db/schema.sql` einzeln entfernt, schlägt weiterhin mindestens ein Test fehl (19, 2, 3, 1, 2 und 2 Tests). Der Suchindex ist damit weiter abgesichert, obwohl die Suchfunktion im Paket fehlt.

## 7. Ungeprüft und offen

- Die Korrektur beim Zitat von Umfragen ist nur mit nachgestellten Nachrichten geprüft, nicht mit echtem WhatsApp.
- Das Release wurde nicht auf einem Pi gebaut oder eingespielt. Wie bei den Vorgängern gilt: x86_64-Läufe belegen die Logik, nicht arm64 und systemd.
- Bekannt, **nicht geändert** (GELESEN, nicht geprüft): Die Stumm-Einstellung eines LID-Chats (`settings`, Schlüssel `chat.muted`) geht beim Zusammenführen in den Nummern-Chat nicht mit über; der Nummern-Chat behält seinen eigenen Zustand.
- Die offenen Punkte aus `docs/RELEASE-0.2.1.md`, Abschnitt 7, gelten unverändert.
