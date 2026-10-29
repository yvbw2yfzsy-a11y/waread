# waread

waread ist eine **rein lesende** Web-Oberfläche für die eigenen WhatsApp-Nachrichten, gedacht für einen Raspberry Pi im Heimnetz. Der Pi verbindet sich als „verknüpftes Gerät“ (Node.js, TypeScript, Baileys), speichert Nachrichten und Medien für wenige Tage in SQLite und zeigt sie im Browser an. Das Programm sendet nichts an WhatsApp zurück: keine Nachricht, keine Lesebestätigung, kein bewusst gesetzter Online-Status. Dass das so bleibt, sichert ein automatischer Test im Code. Was die Bibliothek intern selbst sendet, kann nur der Zweitnummer-Test zeigen (`docs/SECURITY_TESTS.md`).

Stand: Version 0.1.0 (Datei `VERSION`). Das Projekt ist in einer Bauumgebung ohne Zugriff auf die npm-Registry, ohne WhatsApp-Konto und ohne Raspberry Pi entstanden. Was dort geprüft wurde und was nicht, steht in `docs/MERGE_NOTES.md`.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `db/` | SQLite-Schema, Migrationen, Zugriffsmodul `@waread/db` |
| `services/ingest/` | WhatsApp-Empfang, Medien-Download, Sende-Wächter |
| `services/web/` | REST-/SSE-Backend (`src/`), Frontend-Quellen (`public/`), Browsertest |
| `cleanup/` | Aufbewahrung durchsetzen, stündlich; wöchentlich mit VACUUM |
| `config/` | `config.example.toml` (alle gelesenen Schlüssel) |
| `deploy/` | `install.sh`, `waread-update`, `make-release.sh`, systemd-Units, Nginx-Ausschnitt |
| `docs/` | Installation, Betrieb, Sicherheitsprüfung, Testliste, Zusammenführungsnotizen |

## Schnellüberblick

Im Projektordner, mit Node.js ≥ 22.12:

```bash
npm install                 # beim ersten Mal; erzeugt package-lock.json (liegt nicht bei)
npm run build               # db, ingest (mit Sende-Wächter), web, frontend, cleanup
npm test                    # alle Testläufe
npm run check:no-send       # nur der Sende-Wächter
```

Installation auf dem Pi, Konfiguration, Kopplung und die Prüfungen vor dem Hauptkonto beschreibt `docs/INSTALL.md`. Reihenfolge, die nicht umgangen werden sollte: bauen und testen, installieren, mit einer **Testnummer** koppeln, Zweitnummer-Test bestehen, erst dann das Hauptkonto.

## Dokumentation

| Datei | Wofür |
| --- | --- |
| `docs/INSTALL.md` | Schritt für Schritt von einem Pi mit Craft bis zum laufenden waread; Annahmen und offene Punkte in Abschnitt 16 |
| `docs/MAINTENANCE.md` | Betrieb: Logs, Speicher, Updates, Verbindungsabbruch, Notfälle |
| `docs/SECURITY_TESTS.md` | Lesebestätigungs-Gate, Zweitnummer-Test, Sicherheits-Baseline |
| `docs/TEST_CHECKLIST.md` | Was die automatisierten Tests belegen müssen; Sabotage-Proben |
| `docs/MERGE_NOTES.md` | Was beim Zusammenführen geprüft, geändert, angenommen wurde; offene Punkte |
| `deploy/README.md` | Release-Vertrag, Installationsskript, Updater, Units, Nginx |
| `services/*/README.md`, `cleanup/README.md`, `db/README.md` | Verhalten und Grenzen je Baustein |

## Wichtige Grenzen

- Das Craft-System auf demselben Pi wird nicht angefasst (`/var/www/craft`, `/var/lib/craft`, `craft-update`, seine Units). `waread` benutzt nur eigene Pfade und Namen.
- Es gibt **keine Update-Quelle** im Paket. `update_source_url` in der Konfiguration ist leer; ohne eigenen Server und eigenen Signaturschlüssel bleibt der Updater inaktiv.
- Die Abhängigkeitsversionen sind nicht gegen die npm-Registry geprüft, und `baileys` steht auf einem Vorabstand (`7.0.0-rc14`). Prüfe sie vor dem ersten Bau (`docs/SECURITY_TESTS.md`, Abschnitt 1.2).
- Native Module (`better-sqlite3`, `sharp`) müssen auf derselben Architektur gebaut werden, auf der sie laufen (arm64 für den Pi).
