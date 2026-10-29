// Minimale, strukturelle Sicht auf die SQLite-Verbindung (better-sqlite3 erfuellt sie).
// Der Web-Dienst nutzt nur prepare/get/all/run/exec, damit er nicht an eine exakte
// better-sqlite3-Typversion gebunden ist. Es werden ausschliesslich positionale ?-Parameter benutzt.

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): unknown;
  close(): unknown;
}

const caches = new WeakMap<Db, Map<string, Stmt>>();
const MAX_CACHED = 200;

/** Prepared Statements pro Verbindung cachen. SQL-Texte entstehen nur aus festen Bausteinen. */
export function prep(db: Db, sql: string): Stmt {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    if (cache.size >= MAX_CACHED) cache.clear();
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function getRow<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return prep(db, sql).get(...params) as T | undefined;
}

export function allRows<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return prep(db, sql).all(...params) as T[];
}

export function runSql(db: Db, sql: string, ...params: unknown[]): RunResult {
  return prep(db, sql).run(...params);
}

/** Schreibtransaktion. Verschachtelung ist nicht vorgesehen (Vertragsfunktionen duerfen intern Savepoints nutzen). */
export function withTx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Verbindung evtl. schon zurueckgesetzt */
    }
    throw err;
  }
}
