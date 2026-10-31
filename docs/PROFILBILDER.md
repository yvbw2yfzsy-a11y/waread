# Profilbilder (ab Version 0.2.0, ab Werk aus)

Stand: 31. Oktober 2026. Gewissheitsstufen wie in `docs/VERSION2.md`.

## 1. Stand

Der Abruf ist in Ingest, Web-Dienst und Oberfläche eingebaut und ab Werk aus. Tests:
- `services/ingest/test/avatars.test.ts`: 9 Prüfungen.
- `waLib.test.ts`: Hülle, Fehlercodes und Download-Ziel.
- Web-Smoke: 7 Prüfungen.
- Browsertest `e2e-frontend-v2.mjs`: 2 Prüfungen.

**Sende-Wächter:** Er hat eine enge Ausnahme bekommen (Entscheidung des Nutzers vom 31.10.2026):
- `profilePictureUrl` ist nur in `waLib.ts` erlaubt, und nur als `raw.profilePictureUrl` (`WALIB_ONLY_NAMES` in `services/ingest/test/support/scanForbidden.ts`).
- `WaSocket` hat genau `ev`, `end` und `profilePicture`.
- In jeder anderen Datei bleibt der Name verboten.
- Gegentests stellen sicher, dass andere Abfragen weiter anschlagen (`fetchStatus`, `fetchBlocklist`, `query`).
- `npm run check:no-send` ist mit 34 Prüfungen grün.

## 2. Verhalten

Ausgelöst wird der Abruf, wenn ein Chat in der Oberfläche geöffnet wird. Laut Beobachtung des Nutzers macht WhatsApp es genauso; hier ist das nicht nachgemessen.

1. Die Oberfläche ruft `POST api/chats/:id/avatar/refresh` auf.
2. Der Web-Dienst legt den Befehl `refresh_avatar` ab, aber nur, wenn der Abruf eingeschaltet ist (`settings` `avatars.enabled`). Er sendet selbst nichts an WhatsApp, wie bei „Medium jetzt laden“.
3. Der Ingest (`avatars.ts`) fragt nur, wenn die letzte Abfrage für diesen Chat älter als `profile_pictures_interval_days` ist (Standard 7 Tage). Sonst tut er nichts. Das Datum der letzten Abfrage je Chat steht in `settings` `avatars.checked`.
4. Ein neues oder entferntes Bild meldet er der Oberfläche über das Ereignis `avatar_updated`. Sie lädt die Chatliste neu. Die Bildadresse trägt den Dateinamen als Version, damit der Browser kein altes Bild zeigt.

Grenzen:
- Ab Werk aus: `profile_pictures = false` in `[ingest]`.
- Zwischen zwei Abfragen liegen mindestens 5 s (`profile_pictures_gap_seconds`), am Tag höchstens 100 (`profile_pictures_max_per_day`).
- Gefragt wird nur, solange die Verbindung steht. Sonst entfällt die Abfrage bis zum nächsten Öffnen.
- Antwortet WhatsApp mit 429 (zu viele Anfragen), ruht der Abruf 24 Stunden.
- Nur Personen und Gruppen; keine Status-, Kanal- oder Broadcast-Chats.

Ohne Abfrage:
- Meldet WhatsApp von sich aus „Bild entfernt“ (`contacts.update`, `imgUrl: "removed"`), löscht der Ingest das lokale Bild.
- „Bild geändert“ macht den Chat beim nächsten Öffnen fällig, auch vor Ablauf des Intervalls.

Ablage:
- `<media_dir>/avatars/<Hash>-<Zeit>.jpg` (192 px), Verweis in `chats.avatar_path`. Das alte Bild wird beim Ersetzen gelöscht.
- Cleanup und „Speicher leeren“ lassen `avatars/` in Ruhe. Bilder gelöschter Chats räumt `avatars.ts` alle 6 Stunden ohne Netzverkehr weg.
- Im Journal stehen keine Nummern (`avatar_refreshed` mit `found` und `today`).

## 3. Verkehr und Risiko

| Was | Stufe |
| --- | --- |
| Je fälliger Chat beim Öffnen eine Abfrage `iq type=get xmlns=w:profile:picture` über die bestehende Verbindung, bei sichtbarem Bild dazu ein HTTPS-Abruf von `pps.whatsapp.net` | GESICHERT (Quelltext von Baileys 7.0.0-rc14, `lib/Socket/chats.js`, `profilePictureUrl`) |
| Keine Nachricht, keine Lesebestätigung, keine Presence | GESICHERT für den Code dieses Branches |
| WhatsApp fragt Profilbilder ebenfalls beim Öffnen eines Chats ab | VERMUTUNG (Beobachtung des Nutzers, nicht nachgemessen) |
| Ob diese Abfragen das Sperrrisiko erhöhen | UNBEKANNT. Gering wirkt plausibel, belegt ist es nicht. Nachweis wäre ein Zweitnummer-Test mit eingeschaltetem Schalter. |

## 4. „Hat mich blockiert“: nicht umgesetzt

Das geht nicht verlässlich. Die Bibliothek kennt nur die eigene Sperrliste (`fetchBlocklist`, `blocklist.update`: wen dieses Konto blockiert hat), nicht die anderer. Alle bekannten Anzeichen haben auch harmlose Ursachen:

- **Kein Profilbild (404) oder nicht sichtbar (401):** Das passiert auch durch die Datenschutz-Einstellung „Niemand“ oder „Meine Kontakte“, oder weil kein Bild gesetzt ist.
- **Kein „online“ und kein „zuletzt online“:** Das entsteht auch durch Datenschutz-Einstellungen und durch Flugmodus. Eine Abfrage würde außerdem eine Presence-Anmeldung senden.
- **Nur ein Haken:** Dafür müsste man eine Nachricht senden. waread sendet keine.

Eine Anzeige „blockiert“ wäre in vielen Fällen falsch. Deshalb gibt es sie nicht.
