# waread – Datenbank-Schicht (`db/`)

SQLite-Schema, Migrationen und Zugriffsmodul (better-sqlite3, WAL, FTS5). Implementiert den
verbindlichen Datenmodell- und Funktionsvertrag; alle Dienste (Ingest, Web, Cleanup) greifen
ausschliesslich über `client.ts` auf die Datenbank zu.

| Datei | Inhalt |
|---|---|
| `schema.sql` | Vollständiges Schema (Version 1) inkl. Indizes und FTS-Trigger |
| `migrate.ts` | `runMigrations()`, `user_version`-basiert, idempotent, sicher bei parallelem Start |
| `client.ts` | Alle Funktionen des Vertrags plus drei benannte Erweiterungen (siehe unten) |
| `client.test.ts` | 24 Tests (`node:test`) |
| `package.json`, `tsconfig*.json` | Eigenständig testbar / baubar |

## Setup

`db/` ist ein npm-Workspace (`@waread/db`) des Projekts; Ingest, Web und Cleanup importieren es von dort. Im Projektordner:

```bash
npm install                    # better-sqlite3 ist ein natives Modul
npm test -w @waread/db         # tsx --test client.test.ts, 24 Tests
npm run typecheck -w @waread/db
npm run build -w @waread/db    # nach db/dist/ (client.js, migrate.js, Typen)
```

- `package.json` nennt `better-sqlite3 ^12.0.0`. Die Version ist **ungeprüft** (beim Erstellen war keine Registry erreichbar). Nach dem ersten `npm install` entsteht `package-lock.json` im Projektordner; einchecken.
- Das Modul ist ESM (`"type": "module"`, Importe mit `.js`-Endung).
- `migrate.ts` liest `schema.sql` zur Laufzeit (neben `migrate.js` oder eine Ebene darüber). Wird `db/` in einen anderen Build kopiert, muss `schema.sql` mitkopieren, sonst bricht `runMigrations` mit einer Meldung ab, die die Suchorte nennt. Das Release enthält `db/schema.sql` ausdrücklich.
- Ob für better-sqlite3 auf dem Raspberry Pi ein vorkompiliertes Binary existiert oder lokal gebaut werden muss (dann Compiler-Werkzeuge nötig), ist **nicht geprüft**.
- `openDb` setzt WAL, `synchronous=NORMAL`, `foreign_keys=ON`, **`secure_delete=ON`** (Vorgabe des Konzepts; beim Zusammenführen ergänzt, weil sie fehlte) und 5 s `busy_timeout`.

## Nutzung

```ts
import { openDb, runMigrations, upsertChat, insertMessageIfNotExists,
         searchMessages, markSeen, deleteExpired } from '@waread/db';

const db = openDb('/var/lib/waread/db/waread.db'); // WAL, foreign_keys=ON, busy_timeout 5 s
runMigrations(db);                                  // jeder Dienst beim Start; parallel unkritisch

upsertChat(db, { id: chatJid, name: 'Familie', isGroup: true, lastActivityAt: ts });
const isNew = insertMessageIfNotExists(db, { /* ... */ }); // false = Duplikat

const hits = searchMessages(db, 'urlaub', { chatId, onlyNew: true });
const seenIds = markSeen(db, { chatId, upTo: lastVisibleMessageId });

// Beispiel für den Vertrag (der Cleanup-Dienst selbst löscht mit eigenem SQL, erst Dateien, dann DB;
// siehe cleanup/README.md, Punkt 4)
const { deletedMessageIds, mediaPathsToDelete } =
  deleteExpired(db, { messagesBefore: cutoff, mediaBefore: cutoff });
```

## Verhalten im Detail

- **Zeiteinheit:** Der Vertrag nennt keine. Das Modul vergleicht nur; alle Zeitstempel und
  Cutoffs müssen in derselben Einheit kommen. Festlegung des Projekts: Unix-**Sekunden** (so liefert Baileys
  `messageTimestamp`). Selbst erzeugte Zeiten (`seen_at`, `played_at`, `created_at`) sind Unix-Sekunden.
- **Reihenfolge:** `upsertChat` vor `insertMessageIfNotExists` (Fremdschlüssel). Fehlt der Chat, wirft die Funktion.
- **Duplikate:** `ON CONFLICT(id) DO NOTHING` statt `INSERT OR IGNORE`. `OR IGNORE` würde
  auch CHECK-/NOT-NULL-Verletzungen (z. B. falscher `type`) still schlucken und als Duplikat melden.
- **Medienzeile:** Für `image`/`voice`/`video`/`document` entsteht beim Einfügen automatisch eine
  `media`-Zeile mit `pending`. `setMediaStatus` ist ein Upsert, setzt nur übergebene Felder und
  wirft, wenn die Nachricht nicht (mehr) existiert (die Datei sollte der Aufrufer dann selbst entfernen).
- **Neu/angehört:** `markSeen` betrifft nur **eingehende** Nachrichten; `upTo` vergleicht nach
  `wa_timestamp` (Nachrichten mit gleichem Zeitstempel werden mitmarkiert). Ohne `all` und `upTo` wirft die Funktion.
  `markPlayed` behält den ersten Zeitpunkt.
- **Suche:** Eingabe wird quotiert (FTS-Operatoren wie `AND`, `-`, `:` werden zu Text), mehrere
  Wörter = UND, das letzte Wort ist Präfix. Umlaute/Akzente und Groß-/Kleinschreibung werden
  ignoriert (`muller` findet `Müller`); **`ß` wird nicht zu `ss` gefaltet** (geprüft). Neueste
  Treffer zuerst, Standard 100, maximal 1000. Leere Anfrage = nur Filter; Anfrage ohne ein
  Wort aus Buchstaben/Ziffern (z. B. nur `*` oder ein Emoji) = leeres Ergebnis.
- **FTS-Spalten:** `text` bei text/voice/system, `caption` bei image/video/document (dort ist
  `messages.text` die Bildunterschrift), `filename` = Basename von `media.file_path`,
  `chat_name` = `chats.name`, `sender_name` = `messages.sender`. Gepflegt per Trigger, also auch
  bei direktem SQL konsistent. `messages_fts_map` entkoppelt die FTS-Rowid von `messages.rowid`
  (Vorsichtsmaßnahme, Begründung in `schema.sql`).
- **`deleteExpired`:** Eine `BEGIN IMMEDIATE`-Transaktion. Nachrichten mit `wa_timestamp <
  messagesBefore` werden samt `media`-Zeile und Indexeintrag gelöscht (der Vertrag hat kein
  `ON DELETE CASCADE`, daher zuerst `media`). Bei verbleibenden Nachrichten mit `wa_timestamp <
  mediaBefore` wird die `media`-Zeile `expired` (Pfade `NULL`, Metadaten bleiben). Alle betroffenen
  Datei- und Thumbnail-Pfade stehen in `mediaPathsToDelete`; Dateien löscht die Funktion nicht.
  Der Cleanup-Dienst muss vor dem Löschen prüfen, dass jeder Pfad unter `/var/lib/waread/media/` liegt.
- **Nebenläufigkeit:** Mehrschrittige Schreibvorgänge nutzen `.immediate()`, damit ein
  Lese-dann-Schreib-Upgrade im WAL-Modus nicht mit `SQLITE_BUSY` scheitert, wenn ein anderer Prozess dazwischen committet.

## Erweiterungen über den Vertrag hinaus

Alle additiv; die Vertragssignaturen sind unverändert.

- `updateMessageText(db, id, text)`: Bearbeitung, setzt `edited=1` (Index folgt per Trigger).
- `markMessageDeleted(db, id)`: setzt `deleted=1`. **Text und Medien bleiben erhalten**; ob die
  Oberfläche sie zeigt, ist eine Produktentscheidung, die hier nicht getroffen wurde.
- `pruneEvents(db, olderThan)`: räumt `events_outbox`. Der Vertrag sagt, der Web-Dienst leere alte
  Zeilen, nennt aber keine Funktion dafür. `ids` werden dank `AUTOINCREMENT` nie wiederverwendet.
- `searchMessages`-Filter `limit` (siehe oben).

## Lücken, die ich bewusst offen lasse

- **Rückgabeform von `searchMessages`:** Im Vertrag nur `any[]`. Geliefert wird `MessageHit[]`
  (camelCase, `media` als verschachteltes Objekt oder `null`, Flags als Booleans), Typ in `client.ts`.
- **Keine Lesefunktionen für Chatliste, Verlaufs-Paging, Neu-Zähler pro Chat oder Medienpfad-Abfrage**
  im Vertrag. Der Web-Dienst hat dafür eigenes SQL (`services/web/src/queries.ts`).
- **`filename`** stammt aus dem Speicherpfad, nicht aus dem Originalnamen eines Dokuments; der ist im Vertrag nicht vorgesehen.
- **`sender_name`** ist `messages.sender`. Ob dort JID oder Anzeigename steht, bestimmt der Ingest.
- **Verwaiste Dateien:** Stürzt ein Löschlauf zwischen DB-Commit und Dateilöschen ab, bleiben Dateien
  ohne DB-Eintrag liegen. Der Cleanup-Dienst löscht deshalb zuerst die Dateien und hat zusätzlich einen Orphan-Sweep.
- **Leere Chats** bleiben nach `deleteExpired` bestehen (nicht Teil des Vertrags).

## Optionaler Trigram-Index (Skizze, nicht Teil der Lieferung)

Das Folgende ist eine eigene Skizze und nicht Teil des Konzepts. Der Standard-Index findet Wortanfänge (Präfix). Für Teilstring-Suche mitten im Wort
(`ller` in `Müller`) wäre ein zweiter FTS5-Index mit dem `trigram`-Tokenizer möglich:

```sql
CREATE VIRTUAL TABLE messages_fts_tri USING fts5(
  text, caption, filename, chat_name, sender_name,
  tokenize = "trigram remove_diacritics 1"
);
INSERT INTO messages_fts_tri(rowid, text, caption, filename, chat_name, sender_name)
  SELECT rowid, text, caption, filename, chat_name, sender_name FROM messages_fts;
```

Mit SQLite 3.53.4 getestet: `ller` findet `Müller`; Suchbegriffe unter 3 Zeichen liefern nichts; ohne
`remove_diacritics 1` findet `ulle` das Wort `Müller` nicht. Nicht geliefert und nicht getestet: die Trigger,
die diesen Index bei Insert/Update/Delete mitpflegen (als Migration 2 in `migrate.ts` nachzuziehen), sowie die
Frage, ob die in better-sqlite3 eingebaute SQLite-Version die Tokenizer-Option `remove_diacritics` kennt.
Der Index kostet zusätzlichen Speicher und Schreibaufwand auf dem Pi.

## Teststatus (ehrlich)

- Die 24 Tests laufen grün, **aber nicht gegen echtes better-sqlite3**: die npm-Registry war in der
  Entwicklungsumgebung gesperrt. Stattdessen lief der Code gegen ein lokales Ersatzpaket `better-sqlite3` (`0.0.0-test-shim`, nur Testwerkzeug, nicht Teil des Projekts), das die
  genutzte better-sqlite3-API auf Node `node:sqlite` abbildet (echtes SQLite 3.53.4 mit FTS5). SQL, Trigger,
  Transaktionslogik und Suche sind damit real geprüft. **Nicht geprüft** sind Eigenheiten der echten
  better-sqlite3-Bibliothek und deren eingebaute SQLite-Version. `npm test` mit der echten Bibliothek ist der erste Schritt nach dem Einbinden.
- Der Typecheck lief gegen die Typen des lokalen Ersatzpakets in der Bauumgebung, nicht gegen die echten `@types/better-sqlite3`.
- Gegenprobe: Jeder der sechs Trigger wurde testweise entfernt; jeweils schlägt mindestens ein Test fehl.
- Nicht getestet: parallele Schreibzugriffe mehrerer Prozesse unter Last, Verhalten auf dem Pi (SD-Karte, Speicher).
