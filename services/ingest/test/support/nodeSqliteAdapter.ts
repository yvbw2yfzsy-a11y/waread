import { DatabaseSync } from 'node:sqlite'
import type { SqliteDb, SqliteDriver, SqliteStatement } from '../../src/sqlite.js'

/**
 * Testadapter: bildet die vom Dienst genutzte Teilmenge von better-sqlite3 auf node:sqlite ab.
 * Nur fuer Tests (better-sqlite3 ist in der Entwicklungsumgebung nicht installierbar).
 *
 * Bekannte Unterschiede, die Tests NICHT abdecken koennen:
 *  - echtes better-sqlite3 (Typumwandlung von Buffer/BigInt, Fehlertexte, Performance)
 *  - transaction() verschachtelt hier ueber Savepoints; better-sqlite3 verhaelt sich gleich.
 */
export function openNodeSqlite(file: string): SqliteDb {
  const raw = new DatabaseSync(file)
  let depth = 0
  let counter = 0

  const db: SqliteDb = {
    prepare(sql: string): SqliteStatement {
      const stmt = raw.prepare(sql)
      return {
        run: (...params) => {
          const r = stmt.run(...(params as any[]))
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
        },
        get: (...params) => stmt.get(...(params as any[])),
        all: (...params) => stmt.all(...(params as any[])),
      }
    },
    exec: (sql) => raw.exec(sql),
    pragma(source) {
      // better-sqlite3 liefert Zeilen; hier genuegt das Ausfuehren (+ Zeilen, falls vorhanden).
      const rows = raw.prepare(`PRAGMA ${source}`).all()
      return rows
    },
    transaction<F extends (...args: any[]) => any>(fn: F): F {
      const wrapped = ((...args: any[]) => {
        const name = `sp_${++counter}`
        const outer = depth === 0
        raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`)
        depth++
        try {
          const result = fn(...args)
          depth--
          raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`)
          return result
        } catch (err) {
          depth--
          if (outer) raw.exec('ROLLBACK')
          else raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
          throw err
        }
      }) as F
      return wrapped
    },
    close: () => raw.close(),
  }
  return db
}

export const nodeSqliteDriver: SqliteDriver = openNodeSqlite
