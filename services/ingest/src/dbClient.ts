/**
 * Duenne Schicht ueber dem gemeinsamen Datenbankmodul (waread-src/db/client.ts, Workspace-Paket
 * `@waread/db`). Alle Module des Ingest-Dienstes importieren die Datenbank AUSSCHLIESSLICH von hier.
 *
 * Fruehere Fassung: eine eigene Zwischenimplementierung des Vertrags, weil db/client.ts bei der
 * Entwicklung dieses Dienstes nicht vorlag. Sie ist beim Zusammenfuehren durch Re-Exporte des echten
 * Moduls ersetzt worden (Schema, Trigger fuer den Suchindex und Migrationen kommen jetzt aus db/).
 *
 * Alle Zeitstempel: Unix-SEKUNDEN.
 *
 * Statische Importe sind hier Absicht: Der automatische Code-Scan (test/no-send-calls.test.ts) verbietet
 * dynamische Importe ausserhalb von waLib.ts.
 */
import type { Database, MediaStatus } from '@waread/db'

export {
  applyMessageEdit,
  deleteCommand,
  getSetting,
  insertMessageIfNotExists,
  listCommands,
  markMessageDeleted,
  mergeChats,
  openDb,
  pushEvent,
  renameChat,
  runMigrations,
  setMediaStatus,
  setSetting,
  upsertChat,
  type Database,
  type MediaStatus,
  type MessageType,
  type SkipReason,
} from '@waread/db'

// ---------------------------------------------------------------------------------------------
// Ingest-spezifische Zusatzabfragen (NICHT Teil des Vertrags; reines SQL gegen die Vertragstabellen)
// ---------------------------------------------------------------------------------------------

/** Stellt sicher, dass eine media-Zeile existiert. Wirft (Fremdschluessel), wenn die Nachricht fehlt. */
export function ensureMediaRow(db: Database, messageId: string): void {
  db.prepare('INSERT OR IGNORE INTO media (message_id) VALUES (?)').run(messageId)
}

/** Nachrichten-IDs aller Medien-Zeilen mit einem der Status (Neustart-Wiederherstellung). */
export function listMediaIdsByStatus(db: Database, statuses: MediaStatus[]): string[] {
  const marks = statuses.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT message_id FROM media WHERE status IN (${marks})`).all(...statuses) as {
    message_id: string
  }[]
  return rows.map((r) => r.message_id)
}

/** Existiert die Nachricht noch? (Der Cleanup-Dienst kann sie waehrend eines Downloads geloescht haben.) */
export function messageExists(db: Database, messageId: string): boolean {
  return db.prepare('SELECT 1 AS x FROM messages WHERE id = ?').get(messageId) !== undefined
}

/** Ist die Nachricht mit dem Schild geschuetzt? false auch, wenn sie nicht (mehr) existiert. */
export function isMessageProtected(db: Database, messageId: string): boolean {
  const r = db.prepare('SELECT protected_at AS p FROM messages WHERE id = ?').get(messageId) as
    | { p: number | null }
    | undefined
  return r?.p !== null && r?.p !== undefined
}

/** Medien-Zeilen, die "Medium jetzt laden" anbieten (loadable=1): Nachrichten-IDs. */
export function listLoadableMediaIds(db: Database): string[] {
  const rows = db.prepare('SELECT message_id FROM media WHERE loadable = 1').all() as { message_id: string }[]
  return rows.map((r) => r.message_id)
}
