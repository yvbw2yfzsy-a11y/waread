// SQL-Zugriffe des Web-Dienstes und Abbildung der Zeilen auf die API-Objekte.
// Alle Werte werden als Parameter gebunden; SQL-Texte entstehen nur aus festen Bausteinen.
//
// Schema (db/schema.sql):
// - messages_fts ist mit messages ueber die Zuordnungstabelle messages_fts_map(fts_rowid, message_id) verknuepft;
//   die Suche joint darueber. messages_fts.rowid ist NICHT messages.rowid.
// - Zeitstempel werden nur verglichen und durchgereicht, nie umgerechnet; die Einheit ist egal.
import fs from 'node:fs';
import path from 'node:path';
import { allRows, getRow, runSql, withTx, type Db } from './sqlite.js';

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'document' | 'system';
export const MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'voice', 'video', 'document', 'system'];

export interface MediaApi {
  status: string;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  hasThumbnail: boolean;
  /** Originaldateiname bei Dokumenten (aus dem gespeicherten Dateinamen, ohne die Nachrichten-ID davor). */
  fileName: string | null;
  /** Warum die Datei fehlt: rule_off, too_large, history, queue_full, retention, failed, link_expired. */
  skipReason: string | null;
  /** true = "Medium jetzt laden" ist moeglich (die Schluessel liegen im Ingest bereit). */
  loadable: boolean;
}

/** Kurzfassung der Nachricht, auf die sich eine Antwort bezieht. */
export interface QuotedApi {
  id: string;
  /** true = die Originalnachricht ist noch gespeichert (Angaben stammen von ihr), sonst vom Kurzzitat der Antwort. */
  available: boolean;
  sender: string | null;
  fromMe: boolean | null;
  type: string | null;
  text: string | null;
  deleted: boolean;
}

export interface MessageApi {
  id: string;
  chatId: string;
  sender: string;
  waTimestamp: number;
  direction: 'in' | 'out';
  type: MessageType;
  text: string | null;
  replyTo: string | null;
  edited: boolean;
  deleted: boolean;
  seenAt: number | null;
  playedAt: number | null;
  media: MediaApi | null;
  /** Einmal-Ansehen-Nachricht (nur Kennzeichnung). */
  viewOnce: boolean;
  /** Schild: Zeitpunkt (Unix-Sekunden), seit dem die Nachricht vor dem Loeschen geschuetzt ist, sonst null. */
  protectedAt: number | null;
  editedAt: number | null;
  deletedAt: number | null;
  /** Zahl frueherer Fassungen (GET /api/messages/:id/versions). */
  editCount: number;
  quoted: QuotedApi | null;
}

interface MsgRow {
  id: string;
  chat_id: string;
  sender: string;
  wa_timestamp: number;
  direction: 'in' | 'out';
  type: MessageType;
  text: string | null;
  reply_to: string | null;
  edited: number;
  deleted: number;
  seen_at: number | null;
  played_at: number | null;
  md_id: string | null;
  md_status: string | null;
  md_mime: string | null;
  md_size: number | null;
  md_duration: number | null;
  md_thumb: string | null;
  md_skip: string | null;
  md_loadable: number | null;
  md_path: string | null;
  view_once: number;
  protected_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  reply_text: string | null;
  reply_sender: string | null;
  reply_type: string | null;
  edit_count: number;
  q_id: string | null;
  q_sender: string | null;
  q_direction: 'in' | 'out' | null;
  q_type: string | null;
  q_text: string | null;
  q_deleted: number | null;
  chat_name?: string | null;
}

const MSG_COLS =
  'm.id AS id, m.chat_id AS chat_id, m.sender AS sender, m.wa_timestamp AS wa_timestamp, ' +
  'm.direction AS direction, m.type AS type, m.text AS text, m.reply_to AS reply_to, m.edited AS edited, ' +
  'm.deleted AS deleted, m.seen_at AS seen_at, m.played_at AS played_at, md.message_id AS md_id, ' +
  'md.status AS md_status, md.mime_type AS md_mime, md.size_bytes AS md_size, ' +
  'md.duration_seconds AS md_duration, md.thumbnail_path AS md_thumb, ' +
  'md.skip_reason AS md_skip, md.loadable AS md_loadable, md.file_path AS md_path, ' +
  'm.view_once AS view_once, m.protected_at AS protected_at, m.edited_at AS edited_at, m.deleted_at AS deleted_at, ' +
  'm.reply_text AS reply_text, m.reply_sender AS reply_sender, m.reply_type AS reply_type, ' +
  '(SELECT COUNT(*) FROM message_versions v WHERE v.message_id = m.id) AS edit_count, ' +
  'q.id AS q_id, q.sender AS q_sender, q.direction AS q_direction, q.type AS q_type, q.text AS q_text, q.deleted AS q_deleted';

/** Zitierte Nachricht: nur im selben Chat (Nachrichten-IDs sind global eindeutig, der Chat-Vergleich ist Vorsicht). */
const QUOTE_JOIN = 'LEFT JOIN messages q ON q.id = m.reply_to AND q.chat_id = m.chat_id';

const num = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null);

/** Wie im Ingest (mediaQueue.ts safeSegment): die Nachrichten-ID als Teil des Dateinamens. */
function safeSegment(input: string, max = 80): string {
  let s = input.replace(/[^A-Za-z0-9._-]/g, '_');
  s = s.replace(/^\.+/, '_');
  if (s.length === 0) s = '_';
  return s.slice(0, max);
}

/**
 * Dokumente liegen als `<Nachrichten-ID>__<Originalname>` auf der Platte (Ingest, mediaQueue.ts paths()).
 * Gibt den Originalnamen zurueck oder null, wenn der Pfad dieser Konvention nicht folgt.
 */
export function documentFileName(messageId: string, filePath: string | null): string | null {
  if (!filePath) return null;
  const base = path.basename(filePath);
  const prefix = `${safeSegment(messageId)}__`;
  return base.startsWith(prefix) && base.length > prefix.length ? base.slice(prefix.length) : null;
}

function clipText(t: string | null, max = 140): string | null {
  if (t === null) return null;
  const chars = [...t.replace(/\s+/g, ' ').trim()];
  if (chars.length === 0) return null;
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function mapQuoted(r: MsgRow, hideDeleted: boolean): QuotedApi | null {
  if (r.reply_to === null) return null;
  if (r.q_id !== null) {
    const hidden = r.q_deleted === 1 && hideDeleted;
    return {
      id: r.reply_to,
      available: true,
      sender: r.q_direction === 'out' ? null : r.q_sender,
      fromMe: r.q_direction === 'out',
      type: r.q_type,
      text: hidden ? null : clipText(r.q_text),
      deleted: r.q_deleted === 1,
    };
  }
  return {
    id: r.reply_to,
    available: false,
    sender: r.reply_sender,
    fromMe: null,
    type: r.reply_type,
    text: r.reply_text,
    deleted: false,
  };
}

export function mapMessage(r: MsgRow, hideDeleted: boolean): MessageApi {
  const deleted = r.deleted === 1;
  const hide = deleted && hideDeleted;
  return {
    id: r.id,
    chatId: r.chat_id,
    sender: r.sender,
    waTimestamp: r.wa_timestamp,
    direction: r.direction,
    type: r.type,
    text: hide ? null : r.text,
    replyTo: r.reply_to,
    edited: r.edited === 1,
    deleted,
    seenAt: num(r.seen_at),
    playedAt: num(r.played_at),
    media:
      r.md_id === null || hide
        ? null
        : {
            status: r.md_status ?? 'pending',
            mimeType: r.md_mime,
            sizeBytes: num(r.md_size),
            durationSeconds: num(r.md_duration),
            hasThumbnail: typeof r.md_thumb === 'string' && r.md_thumb !== '',
            fileName: r.type === 'document' ? documentFileName(r.id, r.md_path) : null,
            skipReason: r.md_skip,
            loadable: r.md_loadable === 1,
          },
    viewOnce: r.view_once === 1,
    protectedAt: num(r.protected_at),
    editedAt: num(r.edited_at),
    deletedAt: num(r.deleted_at),
    editCount: r.edit_count,
    quoted: mapQuoted(r, hideDeleted),
  };
}

// ---------- Chats ----------

export interface ChatApi {
  id: string;
  name: string;
  isGroup: boolean;
  hasAvatar: boolean;
  lastActivityAt: number | null;
  lastMessagePreview: string | null;
  lastMessageType: MessageType;
  lastMessageDirection: 'in' | 'out';
  lastMessageAt: number;
  lastMessageDeleted: boolean;
  /** Laenge der letzten Nachricht in Sekunden, wenn sie eine Sprachnachricht (oder ein Video) ist. */
  lastMessageDurationSeconds: number | null;
  /** Absender der letzten eingehenden Nachricht (fuer die Vorschau in Gruppen), sonst null. */
  lastMessageSender: string | null;
  unreadCount: number;
  /** "Stumm": der Chat zaehlt nicht in "Neu" und Abzeichen (reine Anzeige, gespeichert in settings chat.muted). */
  muted: boolean;
}

interface ChatRow {
  id: string;
  name: string | null;
  is_group: number;
  avatar_path: string | null;
  last_activity_at: number | null;
  lm_text: string | null;
  lm_type: MessageType;
  lm_direction: 'in' | 'out';
  lm_ts: number;
  lm_deleted: number;
  lm_sender: string;
  lm_duration: number | null;
  unread: number;
}

/** Chat-IDs, die stumm geschaltet sind (settings chat.muted, JSON-Liste). Kaputte Werte ergeben eine leere Liste. */
export function mutedChatIds(db: Db): string[] {
  const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'chat.muted'");
  if (!row) return [];
  try {
    const v: unknown = JSON.parse(row.value);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}

/** „Neu" = eingehend, noch nicht lokal gesehen, nicht geloescht, keine Systemmeldung. Rein lokaler Zustand. */
export function listChats(db: Db, hideDeleted: boolean): ChatApi[] {
  const rows = allRows<ChatRow>(
    db,
    `SELECT c.id AS id, c.name AS name, c.is_group AS is_group, c.avatar_path AS avatar_path,
            c.last_activity_at AS last_activity_at,
            lm.text AS lm_text, lm.type AS lm_type, lm.direction AS lm_direction,
            lm.wa_timestamp AS lm_ts, lm.deleted AS lm_deleted, lm.sender AS lm_sender,
            (SELECT md.duration_seconds FROM media md WHERE md.message_id = lm.id) AS lm_duration,
            (SELECT COUNT(*) FROM messages u
              WHERE u.chat_id = c.id AND u.direction = 'in' AND u.seen_at IS NULL
                AND u.deleted = 0 AND u.type <> 'system') AS unread
       FROM chats c
       JOIN messages lm ON lm.id = (
              SELECT l.id FROM messages l WHERE l.chat_id = c.id
              ORDER BY l.wa_timestamp DESC, l.rowid DESC LIMIT 1)
      ORDER BY lm.wa_timestamp DESC, c.id`,
  );
  const muted = new Set(mutedChatIds(db));
  return rows.map((r) => {
    const deleted = r.lm_deleted === 1;
    let preview: string | null = null;
    if (!(deleted && hideDeleted) && typeof r.lm_text === 'string') {
      const t = r.lm_text.replace(/\s+/g, ' ').trim().slice(0, 140);
      preview = t === '' ? null : t;
    }
    return {
      id: r.id,
      name: r.name && r.name !== '' ? r.name : r.id.split('@')[0] || r.id,
      isGroup: r.is_group === 1,
      hasAvatar: typeof r.avatar_path === 'string' && r.avatar_path !== '',
      lastActivityAt: num(r.last_activity_at),
      lastMessagePreview: preview,
      lastMessageType: r.lm_type,
      lastMessageDirection: r.lm_direction,
      lastMessageAt: r.lm_ts,
      lastMessageDeleted: deleted,
      lastMessageDurationSeconds: typeof r.lm_duration === 'number' ? r.lm_duration : null,
      lastMessageSender: r.lm_direction === 'in' && r.lm_sender !== '' ? r.lm_sender : null,
      unreadCount: r.unread,
      muted: muted.has(r.id),
    };
  });
}

export function chatExists(db: Db, chatId: string): boolean {
  return getRow(db, 'SELECT 1 AS x FROM chats WHERE id = ?', chatId) !== undefined;
}

export function getAvatarPath(db: Db, chatId: string): string | null {
  const r = getRow<{ avatar_path: string | null }>(db, 'SELECT avatar_path FROM chats WHERE id = ?', chatId);
  return r && typeof r.avatar_path === 'string' && r.avatar_path !== '' ? r.avatar_path : null;
}

// ---------- Nachrichten ----------

export function listMessages(
  db: Db,
  chatId: string,
  o: { before: number | null; beforeId: string | null; limit: number },
  hideDeleted: boolean,
): MessageApi[] {
  let sql = `SELECT ${MSG_COLS} FROM messages m LEFT JOIN media md ON md.message_id = m.id ${QUOTE_JOIN} WHERE m.chat_id = ?`;
  const params: unknown[] = [chatId];
  if (o.before !== null) {
    if (o.beforeId !== null) {
      // Stabile Seitengrenze auch bei gleichem Zeitstempel (Sekundenaufloesung).
      sql +=
        ' AND (m.wa_timestamp < ? OR (m.wa_timestamp = ? AND m.rowid < (SELECT b.rowid FROM messages b WHERE b.id = ?)))';
      params.push(o.before, o.before, o.beforeId);
    } else {
      sql += ' AND m.wa_timestamp < ?';
      params.push(o.before);
    }
  }
  sql += ' ORDER BY m.wa_timestamp DESC, m.rowid DESC LIMIT ?';
  params.push(o.limit);
  return allRows<MsgRow>(db, sql, ...params)
    .map((r) => mapMessage(r, hideDeleted))
    .reverse(); // aelteste zuerst
}

export function getMessage(db: Db, id: string, hideDeleted: boolean): MessageApi | null {
  const r = getRow<MsgRow>(
    db,
    `SELECT ${MSG_COLS} FROM messages m LEFT JOIN media md ON md.message_id = m.id ${QUOTE_JOIN} WHERE m.id = ?`,
    id,
  );
  return r ? mapMessage(r, hideDeleted) : null;
}

export function messageExists(db: Db, id: string): boolean {
  return getRow(db, 'SELECT 1 AS x FROM messages WHERE id = ?', id) !== undefined;
}

export function getPlayedAt(db: Db, id: string): number | null {
  const r = getRow<{ played_at: number | null }>(db, 'SELECT played_at FROM messages WHERE id = ?', id);
  return r ? num(r.played_at) : null;
}

export interface VersionsApi {
  id: string;
  /** Aktuelle Fassung. */
  current: { text: string | null; editedAt: number | null };
  /** Fruehere Fassungen, aelteste zuerst (version 1 = Original). replacedAt = Zeitpunkt der naechsten Bearbeitung. */
  versions: { version: number; text: string | null; replacedAt: number }[];
}

/** Bearbeitungsverlauf; null, wenn die Nachricht unbekannt ist. */
export function getVersions(db: Db, id: string): VersionsApi | null {
  const m = getRow<{ text: string | null; edited_at: number | null }>(db, 'SELECT text, edited_at FROM messages WHERE id = ?', id);
  if (!m) return null;
  const versions = allRows<{ version: number; text: string | null; replacedAt: number }>(
    db,
    'SELECT version, text, replaced_at AS replacedAt FROM message_versions WHERE message_id = ? ORDER BY version',
    id,
  );
  return { id, current: { text: m.text, editedAt: num(m.edited_at) }, versions };
}

export function isMessageDeleted(db: Db, id: string): boolean {
  return getRow<{ d: number }>(db, 'SELECT deleted AS d FROM messages WHERE id = ?', id)?.d === 1;
}

/** Zustand der Datei fuer "Medium jetzt laden" und das Schild: Existenz, ladbar, geschuetzt. */
export function getLoadState(db: Db, id: string): { exists: boolean; loadable: boolean; protectedAt: number | null } {
  const r = getRow<{ loadable: number | null; protected_at: number | null }>(
    db,
    'SELECT md.loadable AS loadable, m.protected_at AS protected_at FROM messages m LEFT JOIN media md ON md.message_id = m.id WHERE m.id = ?',
    id,
  );
  return r ? { exists: true, loadable: r.loadable === 1, protectedAt: num(r.protected_at) } : { exists: false, loadable: false, protectedAt: null };
}

/** Wartet fuer diese Nachricht schon ein Befehl "load_media"? (Doppeltes Antippen legt keinen zweiten an.) */
export function hasPendingLoad(db: Db, id: string): boolean {
  const rows = allRows<{ p: string }>(db, "SELECT payload_json AS p FROM ingest_commands WHERE type = 'load_media'");
  return rows.some((r) => {
    try {
      return (JSON.parse(r.p) as { messageId?: unknown } | null)?.messageId === id;
    } catch {
      return false;
    }
  });
}

// ---------- Suche ----------

/**
 * Nutzereingabe in eine sichere FTS5-Abfrage umbauen: jedes Wort wird als Phrase in Anfuehrungszeichen
 * gesetzt (Operatoren wie AND/OR/NEAR, Spaltenfilter, Klammern und * verlieren ihre Sonderbedeutung),
 * das letzte Wort wird zusaetzlich zum Praefix. Gibt null zurueck, wenn nichts Suchbares uebrig bleibt.
 */
export function buildFtsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
}

export interface SearchParams {
  fts: string | null;
  chatId: string | null;
  type: MessageType | null;
  from: number | null;
  to: number | null;
  onlyNew: boolean;
  limit: number;
}

export type SearchHit = MessageApi & { chatName: string };

export function searchMessages(db: Db, p: SearchParams, hideDeleted: boolean): SearchHit[] {
  const params: unknown[] = [];
  let sql = `SELECT ${MSG_COLS}, c.name AS chat_name FROM `;
  if (p.fts !== null) {
    // messages_fts.rowid ist NICHT messages.rowid, sondern messages_fts_map.fts_rowid (db/schema.sql).
    sql += 'messages_fts f JOIN messages_fts_map x ON x.fts_rowid = f.rowid JOIN messages m ON m.id = x.message_id ';
  } else {
    sql += 'messages m ';
  }
  sql += `JOIN chats c ON c.id = m.chat_id LEFT JOIN media md ON md.message_id = m.id ${QUOTE_JOIN} WHERE 1 = 1`;
  if (p.fts !== null) {
    sql += ' AND messages_fts MATCH ?';
    params.push(p.fts);
  }
  if (p.chatId !== null) {
    sql += ' AND m.chat_id = ?';
    params.push(p.chatId);
  }
  if (p.type !== null) {
    sql += ' AND m.type = ?';
    params.push(p.type);
  }
  if (p.from !== null) {
    sql += ' AND m.wa_timestamp >= ?';
    params.push(p.from);
  }
  if (p.to !== null) {
    sql += ' AND m.wa_timestamp <= ?';
    params.push(p.to);
  }
  if (p.onlyNew) sql += " AND m.direction = 'in' AND m.seen_at IS NULL AND m.type <> 'system'";
  if (hideDeleted) sql += ' AND m.deleted = 0';
  sql += ' ORDER BY m.wa_timestamp DESC, m.rowid DESC LIMIT ?';
  params.push(p.limit);
  return allRows<MsgRow>(db, sql, ...params).map((r) => ({
    ...mapMessage(r, hideDeleted),
    chatName: r.chat_name && r.chat_name !== '' ? r.chat_name : r.chat_id.split('@')[0] || r.chat_id,
  }));
}

// ---------- Medien ----------

export interface MediaRow {
  type: MessageType;
  deleted: number;
  file_path: string | null;
  thumbnail_path: string | null;
  mime_type: string | null;
  status: string;
}

export function getMediaRow(db: Db, messageId: string): MediaRow | undefined {
  return getRow<MediaRow>(
    db,
    `SELECT m.type AS type, m.deleted AS deleted, md.file_path AS file_path,
            md.thumbnail_path AS thumbnail_path, md.mime_type AS mime_type, md.status AS status
       FROM messages m JOIN media md ON md.message_id = m.id
      WHERE m.id = ?`,
    messageId,
  );
}

// ---------- Speicher ----------

export interface UsageRows {
  /** Geschuetzte Nachrichten (Schild) und die Groesse ihrer fertig geladenen Medien. */
  protectedMessages: number;
  protectedMediaBytes: number;
  perChat: { chatId: string; name: string; messageCount: number; mediaCount: number; mediaBytes: number }[];
  perType: { type: string; mediaCount: number; mediaBytes: number }[];
  mediaBytes: number;
}

export function storageUsage(db: Db): UsageRows {
  const chats = allRows<{ chat_id: string; name: string | null; msgs: number; media_cnt: number; media_bytes: number }>(
    db,
    `SELECT c.id AS chat_id, c.name AS name, COUNT(DISTINCT m.id) AS msgs,
            COUNT(CASE WHEN md.status = 'ready' THEN 1 END) AS media_cnt,
            COALESCE(SUM(CASE WHEN md.status = 'ready' THEN md.size_bytes END), 0) AS media_bytes
       FROM chats c
       JOIN messages m ON m.chat_id = c.id
       LEFT JOIN media md ON md.message_id = m.id
      GROUP BY c.id
      ORDER BY media_bytes DESC, msgs DESC`,
  );
  const types = allRows<{ type: string; cnt: number; bytes: number }>(
    db,
    `SELECT m.type AS type, COUNT(*) AS cnt, COALESCE(SUM(md.size_bytes), 0) AS bytes
       FROM media md JOIN messages m ON m.id = md.message_id
      WHERE md.status = 'ready'
      GROUP BY m.type
      ORDER BY bytes DESC`,
  );
  const prot = getRow<{ n: number; bytes: number }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN md.status = 'ready' THEN md.size_bytes END), 0) AS bytes
       FROM messages m LEFT JOIN media md ON md.message_id = m.id WHERE m.protected_at IS NOT NULL`,
  ) ?? { n: 0, bytes: 0 };
  return {
    protectedMessages: prot.n,
    protectedMediaBytes: prot.bytes,
    perChat: chats.map((r) => ({
      chatId: r.chat_id,
      name: r.name && r.name !== '' ? r.name : r.chat_id.split('@')[0] || r.chat_id,
      messageCount: r.msgs,
      mediaCount: r.media_cnt,
      mediaBytes: r.media_bytes,
    })),
    perType: types.map((r) => ({ type: r.type, mediaCount: r.cnt, mediaBytes: r.bytes })),
    mediaBytes: types.reduce((s, r) => s + r.bytes, 0),
  };
}

/** Summe der Dateigroessen von Datenbank, WAL und SHM (fehlende Dateien zaehlen 0). */
export function dbFileBytes(dbPath: string): number {
  let sum = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      sum += fs.statSync(dbPath + suffix).size;
    } catch {
      /* nicht vorhanden */
    }
  }
  return sum;
}

/**
 * Alle Nachrichten eines Chats samt Medienzeilen und Volltextindex-Eintraegen loeschen.
 * Der Vertrag (db/client.ts) bietet keine Chat-bezogene Loeschfunktion; deshalb hier direkt.
 * Den Volltextindex (messages_fts, messages_fts_map) raeumt der Trigger trg_messages_ad (db/schema.sql)
 * beim Loeschen jeder Nachricht mit auf. Nicht von Hand ueber rowid loeschen: messages_fts.rowid ist
 * nicht messages.rowid, ein solches DELETE wuerde fremde Suchindex-Zeilen treffen.
 */
export function deleteChatData(
  db: Db,
  chatId: string,
  includeProtected = false,
): { deletedMessages: number; mediaPaths: string[]; keptProtected: number } {
  // Geschuetzte Nachrichten (Schild) bleiben, ausser includeProtected ist ausdruecklich true. Feste Textbausteine.
  const unprotected = includeProtected ? '' : ' AND protected_at IS NULL';
  const unprotectedM = includeProtected ? '' : ' AND m.protected_at IS NULL';
  return withTx(db, () => {
    const files = allRows<{ file_path: string | null; thumbnail_path: string | null }>(
      db,
      `SELECT md.file_path AS file_path, md.thumbnail_path AS thumbnail_path
         FROM messages m JOIN media md ON md.message_id = m.id WHERE m.chat_id = ?${unprotectedM}`,
      chatId,
    );
    runSql(db, `DELETE FROM media WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?${unprotected})`, chatId);
    // message_versions geht per ON DELETE CASCADE mit (foreign_keys=ON in openDb).
    const res = runSql(db, `DELETE FROM messages WHERE chat_id = ?${unprotected}`, chatId);
    const kept = includeProtected
      ? 0
      : (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND protected_at IS NOT NULL', chatId)?.n ?? 0);
    const paths: string[] = [];
    for (const f of files) {
      if (f.file_path) paths.push(f.file_path);
      if (f.thumbnail_path) paths.push(f.thumbnail_path);
    }
    return { deletedMessages: Number(res.changes), mediaPaths: paths, keptProtected: kept };
  });
}
