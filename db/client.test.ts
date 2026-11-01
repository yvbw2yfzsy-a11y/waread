import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  runMigrations,
  upsertChat,
  renameChat,
  mergeChats,
  insertMessageIfNotExists,
  markMessageDeleted,
  applyMessageEdit,
  setMessageProtected,
  enqueueCommand,
  listCommands,
  deleteCommand,
  setMediaStatus,
  markSeen,
  markPlayed,
  getSetting,
  setSetting,
  deleteExpired,
  pushEvent,
  pullEventsSince,
  type Database,
  type NewMessage,
} from './client.js';
import { LATEST_VERSION } from './migrate.js';

// --- Hilfsfunktionen --------------------------------------------------------

function freshDb(): Database {
  const db = openDb(':memory:');
  runMigrations(db);
  upsertChat(db, { id: 'c1', name: 'Familie', isGroup: true, lastActivityAt: 1 });
  return db;
}

let seq = 0;
/** Nachrichten mit streng aufsteigendem wa_timestamp, standardmaessig in Chat c1. */
function msg(over: Partial<NewMessage> = {}): NewMessage {
  seq++;
  return {
    id: `m${seq}`,
    chatId: 'c1',
    sender: '4915100000001@s.whatsapp.net',
    waTimestamp: 1_000_000 + seq,
    receivedAt: 1_000_100 + seq,
    direction: 'in',
    type: 'text',
    text: 'hallo',
    ...over,
  };
}

function scalar(db: Database, sql: string, ...params: unknown[]): unknown {
  return db.prepare(sql).pluck().get(...params);
}

/**
 * Treffer einer FTS-Abfrage im Suchindex (nur ids, neueste zuerst). Die Abfrage wird wie im Web-Dienst gebaut
 * (queries.ts buildFtsQuery): jedes Wort als Phrase, das letzte zusaetzlich als Praefix. Die Suche selbst gehoert dem
 * Web-Dienst; hier dient sie nur dazu, den Index und seine Trigger zu pruefen.
 */
function ftsIds(db: Database, input: string): string[] {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return [];
  const match = tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' ');
  return db
    .prepare(
      `SELECT m.id FROM messages_fts f
         JOIN messages_fts_map x ON x.fts_rowid = f.rowid
         JOIN messages m ON m.id = x.message_id
        WHERE messages_fts MATCH ?
        ORDER BY m.wa_timestamp DESC, m.id DESC`,
    )
    .pluck()
    .all(match) as string[];
}

/** Eingehende, noch nicht gesehene Nachrichten ("neu"), neueste zuerst. */
function unseenIds(db: Database): string[] {
  return db
    .prepare("SELECT id FROM messages WHERE direction = 'in' AND seen_at IS NULL ORDER BY wa_timestamp DESC, id DESC")
    .pluck()
    .all() as string[];
}

/** Die media-Zeile einer Nachricht in der Form, in der die Tests sie vergleichen. */
function mediaOf(db: Database, messageId: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT status, file_path AS filePath, thumbnail_path AS thumbnailPath, mime_type AS mimeType,
              size_bytes AS sizeBytes, duration_seconds AS durationSeconds
         FROM media WHERE message_id = ?`,
    )
    .get(messageId) as Record<string, unknown> | undefined;
}

/** Fruehere Fassungen einer bearbeiteten Nachricht, aelteste zuerst. */
function versionsOf(db: Database, messageId: string): unknown[] {
  return db
    .prepare('SELECT version, text, replaced_at AS replacedAt FROM message_versions WHERE message_id = ? ORDER BY version')
    .all(messageId);
}

/** FTS-Index, Zuordnungstabelle und messages muessen gleich gross und intern konsistent sein. */
function assertFtsConsistent(db: Database): void {
  const n = scalar(db, 'SELECT count(*) FROM messages');
  assert.equal(scalar(db, 'SELECT count(*) FROM messages_fts'), n, 'messages_fts vs messages');
  assert.equal(scalar(db, 'SELECT count(*) FROM messages_fts_map'), n, 'messages_fts_map vs messages');
  // wirft bei Inkonsistenz zwischen Index und Inhalt
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
}

// --- Tests ------------------------------------------------------------------

describe('Migrationen und Verbindung', () => {
  it('legt alle Vertragstabellen an und ist mehrfach ausfuehrbar', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").pluck().all() as string[]
    ).sort();
    for (const t of ['chats', 'messages', 'media', 'messages_fts', 'settings', 'events_outbox', 'message_versions', 'ingest_commands']) {
      assert.ok(names.includes(t), `Tabelle ${t} fehlt`);
    }
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('secure_delete', { simple: true }), 1);
  });

  it('WAL-Modus und gleichzeitiger Start zweier Verbindungen auf derselben Datei', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waread-db-'));
    try {
      const path = join(dir, 'waread.db');
      const a = openDb(path);
      const b = openDb(path);
      runMigrations(a);
      runMigrations(b);
      runMigrations(a);
      assert.equal(a.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(b.pragma('user_version', { simple: true }), LATEST_VERSION);
      upsertChat(a, { id: 'x', name: 'X', isGroup: false, lastActivityAt: 5 });
      assert.equal(scalar(b, 'SELECT count(*) FROM chats'), 1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lehnt eine Datenbank mit neuerer user_version ab', () => {
    const db = openDb(':memory:');
    db.pragma('user_version = 99');
    assert.throws(() => runMigrations(db), /user_version 99/);
  });
});

describe('Chats', () => {
  it('upsert: leerer Name/fehlender Avatar ueberschreiben nichts, last_activity_at wird nie kleiner', () => {
    const db = freshDb();
    upsertChat(db, { id: 'c2', name: 'Anna', isGroup: false, avatarPath: '/a.jpg', lastActivityAt: 100 });
    upsertChat(db, { id: 'c2', name: '', isGroup: false, lastActivityAt: 50 });
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get('c2') as Record<string, unknown>;
    assert.equal(row.name, 'Anna');
    assert.equal(row.avatar_path, '/a.jpg');
    assert.equal(row.last_activity_at, 100);
    assert.equal(row.is_group, 0);
    upsertChat(db, { id: 'c2', name: 'Anna B.', isGroup: false, lastActivityAt: 200 });
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c2'), 'Anna B.');
    assert.equal(scalar(db, 'SELECT last_activity_at FROM chats WHERE id = ?', 'c2'), 200);
  });

  it('Umbenennen zieht chat_name im Suchindex nach', () => {
    const db = freshDb();
    const m = msg({ text: 'irgendwas' });
    insertMessageIfNotExists(db, m);
    assert.deepEqual(ftsIds(db, 'familie'), [m.id]);
    upsertChat(db, { id: 'c1', name: 'Arbeit', isGroup: true, lastActivityAt: 2 });
    assert.deepEqual(ftsIds(db, 'familie'), []);
    assert.deepEqual(ftsIds(db, 'arbeit'), [m.id]);
    assertFtsConsistent(db);
  });

  it('renameChat: benennt nur bestehende Chats um, meldet Aenderungen, ignoriert leere und gleiche Namen', () => {
    const db = freshDb();
    const m = msg({ text: 'irgendwas' });
    insertMessageIfNotExists(db, m);
    assert.equal(renameChat(db, 'c1', 'Arbeit'), true);
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c1'), 'Arbeit');
    assert.equal(renameChat(db, 'c1', 'Arbeit'), false, 'gleicher Name: keine Aenderung');
    assert.equal(renameChat(db, 'c1', '   '), false, 'leerer Name aendert nichts');
    assert.equal(renameChat(db, 'c1', ''), false);
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c1'), 'Arbeit');
    assert.equal(renameChat(db, 'gibt-es-nicht', 'Name'), false);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats WHERE id = ?', 'gibt-es-nicht'), 0, 'legt nie einen Chat an');
    assert.equal(renameChat(db, 'c1', '  Beruf  '), true);
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c1'), 'Beruf', 'Leerraum am Rand entfaellt');
    assert.deepEqual(ftsIds(db, 'arbeit'), []);
    assert.deepEqual(ftsIds(db, 'beruf'), [m.id], 'der Suchindex folgt (Trigger)');
    assertFtsConsistent(db);
  });

  it('renameChat: ein Chat ohne Namen (NULL) bekommt einen', () => {
    const db = freshDb();
    upsertChat(db, { id: 'c9', name: '', isGroup: false, lastActivityAt: 5 });
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c9'), null);
    assert.equal(renameChat(db, 'c9', 'Neu'), true);
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'c9'), 'Neu');
  });
});

describe('Chats zusammenfuehren (dieselbe Person als LID und als Nummer)', () => {
  function two(): Database {
    const db = openDb(':memory:');
    runMigrations(db);
    upsertChat(db, { id: 'lid1@lid', name: 'Anna (LID)', isGroup: false, avatarPath: 'avatars/lid.jpg', lastActivityAt: 100 });
    upsertChat(db, { id: 'pn1@s.whatsapp.net', name: 'Anna', isGroup: false, lastActivityAt: 200 });
    for (const [i, chat] of [[1, 'lid1@lid'], [2, 'lid1@lid'], [3, 'pn1@s.whatsapp.net']] as const) {
      insertMessageIfNotExists(db, { id: `m${i}`, chatId: chat, sender: 'Anna', waTimestamp: 100 + i, receivedAt: 100 + i, direction: 'in', type: 'text', text: `wort${i}` });
    }
    return db;
  }

  it('alle Nachrichten ziehen um, der Quell-Chat verschwindet, der Name des Ziels gewinnt', () => {
    const db = two();
    assert.deepEqual(mergeChats(db, 'lid1@lid', 'pn1@s.whatsapp.net'), { moved: 2 });
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats'), 1);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM messages WHERE chat_id = ?', 'pn1@s.whatsapp.net'), 3);
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'pn1@s.whatsapp.net'), 'Anna');
    assert.equal(scalar(db, 'SELECT avatar_path FROM chats WHERE id = ?', 'pn1@s.whatsapp.net'), 'avatars/lid.jpg', 'fehlender Avatar kommt vom Quell-Chat');
    assert.equal(scalar(db, 'SELECT last_activity_at FROM chats WHERE id = ?', 'pn1@s.whatsapp.net'), 200, 'die neuere Aktivitaet gewinnt');
    assertFtsConsistent(db);
  });

  it('der Suchindex zeigt danach bei allen Nachrichten den Namen des Ziels', () => {
    const db = two();
    mergeChats(db, 'lid1@lid', 'pn1@s.whatsapp.net');
    assert.deepEqual(ftsIds(db, 'wort1'), ['m1']);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM messages_fts WHERE chat_name = 'Anna'"), 3);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM messages_fts WHERE chat_name = 'Anna (LID)'"), 0);
  });

  it('gibt es das Ziel noch nicht, entsteht es aus dem Quell-Chat', () => {
    const db = two();
    mergeChats(db, 'lid1@lid', 'neu@s.whatsapp.net');
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get('neu@s.whatsapp.net') as Record<string, unknown>;
    assert.equal(row.name, 'Anna (LID)');
    assert.equal(row.last_activity_at, 100);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM messages WHERE chat_id = ?', 'neu@s.whatsapp.net'), 2);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats WHERE id = ?', 'lid1@lid'), 0);
    assertFtsConsistent(db);
  });

  it('ein Ziel ohne Namen uebernimmt den des Quell-Chats', () => {
    const db = two();
    db.prepare('UPDATE chats SET name = NULL WHERE id = ?').run('pn1@s.whatsapp.net');
    mergeChats(db, 'lid1@lid', 'pn1@s.whatsapp.net');
    assert.equal(scalar(db, 'SELECT name FROM chats WHERE id = ?', 'pn1@s.whatsapp.net'), 'Anna (LID)');
    assertFtsConsistent(db);
  });

  it('unbekannter Quell-Chat und gleiche IDs aendern nichts', () => {
    const db = two();
    assert.deepEqual(mergeChats(db, 'gibt-es-nicht', 'pn1@s.whatsapp.net'), { moved: 0 });
    assert.deepEqual(mergeChats(db, 'pn1@s.whatsapp.net', 'pn1@s.whatsapp.net'), { moved: 0 });
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats'), 2);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM messages'), 3);
  });

  it('Medien-Zeilen haengen an der Nachricht und bleiben unberuehrt; der Quell-Chat ohne Nachrichten wird ebenfalls entfernt', () => {
    const db = two();
    insertMessageIfNotExists(db, { id: 'mi', chatId: 'lid1@lid', sender: 'Anna', waTimestamp: 150, receivedAt: 150, direction: 'in', type: 'image', text: 'Bild' });
    setMediaStatus(db, 'mi', { filePath: '/media/lid1/x.jpg', mimeType: 'image/jpeg', sizeBytes: 5, status: 'ready' });
    upsertChat(db, { id: 'leer@lid', name: 'Leer', isGroup: false, lastActivityAt: 1 });
    mergeChats(db, 'lid1@lid', 'pn1@s.whatsapp.net');
    assert.equal(scalar(db, 'SELECT file_path FROM media WHERE message_id = ?', 'mi'), '/media/lid1/x.jpg');
    assert.deepEqual(mergeChats(db, 'leer@lid', 'pn1@s.whatsapp.net'), { moved: 0 });
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats WHERE id = ?', 'leer@lid'), 0);
    assertFtsConsistent(db);
  });

  it('bei einem Fehler bleibt alles wie vorher (eine Transaktion)', () => {
    const db = two();
    db.exec('DROP TABLE messages_fts_map');
    assert.throws(() => mergeChats(db, 'lid1@lid', 'pn1@s.whatsapp.net'));
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM chats'), 2);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM messages WHERE chat_id = ?', 'lid1@lid'), 2);
  });
});

describe('Einfuegen und Duplikate', () => {
  it('true beim ersten Mal, false beim Duplikat; erster Eintrag bleibt unveraendert', () => {
    const db = freshDb();
    const m = msg({ text: 'original' });
    assert.equal(insertMessageIfNotExists(db, m), true);
    assert.equal(insertMessageIfNotExists(db, { ...m, text: 'zweiter Versuch' }), false);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages'), 1);
    assert.equal(scalar(db, 'SELECT text FROM messages WHERE id = ?', m.id), 'original');
    assertFtsConsistent(db);
  });

  it('F18/C4: dieselbe ID in einem ZWEITEN Chat ist ein Duplikat: die erste Nachricht bleibt in ihrem Chat, nichts wird ueberschrieben', () => {
    // Die ID ist im Schema global eindeutig (messages.id PRIMARY KEY). Eine Kollision zwischen Chats geht damit auf
    // Kosten der zweiten Nachricht. Das ist eine bekannte Grenze, kein Zufall; dieser Test haelt das Verhalten fest.
    const db = freshDb();
    upsertChat(db, { id: 'c2', name: 'Anderer Chat', isGroup: false, lastActivityAt: 1 });
    const first = msg({ type: 'image', text: 'erste' });
    assert.equal(insertMessageIfNotExists(db, first), true);
    assert.equal(insertMessageIfNotExists(db, { ...first, chatId: 'c2', text: 'zweite' }), false);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages'), 1);
    assert.equal(scalar(db, 'SELECT chat_id FROM messages WHERE id = ?', first.id), 'c1');
    assert.equal(scalar(db, 'SELECT text FROM messages WHERE id = ?', first.id), 'erste');
    assert.equal(scalar(db, 'SELECT count(*) FROM media WHERE message_id = ?', first.id), 1, 'keine zweite media-Zeile');
    assertFtsConsistent(db);
  });

  it('legt nur fuer Medientypen eine media-Zeile mit status pending an', () => {
    const db = freshDb();
    const t = msg();
    const i = msg({ type: 'image', text: 'Bild' });
    const s = msg({ type: 'system', text: 'Gruppe erstellt' });
    for (const m of [t, i, s]) insertMessageIfNotExists(db, m);
    assert.equal(scalar(db, 'SELECT count(*) FROM media WHERE message_id = ?', t.id), 0);
    assert.equal(scalar(db, 'SELECT status FROM media WHERE message_id = ?', i.id), 'pending');
    assert.equal(scalar(db, 'SELECT count(*) FROM media WHERE message_id = ?', s.id), 0);
  });

  it('meldet Constraint-Verletzungen als Fehler, nicht als Duplikat', () => {
    const db = freshDb();
    assert.throws(
      () => insertMessageIfNotExists(db, msg({ type: 'sticker' as unknown as NewMessage['type'] })),
      /CHECK constraint/i,
    );
    assert.throws(() => insertMessageIfNotExists(db, msg({ chatId: 'gibt-es-nicht' })), /FOREIGN KEY/i);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages'), 0);
    assertFtsConsistent(db);
  });

  it('Bearbeiten und Loeschen-Markierung (Erweiterungen) pflegen Flags und Index', () => {
    const db = freshDb();
    const m = msg({ text: 'altertext' });
    insertMessageIfNotExists(db, m);
    assert.equal(applyMessageEdit(db, m.id, 'neuertext').changed, true);
    assert.deepEqual(ftsIds(db, 'altertext'), []);
    assert.deepEqual(ftsIds(db, 'neuertext'), [m.id]);
    const flags = (): unknown => db.prepare('SELECT edited, deleted FROM messages WHERE id = ?').get(m.id);
    assert.deepEqual(flags(), { edited: 1, deleted: 0 });
    assert.equal(markMessageDeleted(db, m.id), true);
    assert.deepEqual(flags(), { edited: 1, deleted: 1 });
    assert.deepEqual(ftsIds(db, 'neuertext'), [m.id], 'Text bleibt im Index, auch wenn die Nachricht als geloescht markiert ist');
    assert.equal(applyMessageEdit(db, 'unbekannt', 'x').changed, false);
    assert.equal(markMessageDeleted(db, 'unbekannt'), false);
    assertFtsConsistent(db);
  });
});

describe('Medien', () => {
  it('setMediaStatus: Teil-Updates, Upsert, Fehler bei unbekannter Nachricht/unbekanntem Feld', () => {
    const db = freshDb();
    const m = msg({ type: 'voice', text: undefined });
    insertMessageIfNotExists(db, m);
    setMediaStatus(db, m.id, { status: 'downloading' });
    setMediaStatus(db, m.id, { status: 'ready', filePath: '/m/a.ogg', mimeType: 'audio/ogg', sizeBytes: 321, durationSeconds: 4.5 });
    setMediaStatus(db, m.id, { thumbnailPath: '/m/a.png' });
    assert.deepEqual(mediaOf(db, m.id), {
      status: 'ready',
      filePath: '/m/a.ogg',
      thumbnailPath: '/m/a.png',
      mimeType: 'audio/ogg',
      sizeBytes: 321,
      durationSeconds: 4.5,
    });
    // Upsert: Textnachricht hat anfangs keine media-Zeile
    const t = msg();
    insertMessageIfNotExists(db, t);
    setMediaStatus(db, t.id, { status: 'failed' });
    assert.equal(scalar(db, 'SELECT status FROM media WHERE message_id = ?', t.id), 'failed');
    // Upsert mit Dateipfad legt die media-Zeile an und traegt den Dateinamen in den Index ein
    const t2 = msg({ text: 'Notiz' });
    insertMessageIfNotExists(db, t2);
    setMediaStatus(db, t2.id, { filePath: '/m/c1/z/Zeugnis_2026.pdf' });
    assert.deepEqual(ftsIds(db, 'zeugnis'), [t2.id]);
    assert.throws(() => setMediaStatus(db, 'unbekannt', { status: 'ready' }), /existiert nicht/);
    assert.throws(
      () => setMediaStatus(db, m.id, { status: 'kaputt' as 'ready' }),
      /CHECK constraint/i,
    );
    assert.throws(
      () => setMediaStatus(db, m.id, { evil: 'x' } as never),
      TypeError,
    );
  });
});

describe('Suchindex (FTS-Trigger)', () => {
  it('findet Text; Umlaute, Gross-/Kleinschreibung und Praefix (letztes Wort) werden toleriert', () => {
    const db = freshDb();
    const a = msg({ text: 'Urlaubsplanung bei Familie Müller' });
    const b = msg({ text: 'Einkaufsliste für morgen' });
    insertMessageIfNotExists(db, a);
    insertMessageIfNotExists(db, b);
    assert.deepEqual(ftsIds(db, 'müller'), [a.id]);
    assert.deepEqual(ftsIds(db, 'MULLER'), [a.id]);
    assert.deepEqual(ftsIds(db, 'urlaubsp'), [a.id]);
    assert.deepEqual(ftsIds(db, 'urlaubsplanung muller'), [a.id]); // UND
    assert.deepEqual(ftsIds(db, 'urlaubsplanung einkaufsliste'), []);
    assert.deepEqual(ftsIds(db, 'fur'), [b.id]); // "für" ohne Umlaut
  });

  it('durchsucht caption, filename (nur Basename), chat_name und sender_name', () => {
    const db = freshDb();
    const img = msg({ type: 'image', text: 'Sonnenuntergang', sender: '4915112345678@s.whatsapp.net' });
    insertMessageIfNotExists(db, img);
    setMediaStatus(db, img.id, {
      status: 'ready',
      filePath: '/var/lib/waread/media/c1/2026-10-28/Rechnung_Strom.pdf',
    });
    // Spaltenbelegung: Bildunterschrift steht in caption, nicht in text
    assert.equal(scalar(db, "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'caption : sonnenuntergang'"), 1);
    assert.equal(scalar(db, "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'text : sonnenuntergang'"), 0);
    assert.deepEqual(ftsIds(db, 'sonnenuntergang'), [img.id]);
    assert.deepEqual(ftsIds(db, 'rechnung'), [img.id]);
    assert.deepEqual(ftsIds(db, 'waread'), []); // Verzeichnisname gehoert nicht in den Index
    assert.deepEqual(ftsIds(db, 'familie'), [img.id]); // chat_name
    assert.deepEqual(ftsIds(db, '4915112345678'), [img.id]); // sender_name
    assertFtsConsistent(db);
  });
});

describe('Neu und angehoert', () => {
  it('markSeen: all/upTo liefern ids, sind idempotent und ignorieren ausgehende Nachrichten', () => {
    const db = freshDb();
    const m1 = msg();
    const m2 = msg();
    const m3 = msg();
    const out = msg({ direction: 'out' });
    for (const m of [m1, m2, m3, out]) insertMessageIfNotExists(db, m);

    assert.deepEqual(markSeen(db, { chatId: 'c1', upTo: m2.id }), [m1.id, m2.id]);
    assert.deepEqual(markSeen(db, { chatId: 'c1', upTo: m2.id }), []);
    assert.deepEqual(unseenIds(db), [m3.id]);
    assert.deepEqual(markSeen(db, { chatId: 'c1', all: true }), [m3.id]);
    assert.deepEqual(unseenIds(db), []);
    assert.equal(scalar(db, 'SELECT seen_at FROM messages WHERE id = ?', out.id), null);
    assert.notEqual(scalar(db, 'SELECT seen_at FROM messages WHERE id = ?', m1.id), null);
    assert.deepEqual(markSeen(db, { chatId: 'c1', upTo: 'gibt-es-nicht' }), []);
    assert.throws(() => markSeen(db, { chatId: 'c1' }), TypeError);
  });

  it('markSeen wirkt nur im angegebenen Chat', () => {
    const db = freshDb();
    upsertChat(db, { id: 'c2', name: 'Anna', isGroup: false, lastActivityAt: 1 });
    const a = msg();
    const b = msg({ chatId: 'c2' });
    insertMessageIfNotExists(db, a);
    insertMessageIfNotExists(db, b);
    assert.deepEqual(markSeen(db, { chatId: 'c1', all: true }), [a.id]);
    assert.deepEqual(unseenIds(db), [b.id]);
    assert.deepEqual(markSeen(db, { chatId: 'c1', upTo: b.id }), []); // b liegt in c2
  });

  it('markPlayed setzt played_at nur beim ersten Mal', () => {
    const db = freshDb();
    const v = msg({ type: 'voice', text: undefined });
    insertMessageIfNotExists(db, v);
    assert.equal(scalar(db, 'SELECT played_at FROM messages WHERE id = ?', v.id), null);
    markPlayed(db, v.id);
    const first = scalar(db, 'SELECT played_at FROM messages WHERE id = ?', v.id);
    assert.equal(typeof first, 'number');
    db.prepare('UPDATE messages SET played_at = 5 WHERE id = ?').run(v.id);
    markPlayed(db, v.id);
    assert.equal(scalar(db, 'SELECT played_at FROM messages WHERE id = ?', v.id), 5);
  });
});

describe('Aufbewahrung (deleteExpired)', () => {
  it('loescht abgelaufene Nachrichten samt Medien und Indexeintrag, markiert alte Medien als expired', () => {
    const db = freshDb();
    const old1 = msg({ type: 'image', text: 'Altes Foto', waTimestamp: 100 });
    const old2 = msg({ text: 'Alter Text', waTimestamp: 200 });
    const mid = msg({ type: 'voice', text: undefined, waTimestamp: 5000 });
    const fresh = msg({ text: 'frischer Text', waTimestamp: 9000 });
    for (const m of [old1, old2, mid, fresh]) assert.equal(insertMessageIfNotExists(db, m), true);
    setMediaStatus(db, old1.id, { status: 'ready', filePath: '/m/c1/a/old.jpg', thumbnailPath: '/m/c1/a/old_t.jpg' });
    setMediaStatus(db, mid.id, { status: 'ready', filePath: '/m/c1/b/mid.ogg', mimeType: 'audio/ogg', durationSeconds: 12.5 });

    const res = deleteExpired(db, { messagesBefore: 1000, mediaBefore: 6000 });

    assert.deepEqual(res.deletedMessageIds, [old1.id, old2.id]);
    assert.deepEqual([...res.mediaPathsToDelete].sort(), ['/m/c1/a/old.jpg', '/m/c1/a/old_t.jpg', '/m/c1/b/mid.ogg']);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages'), 2);
    assert.equal(scalar(db, 'SELECT count(*) FROM media'), 1);

    const media = mediaOf(db, mid.id);
    assert.equal(media?.status, 'expired');
    assert.equal(media?.filePath, null);
    assert.equal(media?.thumbnailPath, null);
    assert.equal(media?.mimeType, 'audio/ogg'); // Metadaten bleiben
    assert.equal(media?.durationSeconds, 12.5);

    assert.deepEqual(ftsIds(db, 'frischer'), [fresh.id]);
    assert.deepEqual(ftsIds(db, 'altes'), []);
    assert.deepEqual(ftsIds(db, 'alter'), []);
    assertFtsConsistent(db);

    // zweiter Lauf: nichts mehr zu tun
    assert.deepEqual(deleteExpired(db, { messagesBefore: 1000, mediaBefore: 6000 }), {
      deletedMessageIds: [],
      mediaPathsToDelete: [],
    });
  });

  it('Dateiname verschwindet aus dem Index, wenn das Medium ablaeuft', () => {
    const db = freshDb();
    const m = msg({ type: 'document', text: 'Dokument', waTimestamp: 500 });
    insertMessageIfNotExists(db, m);
    setMediaStatus(db, m.id, { status: 'ready', filePath: '/m/c1/x/Mietvertrag.pdf' });
    assert.deepEqual(ftsIds(db, 'mietvertrag'), [m.id]);
    deleteExpired(db, { messagesBefore: 100, mediaBefore: 1000 });
    assert.deepEqual(ftsIds(db, 'mietvertrag'), []);
    assert.deepEqual(ftsIds(db, 'dokument'), [m.id]); // Nachricht selbst bleibt
    assertFtsConsistent(db);
  });

  // Hinweis: VACUUM darf laut SQLite-Doku rowids ohne INTEGER PRIMARY KEY aendern; das ist hier
  // mit SQLite 3.53.4 nicht beobachtet worden. Der Test sichert ab, dass der Index in jedem Fall passt.
  it('Suchindex bleibt nach Loeschen und VACUUM konsistent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waread-db-'));
    try {
      const db = openDb(join(dir, 'v.db'));
      runMigrations(db);
      upsertChat(db, { id: 'c1', name: 'Familie', isGroup: true, lastActivityAt: 1 });
      const ms = Array.from({ length: 20 }, (_, i) => msg({ text: `nachricht${i} gemeinsam`, waTimestamp: 100 + i }));
      for (const m of ms) insertMessageIfNotExists(db, m);
      deleteExpired(db, { messagesBefore: 110, mediaBefore: 110 }); // entfernt die ersten 10
      db.exec('VACUUM');
      assertFtsConsistent(db);
      assert.equal(ftsIds(db, 'gemeinsam').length, 10);
      assert.deepEqual(ftsIds(db, 'nachricht15'), [ms[15]!.id]);
      assert.deepEqual(ftsIds(db, 'nachricht5'), []); // geloescht
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wirft bei nicht ganzzahligen Cutoffs, ohne etwas zu veraendern', () => {
    const db = freshDb();
    insertMessageIfNotExists(db, msg());
    assert.throws(() => deleteExpired(db, { messagesBefore: Number.NaN, mediaBefore: 1 }), TypeError);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages'), 1);
  });
});

describe('Einstellungen und Events', () => {
  it('getSetting/setSetting: null wenn unbekannt, Ueberschreiben moeglich', () => {
    const db = freshDb();
    assert.equal(getSetting(db, 'retention_days'), null);
    setSetting(db, 'retention_days', '3');
    assert.equal(getSetting(db, 'retention_days'), '3');
    setSetting(db, 'retention_days', '7');
    assert.equal(getSetting(db, 'retention_days'), '7');
  });

  it('pushEvent/pullEventsSince: Reihenfolge, Payload-Roundtrip, Inkrement; geloeschte ids werden nie wiederverwendet', () => {
    const db = freshDb();
    pushEvent(db, 'message', { chatId: 'c1', n: 1 });
    pushEvent(db, 'chat_updated', null);
    pushEvent(db, 'message', { chatId: 'c1', nested: { a: [1, 2] } });
    const all = pullEventsSince(db, 0);
    assert.deepEqual(all.map((e) => e.type), ['message', 'chat_updated', 'message']);
    assert.deepEqual(all[0]!.payload, { chatId: 'c1', n: 1 });
    assert.equal(all[1]!.payload, null);
    assert.deepEqual(all[2]!.payload, { chatId: 'c1', nested: { a: [1, 2] } });
    assert.ok(all[0]!.id < all[1]!.id && all[1]!.id < all[2]!.id);
    assert.deepEqual(pullEventsSince(db, all[1]!.id).map((e) => e.id), [all[2]!.id]);
    assert.deepEqual(pullEventsSince(db, all[2]!.id), []);

    // Der Web-Dienst leert die Tabelle mit eigenem SQL (sse.ts); AUTOINCREMENT sorgt dafuer, dass ids nie zurueckkehren.
    db.prepare('DELETE FROM events_outbox').run();
    assert.deepEqual(pullEventsSince(db, 0), []);
    pushEvent(db, 'message', undefined); // undefined wird zu null
    const after = pullEventsSince(db, 0);
    assert.equal(after.length, 1);
    assert.ok(after[0]!.id > all[2]!.id, 'ids werden nie wiederverwendet');
    assert.equal(after[0]!.payload, null);
  });

  it('kaputtes payload_json blockiert das Polling nicht', () => {
    const db = freshDb();
    db.prepare("INSERT INTO events_outbox (type, payload_json, created_at) VALUES ('x', '{kaputt', 1)").run();
    assert.deepEqual(pullEventsSince(db, 0).map((e) => e.payload), [null]);
  });
});

describe('Version 2: Versionen, Loeschmarke, Schild, Befehle, Zitat-Kurztext', () => {
  it('Migration von Version 1 auf 2 behaelt bestehende Zeilen und setzt Standardwerte', () => {
    const db = openDb(':memory:');
    // Version 1 von Hand aufbauen: schema.sql ausfuehren und user_version setzen
    const here = new URL('./schema.sql', import.meta.url);
    db.exec(readFileSync(here, 'utf8'));
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO chats (id, name, is_group, last_activity_at) VALUES ('c1', 'A', 0, 1)").run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender, wa_timestamp, received_at, direction, type, text) VALUES ('old', 'c1', 's', 5, 5, 'in', 'image', 'hallo')",
    ).run();
    db.prepare("INSERT INTO media (message_id, status) VALUES ('old', 'ready')").run();
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    const row = db.prepare("SELECT protected_at AS p, view_once AS v, edited_at AS e, reply_text AS r FROM messages WHERE id = 'old'").get() as Record<string, unknown>;
    assert.deepEqual(row, { p: null, v: 0, e: null, r: null });
    const md = db.prepare("SELECT status, skip_reason AS s, loadable AS l FROM media WHERE message_id = 'old'").get() as Record<string, unknown>;
    assert.deepEqual(md, { status: 'ready', s: null, l: 0 });
    assert.equal(ftsIds(db, 'hallo').length, 1);
    assertFtsConsistent(db);
  });

  it('Bearbeiten legt die alte Fassung als Version ab; gleicher Text erzeugt keine Version', () => {
    const db = freshDb();
    const m = msg({ text: 'erste Fassung' });
    insertMessageIfNotExists(db, m);
    assert.deepEqual(applyMessageEdit(db, m.id, 'zweite Fassung', 2_000_000), { changed: true, version: 1 });
    assert.deepEqual(applyMessageEdit(db, m.id, 'zweite Fassung', 2_000_001), { changed: false, version: 0 });
    assert.deepEqual(applyMessageEdit(db, m.id, 'dritte Fassung', 2_000_100), { changed: true, version: 2 });
    assert.deepEqual(applyMessageEdit(db, 'unbekannt', 'x'), { changed: false, version: 0 });
    assert.deepEqual(versionsOf(db, m.id), [
      { version: 1, text: 'erste Fassung', replacedAt: 2_000_000 },
      { version: 2, text: 'zweite Fassung', replacedAt: 2_000_100 },
    ]);
    const row = db.prepare('SELECT text, edited, edited_at AS at FROM messages WHERE id = ?').get(m.id) as Record<string, unknown>;
    assert.deepEqual(row, { text: 'dritte Fassung', edited: 1, at: 2_000_100 });
    // Der Suchindex kennt nur den aktuellen Text
    assert.equal(ftsIds(db, 'dritte').length, 1);
    assert.equal(ftsIds(db, 'erste').length, 0);
    assertFtsConsistent(db);
  });

  it('Loeschmarke: deleted_at bleibt beim ersten Zeitpunkt', () => {
    const db = freshDb();
    const m = msg();
    insertMessageIfNotExists(db, m);
    assert.equal(markMessageDeleted(db, m.id, 3_000_000), true);
    assert.equal(markMessageDeleted(db, m.id, 3_000_500), true);
    const row = db.prepare('SELECT deleted, deleted_at AS at FROM messages WHERE id = ?').get(m.id) as Record<string, unknown>;
    assert.deepEqual(row, { deleted: 1, at: 3_000_000 });
  });

  it('Zitat-Kurztext und Einmal-Kennzeichnung werden gespeichert und gekuerzt', () => {
    const db = freshDb();
    const long = 'x'.repeat(300);
    const m = msg({ replyTo: 'orig', replyText: `  ${long}  `, replySender: 'Anna', replyType: 'image', viewOnce: true });
    insertMessageIfNotExists(db, m);
    const row = db.prepare('SELECT reply_text AS t, reply_sender AS s, reply_type AS ty, view_once AS v FROM messages WHERE id = ?').get(m.id) as { t: string; s: string; ty: string; v: number };
    assert.equal([...row.t].length, 140);
    assert.ok(row.t.endsWith('…'));
    assert.deepEqual({ s: row.s, ty: row.ty, v: row.v }, { s: 'Anna', ty: 'image', v: 1 });
    const plain = msg();
    insertMessageIfNotExists(db, plain);
    const p = db.prepare('SELECT reply_text AS t, view_once AS v FROM messages WHERE id = ?').get(plain.id) as { t: unknown; v: number };
    assert.deepEqual(p, { t: null, v: 0 });
  });

  it('setMediaStatus kennt skipReason und loadable; null loescht den Grund', () => {
    const db = freshDb();
    const m = msg({ type: 'video', text: undefined });
    insertMessageIfNotExists(db, m);
    setMediaStatus(db, m.id, { status: 'expired', skipReason: 'rule_off', loadable: true });
    const a = db.prepare('SELECT status, skip_reason AS s, loadable AS l FROM media WHERE message_id = ?').get(m.id);
    assert.deepEqual(a, { status: 'expired', s: 'rule_off', l: 1 });
    setMediaStatus(db, m.id, { status: 'ready', skipReason: null, loadable: false });
    const b = db.prepare('SELECT status, skip_reason AS s, loadable AS l FROM media WHERE message_id = ?').get(m.id);
    assert.deepEqual(b, { status: 'ready', s: null, l: 0 });
    assert.throws(() => db.prepare("UPDATE media SET skip_reason = 'erfunden' WHERE message_id = ?").run(m.id), /CHECK/);
  });

  it('Schild: deleteExpired laesst geschuetzte Nachrichten samt Medien und Version stehen', () => {
    const db = freshDb();
    const keep = msg({ type: 'image', text: 'Wichtig', waTimestamp: 100 });
    const gone = msg({ type: 'image', text: 'Weg', waTimestamp: 110 });
    for (const m of [keep, gone]) insertMessageIfNotExists(db, m);
    setMediaStatus(db, keep.id, { status: 'ready', filePath: '/m/keep.jpg', thumbnailPath: '/m/keep_t.jpg' });
    setMediaStatus(db, gone.id, { status: 'ready', filePath: '/m/gone.jpg' });
    applyMessageEdit(db, keep.id, 'Wichtig (neu)', 150);
    assert.equal(setMessageProtected(db, keep.id, true, 500), true);
    assert.equal(setMessageProtected(db, keep.id, true, 900), true);
    assert.equal(scalar(db, 'SELECT protected_at FROM messages WHERE id = ?', keep.id), 500, 'Zeitpunkt bleibt');
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM messages WHERE protected_at IS NOT NULL'), 1);

    const res = deleteExpired(db, { messagesBefore: 10_000, mediaBefore: 10_000 });
    assert.deepEqual(res.deletedMessageIds, [gone.id]);
    assert.deepEqual(res.mediaPathsToDelete, ['/m/gone.jpg']);
    assert.equal(scalar(db, 'SELECT count(*) FROM messages WHERE id = ?', keep.id), 1);
    assert.equal(scalar(db, "SELECT status FROM media WHERE message_id = ?", keep.id), 'ready', 'Medium geschuetzt');
    assert.equal(versionsOf(db, keep.id).length, 1);
    assertFtsConsistent(db);

    // Schild entfernen: beim naechsten Lauf verschwindet sie
    assert.equal(setMessageProtected(db, keep.id, false), true);
    const res2 = deleteExpired(db, { messagesBefore: 10_000, mediaBefore: 10_000 });
    assert.deepEqual(res2.deletedMessageIds, [keep.id]);
    assert.equal(scalar(db, 'SELECT count(*) FROM message_versions'), 0, 'Versionen gehen mit der Nachricht');
    assertFtsConsistent(db);
  });

  it('Schild: nur includeProtected === true loescht auch geschuetzte (nicht "true", nicht 1)', () => {
    const db = freshDb();
    const m = msg({ text: 'geschuetzt', waTimestamp: 100 });
    insertMessageIfNotExists(db, m);
    setMessageProtected(db, m.id, true);
    for (const bad of [undefined, false, 1, 'true'] as unknown[]) {
      const r = deleteExpired(db, { messagesBefore: 10_000, mediaBefore: 10_000, includeProtected: bad as boolean });
      assert.deepEqual(r.deletedMessageIds, [], `includeProtected=${String(bad)} darf nichts loeschen`);
    }
    const r = deleteExpired(db, { messagesBefore: 10_000, mediaBefore: 10_000, includeProtected: true });
    assert.deepEqual(r.deletedMessageIds, [m.id]);
  });

  it('Schild: Medien-Ablauf (mediaBefore) trifft geschuetzte Nachrichten nicht; ungeschuetzte werden nicht mehr ladbar', () => {
    const db = freshDb();
    const prot = msg({ type: 'voice', text: undefined, waTimestamp: 100 });
    const plain = msg({ type: 'voice', text: undefined, waTimestamp: 110 });
    for (const m of [prot, plain]) insertMessageIfNotExists(db, m);
    setMediaStatus(db, prot.id, { status: 'ready', filePath: '/m/p.ogg' });
    setMediaStatus(db, plain.id, { status: 'failed', loadable: true });
    setMediaStatus(db, plain.id, { filePath: '/m/q.ogg' });
    setMessageProtected(db, prot.id, true);
    const res = deleteExpired(db, { messagesBefore: 0, mediaBefore: 10_000 });
    assert.deepEqual(res.mediaPathsToDelete, ['/m/q.ogg']);
    assert.equal(scalar(db, 'SELECT status FROM media WHERE message_id = ?', prot.id), 'ready');
    const row = db.prepare('SELECT status, loadable AS l, skip_reason AS s FROM media WHERE message_id = ?').get(plain.id);
    assert.deepEqual(row, { status: 'expired', l: 0, s: 'retention' });
  });

  it('Befehle: Reihenfolge, Payload-Roundtrip, kaputtes JSON blockiert nichts', () => {
    const db = freshDb();
    const a = enqueueCommand(db, 'load_media', { messageId: 'm1' });
    const b = enqueueCommand(db, 'load_media', { messageId: 'm2' });
    assert.ok(b > a);
    db.prepare("UPDATE ingest_commands SET payload_json = '{kaputt' WHERE id = ?").run(b);
    const cmds = listCommands(db);
    assert.deepEqual(cmds.map((c) => [c.id, c.type, c.payload]), [
      [a, 'load_media', { messageId: 'm1' }],
      [b, 'load_media', null],
    ]);
    deleteCommand(db, a);
    assert.deepEqual(listCommands(db).map((c) => c.id), [b]);
  });
});
