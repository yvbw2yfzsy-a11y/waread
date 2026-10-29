import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setSetting } from '../src/dbClient.js'
import type { NewMediaJob } from '../src/jobStore.js'
import { MessageHandler, type EnqueueResult, type MediaSink } from '../src/messageHandler.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const key = Buffer.from('mediakey')

class Sink implements MediaSink {
  jobs: NewMediaJob[] = []
  result: EnqueueResult = 'queued'
  enqueue(job: NewMediaJob): EnqueueResult {
    this.jobs.push(job)
    return this.result
  }
}

const upsert = (id: string, message: any, over: Record<string, unknown> = {}) => ({
  type: 'notify',
  messages: [{ key: { id, remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 60, pushName: 'Anna', message, ...over }],
})

describe('MessageHandler', () => {
  let env: TestEnv
  let sink: Sink
  let handler: MessageHandler

  const make = (): MessageHandler => new MessageHandler({ db: env.db, jobs: env.jobs, media: sink, cfg: env.cfg, log: env.log, now: () => NOW })

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    sink = new Sink()
    handler = make()
  })
  afterEach(() => env.close())

  it('speichert Text: Chat, Nachricht, FTS und Live-Ereignis', () => {
    const stats = handler.handleUpsert(upsert('m1', { conversation: 'Hallo Welt' }))
    assert.deepEqual(stats, { stored: 1, duplicates: 0, dropped: 0, ignored: 0 })
    const m = one(env.db, 'SELECT * FROM messages WHERE id = ?', 'm1')
    assert.equal(m.text, 'Hallo Welt')
    assert.equal(m.chat_id, PN)
    assert.equal(m.sender, 'Anna')
    assert.equal(m.direction, 'in')
    assert.equal(m.received_at, NOW)
    assert.equal(m.wa_timestamp, NOW - 60)
    assert.equal(m.seen_at, null) // "neu" ist ein rein lokaler Zustand
    assert.equal(one(env.db, 'SELECT name, last_activity_at FROM chats WHERE id = ?', PN).name, 'Anna')
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages_fts').n, 1)
    const ev = all(env.db, "SELECT * FROM events_outbox WHERE type = 'new_message'")
    assert.equal(ev.length, 1)
    assert.deepEqual(JSON.parse(ev[0].payload_json), { chatId: PN, messageId: 'm1', type: 'text' })
  })

  it('Duplikate (gleiche ID) werden nicht doppelt gespeichert und erzeugen kein zweites Ereignis', () => {
    handler.handleUpsert(upsert('m1', { conversation: 'a' }))
    const stats = handler.handleUpsert(upsert('m1', { conversation: 'b' }))
    assert.equal(stats.duplicates, 1)
    assert.equal(stats.stored, 0)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1)
    assert.equal(one(env.db, 'SELECT text FROM messages').text, 'a')
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'new_message'").n, 1)
  })

  it('F18/C4: dieselbe Nachrichten-ID in einem zweiten Chat zaehlt als Duplikat, die erste bleibt unveraendert', () => {
    const OTHER = '491709999999@s.whatsapp.net'
    handler.handleUpsert(upsert('m-same', { conversation: 'im ersten Chat' }))
    const stats = handler.handleUpsert({
      type: 'notify',
      messages: [{ key: { id: 'm-same', remoteJid: OTHER, fromMe: false }, messageTimestamp: NOW - 60, pushName: 'Bert', message: { conversation: 'im zweiten Chat' } }],
    })
    assert.equal(stats.duplicates, 1)
    assert.equal(stats.stored, 0)
    const rows = all(env.db, 'SELECT id, chat_id, text FROM messages')
    assert.deepEqual(rows, [{ id: 'm-same', chat_id: PN, text: 'im ersten Chat' }])
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'new_message'").n, 1)
  })

  it('F18/O3: Grenzfall der Aufbewahrung: genau 3 Tage alt bleibt, eine Sekunde aelter wird verworfen', () => {
    const edge = upsert('edge', { conversation: 'rand' }, { messageTimestamp: NOW - 3 * 86_400 })
    const over = upsert('over', { conversation: 'drueber' }, { messageTimestamp: NOW - 3 * 86_400 - 1 })
    assert.equal(handler.handleUpsert(edge).stored, 1)
    assert.equal(handler.handleUpsert(over).dropped, 1)
    assert.deepEqual(all(env.db, 'SELECT id FROM messages').map((r) => r.id), ['edge'])
  })

  it('F18/O3: dieselbe Grenze bei 14 Tagen Aufbewahrung', () => {
    env.cfg.retention.messagesDays = 14
    env.cfg.retention.mediaDays = 14
    const edge = upsert('edge14', { conversation: 'rand' }, { messageTimestamp: NOW - 14 * 86_400 })
    const over = upsert('over14', { conversation: 'drueber' }, { messageTimestamp: NOW - 14 * 86_400 - 1 })
    assert.equal(handler.handleUpsert(edge).stored, 1)
    assert.equal(handler.handleUpsert(over).dropped, 1)
  })

  it('Aufbewahrung zaehlt nach dem WhatsApp-Zeitstempel: zu alte Nachrichten werden verworfen', () => {
    const old = upsert('old', { conversation: 'alt' }, { messageTimestamp: NOW - 4 * 86_400 })
    const fresh = upsert('fresh', { conversation: 'neu' }, { messageTimestamp: NOW - 2 * 86_400 })
    assert.equal(handler.handleUpsert(old).dropped, 1)
    assert.equal(handler.handleUpsert(fresh).stored, 1)
    assert.deepEqual(
      all(env.db, 'SELECT id FROM messages').map((r) => r.id),
      ['fresh'],
    )
  })

  it('Aufbewahrung aus der settings-Tabelle hat Vorrang vor config.toml', () => {
    setSetting(env.db, 'retentionDays', '14')
    handler = make()
    const r = handler.handleUpsert(upsert('m', { conversation: 'x' }, { messageTimestamp: NOW - 10 * 86_400 }))
    assert.equal(r.stored, 1)
  })

  it('ungueltige settings-Werte fallen auf config.toml zurueck; Medien-Dauer <= Nachrichten-Dauer', () => {
    setSetting(env.db, 'retentionDays', 'viel')
    setSetting(env.db, 'retentionMediaDays', '9999')
    handler = make()
    assert.equal(handler.isExpired(NOW - 2 * 86_400, 'messages'), false)
    assert.equal(handler.isExpired(NOW - 4 * 86_400, 'messages'), true)
    assert.equal(handler.isExpired(NOW - 4 * 86_400, 'media'), true)
  })

  it('Medien-Aufbewahrung kuerzer als Nachrichten-Aufbewahrung: Text bleibt, Medium wird "expired"', () => {
    setSetting(env.db, 'retentionDays', '7')
    setSetting(env.db, 'retentionMediaDays', '1')
    handler = make()
    const u = upsert('img', { imageMessage: { mediaKey: key, mimetype: 'image/jpeg', caption: 'x' } }, { messageTimestamp: NOW - 3 * 86_400 })
    assert.equal(handler.handleUpsert(u).stored, 1)
    assert.equal(one(env.db, 'SELECT status FROM media WHERE message_id = ?', 'img').status, 'expired')
    assert.equal(sink.jobs.length, 0)
  })

  it('Bild: media-Zeile "pending" mit MIME/Groesse, Auftrag geht an die Warteschlange (nach dem Commit)', () => {
    handler.handleUpsert(
      upsert('img', {
        imageMessage: { mediaKey: key, mimetype: 'image/jpeg', fileLength: 999, caption: 'Strand', directPath: '/d' },
      }),
    )
    const media = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'img')
    assert.equal(media.status, 'pending')
    assert.equal(media.mime_type, 'image/jpeg')
    assert.equal(media.size_bytes, 999)
    assert.equal(sink.jobs.length, 1)
    assert.equal(sink.jobs[0]!.messageId, 'img')
    assert.equal(sink.jobs[0]!.kind, 'image')
    assert.equal(sink.jobs[0]!.descriptor.mediaKey, key.toString('base64'))
    // Beschriftung ist durchsuchbar
    assert.equal(
      all(env.db, 'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', 'caption:strand').length,
      1,
    )
  })

  it('Sprachnachricht: Dauer wird uebernommen', () => {
    handler.handleUpsert(upsert('v', { audioMessage: { ptt: true, seconds: 12, mimetype: 'audio/ogg; codecs=opus', mediaKey: key } }))
    const media = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'v')
    assert.equal(media.duration_seconds, 12)
    assert.equal(sink.jobs[0]!.kind, 'voice')
  })

  it('ein Fehler in einer Nachricht stoppt die uebrigen nicht', () => {
    const bad = { key: { id: 'bad', remoteJid: PN }, messageTimestamp: NOW, message: { conversation: 'x' } }
    Object.defineProperty(bad, 'pushName', {
      get() {
        throw new Error('kaputt')
      },
    })
    const good = upsert('good', { conversation: 'ok' }).messages[0]
    const stats = handler.handleUpsert({ messages: [bad as never, good as never] })
    assert.equal(stats.stored, 1)
    assert.equal(stats.ignored, 1)
    assert.ok(env.lines.some((l) => l.includes('"message_failed"')))
  })

  it('Verlauf: Medien werden nicht nachgeladen (expired), kein Live-Ereignis je Nachricht, ein Sammelereignis', async () => {
    const msgs = Array.from({ length: 250 }, (_, i) => ({
      key: { id: `h${i}`, remoteJid: PN, fromMe: i % 2 === 0 },
      messageTimestamp: NOW - 3600 - i,
      message: i === 0 ? { imageMessage: { mediaKey: key, mimetype: 'image/jpeg' } } : { conversation: `Nachricht ${i}` },
    }))
    const stats = await handler.handleHistory({ messages: msgs })
    assert.equal(stats.stored, 250)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 250)
    assert.equal(one(env.db, 'SELECT status FROM media WHERE message_id = ?', 'h0').status, 'expired')
    assert.equal(sink.jobs.length, 0)
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'new_message'").n, 0)
    const hs = all(env.db, "SELECT payload_json FROM events_outbox WHERE type = 'history_synced'")
    assert.equal(hs.length, 1)
    assert.deepEqual(JSON.parse(hs[0].payload_json), { stored: 250 })
  })

  it('Verlauf: Alter wird nach WhatsApp-Zeitstempel verworfen, Ergaenzung ist idempotent', async () => {
    const msgs = [
      { key: { id: 'a', remoteJid: PN }, messageTimestamp: NOW - 100, message: { conversation: 'neu' } },
      { key: { id: 'b', remoteJid: PN }, messageTimestamp: NOW - 9 * 86_400, message: { conversation: 'alt' } },
    ]
    const first = await handler.handleHistory({ messages: msgs })
    assert.equal(first.stored, 1)
    assert.equal(first.dropped, 1)
    const second = await handler.handleHistory({ messages: msgs })
    assert.equal(second.duplicates, 1)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1)
  })

  it('Namen: Kontakt > Chat > Push; Push-Name verbessert einen Chatnamen nicht', async () => {
    handler.handleContacts([{ id: PN, name: 'Anna (Kontakt)' }])
    handler.handleUpsert(upsert('m1', { conversation: 'x' })) // pushName "Anna"
    assert.equal(one(env.db, 'SELECT name FROM chats WHERE id = ?', PN).name, 'Anna (Kontakt)')
    assert.equal(one(env.db, 'SELECT sender FROM messages WHERE id = ?', 'm1').sender, 'Anna (Kontakt)')
  })

  it('Gruppennamen aus groups.upsert werden fuer neue Nachrichten genutzt', () => {
    const G = '120363000000000001@g.us'
    handler.handleGroups([{ id: G, subject: 'Familie' }])
    handler.handleUpsert({
      messages: [{ key: { id: 'g1', remoteJid: G, participant: PN }, messageTimestamp: NOW, message: { conversation: 'hi' }, pushName: 'Anna' }],
    })
    const chat = one(env.db, 'SELECT * FROM chats WHERE id = ?', G)
    assert.equal(chat.name, 'Familie')
    assert.equal(chat.is_group, 1)
  })

  it('LID-Zuordnung aus lid-mapping.update: Nachricht landet im Telefonnummern-Chat', () => {
    handler.handleLidMapping({ lid: '55:3@lid', pn: '491701234567:9@s.whatsapp.net' })
    handler.handleUpsert({
      messages: [{ key: { id: 'l1', remoteJid: '55@lid' }, messageTimestamp: NOW, message: { conversation: 'hi' } }],
    })
    assert.equal(one(env.db, 'SELECT chat_id FROM messages WHERE id = ?', 'l1').chat_id, PN)
  })

  it('Warteschlange voll / deaktiviert: Nachricht bleibt gespeichert', () => {
    sink.result = 'queue_full'
    const stats = handler.handleUpsert(upsert('img', { imageMessage: { mediaKey: key } }))
    assert.equal(stats.stored, 1)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1)
  })

  it('INHALTSFREIES LOGGING: weder Text, Namen, Nummern noch Dateinamen erscheinen im Log', async () => {
    const secrets = ['Geheimtext-4711', 'Pushy-Name-4711', 'Beschriftung-4711', 'Datei-4711.pdf', '491701234567', 'Gruppe-4711']
    handler.handleGroups([{ id: '120363000000000009@g.us', subject: 'Gruppe-4711' }])
    handler.handleContacts([{ id: PN, name: 'Pushy-Name-4711' }])
    handler.handleUpsert(upsert('t', { conversation: 'Geheimtext-4711' }, { pushName: 'Pushy-Name-4711' }))
    handler.handleUpsert(upsert('i', { imageMessage: { mediaKey: key, caption: 'Beschriftung-4711' } }))
    handler.handleUpsert(upsert('d', { documentMessage: { mediaKey: key, fileName: 'Datei-4711.pdf' } }))
    handler.handleUpsert(upsert('x', { protocolMessage: {} }))
    handler.handleUpsert({ messages: [{ key: { id: 'bad', remoteJid: PN }, messageTimestamp: NOW, get message(): never { throw new Error('Geheimtext-4711') } } as never] })
    await handler.handleHistory({ messages: [{ key: { id: 'h', remoteJid: PN }, messageTimestamp: NOW, message: { conversation: 'Geheimtext-4711' } }] })
    assert.ok(env.lines.length > 0, 'es sollte etwas geloggt worden sein (Debug-Stufe)')
    const log = env.lines.join('\n')
    for (const s of secrets) assert.ok(!log.includes(s), `Log enthaelt "${s}"`)
  })
})
