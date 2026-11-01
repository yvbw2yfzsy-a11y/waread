# waread

waread ist eine **rein lesende** Web-Oberfläche für die eigenen WhatsApp-Nachrichten, gedacht für einen Raspberry Pi im Heimnetz. Der Pi verbindet sich als „verknüpftes Gerät“ (Node.js, TypeScript, Baileys), speichert Nachrichten und Medien für wenige Tage in SQLite und zeigt sie im Browser an. Das Programm sendet keine Nachricht, keine Lesebestätigung und keinen bewusst gesetzten Online-Status an WhatsApp. Einzige Ausnahme, ab Werk aus: Mit `profile_pictures = true` fragt es beim Öffnen eines Chats dessen Profilbild ab, höchstens einmal pro Woche und Chat (`docs/PROFILBILDER.md`). Dass das so bleibt, sichert ein automatischer Test im Code (der Sende-Wächter). Was die Bibliothek intern selbst sendet, kann nur der Zweitnummer-Test zeigen (`docs/SECURITY_TESTS.md`).

**Version 2** ergänzt: Schild (Nachrichten vor dem Löschen schützen), „Vom Absender gelöscht“ und Bearbeitungsverlauf, Zitate mit Text, „Medium jetzt laden“, Sichern auf dem Gerät, Einmal-Medien (Schalter, Standard aus), stumme Chats, Korrekturen am Layout. Was zu tun ist und was ungeprüft bleibt: `docs/VERSION2.md`.

**Version 0.2.0** bringt außerdem eine Oberfläche im Stil von iOS mit WhatsApp-Aufbau (`docs/DESIGN.md`) und Profilbilder (ab Werk aus, `docs/PROFILBILDER.md`). Einspielen und Prüfen: `docs/RELEASE-0.2.0.md`.

**Version 0.2.1** behebt Fehler aus einem Test mit einem echten Zweitkonto: Bearbeitungen im neuen verschlüsselten Format, Einmal-Medien, die live nur als Hinweis ankommen, doppelte Chats (LID und Nummer), Chatnamen, Reihenfolge und Anzeige. Was sich ändert und wie man es prüft: `docs/RELEASE-0.2.1.md`.

**Version 0.2.2** räumt auf: Code, der nichts tat oder doppelt vorhanden war, ist entfernt (zweite Suche im Datenbankpaket, Altpfade, ungenutzte Hilfen und CSS), dazu eine Korrektur beim Zitat von Umfragen. Funktion, Datenbank und Konfiguration bleiben gleich. Einzelheiten: `docs/RELEASE-0.2.2.md`.

Stand: Version 0.2.2 (Datei `VERSION`). Das Projekt ist in einer Bauumgebung ohne Zugriff auf die npm-Registry, ohne WhatsApp-Konto und ohne Raspberry Pi entstanden. Was dort geprüft wurde und was nicht, steht in `docs/MERGE_NOTES.md`.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `db/` | SQLite-Schema, Migrationen, Zugriffsmodul `@waread/db` |
| `services/ingest/` | WhatsApp-Empfang, Medien-Download, Sende-Wächter |
| `services/web/` | REST-/SSE-Backend (`src/`), Frontend-Quellen (`public/`), Browsertest |
| `cleanup/` | Aufbewahrung durchsetzen, stündlich; wöchentlich mit VACUUM |
| `config/` | `config.example.toml` (alle gelesenen Schlüssel) |
| `install.sh` | Komplettinstallation auf dem Pi: von GitHub holen, bauen, installieren, starten (ruft `deploy/install.sh` auf) |
| `deploy/` | `install.sh`, `waread-update`, `make-release.sh`, systemd-Units, Nginx-Ausschnitt |
| `docs/` | Installation, Betrieb, Sicherheitsprüfung, Testliste, Zusammenführungsnotizen |

## Schnellüberblick

Im Projektordner, mit Node.js ≥ 22.12:

```bash
npm ci                      # package-lock.json liegt bei (npm install, wenn du Abhängigkeiten ändern willst)
npm run build               # db, ingest (mit Sende-Wächter), web, frontend, cleanup
npm test                    # alle Testläufe
npm run check:no-send       # nur der Sende-Wächter
```

**Auf dem Raspberry Pi in einem Schritt:** `install.sh` im Wurzelordner holt waread von GitHub, baut, testet und installiert es und fragt das Anmeldepasswort ab. Es läuft als root, lies es vorher (Ablauf und Optionen: `docs/INSTALL.md`, Abschnitt „Abkürzung“):

```bash
curl -fsSLO https://raw.githubusercontent.com/yvbw2yfzsy-a11y/waread/main/install.sh
sudo bash install.sh
```

Installation auf dem Pi von Hand, Konfiguration, Kopplung und die Prüfungen vor dem Hauptkonto beschreibt `docs/INSTALL.md`. Reihenfolge, die nicht umgangen werden sollte: bauen und testen, installieren, mit einer **Testnummer** koppeln, Zweitnummer-Test bestehen, erst dann das Hauptkonto.

## Dokumentation

| Datei | Wofür |
| --- | --- |
| `docs/INSTALL.md` | Schritt für Schritt von einem Pi mit Craft bis zum laufenden waread; Annahmen und offene Punkte in Abschnitt 16 |
| `docs/MAINTENANCE.md` | Betrieb: Logs, Speicher, Updates, Verbindungsabbruch, Notfälle |
| `docs/SECURITY_TESTS.md` | Lesebestätigungs-Gate, Zweitnummer-Test, Sicherheits-Baseline |
| `docs/TEST_CHECKLIST.md` | Was die automatisierten Tests belegen müssen; Sabotage-Proben |
| `docs/VERSION2.md` | Version 2: was neu ist, Einspielen auf dem Pi, Einmal-Medien, Schild und Aufbewahrung, zusätzlicher Verkehr, Ungeprüftes |
| `docs/DESIGN.md` | Gestaltung im iOS-Stil: Variablen, Kontrastwerte, Tippflächen, was geprüft ist und was nicht |
| `docs/PROFILBILDER.md` | Profilbilder: Ablauf, Grenzen, Verkehr, warum „blockiert“ nicht erkennbar ist |
| `docs/RELEASE-0.2.0.md` | Release 0.2.0: Inhalt, Bauen, Einspielen auf dem Pi, Prüfschritte, Ungeprüftes |
| `docs/RELEASE-0.2.1.md` | Release 0.2.1: Fehlerkorrekturen aus dem Test mit einem Zweitkonto, Daten, Prüfschritte, Offenes |
| `docs/RELEASE-0.2.2.md` | Release 0.2.2: Aufräumen (entfernter Code und warum er weg kann), eine Fehlerkorrektur, Tests, Offenes |
| `docs/VERKEHR.md` | Was die Bibliothek an WhatsApp schickt und was waread dazu beiträgt, je Version |
| `docs/MERGE_NOTES.md` | Was beim Zusammenführen geprüft, geändert, angenommen wurde; offene Punkte |
| `deploy/README.md` | Release-Vertrag, Installationsskript, Updater, Units, Nginx |
| `services/*/README.md`, `cleanup/README.md`, `db/README.md` | Verhalten und Grenzen je Baustein |

## Wichtige Grenzen

- Das Craft-System auf demselben Pi wird nicht angefasst (`/var/www/craft`, `/var/lib/craft`, `craft-update`, seine Units). `waread` benutzt nur eigene Pfade und Namen.
- Es gibt **keine Update-Quelle** im Paket. `update_source_url` in der Konfiguration ist leer; ohne eigenen Server und eigenen Signaturschlüssel bleibt der Updater inaktiv.
- Die Abhängigkeitsversionen sind nicht gegen die npm-Registry geprüft, und `baileys` steht auf einem Vorabstand (`7.0.0-rc14`). Prüfe sie vor dem ersten Bau (`docs/SECURITY_TESTS.md`, Abschnitt 1.2).
- Native Module (`better-sqlite3`, `sharp`) müssen auf derselben Architektur gebaut werden, auf der sie laufen (arm64 für den Pi).
