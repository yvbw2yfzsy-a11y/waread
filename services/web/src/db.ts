// Einziger Beruehrungspunkt mit dem Datenbank-Vertrag (waread-src/db/client.ts).
//
// Das DB-Modul wird zur LAUFZEIT per Pfad geladen (dynamic import), nicht beim Kompilieren eingebunden.
// Grund: Der Web-Dienst und das db/-Modul haben getrennte Builds und ggf. unterschiedliche Modulformate
// (ESM/CommonJS) und Abhaengigkeiten (better-sqlite3 wird dort aufgeloest, nicht hier). Ein
// Compile-Zeit-Import brachte beides durcheinander (im Test: CommonJS-Ausgabe unter "type": "module").
//
// Pfadsuche, wenn paths.db_module nicht gesetzt ist (relativ zum Paketordner services/web):
//   ../../db/dist/client.js   ../../db/client.js   ../../dist/db/client.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Db } from './sqlite.js';

/** Vertragssignaturen, strukturell gegen Db getypt (die echte Implementierung nimmt better-sqlite3-Database). */
export interface DbClient {
  openDb(file: string): Db;
  runMigrations(db: Db): void;
  markSeen(db: Db, opts: { chatId: string; all?: boolean; upTo?: string }): string[];
  markPlayed(db: Db, messageId: string): void;
  getSetting(db: Db, key: string): string | null;
  setSetting(db: Db, key: string, value: string): void;
  deleteExpired(
    db: Db,
    cutoff: { messagesBefore: number; mediaBefore: number; includeProtected?: boolean },
  ): { deletedMessageIds: string[]; mediaPathsToDelete: string[] };
  setMessageProtected(db: Db, messageId: string, on: boolean, at?: number): boolean;
  enqueueCommand(db: Db, type: string, payload: unknown): number;
  pushEvent(db: Db, type: string, payload: unknown): void;
  pullEventsSince(db: Db, lastId: number): { id: number; type: string; payload: unknown }[];
}

const REQUIRED: (keyof DbClient)[] = [
  'openDb',
  'runMigrations',
  'markSeen',
  'markPlayed',
  'getSetting',
  'setSetting',
  'deleteExpired',
  'setMessageProtected',
  'enqueueCommand',
  'pushEvent',
  'pullEventsSince',
];

let client: DbClient | null = null;

function candidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, '..'); // services/web (dist/ liegt darin)
  return [
    path.resolve(pkgRoot, '../../db/dist/client.js'),
    path.resolve(pkgRoot, '../../db/client.js'),
    path.resolve(pkgRoot, '../../dist/db/client.js'),
  ];
}

export class DbModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbModuleError';
  }
}

/** Vor allen anderen DB-Aufrufen genau einmal beim Start aufrufen. */
export async function initDbClient(modulePath?: string): Promise<void> {
  const tried = modulePath ? [path.resolve(modulePath)] : candidates();
  const file = tried.find((p) => fs.existsSync(p));
  if (!file) throw new DbModuleError(`DB-Modul nicht gefunden. Gesucht: ${tried.join(', ')} (Konfiguration: paths.db_module)`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch {
    throw new DbModuleError(`DB-Modul konnte nicht geladen werden: ${file}`);
  }
  // CommonJS-Module liefern ihre Exporte teils nur unter "default".
  const def = mod['default'];
  const api: Record<string, unknown> =
    typeof def === 'object' && def !== null ? { ...(def as Record<string, unknown>), ...mod } : mod;
  const missing = REQUIRED.filter((n) => typeof api[n] !== 'function');
  if (missing.length > 0) throw new DbModuleError(`DB-Modul ${file} fehlen Funktionen: ${missing.join(', ')}`);
  client = api as unknown as DbClient;
}

function c(): DbClient {
  if (!client) throw new DbModuleError('DB-Modul nicht initialisiert (initDbClient fehlt)');
  return client;
}

export function openDatabase(file: string): Db {
  const db = c().openDb(file);
  // Der Ingest-Dienst schreibt parallel; kurze Sperren abwarten statt SQLITE_BUSY zu melden.
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export const migrate = (db: Db): void => c().runMigrations(db);
export const markSeen = (db: Db, o: { chatId: string; all?: boolean; upTo?: string }): string[] => c().markSeen(db, o);
export const markPlayed = (db: Db, messageId: string): void => c().markPlayed(db, messageId);
export const getSetting = (db: Db, key: string): string | null => c().getSetting(db, key);
export const setSetting = (db: Db, key: string, value: string): void => c().setSetting(db, key, value);
export const deleteExpired = (
  db: Db,
  cutoff: { messagesBefore: number; mediaBefore: number; includeProtected?: boolean },
): { deletedMessageIds: string[]; mediaPathsToDelete: string[] } => c().deleteExpired(db, cutoff);
export const setMessageProtected = (db: Db, messageId: string, on: boolean, at?: number): boolean =>
  c().setMessageProtected(db, messageId, on, at);
export const enqueueCommand = (db: Db, type: string, payload: unknown): number => c().enqueueCommand(db, type, payload);
export const pushEvent = (db: Db, type: string, payload: unknown): void => c().pushEvent(db, type, payload);
export const pullEventsSince = (db: Db, lastId: number): { id: number; type: string; payload: unknown }[] =>
  c().pullEventsSince(db, lastId);
