import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  getSetting,
  insertMessageIfNotExists,
  listMediaIdsByStatus,
  messageExists,
  pushEvent,
  runMigrations,
  setMediaStatus,
  setSetting,
  upsertChat,
} from '../src/dbClient.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'

describe('dbClient (Anbindung an @waread/db)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.close())

  const msg = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    chatId: 'c1@s.whatsapp.net',
    sender: 'Anna',
    waTimestamp: 1_800_000_000,
    receivedAt: 1_800_000_005,
    direction: 'in' as const,
    type: 'text' as const,
    text: 'Hallo Welt',
    ...over,
  })

  it('Migration ist wiederholbar', () => {
    runMigrations(env.db)
    runMigrations(env.db)
    const tables = all<{ name: string }>(env.db, "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").map(
      (r) => r.name,
    )
    for (const t of ['chats', 'messages', 'media', 'settings', 'events_outbox', 'messages_fts']) {
      assert.ok(tables.includes(t), t)
    }
  })

  it('upsertChat: leerer Name ueberschreibt nicht, last_activity_at sinkt nie', () => {
    upsertChat(env.db, { id: 'c1', name: 'Anna', isGroup: false, lastActivityAt: 100 })
    upsertChat(env.db, { id: 'c1', name: '', isGroup: false, lastActivityAt: 50 })
    let row = one(env.db, 'SELECT * FROM chats WHERE id = ?', 'c1')
    assert.equal(row.name, 'Anna')
    assert.equal(row.last_activity_at, 100)
    upsertChat(env.db, { id: 'c1', name: 'Anna B.', isGroup: false, lastActivityAt: 200 })
    row = one(env.db, 'SELECT * FROM chats WHERE id = ?', 'c1')
    assert.equal(row.name, 'Anna B.')
    assert.equal(row.last_activity_at, 200)
  })

  it('insertMessageIfNotExists: erste Einfuegung true, Duplikat false, kein zweiter FTS-Eintrag', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'Anna', isGroup: false, lastActivityAt: 1 })
    assert.equal(insertMessageIfNotExists(env.db, msg('m1')), true)
    assert.equal(insertMessageIfNotExists(env.db, msg('m1', { text: 'anders' })), false)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages_fts').n, 1)
    assert.equal(one(env.db, 'SELECT text FROM messages WHERE id = ?', 'm1').text, 'Hallo Welt')
  })

  it('FTS5: Textsuche findet die Nachricht ueber messages_fts_map, Diakritika werden ignoriert', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'Anna', isGroup: false, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { text: 'Treffen am Café um acht' }))
    insertMessageIfNotExists(env.db, msg('m2', { text: 'ganz anderes Thema' }))
    const hits = all<{ id: string }>(
      env.db,
      `SELECT m.id FROM messages_fts f
         JOIN messages_fts_map x ON x.fts_rowid = f.rowid
         JOIN messages m ON m.id = x.message_id WHERE messages_fts MATCH ?`,
      'cafe',
    )
    assert.deepEqual(
      hits.map((h) => h.id),
      ['m1'],
    )
  })

  it('FTS5: bei Medien steht die Bildunterschrift in "caption", nicht in "text"', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'Anna', isGroup: false, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { type: 'image', text: 'Sonnenuntergang' }))
    const row = one(
      env.db,
      'SELECT text, caption FROM messages_fts WHERE rowid = (SELECT fts_rowid FROM messages_fts_map WHERE message_id = ?)',
      'm1',
    )
    assert.equal(row.text, null)
    assert.equal(row.caption, 'Sonnenuntergang')
  })

  it('FTS5: Chat- und Absendername sind durchsuchbar', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'Familie', isGroup: true, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { sender: 'Tante Erika' }))
    const byChat = all(env.db, 'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', 'chat_name:familie')
    const bySender = all(env.db, 'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', 'sender_name:erika')
    assert.equal(byChat.length, 1)
    assert.equal(bySender.length, 1)
  })

  it('Loeschen einer Nachricht entfernt ihren Suchindex-Eintrag (Trigger) und blockiert spaetere Einfuegungen nicht', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'Anna', isGroup: false, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { text: 'erste' }))
    env.db.prepare('DELETE FROM messages WHERE id = ?').run('m1') // direktes SQL, ohne FTS-Handarbeit
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages_fts').n, 0)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages_fts_map').n, 0)
    assert.equal(insertMessageIfNotExists(env.db, msg('m2', { text: 'zweite' })), true)
    const hits = all(
      env.db,
      `SELECT x.message_id FROM messages_fts f JOIN messages_fts_map x ON x.fts_rowid = f.rowid WHERE messages_fts MATCH ?`,
      'zweite',
    )
    assert.equal(hits.length, 1)
    assert.equal(all(env.db, 'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', 'erste').length, 0)
  })

  it('Fremdschluessel: Nachricht ohne Chat wird abgewiesen und hinterlaesst nichts (auch nicht im FTS)', () => {
    assert.throws(() => insertMessageIfNotExists(env.db, msg('m1', { chatId: 'unbekannt' })))
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 0)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages_fts').n, 0)
  })

  it('CHECK-Constraints des Vertrags greifen (direction/type)', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'A', isGroup: false, lastActivityAt: 1 })
    assert.throws(() => insertMessageIfNotExists(env.db, msg('m1', { type: 'sticker' as never })))
    assert.throws(() => insertMessageIfNotExists(env.db, msg('m2', { direction: 'sideways' as never })))
  })

  it('setMediaStatus: legt Zeile an, setzt nur gegebene Felder, kennt kein SQL-Einschleusen', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'A', isGroup: false, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { type: 'image' }))
    setMediaStatus(env.db, 'm1', { status: 'downloading', mimeType: 'image/jpeg' })
    setMediaStatus(env.db, 'm1', { status: 'ready', filePath: '/x/y.jpg', sizeBytes: 12 })
    const row = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'm1')
    assert.equal(row.status, 'ready')
    assert.equal(row.mime_type, 'image/jpeg')
    assert.equal(row.file_path, '/x/y.jpg')
    assert.equal(row.size_bytes, 12)
    assert.throws(() => setMediaStatus(env.db, 'm1', { status: "ready'; DROP TABLE media;--" as never }))
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM media').n, 1)
  })

  it('listMediaIdsByStatus / messageExists', () => {
    upsertChat(env.db, { id: 'c1@s.whatsapp.net', name: 'A', isGroup: false, lastActivityAt: 1 })
    insertMessageIfNotExists(env.db, msg('m1', { type: 'image' }))
    insertMessageIfNotExists(env.db, msg('m2', { type: 'image' }))
    setMediaStatus(env.db, 'm1', { status: 'downloading' })
    setMediaStatus(env.db, 'm2', { status: 'ready' })
    assert.deepEqual(listMediaIdsByStatus(env.db, ['downloading']), ['m1'])
    assert.deepEqual(listMediaIdsByStatus(env.db, ['downloading', 'ready']).sort(), ['m1', 'm2'])
    assert.equal(messageExists(env.db, 'm1'), true)
    assert.equal(messageExists(env.db, 'nope'), false)
  })

  it('settings und events_outbox', () => {
    assert.equal(getSetting(env.db, 'k'), null)
    setSetting(env.db, 'k', 'v1')
    setSetting(env.db, 'k', 'v2')
    assert.equal(getSetting(env.db, 'k'), 'v2')
    pushEvent(env.db, 'demo', { a: 1 })
    const ev = one(env.db, 'SELECT * FROM events_outbox')
    assert.equal(ev.type, 'demo')
    assert.deepEqual(JSON.parse(ev.payload_json), { a: 1 })
    assert.ok(ev.created_at > 1_700_000_000)
  })
})
