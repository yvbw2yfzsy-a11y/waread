import { existsSync, readFileSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;

interface Migration {
  version: number;
  name: string;
  /** Liefert das SQL dieser Migration (wird erst bei Bedarf gelesen). */
  sql: () => string;
}

/**
 * Suchorte fuer schema.sql:
 *   ./schema.sql   neben migrate.ts bzw. migrate.js
 *   ../schema.sql  wenn migrate.js nach dist/ kompiliert wurde und schema.sql im db/-Ordner liegt
 * Wer db/ in einen anderen Build einbindet, muss schema.sql neben die kompilierte migrate.js kopieren.
 */
function readSchemaSql(): string {
  const candidates = [
    new URL('./schema.sql', import.meta.url),
    new URL('../schema.sql', import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) return readFileSync(url, 'utf8');
  }
  throw new Error(
    `schema.sql nicht gefunden. Gesucht in: ${candidates.map((u) => u.pathname).join(', ')}`,
  );
}

/**
 * Migrationen in aufsteigender, lueckenloser Reihenfolge. Neue Aenderungen werden hier
 * ANGEHAENGT (nie bestehende Eintraege aendern). Version 1 ist das komplette Ausgangsschema.
 */
const SCHEMA_V2_SQL = `
-- Version 2: Schild (Schutz vor automatischem Loeschen), Einmal-Medien, Bearbeitungsverlauf,
-- Zitat-Kurztext, Grund fuer nicht geladene Medien, Befehlswarteschlange Web -> Ingest.
-- Nur ADD COLUMN und neue Tabellen: bestehende Zeilen bleiben unveraendert gueltig.

-- Schild: Unix-Sekunden, wann geschuetzt wurde; NULL = nicht geschuetzt. Geschuetzte Nachrichten und ihre
-- Medien loescht kein automatischer Lauf und kein "Speicher leeren" ohne ausdrueckliche Zusatzfreigabe.
ALTER TABLE messages ADD COLUMN protected_at INTEGER;
-- 1 = Einmal-Ansehen-Nachricht (Foto, Video oder Sprachnachricht); nur zur Kennzeichnung.
ALTER TABLE messages ADD COLUMN view_once INTEGER NOT NULL DEFAULT 0;
-- Zeitpunkt der letzten Bearbeitung und des Loeschens "fuer alle" (Unix-Sekunden).
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
-- Kurzzitat der Nachricht, auf die geantwortet wurde (hoechstens 140 Zeichen), damit das Zitat lesbar bleibt,
-- auch wenn das Original nicht mehr gespeichert ist.
ALTER TABLE messages ADD COLUMN reply_text TEXT;
ALTER TABLE messages ADD COLUMN reply_sender TEXT;
ALTER TABLE messages ADD COLUMN reply_type TEXT;
CREATE INDEX idx_messages_protected ON messages(protected_at) WHERE protected_at IS NOT NULL;

-- Warum eine Mediendatei fehlt, und ob sie sich auf Wunsch noch laden laesst (Schluessel liegen dann im
-- privaten Speicher des Ingest). status bleibt wie in Version 1.
ALTER TABLE media ADD COLUMN skip_reason TEXT
  CHECK (skip_reason IS NULL OR skip_reason IN
    ('rule_off', 'too_large', 'history', 'queue_full', 'retention', 'failed', 'link_expired'));
ALTER TABLE media ADD COLUMN loadable INTEGER NOT NULL DEFAULT 0;

-- Frueherer Text einer bearbeiteten Nachricht. Der aktuelle Text steht weiter in messages.text.
-- version zaehlt ab 1 (1 = Original). replaced_at = Zeitpunkt, an dem diese Fassung ersetzt wurde.
CREATE TABLE message_versions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT,
  replaced_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, version)
);

-- Befehle des Web-Dienstes an den Ingest-Dienst (z. B. "Medium jetzt laden"). Der Ingest holt sie ab und loescht sie.
CREATE TABLE ingest_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initiales Schema', sql: readSchemaSql },
  { version: 2, name: 'Schild, Einmal-Medien, Versionen, Medien-Grund, Befehle', sql: () => SCHEMA_V2_SQL },
];

export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function currentVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Bringt die Datenbank auf LATEST_VERSION. Idempotent und sicher bei gleichzeitigem Start
 * mehrerer Dienste: Pruefung und Anwendung laufen in einer BEGIN-IMMEDIATE-Transaktion, ein
 * zweiter Prozess wartet (busy_timeout) und sieht danach die fertige Version.
 * Schlaegt eine Migration fehl, wird die gesamte Transaktion zurueckgerollt.
 * Eine Datenbank mit hoeherer Version als der Code kennt, wird nicht angefasst (Fehler).
 */
export function runMigrations(db: Database): void {
  if (currentVersion(db) === LATEST_VERSION) return; // schneller Pfad ohne Schreibsperre

  db.transaction(() => {
    const start = currentVersion(db); // innerhalb der Sperre neu lesen
    if (start > LATEST_VERSION) {
      throw new Error(
        `Datenbank hat user_version ${start}, dieser Code kennt nur bis ${LATEST_VERSION} (neuere Programmversion noetig)`,
      );
    }
    for (const m of MIGRATIONS) {
      if (m.version <= start) continue;
      db.exec(m.sql());
      // PRAGMA akzeptiert keine Parameter; m.version ist eine feste Ganzzahl aus dem Code.
      db.pragma(`user_version = ${m.version}`);
    }
  }).immediate();
}
