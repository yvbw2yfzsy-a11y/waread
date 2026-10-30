# Profilbilder (Branch `feature/profilbilder`, nicht fertig)

Stand: 30. Oktober 2026. Gewissheitsstufen wie in `docs/VERSION2.md`.

## 1. Stand

Der Code für den Abruf steht (`services/ingest/src/avatars.ts`, Hülle in `waLib.ts`, Schalter in `config.ts`). Seine eigenen Tests sind grün (`test/avatars.test.ts`, 8 Prüfungen). **Der Sende-Wächter (`npm run check:no-send`) schlägt absichtlich an**, und damit auch `npm run build` des Ingest (`prebuild`):

- `kein verbotener Name im gesamten Quellcode`: `profilePictureUrl` steht in der Verbotsliste.
- `die Huelle nutzt vom rohen Socket nur ev.on, ev.off und end`: die Hülle reicht jetzt `profilePicture` durch.
- `waLib`-Test `die Huelle reicht NUR ev.on, ev.off und end durch`.

Die Ausnahme im Wächter ist nicht eingebaut. Sie lockert den zentralen Sicherheitstest und braucht eine ausdrückliche Entscheidung. Vorgesehen war: `profilePictureUrl` nur in `waLib.ts` und nur als `raw.profilePictureUrl`, `WaSocket` mit genau `ev`, `end` und `profilePicture`, in jeder anderen Datei bleibt der Name verboten, dazu Negativtests für andere Abfragen (`fetchStatus`, `fetchBlocklist`).

## 2. Verhalten

- Ab Werk aus: `profile_pictures = false` in `[ingest]`. Eingeschaltet fragt der Ingest je Chat höchstens einmal pro `profile_pictures_interval_days` (Standard 7) nach dem Profilbild. Zwischen zwei Abfragen liegen 15 s ± 30 %, je Runde höchstens 40 Abfragen. Gefragt wird nur, solange die Verbindung steht.
- Nur Chats, die in der Datenbank stehen (also mit Nachrichten im Aufbewahrungszeitraum), Personen und Gruppen; keine Status-, Kanal- oder Broadcast-Chats.
- Meldet WhatsApp von sich aus „Bild entfernt“ (`contacts.update`, `imgUrl: "removed"`), wird das lokale Bild ohne Abfrage gelöscht. „Bild geändert“ macht den Chat für die nächste Runde fällig.
- Antwortet WhatsApp mit 429 (zu viele Anfragen), ruht der Abruf 24 Stunden. Nach drei Fehlern in Folge endet die Runde.
- Ablage: `<media_dir>/avatars/<Hash>.jpg` (192 px), Verweis in `chats.avatar_path`. Web-Dienst und Oberfläche zeigen Bilder von dort schon heute an. Cleanup und „Speicher leeren“ lassen `avatars/` in Ruhe; Bilder gelöschter Chats räumt `avatars.ts` selbst weg.
- Im Journal stehen nur Zahlen (`avatars_round` mit `asked`, `found`, `none`, `failed`), keine Nummern.

## 3. Verkehr und Risiko

| Was | Stufe |
| --- | --- |
| Je Chat und Intervall eine Abfrage `iq type=get xmlns=w:profile:picture` über die bestehende Verbindung, und bei sichtbarem Bild ein HTTPS-Abruf von `pps.whatsapp.net` | GESICHERT (Quelltext von Baileys 7.0.0-rc14, `lib/Socket/chats.js`, `profilePictureUrl`) |
| Keine Nachricht, keine Lesebestätigung, keine Presence | GESICHERT für den Code dieses Branches |
| WhatsApp Web stellt dieselbe Art Abfrage für Profilbilder | VERMUTUNG (Kommentar in der Bibliothek, nicht nachgemessen) |
| Ob wöchentliche Abfragen das Sperrrisiko erhöhen | UNBEKANNT. Gering wirkt plausibel, belegt ist es nicht. Ein Zweitnummer-Test mit eingeschaltetem Schalter wäre der Nachweis. |

## 4. „Hat mich blockiert“: nicht umgesetzt

Geht nicht verlässlich. Die Bibliothek kennt nur die eigene Sperrliste (`fetchBlocklist`, `blocklist.update`: wen dieses Konto blockiert hat), nicht die anderer. Alle bekannten Anzeichen haben auch harmlose Ursachen:

- **Kein Profilbild (404) oder nicht sichtbar (401):** Das passiert auch durch die Datenschutz-Einstellung „Niemand“ oder „Meine Kontakte“, oder weil kein Bild gesetzt ist.
- **Kein „online“ und kein „zuletzt online“:** Das entsteht auch durch Datenschutz-Einstellungen und durch Flugmodus. Eine Abfrage würde außerdem eine Presence-Anmeldung senden.
- **Nur ein Haken:** Dafür müsste man eine Nachricht senden. waread sendet keine.

Eine Anzeige „blockiert“ wäre in vielen Fällen falsch. Deshalb gibt es sie nicht.
