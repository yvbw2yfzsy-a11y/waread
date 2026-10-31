# Release 0.2.0

Stand: 31. Oktober 2026. Vorgänger: 0.1.0. Gewissheitsstufen wie in `docs/VERSION2.md` (GESICHERT, VERMUTUNG, UNBEKANNT).

## 1. Inhalt

| Bereich | Was neu ist | Ausführlich |
| --- | --- | --- |
| Version 2 | Schild, „Vom Absender gelöscht“, Bearbeitungsverlauf, Zitate mit Text, „Medium jetzt laden“, Sichern auf dem Gerät, Einmal-Medien (Schalter, aus), stumme Chats. War schon in `main`, wird hier zum ersten Mal als Version ausgeliefert. | `docs/VERSION2.md` |
| Oberfläche | iOS-Stil mit WhatsApp-Aufbau: Farben und Schrift wie iOS im Dunkelmodus, gruppierte Sprechblasen mit Schwanz, schwebende Leisten und Sheets, Einstellungen als iOS-Gruppen, Tippflächen ≥ 44 px, „Kontrast erhöhen“ und „Bewegung reduzieren“ werden berücksichtigt. Sprachnachrichten im Stil von WhatsApp auf iOS. | `docs/DESIGN.md` |
| Profilbilder | Beim Öffnen eines Chats wird dessen Profilbild geholt, höchstens einmal pro Woche und Chat. **Ab Werk aus.** Einzige Anfrage an WhatsApp, die waread selbst stellen kann; der Sende-Wächter erlaubt sie nur in `waLib.ts`. | `docs/PROFILBILDER.md` |
| „Blockiert“-Anzeige | Nicht enthalten: nicht verlässlich erkennbar. | `docs/PROFILBILDER.md`, Abschnitt 4 |

Datenbank: keine neue Migration gegenüber Version 2. Wer von 0.1.0 kommt, bekommt beim ersten Start die Migration von Version 2 (`user_version` 1 → 2). Profilbilder nutzen die vorhandene Spalte `chats.avatar_path` und Einträge in `settings` (`avatars.*`).

Abhängigkeiten: unverändert gegenüber 0.1.0. In `package-lock.json` ändern sich nur die Versionsnummern der eigenen Pakete. Das Bibliothekstor (`docs/MAINTENANCE.md`, Abschnitt 5.3) greift daher nicht.

## 2. Bauen

Auf einem arm64-Rechner (Raspberry Pi OS / Debian, Node 22), wie in `deploy/README.md`, Abschnitt „Release bauen“:

```sh
git checkout <Commit dieses Releases>
npm ci
npm run build                  # enthält den Sende-Wächter (prebuild)
npm test
npm run prune:prod
deploy/make-release.sh         # release-out/waread-0.2.0.tar.gz und latest.manifest
```

Den Tarball nicht auf einem x86-Rechner bauen. `better-sqlite3` und `sharp` müssen für arm64 gebaut sein.

## 3. Einspielen auf dem Pi

Ablauf wie `docs/MAINTENANCE.md`, Abschnitt 5.2. Zusätzlich für diese Version:

1. `config.toml` sichern: `sudo cp -a /etc/waread/config.toml /etc/waread/config.toml.vor-0.2.0`.
2. Neue Schlüssel bei Bedarf von Hand in `[ingest]` ergänzen. Eine vorhandene Konfiguration wird nie überschrieben. Ohne Eintrag gelten die Standardwerte:
   - `store_view_once = false`, `max_mb_forced = 500` (Version 2)
   - `profile_pictures = false`, `profile_pictures_interval_days = 7`, `profile_pictures_gap_seconds = 5`, `profile_pictures_max_per_day = 100`
3. Wer von 0.1.0 kommt: `hide_deleted_content` prüfen (`docs/VERSION2.md`, Abschnitt 2, Punkt 2).
4. Einspielen (`install.sh` mit dem entpackten Release oder `waread-update`), dann `sudo systemctl restart waread-ingest waread-web`.
5. Prüfen: Status „verbunden“, eine Testnachricht kommt an, das Journal ist frei von Warnungen. Die Oberfläche auf dem iPhone einmal komplett neu laden; Startbildschirm-Symbol und Farbe kommen aus dem neuen Manifest.

**Profilbilder einschalten** (erst nach dem Zweitnummer-Test, `docs/SECURITY_TESTS.md`):
1. In `[ingest]` `profile_pictures = true` setzen und `sudo systemctl restart waread-ingest`.
2. In der Oberfläche einen Chat öffnen. Das Journal zeigt `avatar_refreshed` mit `found=true` oder `found=false`: `journalctl -u waread-ingest -o cat | grep avatar_`.
3. Erscheint `avatars_rate_limited`, ruht der Abruf 24 Stunden. Dann den Schalter wieder ausschalten und beobachten.

**Rücksprung:** `docs/MAINTENANCE.md`, Abschnitt 8. Für 0.1.0 gilt dort die Warnung zum Schild (der alte Cleanup kennt es nicht).

## 4. Geprüft

GESICHERT, in der Entwicklungsumgebung (x86_64, Node 22, Chromium über Playwright):

- `npm run build` und `npm run typecheck` grün.
- `npm test` grün: Datenbank 34, Ingest 351, Web-Smoke 324, Passkey 168, Cleanup 38, Formatierung 7.
- `npm run check:no-send`: 34 Prüfungen grün.
- Browsertests grün, ohne Konsolenfehler und ohne CSP-Verletzung: `e2e-frontend.mjs` 16/16, `e2e-frontend-v2.mjs` 54/54, `passkey-e2e.mjs` 18/18.
- `deploy/make-release.sh` in einer Wegwerf-Kopie nach `prune:prod`: Release-Vertrag erfüllt, `waread-0.2.0.tar.gz` erzeugt (x86_64, nur Probelauf, nicht für den Pi), ohne `typescript` im Paket.
- Kein seitliches Scrollen bei 320 und 390 px Breite und im Querformat. Alle Tippflächen ≥ 44 px. Kontraste nach WCAG AA (Werte in `docs/DESIGN.md`).

## 5. Nicht geprüft

- Safari/WebKit und ein echtes iPhone: Aussehen, Glas-Effekt auf alten Geräten, Tastatur, Dynamic Island, Teilen-Blatt.
- Echter Pi und Tarball-Bau auf arm64: Der Tarball wurde hier nicht gebaut.
- Profilbilder gegen echtes WhatsApp:
  - ob `pps.whatsapp.net` weiterleitet (der Download folgt keiner Weiterleitung und würde dann scheitern),
  - wie groß die Bilder sind,
  - ob WhatsApp die Abfragen anders bewertet als die eines offiziellen Geräts (UNBEKANNT).
- Alles aus `docs/VERSION2.md`, Abschnitt 6, „Nicht geprüft“.
