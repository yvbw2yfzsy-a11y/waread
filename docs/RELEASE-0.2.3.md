# Release 0.2.3

Stand: 1. November 2026. Vorgänger: 0.2.2. Gewissheitsstufen: **GEMESSEN** (am laufenden System beobachtet), **GELESEN** (im Quelltext von waread oder der Bibliothek), **GEPRÜFT** (ein Befehl oder Test lief, die Ausgabe wurde gesehen), **VERMUTUNG**, **UNBEKANNT**.

Dieses Release betrifft Einmal-Medien (Foto, Video, Sprachnachricht zum einmaligen Ansehen). Es ändert nichts am Schema der gemeinsamen Datenbank, braucht keine Änderung an `config.toml` und stellt keine zusätzlichen Anfragen an WhatsApp.

## 1. Inhalt

### Was nicht geht, und warum

| Fund | Ursache |
| --- | --- |
| Einmal-Fotos und Einmal-Sprachnachrichten erscheinen nur als Textzeile „Einmal-Ansehen-Medium (nicht gespeichert)“. Ansehen lassen sie sich nicht, auch nicht einmal. GEMESSEN (Rückmeldung des Nutzers zu 0.2.2). | WhatsApp stellt Einmal-Medien einem verknüpften Gerät live nur als `<unavailable type="view_once"/>` zu. Der Knoten enthält keine verschlüsselte Nachricht, also weder die Datei noch den Medienschlüssel. Die Bibliothek setzt dafür nur `key.isViewOnce` und fordert beim Handy nichts nach (`baileys/lib/Utils/decode-wa-message.js`, Zeilen 223–224 und 303; `Socket/messages-recv.js` ab Zeile 1304: Placeholder-Resend nur bei anderen fehlenden Inhalten). GELESEN. Ohne Schlüssel lässt sich die Datei nicht entschlüsseln, und `store_view_once` hat nichts zu speichern. |

**Das ist eine Grenze von WhatsApp, kein Fehler in waread.** Ansehen, Herunterladen oder mehrfaches Abspielen live eintreffender Einmal-Medien ist mit dem, was beim Pi ankommt, nicht möglich. Dass auch WhatsApp Web und WhatsApp Desktop sie nicht öffnen, ist VERMUTUNG (aus dem Gedächtnis, wie schon in `docs/VERSION2.md`, Abschnitt 3); die Bibliothek nennt für ihren Filter beim Placeholder-Resend WhatsApp Web als Vorbild (Kommentar in `messages-recv.js`, GELESEN).

### Was sich ändert

| Fund | Ursache | Änderung |
| --- | --- | --- |
| Die Hinweiszeile klang, als hätte waread sich gegen das Speichern entschieden. | Text „(nicht gespeichert)“. | Neue Nachrichten zeigen „Einmal-Medium (nur auf dem Handy zu öffnen)“ (`PLACEHOLDER.viewOnceUnavailable` in `services/ingest/src/messageHandler.ts`). |
| Das Menü einer Einmal-Nachricht ohne Datei sagte „Hier bleibt sie ansehbar, solange sie gespeichert ist“. GEPRÜFT (Browsertest gegen den alten Stand). | Der Hinweis unterschied nicht zwischen gespeicherter Datei und bloßer Hinweiszeile. | Ohne Datei: „Einmal-Medium ohne Datei: waread hat die Datei nicht und kann sie nicht nachladen. Öffnen lässt es sich nur in WhatsApp auf dem Handy.“ Kopfzeile „Einmal-Medium“ statt „Nachricht“. Mit Datei bleibt alles wie bisher (`services/web/public/src/components/messageSheet.ts`). |
| Die in `docs/VERSION2.md` empfohlene Prüfung (`grep viewonce_probe`) zeigte für den Live-Fall nichts. GELESEN. | Die Probe wurde nur für Nachrichten mit Inhalt geschrieben. | Auch für den Live-Fall eine Zeile: `"kind":"unknown"`, `"has_key":false`, `"stored":false`, `"unavailable":true`. Das Feld `unavailable` ist neu und sonst `false`. Wie bisher nur Ja/Nein-Werte, keine Kennungen, Namen oder Inhalte. |

## 2. Daten und Datenschutz

- Das Schema der gemeinsamen Datenbank ist unverändert (`user_version` bleibt 2). Keine neuen Dateien, keine neuen Einstellungen.
- Bereits gespeicherte Hinweiszeilen behalten den alten Text „Einmal-Ansehen-Medium (nicht gespeichert)“, bis die Aufbewahrung sie löscht. Mit dem Schild geschützte behalten ihn dauerhaft.
- `config.toml` braucht keine Änderung. `config/config.example.toml` hat zwei neue Kommentarzeilen zu `store_view_once`.

## 3. Verkehr

Keiner zusätzlich. Der Sende-Wächter (`npm run check:no-send`) ist unverändert und grün (34 von 34); die Hülle `waLib.ts` ist unverändert.

**Bewusst nicht eingebaut:** waread könnte das Handy per Placeholder-Resend (eine Peer-Nachricht an die eigene Nummer, wie sie die Bibliothek bei anderen fehlenden Inhalten selbst schickt) um den Inhalt bitten. Ob das Handy bei Einmal-Medien den Inhalt liefert: UNBEKANNT. VERMUTUNG: nein. Gründe: WhatsApp schickt diese Medien dem verknüpften Gerät erkennbar absichtlich ohne Inhalt (eigener Knotentyp `view_once`), und die Bibliothek nimmt Einmal-Medien vom Placeholder-Resend aus, nach ihrem eigenen Kommentar wie WhatsApp Web. Es wäre eine neue, von waread selbst ausgelöste Nachricht über die WhatsApp-Verbindung und bräche die Zusage „sendet keine Nachricht“. Deshalb nur nach ausdrücklicher Entscheidung des Nutzers, mit eigenem Schalter, Prüfung mit der Zweitnummer und Anpassung des Sende-Wächters.

## 4. Bauen und einspielen

Wie in `docs/RELEASE-0.2.0.md`, Abschnitte 2 und 3. `config.toml` bleibt unverändert. Nach dem Einspielen den Ingest neu starten (macht `waread-update`).

- Diese Version hat eine neue Versionsnummer (`VERSION`, alle `package.json`). Ohne sie würde `install.sh` eine bereits installierte Version 0.2.2 nicht ersetzen. Mit `install.sh` braucht der Wechsel `--upgrade`.
- `package-lock.json`: nur die Versionsnummern der eigenen Pakete. Die WhatsApp-Bibliothek und alle übrigen Pakete sind unverändert, das Bibliothekstor (`docs/MAINTENANCE.md`, Abschnitt 5.3) greift daher nicht.
- Die Oberfläche auf dem iPhone einmal komplett neu laden, damit das neue Menü ankommt.

## 5. Prüfen nach dem Einspielen

| Was | Erwartung |
| --- | --- |
| `systemctl is-active waread-ingest waread-web` | beide `active` |
| Von einem zweiten Konto ein Einmal-Foto senden | Eine Zeile „Einmal-Medium (nur auf dem Handy zu öffnen)“ (**nicht live geprüft**) |
| Auf diese Zeile tippen | Menü „Einmal-Medium“ mit dem Hinweis „ohne Datei“, kein „ansehbar“ |
| `journalctl -u waread-ingest -o cat \| grep viewonce_probe` | Eine Zeile mit `"unavailable":true` und `"has_key":false` (**nicht live geprüft**) |
| Auf dem Handy | Das Einmal-Foto lässt sich dort wie gewohnt einmal öffnen |

## 6. Tests

Sende-Wächter 34, DB-Paket 41, Ingest 454, Web-Smoke 347, Passkey 168, Cleanup 38, Frontend 21. Gemessen mit Node 22.23.4 auf x86_64, alle grün; `npm run build` und `npm run typecheck` ohne Fehler. Optionale Browsertests (Playwright, Chromium): `e2e-frontend.mjs` 16/16, `e2e-frontend-v2.mjs` 56/56, `passkey-e2e.mjs` 18/18.

Gegenüber 0.2.2: Ingest 1 mehr (der Hinweistext behauptet nicht „nicht gespeichert“), 4 angepasst (Text und Probe im Live-Fall, Feld `unavailable`); Browsertest v2 2 mehr (Menü mit und ohne Datei).

Gegenprobe: Mit dem Quelltext von 0.2.2 und den neuen Tests schlagen 6 Ingest-Tests und 1 Browserprüfung fehl. Die fehlschlagende Browserprüfung zeigt den alten Fehler: Das Menü der Hinweiszeile sagte „Hier bleibt sie ansehbar“.

## 7. Ungeprüft und offen

- Die neuen Texte und die Journalzeile sind nur mit nachgestellten Nachrichten geprüft, nicht mit echtem WhatsApp.
- Ob WhatsApp Einmal-Medien im Verlauf nach dem Koppeln mit Inhalt und Schlüssel liefert: UNBEKANNT. Nur dann könnte `store_view_once = true` etwas speichern.
- Der Placeholder-Resend für Einmal-Medien (Abschnitt 3) ist nicht eingebaut und nicht erprobt.
- Das Release wurde nicht auf einem Pi gebaut oder eingespielt. Wie bei den Vorgängern gilt: x86_64-Läufe belegen die Logik, nicht arm64 und systemd.
- Die offenen Punkte aus `docs/RELEASE-0.2.2.md`, Abschnitt 7, gelten unverändert.
