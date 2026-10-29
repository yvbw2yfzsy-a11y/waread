import fs from 'node:fs'
import { openSqlite, type SqliteDb } from './sqlite.js'
import type { AuthLib, AuthStateLike } from './waLib.js'

/**
 * WhatsApp-Sitzungsspeicher in EINER SQLite-Datei (auth/auth.db) statt hunderter JSON-Dateien.
 *
 * Gruende (Quelle: use-multi-file-auth-state.ts in Baileys sagt selbst: "wouldn't endorse this for
 * any production level use ... Would recommend writing an auth state for use with a proper SQL
 * ... DB"; SD-Karte; Konzept "ein eigener SQLite-Speicher statt vieler Einzeldateien").
 *
 * Semantik bewusst identisch zum Referenz-Speicher:
 *   - Serialisierung mit BufferJSON (Buffer <-> {type:'Buffer', data: base64}),
 *   - get() liefert fuer fehlende IDs `null`,
 *   - 'app-state-sync-key' wird beim Lesen per proto.Message.AppStateSyncKeyData.fromObject
 *     wiederhergestellt,
 *   - set() mit Wert null/undefined loescht den Eintrag.
 *
 * Haltbarkeit: synchronous=FULL. Verlorene Schluessel-Updates nach einem Stromausfall wuerden zu
 * Entschluesselungsfehlern fuehren; die Schreiblast (einige Updates pro Nachricht) ist gering.
 */
export interface AuthStore {
  readonly state: AuthStateLike
  /** Aktuelle Zugangsdaten (state.creds, von der Bibliothek mutiert) persistieren. */
  saveCreds(): void
  /** Ist ein Konto gekoppelt? (creds.me.id gesetzt - so unterscheidet Baileys Login von Registrierung.) */
  isPaired(): boolean
  /** Alles loeschen (nach "abgemeldet"), danach liefert `reset()` frische Zugangsdaten. */
  wipe(): void
  /** Nach wipe(): frische Zugangsdaten in `state` einsetzen. */
  reset(): void
  close(): void
}

export function openAuthStore(file: string, lib: AuthLib): AuthStore {
  const db: SqliteDb = openSqlite(file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* umask 077 greift ohnehin */
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS creds (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_keys (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (type, id)
    ) WITHOUT ROWID;
  `)

  const { replacer, reviver } = lib.BufferJSON
  const getCreds = db.prepare('SELECT json FROM creds WHERE id = 1')
  const putCreds = db.prepare(
    'INSERT INTO creds (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  )
  const getKey = db.prepare('SELECT json FROM signal_keys WHERE type = ? AND id = ?')
  const putKey = db.prepare(
    'INSERT INTO signal_keys (type, id, json) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET json = excluded.json',
  )
  const delKey = db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?')

  const loadCreds = (): any => {
    const row = getCreds.get() as { json: string } | undefined
    return row ? JSON.parse(row.json, reviver) : lib.initAuthCreds()
  }

  const writeBatch = db.transaction((data: Record<string, Record<string, unknown>>) => {
    for (const type of Object.keys(data)) {
      const entries = data[type] ?? {}
      for (const id of Object.keys(entries)) {
        const value = entries[id]
        if (value) putKey.run(type, id, JSON.stringify(value, replacer))
        else delKey.run(type, id)
      }
    }
  })

  const state: AuthStateLike = {
    creds: loadCreds(),
    keys: {
      get(type, ids) {
        const out: Record<string, unknown> = {}
        for (const id of ids) {
          const row = getKey.get(type, id) as { json: string } | undefined
          let value: any = row ? JSON.parse(row.json, reviver) : null
          if (type === 'app-state-sync-key' && value) value = lib.reviveAppStateSyncKey(value)
          out[id] = value
        }
        return out
      },
      set(data) {
        writeBatch(data)
      },
      clear() {
        db.exec('DELETE FROM signal_keys')
      },
    },
  }

  return {
    state,
    saveCreds() {
      putCreds.run(JSON.stringify(state.creds, replacer))
    },
    isPaired() {
      return Boolean(state.creds?.me?.id)
    },
    wipe() {
      db.exec('DELETE FROM signal_keys; DELETE FROM creds;')
    },
    reset() {
      state.creds = lib.initAuthCreds()
    },
    close() {
      db.close()
    },
  }
}
