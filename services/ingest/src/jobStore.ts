import fs from 'node:fs'
import { nowSec, openSqlite, type SqliteDb } from './sqlite.js'
import type { MediaKind } from './config.js'

/**
 * Privater, persistenter Speicher des Ingest-Dienstes (eigene Datei, NICHT die gemeinsame DB).
 *
 * Warum es ihn braucht: Das gemeinsame Schema hat keinen Platz fuer die Schluessel, die zum
 * Herunterladen/Entschluesseln eines Mediums noetig sind (mediaKey, directPath, ...). Ohne sie
 * kann ein nach einem Absturz haengengebliebener Download nicht erneut gestartet werden.
 * Hier liegen deshalb:
 *   - media_jobs: Warteschlange samt Deskriptor (ueberlebt Neustarts),
 *   - names:      Anzeigenamen mit Rangfolge (damit Namen nach einem Neustart nicht "schlechter" werden),
 *   - lid_map:    Zuordnung LID <-> Telefonnummer.
 *
 * Der Inhalt ist sensibel (mediaKey entschluesselt Medien) -> Datei 0600, nie in Backups
 * (/var/lib/waread gehoert nicht in Sicherungen).
 */

/** Alles, was zum Herunterladen und Entschluesseln eines Mediums noetig ist (Binaerwerte als base64). */
export interface MediaDescriptor {
  /** HKDF-Typ der Bibliothek: image | video | ptv | audio | document | sticker */
  hkdfType: string
  mediaKey: string
  directPath: string | null
  url: string | null
  fileSha256: string | null
  mimetype: string | null
  fileLength: number | null
  fileName: string | null
  seconds: number | null
  ptt: boolean
}

export interface MediaJob {
  messageId: string
  chatId: string
  kind: MediaKind
  descriptor: MediaDescriptor
  waTimestamp: number
  attempts: number
  nextAttemptAt: number
  createdAt: number
  /**
   * true = ausdruecklich angefordert ("Medium jetzt laden"): die Groessen-Regeln der Download-Regel gelten nicht,
   * es gilt nur das feste Hoechstmass (media.forceMaxBytes).
   */
  forced?: boolean
}

export type NewMediaJob = Omit<MediaJob, 'attempts' | 'nextAttemptAt' | 'createdAt'>

/** Rang eines Namens: hoeher gewinnt. */
export const NAME_RANK = { push: 1, chat: 2, contact: 3 } as const

interface JobRow {
  message_id: string
  chat_id: string
  kind: string
  descriptor_json: string
  wa_timestamp: number
  attempts: number
  next_attempt_at: number
  created_at: number
  forced?: number
}

/** Schluessel eines Mediums, das nicht (oder nicht fertig) geladen wurde und auf Wunsch noch geladen werden kann. */
export interface DeferredMedia {
  messageId: string
  chatId: string
  kind: MediaKind
  descriptor: MediaDescriptor
  waTimestamp: number
  createdAt: number
}

export class JobStore {
  constructor(private readonly db: SqliteDb) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_jobs (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        wa_timestamp INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deferred_media (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        wa_timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS names (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rank INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lid_map (
        lid TEXT PRIMARY KEY,
        pn TEXT NOT NULL
      );
    `)
    // Spalte "forced" kam spaeter dazu: bei bestehenden Dateien nachziehen.
    const cols = db.prepare('PRAGMA table_info(media_jobs)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'forced')) {
      db.exec('ALTER TABLE media_jobs ADD COLUMN forced INTEGER NOT NULL DEFAULT 0')
    }
  }

  static open(file: string): JobStore {
    const db = openSqlite(file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* Datei evtl. noch nicht materialisiert; umask 077 greift ohnehin */
    }
    return new JobStore(db)
  }

  close(): void {
    this.db.close()
  }

  // --- Jobs ----------------------------------------------------------------------------------

  upsertJob(job: NewMediaJob, now = nowSec()): void {
    this.db
      .prepare(
        `INSERT INTO media_jobs
           (message_id, chat_id, kind, descriptor_json, wa_timestamp, attempts, next_attempt_at, created_at, forced)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(job.messageId, job.chatId, job.kind, JSON.stringify(job.descriptor), job.waTimestamp, now, job.forced ? 1 : 0)
  }

  // --- Zurueckgestellte Medien ("Medium jetzt laden") -----------------------------------------------

  /** Merkt sich die Schluessel eines nicht geladenen Mediums. Ein vorhandener Eintrag bleibt unveraendert. */
  upsertDeferred(job: NewMediaJob, now = nowSec()): void {
    this.db
      .prepare(
        `INSERT INTO deferred_media (message_id, chat_id, kind, descriptor_json, wa_timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(job.messageId, job.chatId, job.kind, JSON.stringify(job.descriptor), job.waTimestamp, now)
  }

  getDeferred(messageId: string): DeferredMedia | undefined {
    const r = this.db.prepare('SELECT * FROM deferred_media WHERE message_id = ?').get(messageId) as
      | { message_id: string; chat_id: string; kind: string; descriptor_json: string; wa_timestamp: number; created_at: number }
      | undefined
    return r
      ? {
          messageId: r.message_id,
          chatId: r.chat_id,
          kind: r.kind as MediaKind,
          descriptor: JSON.parse(r.descriptor_json) as MediaDescriptor,
          waTimestamp: r.wa_timestamp,
          createdAt: r.created_at,
        }
      : undefined
  }

  deleteDeferred(messageId: string): void {
    this.db.prepare('DELETE FROM deferred_media WHERE message_id = ?').run(messageId)
  }

  /** Nachrichten-ID und Zeitstempel aller zurueckgestellten Medien (fuer das Aufraeumen, ohne Schluessel zu laden). */
  listDeferredIds(): { messageId: string; waTimestamp: number }[] {
    const rows = this.db.prepare('SELECT message_id, wa_timestamp FROM deferred_media').all() as {
      message_id: string
      wa_timestamp: number
    }[]
    return rows.map((r) => ({ messageId: r.message_id, waTimestamp: r.wa_timestamp }))
  }

  countDeferred(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM deferred_media').get() as { n: number }).n
  }

  getJob(messageId: string): MediaJob | undefined {
    const row = this.db.prepare('SELECT * FROM media_jobs WHERE message_id = ?').get(messageId) as JobRow | undefined
    return row ? toJob(row) : undefined
  }

  listJobs(): MediaJob[] {
    const rows = this.db.prepare('SELECT * FROM media_jobs ORDER BY wa_timestamp DESC').all() as JobRow[]
    return rows.map(toJob)
  }

  countJobs(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM media_jobs').get() as { n: number }).n
  }

  recordAttempt(messageId: string, attempts: number, nextAttemptAt: number): void {
    this.db
      .prepare('UPDATE media_jobs SET attempts = ?, next_attempt_at = ? WHERE message_id = ?')
      .run(attempts, nextAttemptAt, messageId)
  }

  deleteJob(messageId: string): void {
    this.db.prepare('DELETE FROM media_jobs WHERE message_id = ?').run(messageId)
  }

  // --- Namen ---------------------------------------------------------------------------------

  /** Speichert einen Namen, wenn sein Rang mindestens dem vorhandenen entspricht. */
  upsertName(jid: string, name: string, rank: number, now = nowSec()): void {
    const trimmed = name.trim()
    if (!trimmed) return
    this.db
      .prepare(
        `INSERT INTO names (jid, name, rank, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name, rank = excluded.rank, updated_at = excluded.updated_at
         WHERE excluded.rank >= names.rank`,
      )
      .run(jid, trimmed, rank, now)
  }

  getName(jid: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM names WHERE jid = ?').get(jid) as { name: string } | undefined
    return row?.name
  }

  /**
   * F14: Entfernt alle gespeicherten Anzeigenamen und die LID<->Nummer-Zuordnung (personenbezogen). Die Medienaufgaben
   * bleiben unberuehrt. Gibt die Anzahl entfernter Zeilen zurueck.
   */
  clearIdentityData(): { names: number; lidMappings: number } {
    const names = this.db.prepare('DELETE FROM names').run().changes
    const lidMappings = this.db.prepare('DELETE FROM lid_map').run().changes
    return { names, lidMappings }
  }

  // --- LID <-> Telefonnummer -----------------------------------------------------------------

  setLidMapping(lid: string, pn: string): void {
    this.db
      .prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn')
      .run(lid, pn)
  }

  pnForLid(lid: string): string | undefined {
    const row = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid) as { pn: string } | undefined
    return row?.pn
  }
}

function toJob(row: JobRow): MediaJob {
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    kind: row.kind as MediaKind,
    descriptor: JSON.parse(row.descriptor_json) as MediaDescriptor,
    waTimestamp: row.wa_timestamp,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    forced: row.forced === 1,
  }
}
