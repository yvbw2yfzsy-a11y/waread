# waread – Cleanup-Dienst

Setzt die Aufbewahrungsregeln durch. Läuft stündlich per systemd-Timer, einmal pro Woche mit `--vacuum`.
Spricht nie mit WhatsApp und braucht weder Ingest noch Web: nur die SQLite-Datei und den Media-Ordner.

## Aufruf

Gebaut (`npm run build -w waread-cleanup`, Ergebnis `cleanup/dist/cleanup.js`), so startet es auch systemd (`deploy/systemd/waread-cleanup*.service`):

```
node cleanup/dist/cleanup.js                  # stündlicher Lauf
node cleanup/dist/cleanup.js --vacuum         # normaler Lauf, danach VACUUM (wöchentlich)
node cleanup/dist/cleanup.js --dry-run        # nur zählen und melden; ändert nichts, schreibt kein Event
node cleanup/dist/cleanup.js --help
```

| Einstellung | Flag | Umgebungsvariable | dann | Default |
|---|---|---|---|---|
| SQLite-Datei | `--db` | `WAREAD_DB` | `[paths] db` aus der Konfiguration | `/var/lib/waread/db/waread.db` |
| Media-Ordner | `--media-root` | `WAREAD_MEDIA_ROOT` | `[paths] media_dir` aus der Konfiguration | `/var/lib/waread/media` |

Die Konfigurationsdatei ist `$WAREAD_CONFIG` oder `/etc/waread/config.toml`; fehlt sie, gelten die Standardpfade. Gelesen werden nur diese beiden Schlüssel (`smol-toml`). Die Aufbewahrungsfristen kommen aus der Datenbank (`settings`), nicht aus der Konfigurationsdatei; `[retention]` in `config.toml` ist nur ein Rückfall des Ingest. Das Datenbankmodul kommt aus `@waread/db` (`db/`), nicht aus einer eigenen Kopie.

Exit-Codes: `0` ok · `1` Fehler (auch nicht-fatale, etwa nicht löschbare Dateien oder übersprungener Sweep) · `2` falsche Argumente.
Das Skript ist wiederholbar: ein zweiter oder überlappender Lauf (z. B. stündlich + wöchentlich zur selben Minute) löscht nichts doppelt und schadet nicht. Die systemd-Einheiten serialisieren die Läufe zusätzlich mit `flock` auf `/var/lib/waread/tmp/cleanup.lock`.

## Ablauf pro Lauf

1. Einstellungen lesen: `retentionDays` (Default 3), `retentionMediaDays` (Default = `retentionDays`).
   Ungültiger Wert (nicht 1–3650) bricht ab, bevor etwas gelöscht wird.
2. **Nachrichten** mit `wa_timestamp` älter als `retentionDays` löschen, **ausser geschützten** (`messages.protected_at`, das Schild; Version 2), in Stapeln zu 500: erst Medien-Dateien und Thumbnails, dann `media` und `messages` in **einer** Transaktion (`BEGIN IMMEDIATE`). Den Suchindex (`messages_fts`, `messages_fts_map`) räumen die Trigger aus `db/schema.sql` mit auf; der Cleanup löscht keine FTS-Zeilen von Hand.
   Maßgeblich ist der WhatsApp-Zeitstempel, nie `received_at`.
3. **Nur Medien** früher ablaufen lassen, wenn `retentionMediaDays` < `retentionDays`: Datei weg, `media.status = 'expired'`, Pfade `NULL`; Nachricht und FTS-Eintrag bleiben.
   Ist `retentionMediaDays` größer, überlebt das Medium seine Nachricht nicht (Schritt 2 gilt zuerst). Medien geschützter Nachrichten laufen nicht ab; bei den übrigen setzt der Ablauf `loadable = 0` (nichts mehr zu laden).
4. **Orphan-Sweep**: Dateien unter dem Media-Root ohne Verweis aus `media.file_path`, `media.thumbnail_path` oder `chats.avatar_path` löschen, danach leere Ordner.
   Nur was älter als 60 Minuten ist (der Ingest schreibt die Datei vor der DB-Zeile). `avatars/` und Symlinks werden nie angefasst.
5. WAL-Checkpoint (`TRUNCATE`) ab 100 gelöschten Zeilen. Mit `--vacuum`: `VACUUM`, danach erneut Checkpoint.
6. Event `cleanup_done` in `events_outbox` (bei jedem echten Lauf, auch wenn nichts zu löschen war):
   `{ deletedMessages, deletedMedia, orphansRemoved, vacuumed, fileErrors, at }`.
   `deletedMedia` zählt Medien-Einträge, deren Dateien entfernt wurden. Die Feldnamen sind eine Festlegung beim Zusammenführen (der Vertrag nennt nur Typ und „Anzahl“); der Web-Dienst gibt `deletedMessages` und `deletedMedia` per SSE weiter.

## Crash-Sicherheit

Die Reihenfolge „Dateien zuerst, DB danach" macht jeden Abbruchpunkt heilbar, ohne manuelles Eingreifen:

| Zustand nach Abbruch | Was der nächste Lauf tut |
|---|---|
| Dateien gelöscht, DB-Zeilen noch da | Findet dieselben Zeilen wieder, `ENOENT` zählt als „schon weg", DB-Teil wird nachgeholt (`files_already_gone` im Log). |
| Transaktion nicht committet | Rollback durch SQLite; Zeilen und Dateien-Stand wie oben. |
| DB-Zeilen weg, Dateien übrig | Orphan-Sweep löscht sie nach der Schonfrist. |
| Leere Ordner übrig | Sweep entfernt sie nach der Schonfrist. |

## Sicherheitsnetze

- **Media-Root-Prüfung (F09):** Der Lauf bricht vor jedem Löschen ab, wenn die Datenbankdatei unter dem Media-Root liegt oder dort direkt `auth`, `session.key`, `passkeys.json`, `ingest-state.db`, `ingest.lock` oder `config.toml` liegen (typischer Fehler: `media_dir = "/var/lib/waread"`). Sonst würde der Orphan-Sweep Betriebsdaten als „verwaiste Dateien“ löschen. Die Fehlermeldung beginnt mit „Media-Root enthält …“, Exit-Code 1.
- **Journal ohne Pfade (F17):** Warnungen nennen nur den Fehlercode und eine pro Lauf gesalzene Kurzkennung `pfad#xxxxxxxx`, nie Pfad, Dateiname, Chat-Kennung oder Node-Fehlertext. Die Datei selbst benennt das Journal bewusst nicht; `file_errors` zählt sie.
- **Nur unter dem Media-Root löschen.** Pfade außerhalb (absolut oder über einen Symlink-Ordner) werden nicht angefasst und als Fehler gezählt (Exit 1). Die Nachricht wird trotzdem gelöscht: Datenschutz vor Ordnung.
- **Millisekunden-Guard**: liegt ein `wa_timestamp` über 1e11, bricht der Lauf ab (erwartet werden Unix-Sekunden).
- **Notbremse im Sweep**: fehlen ≥ 5 und mehr als die Hälfte der `ready`-Dateien auf der Platte, wird der Sweep übersprungen (Exit 1). Das schützt vor falscher Pfad-Konvention oder nicht eingehängtem Speicher, wo sonst lebende Medien als „verwaist" gälten.
- DB wird nur geöffnet, nie angelegt (`fileMustExist`). Busy-Timeout 15 s, kleine Transaktionen, damit der Ingest nicht blockiert.

## Tests

Im Projektordner:

```
npm test -w waread-cleanup            # node --import tsx --test cleanup.test.ts, 38 Tests, gegen das echte Schema aus db/
npm run typecheck -w waread-cleanup
```

Abgedeckt: Löschung nach WhatsApp-Zeitstempel (Zeile, FTS-Eintrag über die Trigger, Datei, Thumbnail), Einstellungen, kürzere/längere Medienfrist, Stapelgrenzen, relative Pfade, beide Resume-Fälle, Schonfrist, Sweep-Ausnahmen, Pfad-Ausbruch, Notbremse, Millisekunden-Guard, ungültige Einstellungen, Dry-Run, VACUUM nur im Wochenlauf, Pfade aus der Konfigurationsdatei, CLI (Exit-Codes, Start über Symlink, zwei gleichzeitig gestartete Läufe).

**Was die Tests nicht belegen:**
- Sie liefen in der Bauumgebung gegen ein lokales Ersatzpaket `better-sqlite3` (`0.0.0-test-shim`, bildet die benutzte API auf `node:sqlite` ab), weil die npm-Registry gesperrt war. SQLite selbst (FTS5, WAL, VACUUM, Fremdschlüssel) war echt. **Ein Lauf gegen das echte `better-sqlite3` steht noch aus** – `npm test -w waread-cleanup` nach dem ersten `npm install` holt das nach.
- Nicht geprüft: Lauf auf dem Raspberry Pi, Zusammenspiel mit dem echten Ingest, Verhalten bei sehr großen Datenmengen auf dem Pi (früher mit der Hülle: 30 000 Nachrichten / 6 000 Dateien in unter 1 s, ca. 90 MB RSS).

## Annahmen und offene Punkte

| # | Punkt | Stand |
|---|---|---|
| 1 | Verknüpfung Suchindex ↔ Nachricht | *Erledigt:* `messages_fts_map` plus Trigger in `db/schema.sql`; der frühere Ansatz (`messages_fts.rowid = messages.rowid`) ist entfallen. |
| 2 | Alle Zeitstempel (`wa_timestamp`, `events_outbox.created_at`) sind Unix-**Sekunden**. | Projektweit festgelegt. Bei `wa_timestamp` in ms bricht der Guard ab. |
| 3 | `media.file_path` und `thumbnail_path` sind absolut (so schreibt sie der Ingest) oder relativ zum Media-Root. | Anders relativ (z. B. zu `/var/lib/waread`): Notbremse greift. Vorab mit `--dry-run` prüfen (`dangling_ready` muss 0 sein). |
| 4 | **`deleteExpired()` aus `@waread/db` wird nicht benutzt.** Der Cleanup löscht mit eigenem SQL, weil die geforderte Reihenfolge „Dateien zuerst, dann DB“ eine Funktion nicht verträgt, die selbst löscht und nur Pfade zurückgibt. | Alternative: DB zuerst, Dateien danach (auch heilbar durch den Orphan-Sweep, aber nicht die vorgegebene Reihenfolge). Das Web nutzt `deleteExpired` nur für „Speicher leeren“. |
| 5 | Datenbankzugriff über `@waread/db` (`openExistingDb` öffnet nur eine vorhandene Datei, legt nie eine leere an). | *Erledigt* beim Zusammenführen. |
| 6 | Medien mit Status `failed` bleiben unverändert; `pending`/`downloading` werden bei Ablauf `expired`. Zeilen in `chats` werden nie gelöscht. | Anpassen in `expireMediaOnly` bzw. neue Phase. |
| 7 | `retentionDays` akzeptiert jede ganze Zahl 1–3650, nicht nur 1/3/7/14/30. Das Einschränken auf die UI-Werte ist Sache der Web-Schicht. | — |
| 8 | `storageLimitMb` (Speicherlimit) wird vom Cleanup **nicht** durchgesetzt. | Offen: Das Konzept nennt ein Limit (Start 2 GB, älteste Medien zuerst); kein Dienst setzt es um. |

## Hinweise zum Betrieb

- Zwei Timer: `waread-cleanup.timer` (stündlich um :17) startet `waread-cleanup.service`, `waread-cleanup-vacuum.timer` (sonntags gegen 04:30) startet `waread-cleanup-vacuum.service` (`--vacuum`). Details in `deploy/README.md`.
- Ressourcen laut Units: `Nice=15`, `IOSchedulingClass=idle`, `User=waread`, `MemoryMax=256M`; Schreibrecht nur auf `/var/lib/waread` (WAL/SHM und Media-Root liegen dort).
- Pi ohne Echtzeituhr: Dienst nach der Zeitsynchronisation starten, sonst rechnet der Lauf mit falscher Uhr. Die mitgelieferten Units setzen dafür **kein** `After=time-sync.target` (nicht umgesetzt); der Ingest-Dienst und `Persistent=true` der Timer fangen das nicht ab.
- Erwartung an den Ingest: Medien-Ordner direkt vor jedem Schreiben mit `mkdir -p` anlegen. Der Sweep entfernt leere Ordner, die älter als 60 Minuten sind.
- `VACUUM` braucht temporär zusätzlichen Plattenplatz in der Größenordnung der Datenbank.
