import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { IngestCommands } from '../src/commands.js'
import { enqueueCommand } from '@waread/db'
import { insertMessageIfNotExists, listCommands, setMediaStatus, upsertChat } from '../src/dbClient.js'
import type { MediaKind } from '../src/config.js'
import type { MediaDescriptor, NewMediaJob } from '../src/jobStore.js'
import { MediaQueue, type QueueDeps } from '../src/mediaQueue.js'
import {
  editedTextOf,
  MessageHandler,
  normalizeMessage,
  PLACEHOLDER,
  type EnqueueResult,
  type MediaSink,
  type NormEnv,
  type RawMessage,
} from '../src/messageHandler.js'
import type { DownloadTarget } from '../src/waLib.js'
import { all, boom, FakeScheduler, makeEnv, one, type TestEnv } from './support/helpers.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const key = Buffer.from('geheimer-schluessel')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('base64')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('Zeitueberschreitung beim Warten')
    await sleep(5)
  }
}

const rawMsg = (message: any, over: Partial<RawMessage> = {}): RawMessage => ({
  key: { id: 'ABC123', remoteJid: PN, fromMe: false },
  messageTimestamp: NOW - 60,
  message,
  ...over,
})
const envOf = (over: Partial<NormEnv> = {}): NormEnv => ({ pnForLid: () => undefined, nameOf: () => undefined, ...over })
function msgOf(r: RawMessage, env: NormEnv = envOf()) {
  const res = normalizeMessage(r, env)
  assert.equal(res.kind, 'message', res.kind === 'ignored' ? res.reason : '')
  return res.kind === 'message' ? res.message : (undefined as never)
}

describe('normalizeMessage: Einmal-Ansehen (Probe und optionales Speichern)', () => {
  const viewOnceImage = { viewOnceMessageV2: { message: { imageMessage: { mediaKey: key, directPath: '/d', url: 'https://x.whatsapp.net/y', fileSha256: Buffer.from('h'), caption: 'geheim', mimetype: 'image/jpeg' } } } }

  it('Standard (aus): nur Hinweis, aber mit Kennzeichnung und Ja/Nein-Probe, ohne Schluessel oder Inhalt', () => {
    const m = msgOf(rawMsg(viewOnceImage))
    assert.equal(m.type, 'system')
    assert.equal(m.text, PLACEHOLDER.viewOnceKind.image)
    assert.equal(m.viewOnce, true)
    assert.equal(m.media, undefined)
    assert.deepEqual(m.viewOnceProbe, { kind: 'image', hasKey: true, hasDirectPath: true, hasUrl: true, hasSha: true })
    assert.ok(!JSON.stringify(m).includes(key.toString('base64')), 'kein Schluessel in der Nachricht')
    assert.ok(!JSON.stringify(m).includes('geheim'), 'Bildunterschrift wird bei "aus" nicht uebernommen')
  })

  it('eingeschaltet und Schluessel vorhanden: wie ein normales Medium, aber als Einmal-Nachricht gekennzeichnet', () => {
    const m = msgOf(rawMsg(viewOnceImage), envOf({ storeViewOnce: true }))
    assert.equal(m.type, 'image')
    assert.equal(m.viewOnce, true)
    assert.equal(m.text, 'geheim')
    assert.equal(m.media?.kind, 'image')
    assert.equal(m.media?.descriptor.mediaKey, key.toString('base64'))
    const v = msgOf(rawMsg({ viewOnceMessage: { message: { audioMessage: { mediaKey: key, ptt: true, seconds: 5, viewOnce: true } } } }), envOf({ storeViewOnce: true }))
    assert.equal(v.type, 'voice')
    assert.equal(v.viewOnce, true)
    assert.equal(v.media?.kind, 'voice')
  })

  it('eingeschaltet, aber ohne Schluessel: bleibt beim Hinweis (die Probe zeigt es)', () => {
    const m = msgOf(rawMsg({ viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4' } } } }), envOf({ storeViewOnce: true }))
    assert.equal(m.type, 'system')
    assert.equal(m.text, PLACEHOLDER.viewOnceKind.video)
    assert.equal(m.viewOnceProbe?.hasKey, false)
  })

  it('normale Nachrichten haben weder Kennzeichnung noch Probe', () => {
    const m = msgOf(rawMsg({ imageMessage: { mediaKey: key } }))
    assert.equal(m.viewOnce, undefined)
    assert.equal(m.viewOnceProbe, undefined)
  })
})

describe('normalizeMessage: Erwaehnungen', () => {
  const text = (t: string, mentioned: string[]) =>
    rawMsg({ extendedTextMessage: { text: t, contextInfo: { mentionedJid: mentioned } } })

  it('ersetzt @Nummer durch den bekannten Namen, sonst durch die Telefonnummer; Unbekanntes und Fremdes bleibt', () => {
    const env = envOf({ nameOf: (j) => (j === '491701111111@s.whatsapp.net' ? 'Lisa' : undefined) })
    const m = msgOf(text('@491701111111 und @491702222222 und @999 bringt Kuchen mit', ['491701111111@s.whatsapp.net', '491702222222:7@s.whatsapp.net', '999@s.whatsapp.net']), env)
    assert.equal(m.text, '@Lisa und @+491702222222 und @999 bringt Kuchen mit')
  })

  it('LID-Erwaehnung wird ueber die Zuordnung aufgeloest; ohne Zuordnung bleibt der Text', () => {
    const env = envOf({ pnForLid: (l) => (l === '123456789012@lid' ? '491703333333@s.whatsapp.net' : undefined), nameOf: (j) => (j === '491703333333@s.whatsapp.net' ? 'Tom' : undefined) })
    assert.equal(msgOf(text('Hallo @123456789012!', ['123456789012@lid']), env).text, 'Hallo @Tom!')
    assert.equal(msgOf(text('Hallo @555555555555!', ['555555555555@lid']), env).text, 'Hallo @555555555555!')
  })

  it('eine laengere Nummer, die mit der gemeinten beginnt, wird nicht angefasst', () => {
    const env = envOf({ nameOf: () => 'Lisa' })
    assert.equal(msgOf(text('@49170111 und @491701119999', ['49170111@s.whatsapp.net']), env).text, '@Lisa und @491701119999')
  })

  it('ohne mentionedJid aendert sich nichts', () => {
    assert.equal(msgOf(rawMsg({ conversation: 'schreib an @4917011111 bitte' })).text, 'schreib an @4917011111 bitte')
  })
})

describe('normalizeMessage: Zitat-Kurztext und Bearbeitung', () => {
  const reply = (quotedMessage: any, extra: any = {}) =>
    rawMsg({ extendedTextMessage: { text: 'Antwort', contextInfo: { stanzaId: 'ORIG', quotedMessage, participant: '491709999999:5@s.whatsapp.net', ...extra } } })

  it('Text, Foto mit Unterschrift, Sprachnachricht, Dokument, Sticker', () => {
    const named = envOf({ nameOf: (j) => (j === '491709999999@s.whatsapp.net' ? 'Bert' : undefined) })
    const t = msgOf(reply({ conversation: 'Wann kommst du?' }), named)
    assert.deepEqual([t.replyTo, t.replyText, t.replySender, t.replyType], ['ORIG', 'Wann kommst du?', 'Bert', 'text'])
    const i = msgOf(reply({ imageMessage: { caption: 'See' } }), named)
    assert.deepEqual([i.replyText, i.replyType], ['See', 'image'])
    const v = msgOf(reply({ audioMessage: { seconds: 3 } }), named)
    assert.deepEqual([v.replyText, v.replyType], [undefined, 'voice'])
    const d = msgOf(reply({ documentMessage: { fileName: 'Rechnung.pdf' } }), named)
    assert.deepEqual([d.replyText, d.replyType], ['Rechnung.pdf', 'document'])
    const s = msgOf(reply({ stickerMessage: {} }), named)
    assert.equal(s.replyType, 'sticker')
  })

  it('Absender ohne bekannten Namen: Telefonnummer; ohne participant: kein Absender; ohne Zitat: nichts', () => {
    assert.equal(msgOf(reply({ conversation: 'x' })).replySender, '+491709999999')
    const noPart = msgOf(rawMsg({ extendedTextMessage: { text: 'A', contextInfo: { stanzaId: 'O', quotedMessage: { conversation: 'x' } } } }))
    assert.equal(noPart.replySender, undefined)
    const plain = msgOf(rawMsg({ conversation: 'hi' }))
    assert.deepEqual([plain.replyTo, plain.replyText, plain.replySender, plain.replyType], [undefined, undefined, undefined, undefined])
  })

  it('editedTextOf: Text, erweiterter Text, Unterschrift, Huelle; sonst undefined', () => {
    assert.equal(editedTextOf({ conversation: 'neu' }), 'neu')
    assert.equal(editedTextOf({ extendedTextMessage: { text: 'neu2' } }), 'neu2')
    assert.equal(editedTextOf({ imageMessage: { caption: 'Unterschrift' } }), 'Unterschrift')
    assert.equal(editedTextOf({ ephemeralMessage: { message: { conversation: 'in Huelle' } } }), 'in Huelle')
    assert.equal(editedTextOf({ audioMessage: {} }), undefined)
    assert.equal(editedTextOf(null), undefined)
  })
})

class Sink implements MediaSink {
  jobs: NewMediaJob[] = []
  enqueue(job: NewMediaJob): EnqueueResult {
    this.jobs.push(job)
    return 'queued'
  }
}

describe('MessageHandler: messages.update und Medien-Grund', () => {
  let env: TestEnv
  let sink: Sink
  let handler: MessageHandler
  const make = (patch: (c: TestEnv['cfg']) => void = () => {}): MessageHandler => {
    patch(env.cfg)
    return new MessageHandler({ db: env.db, jobs: env.jobs, media: sink, cfg: env.cfg, log: env.log, now: () => NOW })
  }
  const upsert = (id: string, message: any, over: Record<string, unknown> = {}) => ({
    type: 'notify',
    messages: [{ key: { id, remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 60, pushName: 'Anna', message, ...over }],
  })

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    sink = new Sink()
    handler = make()
  })
  afterEach(() => env.close())

  it('"fuer alle geloescht" (REVOKE): Nachricht bleibt, deleted=1, deleted_at, Ereignis; ein zweites Mal aendert den Zeitpunkt nicht', () => {
    handler.handleUpsert(upsert('m1', { conversation: 'Hallo' }))
    const revoke = (at: number) => [{ key: { id: 'm1', remoteJid: PN, fromMe: false }, update: { message: null, messageStubType: 1 } }, at]
    handler.handleUpdates([revoke(0)[0] as any])
    const m = one(env.db, 'SELECT text, deleted, deleted_at FROM messages WHERE id = ?', 'm1')
    assert.deepEqual(m, { text: 'Hallo', deleted: 1, deleted_at: NOW })
    const ev = all(env.db, "SELECT payload_json FROM events_outbox WHERE type = 'message_updated'")
    assert.deepEqual(JSON.parse(ev[0].payload_json), { messageId: 'm1' })
    handler.handleUpdates([revoke(1)[0] as any])
    assert.equal(one(env.db, 'SELECT deleted_at FROM messages WHERE id = ?', 'm1').deleted_at, NOW)
  })

  it('Bearbeitung: alte Fassung wird Version, neuer Text gilt; gleicher Text und unbekannte ID tun nichts; Protokoll ohne Inhalt', () => {
    handler.handleUpsert(upsert('m1', { conversation: 'erste Fassung' }))
    const edit = (text: string, ts: number) => ({
      key: { id: 'm1', remoteJid: PN, fromMe: false },
      update: { message: { editedMessage: { message: { conversation: text } } }, messageTimestamp: ts },
    })
    handler.handleUpdates([edit('zweite Fassung', NOW - 30), edit('zweite Fassung', NOW - 20), edit('dritte Fassung', NOW - 10)])
    handler.handleUpdates([{ key: { id: 'unbekannt' }, update: { message: { editedMessage: { message: { conversation: 'x' } } } } }])
    const m = one(env.db, 'SELECT text, edited, edited_at FROM messages WHERE id = ?', 'm1')
    assert.deepEqual(m, { text: 'dritte Fassung', edited: 1, edited_at: NOW - 10 })
    assert.deepEqual(
      all(env.db, 'SELECT version, text, replaced_at FROM message_versions WHERE message_id = ? ORDER BY version', 'm1'),
      [
        { version: 1, text: 'erste Fassung', replaced_at: NOW - 30 },
        { version: 2, text: 'zweite Fassung', replaced_at: NOW - 10 },
      ],
    )
    assert.equal(all(env.db, "SELECT 1 FROM events_outbox WHERE type = 'message_updated'").length, 2)
    assert.ok(!env.lines.join('\n').includes('Fassung'), 'Texte gehoeren nicht ins Journal')
  })

  it('andere Aktualisierungen (Zustell-/Lesestatus) werden ignoriert', () => {
    handler.handleUpsert(upsert('m1', { conversation: 'Hallo' }))
    handler.handleUpdates([{ key: { id: 'm1' }, update: { status: 4 } }, { key: {}, update: {} }, {} as any])
    handler.handleUpdates(undefined)
    assert.deepEqual(one(env.db, 'SELECT deleted, edited FROM messages WHERE id = ?', 'm1'), { deleted: 0, edited: 0 })
    assert.equal(all(env.db, "SELECT 1 FROM events_outbox WHERE type = 'message_updated'").length, 0)
  })

  it('Antwort speichert das Kurzzitat mit', () => {
    handler.handleUpsert(
      upsert('r1', { extendedTextMessage: { text: 'Antwort', contextInfo: { stanzaId: 'ORIG', quotedMessage: { conversation: 'Original' } } } }),
    )
    assert.deepEqual(one(env.db, 'SELECT reply_to, reply_text, reply_type FROM messages WHERE id = ?', 'r1'), {
      reply_to: 'ORIG',
      reply_text: 'Original',
      reply_type: 'text',
    })
  })

  it('Einmal-Probe steht im Journal (nur Ja/Nein); Einmal-Nachricht ist gekennzeichnet; bei "aus" gibt es keinen Download-Auftrag', () => {
    handler.handleUpsert(upsert('v1', { viewOnceMessageV2: { message: { imageMessage: { mediaKey: key, directPath: '/d' } } } }))
    const line = env.lines.find((l) => l.includes('viewonce_probe'))
    assert.ok(line, 'Probe fehlt')
    assert.match(line!, /"has_key":true/)
    assert.match(line!, /"has_direct_path":true/)
    assert.match(line!, /"stored":false/)
    assert.ok(!env.lines.join('\n').includes(key.toString('base64')))
    assert.deepEqual(one(env.db, 'SELECT type, view_once FROM messages WHERE id = ?', 'v1'), { type: 'system', view_once: 1 })
    assert.equal(sink.jobs.length, 0)
  })

  it('Einmal-Medium mit store_view_once: wird wie ein Medium eingereiht und bleibt gekennzeichnet', () => {
    handler = make((c) => {
      c.media.storeViewOnce = true
    })
    handler.handleUpsert(upsert('v2', { viewOnceMessageV2: { message: { imageMessage: { mediaKey: key, directPath: '/d', fileLength: 10 } } } }))
    assert.deepEqual(one(env.db, 'SELECT type, view_once FROM messages WHERE id = ?', 'v2'), { type: 'image', view_once: 1 })
    assert.equal(sink.jobs.length, 1)
    assert.match(env.lines.find((l) => l.includes('viewonce_probe'))!, /"stored":true/)
  })

  it('Verlaufsmedium: nicht geladen, aber ladbar (Schluessel zurueckgestellt); abgelaufenes: weder ladbar noch Schluessel', async () => {
    await handler.handleHistory({
      messages: [
        { key: { id: 'h1', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 3600, message: { imageMessage: { mediaKey: key, directPath: '/d', fileLength: 5 } } },
        { key: { id: 'h2', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 3 * 86_400 + 5, message: { imageMessage: { mediaKey: key, directPath: '/d' } } },
      ],
    })
    assert.deepEqual(one(env.db, 'SELECT status, skip_reason, loadable FROM media WHERE message_id = ?', 'h1'), { status: 'expired', skip_reason: 'history', loadable: 1 })
    assert.ok(env.jobs.getDeferred('h1'))
    assert.equal(sink.jobs.length, 0)

    // Medien-Aufbewahrung enger als Nachrichten-Aufbewahrung: Medium schon abgelaufen
    handler = make((c) => {
      c.retention = { messagesDays: 3, mediaDays: 1 }
    })
    await handler.handleHistory({
      messages: [{ key: { id: 'h3', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 2 * 86_400, message: { imageMessage: { mediaKey: key, directPath: '/d' } } }],
    })
    assert.deepEqual(one(env.db, 'SELECT status, skip_reason, loadable FROM media WHERE message_id = ?', 'h3'), { status: 'expired', skip_reason: 'retention', loadable: 0 })
    assert.equal(env.jobs.getDeferred('h3'), undefined)
  })
})

describe('MediaQueue: Grund, "Medium jetzt laden", Aufraeumen', () => {
  let env: TestEnv
  let queue: MediaQueue | undefined
  let downloads: DownloadTarget[]
  let behaviour: (target: DownloadTarget, call: number) => Promise<Readable>
  let expired: boolean

  const mk = (patch: Partial<QueueDeps> = {}): MediaQueue => {
    queue = new MediaQueue({
      db: env.db,
      jobs: env.jobs,
      cfg: env.cfg,
      log: env.log,
      download: (t) => {
        downloads.push(t)
        return behaviour(t, downloads.length)
      },
      isExpired: () => expired,
      ...patch,
    })
    return queue
  }

  beforeEach(() => {
    env = makeEnv((c) => {
      c.media.retryBaseMs = 10
      c.media.retryCapMs = 30
      c.media.stallTimeoutMs = 120
      c.media.maxRetries = 1
      c.media.maxBytes = { image: 100, voice: 100, video: 100, document: 100 }
      c.media.forceMaxBytes = 1000
      c.media.autoDownload = { image: true, voice: true, video: false, document: true }
    })
    downloads = []
    expired = false
    behaviour = async () => Readable.from([Buffer.from('x')])
    queue = undefined
  })
  afterEach(async () => {
    await queue?.stop(500)
    env.close()
  })

  function seed(id: string, kind: MediaKind, body: Buffer, over: Partial<MediaDescriptor> = {}, waTimestamp = NOW - 100): NewMediaJob {
    upsertChat(env.db, { id: PN, name: 'Anna', isGroup: false, lastActivityAt: waTimestamp })
    insertMessageIfNotExists(env.db, { id, chatId: PN, sender: 'Anna', waTimestamp, receivedAt: NOW, direction: 'in', type: kind === 'voice' ? 'voice' : kind })
    setMediaStatus(env.db, id, { status: 'pending' })
    return {
      messageId: id,
      chatId: PN,
      kind,
      waTimestamp,
      descriptor: {
        hkdfType: kind,
        mediaKey: Buffer.from('key').toString('base64'),
        directPath: '/d',
        url: null,
        fileSha256: sha(body),
        mimetype: 'image/jpeg',
        fileLength: body.length,
        fileName: null,
        seconds: null,
        ptt: false,
        ...over,
      },
    }
  }
  const media = (id: string) => one(env.db, 'SELECT status, skip_reason, loadable FROM media WHERE message_id = ?', id)

  it('Regel "aus": Status expired (wie bisher), Grund rule_off, ladbar, Schluessel zurueckgestellt; Auftrag nicht eingereiht', () => {
    const q = mk()
    const job = seed('v1', 'video', Buffer.alloc(50))
    assert.equal(q.enqueue(job), 'disabled')
    assert.deepEqual(media('v1'), { status: 'expired', skip_reason: 'rule_off', loadable: 1 })
    assert.ok(env.jobs.getDeferred('v1'))
    assert.equal(env.jobs.getJob('v1'), undefined)
    assert.equal(downloads.length, 0)
  })

  it('"Medium jetzt laden" holt auch Dateien ueber der Regel-Grenze (bis zum festen Hoechstmass) und raeumt den Zustand auf', async () => {
    const body = Buffer.alloc(500, 7) // Regel erlaubt 100, Hoechstmass 1000
    const q = mk()
    q.start()
    const job = seed('v1', 'video', body)
    assert.equal(q.enqueue(job), 'disabled')
    behaviour = async () => Readable.from([body])
    assert.equal(q.loadDeferred('v1'), 'queued')
    const during = media('v1')
    assert.ok(['pending', 'downloading'].includes(during.status), `Status waehrend des Ladens: ${during.status}`)
    assert.deepEqual([during.skip_reason, during.loadable], [null, 0])
    await until(() => media('v1').status === 'ready')
    await q.whenIdle()
    assert.deepEqual(media('v1'), { status: 'ready', skip_reason: null, loadable: 0 })
    assert.equal(env.jobs.getDeferred('v1'), undefined)
    assert.equal(env.jobs.getJob('v1'), undefined)
    const row = one(env.db, 'SELECT file_path FROM media WHERE message_id = ?', 'v1')
    assert.equal(fs.statSync(row.file_path).size, 500)
    // ohne ausdrueckliche Anforderung waere dieselbe Datei als zu gross abgebrochen worden
    assert.equal(downloads.length, 1)
  })

  it('zu gross laut Angabe: Grund too_large und ladbar, solange sie unter dem Hoechstmass liegt; darueber nicht ladbar', () => {
    const q = mk()
    assert.equal(q.enqueue(seed('i1', 'image', Buffer.alloc(300))), 'too_large')
    assert.deepEqual(media('i1'), { status: 'failed', skip_reason: 'too_large', loadable: 1 })
    assert.equal(q.enqueue(seed('i2', 'image', Buffer.alloc(2000))), 'too_large')
    assert.deepEqual(media('i2'), { status: 'failed', skip_reason: 'too_large', loadable: 0 })
    assert.equal(env.jobs.getDeferred('i2'), undefined)
  })

  it('Netzfehler nach allen Versuchen: failed, ladbar; abgelaufener Link (404): expired, nicht ladbar', async () => {
    behaviour = async () => {
      throw boom(500)
    }
    const q = mk()
    q.start()
    q.enqueue(seed('n1', 'image', Buffer.from('x')))
    await until(() => media('n1').status === 'failed')
    await q.whenIdle()
    assert.deepEqual(media('n1'), { status: 'failed', skip_reason: 'failed', loadable: 1 })
    assert.ok(env.jobs.getDeferred('n1'))
    behaviour = async () => {
      throw boom(404)
    }
    q.enqueue(seed('n2', 'image', Buffer.from('x')))
    await until(() => media('n2').status === 'expired')
    assert.deepEqual(media('n2'), { status: 'expired', skip_reason: 'link_expired', loadable: 0 })
    assert.equal(env.jobs.getDeferred('n2'), undefined)
  })

  it('loadDeferred: unbekannte Nachricht, fehlende Schluessel, Ablauf der Aufbewahrung, doppelter Aufruf', () => {
    const q = mk()
    assert.equal(q.loadDeferred('gibt-es-nicht'), 'gone')
    // loadable=1, aber keine Schluessel (z. B. Zustandsdatei verloren)
    seed('a', 'video', Buffer.alloc(5))
    setMediaStatus(env.db, 'a', { status: 'expired', skipReason: 'rule_off', loadable: true })
    assert.equal(q.loadDeferred('a'), 'no_keys')
    assert.equal(media('a').loadable, 0)
    // Aufbewahrung abgelaufen
    q.enqueue(seed('b', 'video', Buffer.alloc(5)))
    expired = true
    assert.equal(q.loadDeferred('b'), 'retention')
    assert.deepEqual(media('b'), { status: 'expired', skip_reason: 'retention', loadable: 0 })
    assert.equal(env.jobs.getDeferred('b'), undefined)
    // doppelt
    expired = false
    q.enqueue(seed('c', 'video', Buffer.alloc(5)))
    assert.equal(q.loadDeferred('c'), 'queued')
    assert.equal(q.loadDeferred('c'), 'duplicate')
  })

  it('geschuetzte Nachricht darf nach Ablauf der Medien-Aufbewahrung noch geladen werden', async () => {
    const body = Buffer.from('abc')
    const q = mk()
    q.start()
    q.enqueue(seed('p', 'video', body))
    env.db.prepare('UPDATE messages SET protected_at = ? WHERE id = ?').run(NOW, 'p')
    expired = true
    behaviour = async () => Readable.from([body])
    assert.equal(q.loadDeferred('p'), 'queued')
    await until(() => media('p').status === 'ready')
  })

  it('purgeDeferred: Schluessel zu geloeschten oder abgelaufenen Nachrichten verschwinden, geschuetzte bleiben; verwaiste loadable-Markierung wird zurueckgenommen', () => {
    const q = mk()
    for (const id of ['keep', 'old', 'prot', 'gone']) q.enqueue(seed(id, 'video', Buffer.alloc(5)))
    env.db.prepare('UPDATE messages SET protected_at = ? WHERE id = ?').run(NOW, 'prot')
    env.db.prepare("DELETE FROM media WHERE message_id = 'gone'").run()
    env.db.prepare("DELETE FROM messages WHERE id = 'gone'").run()
    // Alter und Schutz: isExpired entscheidet je Zeitstempel
    const q2 = mk({ isExpired: (ts) => ts === 1 })
    env.db.prepare("UPDATE messages SET wa_timestamp = 1 WHERE id IN ('old', 'prot')").run()
    env.jobs.upsertDeferred({ ...env.jobs.getDeferred('old')!, waTimestamp: 1 }, NOW) // bleibt unveraendert (ON CONFLICT)
    const jobsDb = env.jobs as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }
    jobsDb.db.prepare("UPDATE deferred_media SET wa_timestamp = 1 WHERE message_id IN ('old', 'prot')").run()
    // verwaiste Markierung
    seed('orphan', 'video', Buffer.alloc(5))
    setMediaStatus(env.db, 'orphan', { status: 'expired', skipReason: 'rule_off', loadable: true })

    const removed = q2.purgeDeferred()
    assert.equal(removed, 2, 'old und gone')
    assert.ok(env.jobs.getDeferred('keep'))
    assert.ok(env.jobs.getDeferred('prot'))
    assert.equal(env.jobs.getDeferred('old'), undefined)
    assert.deepEqual(media('old'), { status: 'expired', skip_reason: 'retention', loadable: 0 })
    assert.equal(media('orphan').loadable, 0)
    assert.equal(media('keep').loadable, 1)
    assert.equal(media('prot').loadable, 1)
  })
})

describe('IngestCommands', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.close())

  it('fuehrt load_media aus, quittiert jeden Befehl, meldet ungueltige und unbekannte; Protokoll ohne Inhalt', () => {
    const calls: string[] = []
    const queue = {
      loadDeferred: (id: string) => {
        calls.push(id)
        return id === 'boom' ? (() => { throw new Error('kaputt') })() : ('queued' as const)
      },
      purgeDeferred: () => 0,
    }
    const cmds = new IngestCommands({ db: env.db, queue, log: env.log, pollMs: 1000 })
    enqueueCommand(env.db, 'load_media', { messageId: 'm1' })
    enqueueCommand(env.db, 'load_media', { messageId: 42 })
    enqueueCommand(env.db, 'load_media', { messageId: 'boom' })
    enqueueCommand(env.db, 'unbekannt', {})
    cmds.poll()
    assert.deepEqual(calls, ['m1', 'boom'])
    assert.equal(listCommands(env.db).length, 0)
    const log = env.lines.join('\n')
    assert.match(log, /command_load_media/)
    assert.match(log, /command_invalid/)
    assert.match(log, /command_unknown/)
    assert.match(log, /command_load_media_failed/)
  })

  it('start: Aufraeumen und erster Durchlauf sofort, danach im Takt; stop beendet beides', () => {
    const sched = new FakeScheduler()
    let purged = 0
    const queue = { loadDeferred: () => 'queued' as const, purgeDeferred: () => (purged++, 0) }
    const cmds = new IngestCommands({ db: env.db, queue, log: env.log, pollMs: 1000, housekeepingMs: 5000, scheduler: sched })
    cmds.start()
    assert.equal(purged, 1)
    enqueueCommand(env.db, 'load_media', { messageId: 'x' })
    sched.advance(1000)
    assert.equal(listCommands(env.db).length, 0)
    sched.advance(5000)
    assert.ok(purged >= 2)
    cmds.stop()
    const before = purged
    sched.advance(20_000)
    assert.equal(purged, before)
  })
})
