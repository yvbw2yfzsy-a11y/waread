import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  runMigrations,
  upsertChat,
  insertMessageIfNotExists,
  updateMessageText,
  markMessageDeleted,
  setMediaStatus,
  markSeen,
  markPlayed,
  searchMessages,
  getSetting,
  setSetting,
  deleteExpired,
  pushEvent,
  pullEventsSince,
  pruneEvents,
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

const ids = (hits: { id: string }[]): string[] => hits.map((h) => h.id);

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
    for (const t of ['chats', 'messages', 'media', 'messages_fts', 'settings', 'events_outbox']) {
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
    assert.deepEqual(ids(searchMessages(db, 'familie')), [m.id]);
    upsertChat(db, { id: 'c1', name: 'Arbeit', isGroup: true, lastActivityAt: 2 });
    assert.deepEqual(searchMessages(db, 'familie'), []);
    assert.deepEqual(ids(searchMessages(db, 'arbeit')), [m.id]);
    assertFtsConsistent(db);
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
    assert.equal(updateMessageText(db, m.id, 'neuertext'), true);
    assert.deepEqual(searchMessages(db, 'altertext'), []);
    const [hit] = searchMessages(db, 'neuertext');
    assert.equal(hit?.id, m.id);
    assert.equal(hit?.edited, true);
    assert.equal(hit?.deleted, false);
    assert.equal(markMessageDeleted(db, m.id), true);
    assert.equal(searchMessages(db, 'neuertext')[0]?.deleted, true);
    assert.equal(updateMessageText(db, 'unbekannt', 'x'), false);
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
    const media = searchMessages(db, '', { type: 'voice' })[0]?.media;
    assert.deepEqual(media, {
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
    assert.deepEqual(ids(searchMessages(db, 'zeugnis')), [t2.id]);
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

describe('Suche', () => {
  it('findet Text; Umlaute, Gross-/Kleinschreibung und Praefix (letztes Wort) werden toleriert', () => {
    const db = freshDb();
    const a = msg({ text: 'Urlaubsplanung bei Familie Müller' });
    const b = msg({ text: 'Einkaufsliste für morgen' });
    insertMessageIfNotExists(db, a);
    insertMessageIfNotExists(db, b);
    assert.deepEqual(ids(searchMessages(db, 'müller')), [a.id]);
    assert.deepEqual(ids(searchMessages(db, 'MULLER')), [a.id]);
    assert.deepEqual(ids(searchMessages(db, 'urlaubsp')), [a.id]);
    assert.deepEqual(ids(searchMessages(db, 'urlaubsplanung muller')), [a.id]); // UND
    assert.deepEqual(searchMessages(db, 'urlaubsplanung einkaufsliste'), []);
    assert.deepEqual(ids(searchMessages(db, 'fur')), [b.id]); // "für" ohne Umlaut
  });

  it('Sonderzeichen in der Eingabe loesen keinen FTS-Syntaxfehler aus', () => {
    const db = freshDb();
    insertMessageIfNotExists(db, msg({ text: 'it works' }));
    for (const q of ['"', 'foo AND', 'NEAR(', 'a:b', '-x', "it's", '(', 'OR', 'x*', 'a" b', 'text:works']) {
      assert.doesNotThrow(() => searchMessages(db, q), `Eingabe ${JSON.stringify(q)}`);
    }
    // keine Buchstaben/Ziffern => leer, nicht "alles"
    assert.deepEqual(searchMessages(db, '*'), []);
    assert.deepEqual(searchMessages(db, '😀'), []);
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
    assert.deepEqual(ids(searchMessages(db, 'sonnenuntergang')), [img.id]);
    assert.deepEqual(ids(searchMessages(db, 'rechnung')), [img.id]);
    assert.deepEqual(searchMessages(db, 'waread'), []); // Verzeichnisname gehoert nicht in den Index
    assert.deepEqual(ids(searchMessages(db, 'familie')), [img.id]); // chat_name
    assert.deepEqual(ids(searchMessages(db, '4915112345678')), [img.id]); // sender_name
    assertFtsConsistent(db);
  });

  it('Filter chatId, type, from/to, onlyNew, limit; blanke Anfrage listet neueste zuerst', () => {
    const db = freshDb();
    upsertChat(db, { id: 'c2', name: 'Anna', isGroup: false, lastActivityAt: 1 });
    const a = msg({ text: 'eins' });
    const b = msg({ text: 'zwei', type: 'voice' });
    const c = msg({ text: 'drei', chatId: 'c2' });
    const d = msg({ text: 'vier', direction: 'out' });
    for (const m of [a, b, c, d]) insertMessageIfNotExists(db, m);

    assert.deepEqual(ids(searchMessages(db, '')), [d.id, c.id, b.id, a.id]);
    assert.deepEqual(ids(searchMessages(db, '   ', { chatId: 'c1' })), [d.id, b.id, a.id]);
    assert.deepEqual(ids(searchMessages(db, '', { type: 'voice' })), [b.id]);
    assert.deepEqual(ids(searchMessages(db, '', { from: b.waTimestamp, to: c.waTimestamp })), [c.id, b.id]);
    assert.deepEqual(ids(searchMessages(db, '', { onlyNew: true })), [c.id, b.id, a.id]); // 'out' ist nie neu
    assert.deepEqual(ids(searchMessages(db, '', { limit: 2 })), [d.id, c.id]);
    assert.deepEqual(ids(searchMessages(db, 'drei', { chatId: 'c1' })), []);
    assert.deepEqual(ids(searchMessages(db, 'drei', { chatId: 'c2' })), [c.id]);
    const hit = searchMessages(db, 'drei')[0];
    assert.equal(hit?.chatName, 'Anna');
    assert.equal(hit?.isGroup, false);
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
    assert.deepEqual(ids(searchMessages(db, '', { onlyNew: true })), [m3.id]);
    assert.deepEqual(markSeen(db, { chatId: 'c1', all: true }), [m3.id]);
    assert.deepEqual(searchMessages(db, '', { onlyNew: true }), []);
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
    assert.deepEqual(ids(searchMessages(db, '', { onlyNew: true })), [b.id]);
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

    const media = searchMessages(db, '', { type: 'voice' })[0]?.media;
    assert.equal(media?.status, 'expired');
    assert.equal(media?.filePath, null);
    assert.equal(media?.thumbnailPath, null);
    assert.equal(media?.mimeType, 'audio/ogg'); // Metadaten bleiben
    assert.equal(media?.durationSeconds, 12.5);

    assert.deepEqual(ids(searchMessages(db, 'frischer')), [fresh.id]);
    assert.deepEqual(searchMessages(db, 'altes'), []);
    assert.deepEqual(searchMessages(db, 'alter'), []);
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
    assert.deepEqual(ids(searchMessages(db, 'mietvertrag')), [m.id]);
    deleteExpired(db, { messagesBefore: 100, mediaBefore: 1000 });
    assert.deepEqual(searchMessages(db, 'mietvertrag'), []);
    assert.deepEqual(ids(searchMessages(db, 'dokument')), [m.id]); // Nachricht selbst bleibt
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
      assert.equal(searchMessages(db, 'gemeinsam').length, 10);
      assert.deepEqual(ids(searchMessages(db, 'nachricht15')), [ms[15]!.id]);
      assert.deepEqual(searchMessages(db, 'nachricht5'), []); // geloescht
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

  it('pushEvent/pullEventsSince: Reihenfolge, Payload-Roundtrip, Inkrement; pruneEvents raeumt auf', () => {
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

    assert.equal(pruneEvents(db, 0), 0);
    assert.equal(pruneEvents(db, Math.floor(Date.now() / 1000) + 60), 3);
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
