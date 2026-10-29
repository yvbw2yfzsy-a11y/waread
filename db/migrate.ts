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
const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initiales Schema', sql: readSchemaSql },
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
