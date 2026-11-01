import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate.js';

export type Database = BetterSqlite3.Database;
export { runMigrations };

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'document' | 'system';
export type Direction = 'in' | 'out';
export type MediaStatus = 'pending' | 'downloading' | 'ready' | 'failed' | 'expired';

/** Nachrichtentypen, die beim Einfuegen eine media-Zeile (status 'pending') bekommen. */
const MEDIA_TYPES: ReadonlySet<MessageType> = new Set(['image', 'voice', 'video', 'document']);

/**
 * Zeiteinheit: Der Vertrag legt sie nicht fest. Dieses Modul rechnet nichts um und vergleicht
 * nur; alle Zeitstempel (wa_timestamp, received_at, last_activity_at, Cutoffs) muessen vom
 * Aufrufer in derselben Einheit geliefert werden. Empfehlung: Unix-Sekunden (so liefert Baileys
 * messageTimestamp). Selbst erzeugte Zeiten (seen_at, played_at, events_outbox.created_at)
 * sind Unix-Sekunden.
 */
const nowSec = (): number => Math.floor(Date.now() / 1000);

function assertInt(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} muss eine ganze Zahl sein (erhalten: ${String(value)})`);
  }
}

// ---------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------

/**
 * Oeffnet die Datenbank mit WAL, synchronous=NORMAL, foreign_keys=ON, secure_delete=ON und 5 s busy_timeout.
 * Fuehrt KEINE Migrationen aus: jeder Dienst ruft danach runMigrations(db) selbst auf.
 * synchronous=NORMAL im WAL-Modus: kein Korruptionsrisiko, bei Stromausfall koennen aber die
 * letzten bestaetigten Transaktionen verloren gehen (hier akzeptiert: Cache mit 3 Tagen Laufzeit).
 */
export function openDb(path: string): Database {
  const db = new BetterSqlite3(path, { timeout: 5000 });
  try {
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (path !== ':memory:' && mode !== 'wal') {
      throw new Error(`WAL-Modus konnte nicht aktiviert werden (journal_mode=${String(mode)})`);
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    // Konzept: geloeschte Inhalte in der Datenbankdatei ueberschreiben (die Aufbewahrungsfrist ist dann echt).
    // Gilt je Verbindung; auf SD-Karte/SSD kann der Datentraeger trotzdem Reste behalten (docs/MAINTENANCE.md).
    db.pragma('secure_delete = ON');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/**
 * Legt einen Chat an oder aktualisiert ihn.
 *  - leerer name ueberschreibt einen vorhandenen Namen nicht
 *  - fehlender avatarPath ueberschreibt einen vorhandenen Pfad nicht
 *  - last_activity_at wird nie kleiner (aeltere Nachrichten aus einem History-Sync
 *    schieben den Chat nicht nach unten)
 * Aendert sich der Name, zieht ein Trigger chat_name im Suchindex nach.
 */
export function upsertChat(
  db: Database,
  chat: { id: string; name: string; isGroup: boolean; avatarPath?: string; lastActivityAt: number },
): void {
  assertInt('lastActivityAt', chat.lastActivityAt);
  db.prepare(
    `INSERT INTO chats (id, name, is_group, avatar_path, last_activity_at)
     VALUES (@id, NULLIF(@name, ''), @isGroup, @avatarPath, @lastActivityAt)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(NULLIF(excluded.name, ''), chats.name),
       is_group = excluded.is_group,
       avatar_path = COALESCE(excluded.avatar_path, chats.avatar_path),
       last_activity_at = MAX(COALESCE(chats.last_activity_at, 0), COALESCE(excluded.last_activity_at, 0))`,
  ).run({
    id: chat.id,
    name: chat.name ?? '',
    isGroup: chat.isGroup ? 1 : 0, // better-sqlite3 bindet keine Booleans
    avatarPath: chat.avatarPath ?? null,
    lastActivityAt: chat.lastActivityAt,
  });
}

/**
 * Setzt den Namen eines BESTEHENDEN Chats (legt nie einen an). true, wenn sich der Name geaendert hat.
 * Leere Namen aendern nichts. Der Trigger trg_chats_au_name zieht chat_name im Suchindex nach.
 * Gebraucht, wenn ein Name erst nach der ersten Nachricht bekannt wird (Kontaktliste, Gruppenname): Ohne diesen Aufruf
 * erschien er erst mit der naechsten Nachricht des Chats.
 */
export function renameChat(db: Database, id: string, name: string): boolean {
  const n = name.trim();
  if (n === '') return false;
  return db.prepare('UPDATE chats SET name = ? WHERE id = ? AND name IS NOT ?').run(n, id, n).changes > 0;
}

/**
 * Fuehrt den Chat `fromId` in den Chat `toId` zusammen: Alle Nachrichten ziehen um, der Quell-Chat verschwindet. Gebraucht,
 * wenn dieselbe Person erst unter ihrer LID und spaeter unter ihrer Telefonnummer auftaucht (zwei Chats statt einem).
 * Gibt es `toId` noch nicht, entsteht er aus den Angaben des Quell-Chats. Ein vorhandener Name, Avatar und die neuere
 * Aktivitaet des Ziels gewinnen. Der Suchindex folgt (chat_name der verschobenen Nachrichten). Mediendateien bleiben, wo sie
 * sind (die media-Zeilen haengen an der Nachricht, nicht am Chat). Alles in einer Transaktion; unbekannter Quell-Chat: nichts.
 */
export function mergeChats(db: Database, fromId: string, toId: string): { moved: number } {
  if (fromId === toId) return { moved: 0 };
  return db
    .transaction((): { moved: number } => {
      const from = db
        .prepare('SELECT name, is_group AS isGroup, avatar_path AS avatarPath, last_activity_at AS lastActivityAt FROM chats WHERE id = ?')
        .get(fromId) as { name: string | null; isGroup: number; avatarPath: string | null; lastActivityAt: number | null } | undefined;
      if (!from) return { moved: 0 };
      db.prepare(
        `INSERT INTO chats (id, name, is_group, avatar_path, last_activity_at) VALUES (@id, @name, @isGroup, @avatarPath, @lastActivityAt)
         ON CONFLICT(id) DO UPDATE SET
           name = COALESCE(NULLIF(chats.name, ''), excluded.name),
           avatar_path = COALESCE(chats.avatar_path, excluded.avatar_path),
           last_activity_at = MAX(COALESCE(chats.last_activity_at, 0), COALESCE(excluded.last_activity_at, 0))`,
      ).run({ id: toId, name: from.name, isGroup: from.isGroup, avatarPath: from.avatarPath, lastActivityAt: from.lastActivityAt });
      const moved = db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(toId, fromId).changes;
      // Der Suchindex fuehrt den Chatnamen je Nachricht; nach dem Umzug muss er der des Ziels sein (auch fuer dessen alte).
      db.prepare(
        `UPDATE messages_fts SET chat_name = (SELECT name FROM chats WHERE id = ?)
         WHERE rowid IN (SELECT fts_rowid FROM messages_fts_map WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?))`,
      ).run(toId, toId);
      db.prepare('DELETE FROM chats WHERE id = ?').run(fromId);
      return { moved };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

export interface NewMessage {
  id: string;
  chatId: string;
  sender: string;
  waTimestamp: number;
  receivedAt: number;
  direction: Direction;
  type: MessageType;
  text?: string;
  replyTo?: string;
  /** Einmal-Ansehen-Nachricht (nur zur Kennzeichnung). */
  viewOnce?: boolean;
  /** Kurzzitat der Nachricht, auf die geantwortet wurde (wird auf 140 Zeichen gekuerzt). */
  replyText?: string;
  replySender?: string;
  /** Typ der zitierten Nachricht (text, image, voice, video, document ...), nur zur Anzeige. */
  replyType?: string;
}

/** Laenge des gespeicherten Kurzzitats in Zeichen (nicht Bytes). */
export const REPLY_TEXT_MAX = 140;

function clip(value: string | undefined, max: number): string | null {
  if (value === undefined || value === '') return null;
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  if (chars.length === 0) return null;
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * Fuegt eine Nachricht ein. true = neu, false = Duplikat (gleiche id; der erste Eintrag bleibt
 * unveraendert). Der Chat muss vorher per upsertChat angelegt sein, sonst wirft die
 * Fremdschluessel-Pruefung.
 *
 * Bewusst ON CONFLICT(id) DO NOTHING statt INSERT OR IGNORE: OR IGNORE wuerde auch
 * CHECK-/NOT-NULL-Verletzungen (z. B. unbekannter type) still verschlucken und als
 * "Duplikat" melden. So wird nur die id-Kollision abgefangen, alles andere wirft.
 *
 * Fuer image/voice/video/document wird zugleich eine media-Zeile mit status 'pending' angelegt.
 * messages_fts wird per Trigger in derselben Transaktion gepflegt.
 */
export function insertMessageIfNotExists(db: Database, msg: NewMessage): boolean {
  assertInt('waTimestamp', msg.waTimestamp);
  assertInt('receivedAt', msg.receivedAt);
  const run = db.transaction((m: NewMessage): boolean => {
    const info = db
      .prepare(
        `INSERT INTO messages
           (id, chat_id, sender, wa_timestamp, received_at, direction, type, text, reply_to,
            view_once, reply_text, reply_sender, reply_type)
         VALUES
           (@id, @chatId, @sender, @waTimestamp, @receivedAt, @direction, @type, @text, @replyTo,
            @viewOnce, @replyText, @replySender, @replyType)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: m.id,
        chatId: m.chatId,
        sender: m.sender,
        waTimestamp: m.waTimestamp,
        receivedAt: m.receivedAt,
        direction: m.direction,
        type: m.type,
        text: m.text ?? null,
        replyTo: m.replyTo ?? null,
        viewOnce: m.viewOnce ? 1 : 0,
        replyText: clip(m.replyText, REPLY_TEXT_MAX),
        replySender: clip(m.replySender, 100),
        replyType: clip(m.replyType, 20),
      });
    if (info.changes === 0) return false;
    if (MEDIA_TYPES.has(m.type)) {
      db.prepare('INSERT INTO media (message_id) VALUES (?)').run(m.id);
    }
    return true;
  });
  return run.immediate(msg);
}

/**
 * Bearbeitung einer Nachricht: legt die bisherige Fassung als Version ab (1 = Original), setzt den neuen
 * Text, edited=1 und edited_at. Der Suchindex folgt per Trigger (er enthaelt nur den aktuellen Text).
 * changed=false, wenn die Nachricht unbekannt ist oder der Text schon so lautet (keine doppelte Version).
 * version = laufende Nummer der abgelegten Fassung (0, wenn nichts abgelegt wurde).
 */
export function applyMessageEdit(
  db: Database,
  messageId: string,
  newText: string,
  editedAt: number = nowSec(),
): { changed: boolean; version: number } {
  assertInt('editedAt', editedAt);
  return db
    .transaction((): { changed: boolean; version: number } => {
      const row = db.prepare('SELECT text FROM messages WHERE id = ?').get(messageId) as
        | { text: string | null }
        | undefined;
      if (!row) return { changed: false, version: 0 };
      if ((row.text ?? '') === newText) return { changed: false, version: 0 };
      const next =
        ((
          db.prepare('SELECT MAX(version) AS v FROM message_versions WHERE message_id = ?').get(messageId) as {
            v: number | null;
          }
        ).v ?? 0) + 1;
      db.prepare(
        'INSERT INTO message_versions (message_id, version, text, replaced_at) VALUES (?, ?, ?, ?)',
      ).run(messageId, next, row.text, editedAt);
      db.prepare('UPDATE messages SET text = ?, edited = 1, edited_at = ? WHERE id = ?').run(
        newText,
        editedAt,
        messageId,
      );
      return { changed: true, version: next };
    })
    .immediate();
}

/** Aelterer Name, bleibt fuer bestehende Aufrufer: Bearbeitung mit der aktuellen Zeit. */
export function updateMessageText(db: Database, messageId: string, text: string): boolean {
  const known = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId) !== undefined;
  if (!known) return false;
  applyMessageEdit(db, messageId, text);
  db.prepare('UPDATE messages SET edited = 1 WHERE id = ?').run(messageId);
  return true;
}

export interface MessageVersion {
  version: number;
  text: string | null;
  replacedAt: number;
}

/** Fruehere Fassungen einer Nachricht, aelteste zuerst. Der aktuelle Text steht in messages.text. */
export function listMessageVersions(db: Database, messageId: string): MessageVersion[] {
  return db
    .prepare(
      'SELECT version, text, replaced_at AS replacedAt FROM message_versions WHERE message_id = ? ORDER BY version',
    )
    .all(messageId) as MessageVersion[];
}

/**
 * "Fuer alle geloescht" markieren (deleted=1, deleted_at). Text und Medien bleiben unveraendert,
 * ob die Oberflaeche sie zeigt, steuert der Web-Dienst (hide_deleted_content).
 * Gibt false zurueck, wenn die Nachricht unbekannt ist. deleted_at bleibt beim ersten Zeitpunkt.
 */
export function markMessageDeleted(db: Database, messageId: string, at: number = nowSec()): boolean {
  assertInt('at', at);
  const info = db
    .prepare('UPDATE messages SET deleted = 1, deleted_at = COALESCE(deleted_at, ?) WHERE id = ?')
    .run(at, messageId);
  return info.changes > 0;
}

/**
 * Schild setzen oder entfernen. Geschuetzte Nachrichten loescht kein automatischer Lauf (deleteExpired,
 * Cleanup-Dienst) und kein "Speicher leeren" ohne ausdrueckliche Freigabe. Gibt false zurueck, wenn die
 * Nachricht unbekannt ist. Ein bestehendes Schild behaelt seinen urspruenglichen Zeitpunkt.
 */
export function setMessageProtected(db: Database, messageId: string, on: boolean, at: number = nowSec()): boolean {
  assertInt('at', at);
  const info = on
    ? db.prepare('UPDATE messages SET protected_at = COALESCE(protected_at, ?) WHERE id = ?').run(at, messageId)
    : db.prepare('UPDATE messages SET protected_at = NULL WHERE id = ?').run(messageId);
  return info.changes > 0;
}

/** Anzahl geschuetzter Nachrichten und Summe ihrer fertig geladenen Mediendateien (Bytes). */
export function countProtected(db: Database): { messages: number; mediaBytes: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN md.status = 'ready' THEN md.size_bytes END), 0) AS bytes
         FROM messages m LEFT JOIN media md ON md.message_id = m.id
        WHERE m.protected_at IS NOT NULL`,
    )
    .get() as { n: number; bytes: number };
  return { messages: r.n, mediaBytes: r.bytes };
}

// ---------------------------------------------------------------------------
// Befehle Web -> Ingest
// ---------------------------------------------------------------------------

export interface IngestCommand {
  id: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

/** Legt einen Befehl fuer den Ingest-Dienst ab (der Web-Dienst spricht nie selbst mit WhatsApp). */
export function enqueueCommand(db: Database, type: string, payload: unknown): number {
  const info = db
    .prepare('INSERT INTO ingest_commands (type, payload_json, created_at) VALUES (?, ?, ?)')
    .run(type, JSON.stringify(payload ?? null), nowSec());
  return Number(info.lastInsertRowid);
}

/** Wartende Befehle, aelteste zuerst (hoechstens `limit`). Ein kaputtes payload_json ergibt payload null. */
export function listCommands(db: Database, limit = 50): IngestCommand[] {
  const rows = db
    .prepare('SELECT id, type, payload_json AS p, created_at AS createdAt FROM ingest_commands ORDER BY id LIMIT ?')
    .all(limit) as { id: number; type: string; p: string; createdAt: number }[];
  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.p);
    } catch {
      /* payload bleibt null */
    }
    return { id: r.id, type: r.type, payload, createdAt: r.createdAt };
  });
}

export function deleteCommand(db: Database, id: number): void {
  db.prepare('DELETE FROM ingest_commands WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Medien
// ---------------------------------------------------------------------------

const MEDIA_COLUMNS = {
  filePath: 'file_path',
  thumbnailPath: 'thumbnail_path',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes',
  durationSeconds: 'duration_seconds',
  status: 'status',
  skipReason: 'skip_reason',
  loadable: 'loadable',
} as const;

/** Grund, warum eine Mediendatei fehlt (Spalte media.skip_reason). */
export type SkipReason = 'rule_off' | 'too_large' | 'history' | 'queue_full' | 'retention' | 'failed' | 'link_expired';

/**
 * Setzt die uebergebenen Felder der media-Zeile; fehlt die Zeile, wird sie angelegt
 * (Upsert). Nicht uebergebene Felder bleiben unveraendert. Wirft, wenn die Nachricht nicht
 * existiert (z. B. inzwischen vom Cleanup geloescht) – der Aufrufer sollte dann eine
 * bereits geschriebene Datei selbst wieder entfernen, sonst bleibt sie verwaist.
 * filePath aendern aktualisiert per Trigger auch den Dateinamen im Suchindex.
 */
export function setMediaStatus(
  db: Database,
  messageId: string,
  patch: Partial<{
    filePath: string;
    thumbnailPath: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
    status: MediaStatus;
    /** null loescht den Grund (z. B. wenn die Datei doch geladen wurde). */
    skipReason: SkipReason | null;
    /** true = Schluessel liegen im Ingest bereit, "Medium jetzt laden" ist moeglich. */
    loadable: boolean;
  }>,
): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of entries) {
    const col = (MEDIA_COLUMNS as Record<string, string>)[key];
    if (col === undefined) throw new TypeError(`setMediaStatus: unbekanntes Feld '${key}'`);
    cols.push(col);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); // better-sqlite3 bindet keine Booleans
  }

  db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId);
    if (!exists) throw new Error(`setMediaStatus: Nachricht '${messageId}' existiert nicht`);
    if (cols.length === 0) {
      db.prepare('INSERT INTO media (message_id) VALUES (?) ON CONFLICT(message_id) DO NOTHING').run(
        messageId,
      );
      return;
    }
    // Spaltennamen stammen aus der festen Whitelist MEDIA_COLUMNS, nie aus Eingaben.
    db.prepare(
      `INSERT INTO media (message_id, ${cols.join(', ')})
       VALUES (?, ${cols.map(() => '?').join(', ')})
       ON CONFLICT(message_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    ).run(messageId, ...values);
  }).immediate();
}

// ---------------------------------------------------------------------------
// "Neu" / "angehoert" (rein lokal, keinerlei Rueckwirkung auf WhatsApp)
// ---------------------------------------------------------------------------

/**
 * Markiert eingehende, noch ungesehene Nachrichten eines Chats als gesehen und gibt deren ids
 * (nach wa_timestamp sortiert) zurueck. Ausgehende Nachrichten zaehlen nie als "neu".
 *  - all: alle ungesehenen des Chats
 *  - upTo: alle ungesehenen bis einschliesslich der Nachricht mit dieser id (nach wa_timestamp;
 *    Nachrichten mit identischem Zeitstempel werden mitmarkiert). Unbekannte id => [].
 * all hat Vorrang vor upTo. Ohne all und upTo wirft die Funktion (Fehlaufruf nicht still schlucken).
 */
export function markSeen(
  db: Database,
  opts: { chatId: string; all?: boolean; upTo?: string },
): string[] {
  if (!opts.all && !opts.upTo) {
    throw new TypeError('markSeen: entweder all oder upTo angeben');
  }
  return db
    .transaction((): string[] => {
      let limitTs: number | null = null;
      if (!opts.all) {
        const ref = db
          .prepare('SELECT wa_timestamp AS ts FROM messages WHERE id = ? AND chat_id = ?')
          .get(opts.upTo, opts.chatId) as { ts: number } | undefined;
        if (!ref) return [];
        limitTs = ref.ts;
      }
      const where = `chat_id = @chatId AND direction = 'in' AND seen_at IS NULL
                     AND (@limitTs IS NULL OR wa_timestamp <= @limitTs)`;
      const params = { chatId: opts.chatId, limitTs };
      const ids = db
        .prepare(`SELECT id FROM messages WHERE ${where} ORDER BY wa_timestamp, id`)
        .pluck()
        .all(params) as string[];
      if (ids.length > 0) {
        db.prepare(`UPDATE messages SET seen_at = @now WHERE ${where}`).run({
          ...params,
          now: nowSec(),
        });
      }
      return ids;
    })
    .immediate();
}

/** Setzt played_at beim ersten Abspielen; spaetere Aufrufe lassen den ersten Zeitpunkt stehen. */
export function markPlayed(db: Database, messageId: string): void {
  db.prepare('UPDATE messages SET played_at = ? WHERE id = ? AND played_at IS NULL').run(
    nowSec(),
    messageId,
  );
}

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

export interface SearchFilters {
  chatId?: string;
  type?: string;
  /** wa_timestamp >= from */
  from?: number;
  /** wa_timestamp <= to */
  to?: number;
  /** nur eingehende, ungesehene Nachrichten */
  onlyNew?: boolean;
  /** ERWEITERUNG: Maximalzahl Treffer, Standard 100, hoechstens 1000 */
  limit?: number;
}

/** Rueckgabeform von searchMessages (im Vertrag nur als any[] angegeben). */
export interface MessageHit {
  id: string;
  chatId: string;
  chatName: string | null;
  isGroup: boolean;
  sender: string;
  waTimestamp: number;
  receivedAt: number;
  direction: Direction;
  type: MessageType;
  text: string | null;
  replyTo: string | null;
  edited: boolean;
  deleted: boolean;
  seenAt: number | null;
  playedAt: number | null;
  /** null, wenn zur Nachricht keine media-Zeile existiert (z. B. reine Textnachricht) */
  media: null | {
    status: MediaStatus;
    filePath: string | null;
    thumbnailPath: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    durationSeconds: number | null;
  };
}

/**
 * Macht aus Nutzereingabe eine sichere FTS5-Abfrage: jedes Wort wird als Phrase in
 * Anfuehrungszeichen gesetzt (FTS-Operatoren wie AND, NEAR, -, : werden so zu normalem Text),
 * das letzte Wort zusaetzlich als Praefix ("urlau"* findet "Urlaub"). Mehrere Woerter = UND.
 * null, wenn kein einziges Wort Buchstaben oder Ziffern enthaelt.
 */
function toFtsMatch(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

interface HitRow {
  id: string;
  chatId: string;
  chatName: string | null;
  isGroup: number;
  sender: string;
  waTimestamp: number;
  receivedAt: number;
  direction: Direction;
  type: MessageType;
  text: string | null;
  replyTo: string | null;
  edited: number;
  deleted: number;
  seenAt: number | null;
  playedAt: number | null;
  mediaStatus: MediaStatus | null;
  mediaFilePath: string | null;
  mediaThumbnailPath: string | null;
  mediaMimeType: string | null;
  mediaSizeBytes: number | null;
  mediaDurationSeconds: number | null;
}

/**
 * Volltextsuche ueber text, caption, filename, chat_name und sender_name (FTS5, unicode61,
 * Umlaute/Akzente werden ignoriert: "muller" findet "Müller"; "ß" wird NICHT zu "ss" gefaltet).
 * Ergebnis: neueste zuerst (wa_timestamp absteigend).
 *  - leere/blanke query: kein Textfilter, nur die Filter (z. B. Chatverlauf oder alle "Neu")
 *  - nicht-leere query ohne ein einziges Wort aus Buchstaben/Ziffern (z. B. nur "*" oder ein
 *    Emoji): leeres Ergebnis, nie "alles"
 */
export function searchMessages(
  db: Database,
  query: string,
  filters: SearchFilters = {},
): MessageHit[] {
  const where: string[] = [];
  const params: unknown[] = [];

  const trimmed = (query ?? '').trim();
  if (trimmed !== '') {
    const match = toFtsMatch(trimmed);
    if (match === null) return [];
    where.push(
      `m.id IN (SELECT x.message_id FROM messages_fts_map x
                WHERE x.fts_rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))`,
    );
    params.push(match);
  }
  if (filters.chatId !== undefined) {
    where.push('m.chat_id = ?');
    params.push(filters.chatId);
  }
  if (filters.type !== undefined) {
    where.push('m.type = ?');
    params.push(filters.type);
  }
  if (filters.from !== undefined) {
    assertInt('from', filters.from);
    where.push('m.wa_timestamp >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    assertInt('to', filters.to);
    where.push('m.wa_timestamp <= ?');
    params.push(filters.to);
  }
  if (filters.onlyNew) {
    where.push("m.direction = 'in' AND m.seen_at IS NULL");
  }
  const limit = Math.min(Math.max(1, Math.trunc(filters.limit ?? 100)), 1000);

  const rows = db
    .prepare(
      `SELECT m.id AS id, m.chat_id AS chatId, c.name AS chatName, c.is_group AS isGroup,
              m.sender AS sender, m.wa_timestamp AS waTimestamp, m.received_at AS receivedAt,
              m.direction AS direction, m.type AS type, m.text AS text, m.reply_to AS replyTo,
              m.edited AS edited, m.deleted AS deleted, m.seen_at AS seenAt, m.played_at AS playedAt,
              md.status AS mediaStatus, md.file_path AS mediaFilePath,
              md.thumbnail_path AS mediaThumbnailPath, md.mime_type AS mediaMimeType,
              md.size_bytes AS mediaSizeBytes, md.duration_seconds AS mediaDurationSeconds
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       LEFT JOIN media md ON md.message_id = m.id
       ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.wa_timestamp DESC, m.id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as HitRow[];

  return rows.map(
    (r): MessageHit => ({
      id: r.id,
      chatId: r.chatId,
      chatName: r.chatName,
      isGroup: r.isGroup === 1,
      sender: r.sender,
      waTimestamp: r.waTimestamp,
      receivedAt: r.receivedAt,
      direction: r.direction,
      type: r.type,
      text: r.text,
      replyTo: r.replyTo,
      edited: r.edited === 1,
      deleted: r.deleted === 1,
      seenAt: r.seenAt,
      playedAt: r.playedAt,
      media:
        r.mediaStatus === null
          ? null
          : {
              status: r.mediaStatus,
              filePath: r.mediaFilePath,
              thumbnailPath: r.mediaThumbnailPath,
              mimeType: r.mediaMimeType,
              sizeBytes: r.mediaSizeBytes,
              durationSeconds: r.mediaDurationSeconds,
            },
    }),
  );
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// Aufbewahrung
// ---------------------------------------------------------------------------

/**
 * Entfernt abgelaufene Daten in EINER Transaktion und gibt zurueck, was auf der Platte noch
 * zu loeschen ist. Dateien loescht diese Funktion NICHT.
 *  - Nachrichten mit wa_timestamp < messagesBefore werden samt media-Zeile und Suchindex-Eintrag
 *    geloescht; ihre Datei- und Thumbnail-Pfade stehen in mediaPathsToDelete.
 *  - Bei verbleibenden Nachrichten mit wa_timestamp < mediaBefore bleibt die Nachricht
 *    bestehen, die media-Zeile bekommt status 'expired' und file_path/thumbnail_path NULL
 *    (mime_type, size_bytes, duration_seconds bleiben); die bisherigen Pfade stehen ebenfalls
 *    in mediaPathsToDelete.
 *  - Geschuetzte Nachrichten (protected_at) bleiben samt Medien unberuehrt, ausser includeProtected ist
 *    genau true. Das ist die ausdrueckliche Ausnahme von der kurzen Aufbewahrung.
 * Pfade werden so zurueckgegeben, wie sie gespeichert sind. Der Cleanup-Dienst muss vor dem
 * Loeschen pruefen, dass jeder Pfad unter dem Medienverzeichnis liegt.
 * Zeiteinheit der Cutoffs = Einheit von wa_timestamp (siehe nowSec-Kommentar).
 */
export function deleteExpired(
  db: Database,
  cutoff: { messagesBefore: number; mediaBefore: number; includeProtected?: boolean },
): { deletedMessageIds: string[]; mediaPathsToDelete: string[] } {
  assertInt('messagesBefore', cutoff.messagesBefore);
  assertInt('mediaBefore', cutoff.mediaBefore);
  // Geschuetzte Nachrichten (Schild) bleiben stehen, ausser der Aufrufer gibt sie ausdruecklich frei
  // (nur "Speicher leeren (auch geschuetzte)"). Die Bausteine sind feste Texte, nie Eingaben.
  const withProtected = cutoff.includeProtected === true;
  const unprotected = withProtected ? '' : ' AND protected_at IS NULL';
  const unprotectedM = withProtected ? '' : ' AND m.protected_at IS NULL';
  const named = { messagesBefore: cutoff.messagesBefore, mediaBefore: cutoff.mediaBefore };

  return db
    .transaction(() => {
      const paths = new Set<string>();
      const collect = (rows: { filePath: string | null; thumbnailPath: string | null }[]): void => {
        for (const r of rows) {
          if (r.filePath) paths.add(r.filePath);
          if (r.thumbnailPath) paths.add(r.thumbnailPath);
        }
      };
      type PathRow = { filePath: string | null; thumbnailPath: string | null };

      // 1) Nachrichten, die komplett verschwinden
      const deletedMessageIds = db
        .prepare(`SELECT id FROM messages WHERE wa_timestamp < ?${unprotected} ORDER BY wa_timestamp, id`)
        .pluck()
        .all(cutoff.messagesBefore) as string[];
      collect(
        db
          .prepare(
            `SELECT file_path AS filePath, thumbnail_path AS thumbnailPath FROM media
             WHERE message_id IN (SELECT id FROM messages WHERE wa_timestamp < ?${unprotected})`,
          )
          .all(cutoff.messagesBefore) as PathRow[],
      );
      // media hat laut Vertrag keinen ON DELETE CASCADE: erst media, dann messages.
      // message_versions geht per ON DELETE CASCADE mit (foreign_keys=ON in openDb).
      db.prepare(
        `DELETE FROM media WHERE message_id IN (SELECT id FROM messages WHERE wa_timestamp < ?${unprotected})`,
      ).run(cutoff.messagesBefore);
      db.prepare(`DELETE FROM messages WHERE wa_timestamp < ?${unprotected}`).run(cutoff.messagesBefore);

      // 2) Medien verbleibender Nachrichten, die frueher ablaufen als die Nachricht
      const expiring = `message_id IN (
          SELECT m.id FROM messages m
          WHERE m.wa_timestamp >= @messagesBefore AND m.wa_timestamp < @mediaBefore${unprotectedM})
        AND status <> 'expired'`;
      collect(
        db
          .prepare(
            `SELECT file_path AS filePath, thumbnail_path AS thumbnailPath FROM media WHERE ${expiring}`,
          )
          .all(named) as PathRow[],
      );
      // loadable=0: nach Ablauf der Medien-Aufbewahrung gibt der Ingest die Schluessel frei (siehe Ingest).
      db.prepare(
        `UPDATE media SET status = 'expired', file_path = NULL, thumbnail_path = NULL, loadable = 0,
                skip_reason = COALESCE(skip_reason, 'retention')
          WHERE ${expiring}`,
      ).run(named);

      return { deletedMessageIds, mediaPathsToDelete: [...paths] };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// Events (Cross-Prozess-Benachrichtigung fuer Server-Sent Events)
// ---------------------------------------------------------------------------

export function pushEvent(db: Database, type: string, payload: unknown): void {
  db.prepare('INSERT INTO events_outbox (type, payload_json, created_at) VALUES (?, ?, ?)').run(
    type,
    JSON.stringify(payload ?? null),
    nowSec(),
  );
}

/**
 * Events mit id > lastId, aufsteigend, hoechstens 1000 pro Aufruf. Ein nicht lesbares
 * payload_json liefert payload null, statt den Polling-Lauf des Web-Dienstes zu blockieren.
 */
export function pullEventsSince(
  db: Database,
  lastId: number,
): { id: number; type: string; payload: unknown }[] {
  const rows = db
    .prepare(
      'SELECT id, type, payload_json AS payloadJson FROM events_outbox WHERE id > ? ORDER BY id LIMIT 1000',
    )
    .all(lastId) as { id: number; type: string; payloadJson: string }[];
  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payloadJson);
    } catch {
      /* payload bleibt null */
    }
    return { id: r.id, type: r.type, payload };
  });
}

/**
 * ERWEITERUNG ueber den Vertrag hinaus: loescht Events mit created_at < olderThan (Unix-
 * Sekunden) und gibt die Anzahl zurueck. Der Vertrag sagt, der Web-Dienst "leert alte Zeilen
 * periodisch", nennt dafuer aber keine Funktion. ids werden dank AUTOINCREMENT nie wiederverwendet.
 */
export function pruneEvents(db: Database, olderThan: number): number {
  assertInt('olderThan', olderThan);
  return db.prepare('DELETE FROM events_outbox WHERE created_at < ?').run(olderThan).changes;
}
