import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import sharp from 'sharp'
import { openAuthStore, type AuthStore } from '../src/authStore.js'
import { getSetting, setSetting } from '../src/dbClient.js'
import { createService, type Service } from '../src/service.js'
import type { DownloadTarget } from '../src/waLib.js'
import { all, boom, FakeLib, fakeAuthLib, makeEnv, one, type TestEnv } from './support/helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitueberschreitung beim Warten')
    await sleep(5)
  }
}

const PN = '491701234567@s.whatsapp.net'

/** Gesamtweg mit gefaelschter Bibliothek: Ereignis -> Normalisierung -> Datenbank -> Download -> Vorschau -> fertig. */
describe('Gesamtweg (ohne WhatsApp-Netz, echte Datenbank/Dateien/sharp)', () => {
  let env: TestEnv
  let lib: FakeLib & { downloadMedia: (t: DownloadTarget) => Promise<Readable> }
  let auth: AuthStore
  let service: Service
  let payloads: Map<string, Buffer>

  beforeEach(() => {
    env = makeEnv((c) => {
      c.media.retryBaseMs = 10
      c.media.retryCapMs = 30
    })
    payloads = new Map()
    const base = new FakeLib()
    lib = Object.assign(base, {
      downloadMedia: async (t: DownloadTarget) => {
        const body = payloads.get(Buffer.from(t.mediaKey).toString())
        if (!body) throw boom(404)
        return Readable.from([body.subarray(0, 10), body.subarray(10)])
      },
    })
    auth = openAuthStore(path.join(env.cfg.paths.authDir, 'auth.db'), fakeAuthLib)
    auth.state.creds.me = { id: '491700000000:1@s.whatsapp.net' }
    auth.saveCreds()
    service = createService({ cfg: env.cfg, log: env.log, lib, db: env.db, jobs: env.jobs, auth, ffmpegOk: false })
  })
  afterEach(async () => {
    try {
      await service.stop()
      assert.deepEqual(lib.unexpectedCalls, [], 'F18/S1: unzulaessiger Zugriff auf den Socket')
    } finally {
      auth.close()
      env.close()
    }
  })

  const status = (id: string): string | undefined => one(env.db, 'SELECT status FROM media WHERE message_id = ?', id)?.status

  async function jpeg(w: number, h: number): Promise<Buffer> {
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer()
  }
  const now = () => Math.floor(Date.now() / 1000)

  it('Text und Bild laufen komplett durch; Medium und Vorschau liegen unter dem Medienverzeichnis', async () => {
    service.start()
    const sock = lib.last
    sock.emit('connection.update', { connection: 'open' })
    assert.equal(getSetting(env.db, 'connection.status'), 'connected')

    const img = await jpeg(800, 400)
    payloads.set('schluessel-1', img)
    sock.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { id: 'T1', remoteJid: PN }, messageTimestamp: now(), pushName: 'Anna', message: { conversation: 'Hallo!' } },
        {
          key: { id: 'I1', remoteJid: PN },
          messageTimestamp: now(),
          pushName: 'Anna',
          message: {
            imageMessage: {
              caption: 'Schau mal',
              mimetype: 'image/jpeg',
              mediaKey: Buffer.from('schluessel-1'),
              fileSha256: createHash('sha256').update(img).digest(),
              fileLength: img.length,
              directPath: '/d',
            },
          },
        },
      ],
    })

    assert.equal(one(env.db, 'SELECT text FROM messages WHERE id = ?', 'T1').text, 'Hallo!')
    await until(() => status('I1') === 'ready')
    await service.queue.whenIdle()

    const media = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'I1')
    assert.ok(media.file_path.startsWith(env.cfg.paths.mediaDir))
    assert.deepEqual(fs.readFileSync(media.file_path), img)
    const thumb = await sharp(media.thumbnail_path).metadata()
    assert.equal(Math.min(thumb.width!, thumb.height!), 200)
    assert.equal(media.mime_type, 'image/jpeg')

    const types = all(env.db, 'SELECT type, payload_json FROM events_outbox ORDER BY id').map((r) => r.type)
    assert.ok(types.includes('connection_status'))
    assert.equal(types.filter((t) => t === 'new_message').length, 2)
    assert.ok(types.includes('media_ready'))
  })

  it('abgemeldet: Sitzung weg, Status needs_qr, keine Wiederverbindung ohne Befehl', async () => {
    service.start()
    const sock = lib.last
    sock.emit('connection.update', { connection: 'open' })
    sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(401) } })
    assert.equal(getSetting(env.db, 'connection.status'), 'needs_qr')
    assert.equal(getSetting(env.db, 'connection.reason'), 'logged_out')
    assert.equal(auth.isPaired(), false)
    await sleep(100)
    assert.equal(lib.sockets.length, 1)
  })

  it('F14: Abmelden leert Namen und LID-Zuordnung des alten Kontos', async () => {
    env.jobs.upsertName(PN, 'Alte Anna', 3)
    env.jobs.setLidMapping('123456789@lid', PN)
    service.start()
    lib.last.emit('connection.update', { connection: 'open' })
    assert.equal(env.jobs.getName(PN), 'Alte Anna', 'waehrend der Sitzung bleiben sie')
    lib.last.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(401) } })
    assert.equal(env.jobs.getName(PN), undefined)
    assert.equal(env.jobs.pnForLid('123456789@lid'), undefined)
  })

  it('F14: der vom Web gesetzte Befehl "clear_identity" (Speicher leeren -> alles) wirkt beim Start und im Betrieb', async () => {
    env.jobs.upsertName(PN, 'Alte Anna', 3)
    setSetting(env.db, 'ingest.state_command', 'clear_identity')
    service.start()
    assert.equal(env.jobs.getName(PN), undefined, 'vor dem Start gesetzt: sofort')
    env.jobs.upsertName(PN, 'Neue Anna', 3)
    setSetting(env.db, 'ingest.state_command', 'clear_identity')
    await until(() => env.jobs.getName(PN) === undefined, 6000)
    assert.equal(getSetting(env.db, 'ingest.state_command'), '')
  })

  it('der Dienst nutzt vom Socket nur ev.on/ev.off/end (Methodenaufrufe auf dem Socket wuerden hier scheitern)', async () => {
    service.start()
    const sock = lib.last
    assert.deepEqual(Object.keys(sock).sort(), ['ended', 'endError', 'ev', 'handlers'].sort())
    // Alle abonnierten Ereignisse sind reine Empfangsereignisse
    const events = [...sock.handlers.keys()].sort()
    assert.deepEqual(events, [
      'chats.update',
      'chats.upsert',
      'connection.update',
      'contacts.update',
      'contacts.upsert',
      'creds.update',
      'groups.update',
      'groups.upsert',
      'lid-mapping.update',
      'messages.upsert',
      'messaging-history.set',
    ])
    await service.stop()
    assert.equal(sock.ended, true)
    assert.equal(sock.endError, undefined)
  })
})
