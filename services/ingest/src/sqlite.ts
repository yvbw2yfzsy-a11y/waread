import { createRequire } from 'node:module'

/**
 * Minimale, strukturelle Teilmenge der better-sqlite3-API, die dieser Dienst nutzt.
 * Ein echtes better-sqlite3-`Database` erfuellt dieses Interface; der gemeinsame Vertrag
 * (db/client.ts) darf daher weiter den better-sqlite3-Typ verwenden.
 *
 * Es werden ausschliesslich positionelle Parameter (`?`) verwendet.
 */
export interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): any
  all(...params: unknown[]): any[]
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  pragma(source: string): unknown
  transaction<F extends (...args: any[]) => any>(fn: F): F
  close(): unknown
}

export type SqliteDriver = (file: string) => SqliteDb

let driver: SqliteDriver | null = null

/** Testnaht: ersetzt better-sqlite3 (z. B. durch einen node:sqlite-Adapter). */
export function setSqliteDriver(d: SqliteDriver | null): void {
  driver = d
}

/**
 * Oeffnet eine SQLite-Datei synchron. Produktiv: better-sqlite3 (per createRequire geladen,
 * damit der Aufruf synchron bleibt und kein Typpaket noetig ist).
 */
export function openSqlite(file: string): SqliteDb {
  if (driver) return driver(file)
  const require = createRequire(import.meta.url)
  const BetterSqlite3 = require('better-sqlite3') as new (file: string) => SqliteDb
  return new BetterSqlite3(file)
}

/** Unix-Zeit in ganzen Sekunden. ALLE Zeitstempel dieses Dienstes sind Unix-Sekunden. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
