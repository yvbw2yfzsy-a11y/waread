import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { insertMessageIfNotExists, upsertChat, setMediaStatus, setSetting } from '../src/dbClient.js'
import type { MediaDescriptor, NewMediaJob } from '../src/jobStore.js'
import {
  classifyFailure,
  extensionFor,
  MediaQueue,
  mediaDir,
  safeFileName,
  safeSegment,
  utcDate,
  type QueueDeps,
} from '../src/mediaQueue.js'
import type { MediaKind } from '../src/config.js'
import type { DownloadTarget } from '../src/waLib.js'
import { all, boom, makeEnv, one, type TestEnv } from './support/helpers.js'

const NOW = Math.floor(Date.now() / 1000)
const CHAT = '491701234567@s.whatsapp.net'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('base64')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('Zeitueberschreitung beim Warten')
    await sleep(5)
  }
}

describe('Hilfsfunktionen', () => {
  it('safeSegment macht aus beliebigem Text ein harmloses Pfadsegment', () => {
    assert.equal(safeSegment('../../etc/passwd'), '__.._etc_passwd')
    assert.equal(safeSegment('..'), '_')
    assert.equal(safeSegment(''), '_')
    assert.equal(safeSegment('a/b\\c'), 'a_b_c')
    assert.equal(safeSegment('491701234567@s.whatsapp.net'), '491701234567_s.whatsapp.net')
    assert.ok(safeSegment('x'.repeat(500)).length <= 80)
    for (const s of ['../x', '/abs', 'a\u0000b', '.hidden']) {
      const out = safeSegment(s)
      assert.ok(!out.includes('/') && !out.includes('\\') && !out.includes('\u0000') && !out.startsWith('.'), out)
    }
  })

  it('safeFileName behaelt Umlaute, entfernt Pfade und versteckte Dateien, kuerzt mit Endung', () => {
    assert.equal(safeFileName('Rechnung März.pdf'), 'Rechnung März.pdf')
    assert.equal(safeFileName('../../etc/passwd'), 'passwd')
    assert.equal(safeFileName('C:\\Users\\x\\evil.exe'), 'evil.exe')
    assert.equal(safeFileName('.bashrc'), '_bashrc')
    assert.equal(safeFileName(''), 'datei')
    assert.equal(safeFileName('a<b>:c|d.txt'), 'a_b__c_d.txt')
    const long = safeFileName('x'.repeat(300) + '.pdf')
    assert.ok(long.length <= 100 && long.endsWith('.pdf'))
  })

  it('extensionFor / utcDate / mediaDir', () => {
    assert.equal(extensionFor('image/jpeg', 'image'), '.jpg')
    assert.equal(extensionFor('audio/ogg; codecs=opus', 'voice'), '.ogg')
    assert.equal(extensionFor(null, 'voice'), '.ogg')
    assert.equal(extensionFor('application/x-weird', 'document'), '.bin')
    assert.equal(utcDate(1_800_000_000), '2027-01-15')
    assert.equal(mediaDir('/m', '49@s.whatsapp.net', 1_800_000_000), path.join('/m', '49_s.whatsapp.net', '2027-01-15'))
  })

  it('classifyFailure', () => {
    assert.deepEqual(classifyFailure(boom(404)), { retry: false, finalStatus: 'expired', code: 'http_404' })
    assert.deepEqual(classifyFailure(boom(410)), { retry: false, finalStatus: 'expired', code: 'http_410' })
    assert.deepEqual(classifyFailure(boom(403)), { retry: false, finalStatus: 'expired', code: 'http_403' })
    assert.deepEqual(classifyFailure(boom(400)), { retry: false, finalStatus: 'failed', code: 'http_400' })
    assert.deepEqual(classifyFailure(boom(500)), { retry: true, finalStatus: 'failed', code: 'http_500' })
    assert.deepEqual(classifyFailure(new Error('x')), { retry: true, finalStatus: 'failed', code: 'error' })
  })
})

describe('MediaQueue', () => {
  let env: TestEnv
  let queue: MediaQueue | undefined
  let downloads: DownloadTarget[]
  let behaviour: (target: DownloadTarget, call: number) => Promise<Readable>

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
      isExpired: () => false,
      ...patch,
    })
    return queue
  }

  beforeEach(() => {
    env = makeEnv((c) => {
      c.media.retryBaseMs = 15
      c.media.retryCapMs = 60
      c.media.stallTimeoutMs = 120
      c.media.maxRetries = 3
      c.media.maxBytes = { image: 1000, voice: 1000, video: 5000, document: 5000 }
      c.media.autoDownload = { image: true, voice: true, video: true, document: true }
    })
    downloads = []
    behaviour = async () => Readable.from([Buffer.from('x')])
    queue = undefined
  })
  afterEach(async () => {
    await queue?.stop(500)
    env.close()
  })

  /** Legt Chat, Nachricht und media-Zeile an (wie der Handler) und liefert den Auftrag. */
  function seed(
    id: string,
    kind: MediaKind,
    body: Buffer,
    over: Partial<MediaDescriptor> = {},
    waTimestamp = NOW - 100,
  ): NewMediaJob {
    upsertChat(env.db, { id: CHAT, name: 'Anna', isGroup: false, lastActivityAt: waTimestamp })
    const type = kind === 'voice' ? 'voice' : kind
    insertMessageIfNotExists(env.db, {
      id,
      chatId: CHAT,
      sender: 'Anna',
      waTimestamp,
      receivedAt: NOW,
      direction: 'in',
      type,
    })
    setMediaStatus(env.db, id, { status: 'pending' })
    const hkdf = { image: 'image', video: 'video', voice: 'audio', document: 'document' }[kind]
    return {
      messageId: id,
      chatId: CHAT,
      kind,
      waTimestamp,
      descriptor: {
        hkdfType: hkdf,
        mediaKey: Buffer.from('key').toString('base64'),
        directPath: '/d',
        url: null,
        fileSha256: sha(body),
        mimetype: kind === 'image' ? 'image/jpeg' : kind === 'voice' ? 'audio/ogg; codecs=opus' : 'application/pdf',
        fileLength: body.length,
        fileName: null,
        seconds: null,
        ptt: kind === 'voice',
        ...over,
      },
    }
  }

  const status = (id: string): string => one(env.db, 'SELECT status FROM media WHERE message_id = ?', id).status
  const events = (id: string): string[] =>
    all(env.db, "SELECT payload_json FROM events_outbox WHERE type = 'media_ready'")
      .map((r) => JSON.parse(r.payload_json))
      .filter((p) => p.messageId === id)
      .map((p) => p.status)

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  }

  it('Erfolgsfall: Datei an erwartetem Ort, Status ready, Ereignis, Auftrag samt Schluessel geloescht, kein .part', async () => {
    const body = Buffer.from('bilddaten'.repeat(10))
    behaviour = async () => Readable.from([body.subarray(0, 20), body.subarray(20)])
    const q = mk({ thumbnail: async () => ({ format: 'png' }) })
    q.start()
    assert.equal(q.enqueue(seed('img1', 'image', body)), 'queued')
    await until(() => status('img1') === 'ready')
    await q.whenIdle()

    const row = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'img1')
    assert.ok(row.file_path.startsWith(env.cfg.paths.mediaDir))
    assert.ok(row.file_path.endsWith('img1.jpg'))
    assert.deepEqual(fs.readFileSync(row.file_path), body)
    assert.equal(row.size_bytes, body.length)
    assert.equal(row.mime_type, 'image/png', 'MIME kommt aus dem Inhalt (Thumbnail-Format), nicht vom Absender')
    assert.ok(row.thumbnail_path.endsWith('img1.thumb.jpg'))
    assert.equal(fs.statSync(row.file_path).mode & 0o077, 0, 'Mediendatei nur fuer den Dienstbenutzer')
    assert.deepEqual(events('img1'), ['ready'])
    assert.equal(env.jobs.getJob('img1'), undefined, 'Schluessel werden nach Abschluss nicht aufbewahrt')
    assert.deepEqual(walk(env.cfg.paths.mediaDir).filter((f) => f.endsWith('.part')), [])
    // Entschluesselungsparameter kamen aus dem Deskriptor
    assert.equal(downloads[0]!.hkdfType, 'image')
    assert.equal(Buffer.from(downloads[0]!.mediaKey).toString(), 'key')
  })

  it('hoechstens 2 gleichzeitige Downloads, alle werden abgearbeitet (FIFO)', async () => {
    let running = 0
    let peak = 0
    const gate: (() => void)[] = []
    behaviour = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>((r) => gate.push(r))
      running--
      return Readable.from([Buffer.from('x')])
    }
    const q = mk()
    q.start()
    for (let i = 0; i < 5; i++) {
      const j = seed(`m${i}`, 'image', Buffer.from('x'))
      assert.equal(q.enqueue(j), 'queued')
    }
    await until(() => gate.length === 2)
    await sleep(40)
    assert.equal(gate.length, 2, 'es laufen genau 2, nicht mehr')
    assert.deepEqual(q.size, { waiting: 3, active: 2 })
    while (all(env.db, "SELECT 1 FROM media WHERE status = 'ready'").length < 5) {
      gate.splice(0).forEach((g) => g())
      await sleep(10)
    }
    assert.equal(peak, 2)
  })

  it('angegebene Laenge ueber dem Limit: sofort "failed", kein Download', async () => {
    const q = mk()
    q.start()
    const big = Buffer.alloc(1001)
    assert.equal(q.enqueue(seed('big', 'image', big)), 'too_large')
    assert.equal(status('big'), 'failed')
    assert.equal(downloads.length, 0)
    assert.deepEqual(events('big'), ['failed'])
  })

  it('Limit je Medienart: Video darf groesser sein als Bild', async () => {
    const q = mk()
    q.start()
    const body = Buffer.alloc(3000, 1)
    assert.equal(q.enqueue(seed('vid', 'video', body)), 'queued')
    behaviour = async () => Readable.from([body])
    await until(() => status('vid') === 'ready')
  })

  it('tatsaechlich groesser als angegeben: Abbruch mitten im Strom, failed, ohne Wiederholung, keine Reste', async () => {
    const body = Buffer.alloc(2500, 7)
    const j = seed('liar', 'image', Buffer.alloc(10), { fileLength: 10, fileSha256: null })
    behaviour = async () => Readable.from([body.subarray(0, 800), body.subarray(800, 1600), body.subarray(1600)])
    const q = mk()
    q.start()
    q.enqueue(j)
    await until(() => status('liar') === 'failed')
    await q.whenIdle()
    assert.equal(downloads.length, 1, 'zu gross wird nicht wiederholt')
    assert.deepEqual(walk(env.cfg.paths.mediaDir), [])
  })

  it('Pruefsumme falsch: wiederholt bis zum Limit (1 + 3 Versuche), dann failed', async () => {
    const body = Buffer.from('echt')
    behaviour = async () => Readable.from([Buffer.from('falsch')])
    const q = mk()
    q.start()
    q.enqueue(seed('h', 'image', body))
    await until(() => status('h') === 'failed', 5000)
    assert.equal(downloads.length, 4)
    assert.deepEqual(walk(env.cfg.paths.mediaDir), [])
    assert.equal(env.jobs.getJob('h'), undefined)
  })

  it('404 -> sofort "expired", genau ein Versuch', async () => {
    behaviour = async () => {
      throw boom(404)
    }
    const q = mk()
    q.start()
    q.enqueue(seed('gone', 'image', Buffer.from('x')))
    await until(() => status('gone') === 'expired')
    await q.whenIdle()
    assert.equal(downloads.length, 1)
    assert.deepEqual(events('gone'), ['expired'])
  })

  it('F01: abgewiesenes Medienziel -> failed ohne Wiederholung, Code bad_target, keine URL im Log', async () => {
    const { DownloadTargetError } = (await import('../src/waLib.js')) as any
    behaviour = async () => {
      throw new DownloadTargetError('url_host')
    }
    const q = mk()
    q.start()
    q.enqueue(seed('evil', 'image', Buffer.from('x'), { url: 'https://evil.example/geheimer-pfad-4711' }))
    await until(() => status('evil') === 'failed')
    await q.whenIdle()
    assert.equal(downloads.length, 1, 'keine Wiederholung')
    const log = env.lines.join('\n')
    assert.ok(log.includes('bad_target'), 'Ablehnung wird gezaehlt/sichtbar (nur Code)')
    assert.ok(!log.includes('evil.example') && !log.includes('geheimer-pfad-4711'), 'URL gehoert nicht ins Journal')
  })

  it('kein Medienschluessel -> failed ohne Download', async () => {
    const q = mk()
    q.start()
    q.enqueue(seed('nokey', 'image', Buffer.from('x'), { mediaKey: '' }))
    await until(() => status('nokey') === 'failed')
    assert.equal(downloads.length, 0)
  })

  it('voruebergehender Fehler: nach Wiederholung erfolgreich; Wartezeit blockiert andere Jobs nicht', async () => {
    env.cfg.media.maxConcurrentDownloads = 1
    env.cfg.media.retryBaseMs = 200
    env.cfg.media.retryCapMs = 400
    const body = Buffer.from('ok')
    behaviour = async (_t, call) => {
      if (call === 1) throw boom(500)
      return Readable.from([body])
    }
    const q = mk()
    q.start()
    q.enqueue(seed('flaky', 'image', body))
    q.enqueue(seed('other', 'image', body))
    await until(() => status('other') === 'ready')
    assert.notEqual(status('flaky'), 'ready', 'flaky wartet noch auf seine Wiederholung, other ist schon fertig')
    await until(() => status('flaky') === 'ready', 5000)
    assert.equal(downloads.length, 3)
  })

  it('Stillstand (kein Byte) -> Abbruch nach stallTimeoutMs und Wiederholung', async () => {
    const body = Buffer.from('spaet')
    behaviour = async (_t, call) => {
      if (call === 1) return new Readable({ read() {} }) // liefert nie etwas
      return Readable.from([body])
    }
    const q = mk()
    q.start()
    q.enqueue(seed('stall', 'image', body))
    await until(() => status('stall') === 'ready', 5000)
    assert.equal(downloads.length, 2)
  })

  it('Stillstand schon beim Verbindungsaufbau (download() haengt)', async () => {
    const body = Buffer.from('spaet')
    behaviour = async (_t, call) => {
      if (call === 1) return new Promise<Readable>(() => {})
      return Readable.from([body])
    }
    const q = mk()
    q.start()
    q.enqueue(seed('hang', 'image', body))
    await until(() => status('hang') === 'ready', 5000)
  })

  it('Warteschlange voll -> queue_full, Status failed', () => {
    env.cfg.media.maxQueueLength = 2
    const q = mk() // nicht gestartet: nichts wird abgearbeitet
    assert.equal(q.enqueue(seed('a', 'image', Buffer.from('x'))), 'queued')
    assert.equal(q.enqueue(seed('b', 'image', Buffer.from('x'))), 'queued')
    assert.equal(q.enqueue(seed('c', 'image', Buffer.from('x'))), 'queue_full')
    assert.equal(status('c'), 'failed')
  })

  it('doppelt eingereihte Nachricht -> duplicate', () => {
    const q = mk()
    const j = seed('a', 'image', Buffer.from('x'))
    assert.equal(q.enqueue(j), 'queued')
    assert.equal(q.enqueue(j), 'duplicate')
    assert.equal(env.jobs.countJobs(), 1)
  })

  it('automatischer Download je Medienart abschaltbar -> disabled, Status expired (kein ewiges "wird geladen")', () => {
    env.cfg.media.autoDownload.video = false
    const q = mk()
    assert.equal(q.enqueue(seed('v', 'video', Buffer.from('x'))), 'disabled')
    assert.equal(status('v'), 'expired')
    assert.deepEqual(events('v'), ['expired'])
    assert.equal(env.jobs.countJobs(), 0)
  })

  it('Download-Regeln aus der settings-Tabelle (Oberflaeche) haben Vorrang vor config.toml', async () => {
    setSetting(
      env.db,
      'downloadRules',
      JSON.stringify({ image: { mode: 'off', maxMb: 5 }, voice: { mode: 'auto', maxMb: 1 }, video: { mode: 'auto', maxMb: 1 } }),
    )
    const q = mk()
    q.start()
    assert.equal(q.enqueue(seed('img', 'image', Buffer.from('x'))), 'disabled', 'image: mode off')
    assert.equal(status('img'), 'expired')
    // video steht in der Konfiguration auf true; die Regel "auto, 1 MB" gilt ebenfalls, 2 MB sind zu gross
    const big = seed('vid', 'video', Buffer.from('x'), { fileLength: 2 * 1024 * 1024 })
    assert.equal(q.enqueue(big), 'too_large')
    assert.equal(status('vid'), 'failed')
    // document: keine Regel gespeichert -> Konfigurationswerte
    const doc = Buffer.from('dokument')
    behaviour = async () => Readable.from([doc])
    assert.equal(q.enqueue(seed('doc', 'document', doc)), 'queued')
    await until(() => status('doc') === 'ready')
  })

  it('Neustart: unterbrochener Job wird aus dem JobStore fortgesetzt', async () => {
    const body = Buffer.from('nach-dem-absturz')
    const j = seed('crash', 'image', body)
    env.jobs.upsertJob(j, NOW)
    env.jobs.recordAttempt('crash', 1, 0)
    setMediaStatus(env.db, 'crash', { status: 'downloading' })

    behaviour = async () => Readable.from([body])
    const q = mk()
    const rec = q.recover()
    assert.deepEqual(rec, { requeued: 1, expired: 0, unrecoverable: 0 })
    q.start()
    await until(() => status('crash') === 'ready')
  })

  it('Neustart: "downloading" ohne Auftrag (Deskriptor verloren) -> failed mit Ereignis', () => {
    seed('orphan', 'image', Buffer.from('x'))
    setMediaStatus(env.db, 'orphan', { status: 'downloading' })
    const q = mk()
    const rec = q.recover()
    assert.equal(rec.unrecoverable, 1)
    assert.equal(status('orphan'), 'failed')
    assert.deepEqual(events('orphan'), ['failed'])
  })

  it('Neustart: Auftrag, dessen Nachricht inzwischen geloescht wurde, verschwindet; abgelaufene werden expired', () => {
    const gone = seed('gone', 'image', Buffer.from('x'))
    env.jobs.upsertJob(gone, NOW)
    env.db.prepare('DELETE FROM media WHERE message_id = ?').run('gone')
    env.db.prepare('DELETE FROM messages WHERE id = ?').run('gone')
    const old = seed('old', 'image', Buffer.from('x'), {}, NOW - 10 * 86_400)
    env.jobs.upsertJob(old, NOW)
    const q = mk({ isExpired: (ts) => ts < NOW - 86_400 })
    const rec = q.recover()
    assert.equal(rec.expired, 1)
    assert.equal(rec.requeued, 0)
    assert.equal(env.jobs.countJobs(), 0)
    assert.equal(status('old'), 'expired')
  })

  it('Nachricht waehrend des Downloads geloescht (Aufbewahrung): Datei wird wieder entfernt', async () => {
    const body = Buffer.from('wird-geloescht')
    let release!: () => void
    behaviour = async () => {
      await new Promise<void>((r) => (release = r))
      return Readable.from([body])
    }
    const q = mk()
    q.start()
    q.enqueue(seed('del', 'image', body))
    await until(() => typeof release === 'function')
    env.db.prepare('DELETE FROM media WHERE message_id = ?').run('del')
    env.db.prepare('DELETE FROM messages WHERE id = ?').run('del')
    release()
    await until(() => env.jobs.getJob('del') === undefined)
    await q.whenIdle()
    assert.deepEqual(walk(env.cfg.paths.mediaDir), [])
  })

  it('Pfade: Dokumentname mit "../" bleibt im Medienverzeichnis, Chat-ID wird bereinigt', async () => {
    const body = Buffer.from('pdf')
    behaviour = async () => Readable.from([body])
    const q = mk()
    q.start()
    q.enqueue(seed('doc', 'document', body, { fileName: '../../../etc/cron.d/evil' }))
    await until(() => status('doc') === 'ready')
    const p = one(env.db, 'SELECT file_path FROM media WHERE message_id = ?', 'doc').file_path as string
    assert.ok(path.resolve(p).startsWith(path.resolve(env.cfg.paths.mediaDir) + path.sep))
    assert.ok(!p.includes('..'))
    assert.ok(p.endsWith('doc__evil'))
  })

  it('Sprachnachricht: Umwandlung ersetzt das Original; bei Fehler bleibt das Original', async () => {
    const body = Buffer.from('opus-daten')
    behaviour = async () => Readable.from([body])

    const q1 = mk({
      convertVoice: async (_src, dest) => {
        fs.writeFileSync(dest, 'aac')
      },
    })
    q1.start()
    q1.enqueue(seed('v1', 'voice', body, { seconds: 4 }))
    await until(() => status('v1') === 'ready')
    let row = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'v1')
    assert.ok(row.file_path.endsWith('v1.m4a'))
    assert.equal(row.mime_type, 'audio/mp4')
    assert.equal(row.duration_seconds, 4)
    assert.deepEqual(walk(path.dirname(row.file_path)).map((f) => path.basename(f)), ['v1.m4a'], 'Original ist ersetzt')
    await q1.stop(500)

    const q2 = mk({
      convertVoice: async () => {
        throw new Error('ffmpeg kaputt')
      },
    })
    q2.start()
    q2.enqueue(seed('v2', 'voice', body))
    await until(() => status('v2') === 'ready')
    row = one(env.db, 'SELECT * FROM media WHERE message_id = ?', 'v2')
    assert.ok(row.file_path.endsWith('v2.ogg'))
    assert.deepEqual(fs.readFileSync(row.file_path), body)
    assert.equal(row.mime_type, 'audio/ogg')
  })

  it('Sprachnachricht, die schon AAC/MP4 ist, wird nicht umgewandelt', async () => {
    const body = Buffer.from('m4a')
    behaviour = async () => Readable.from([body])
    let called = 0
    const q = mk({ convertVoice: async () => void called++ })
    q.start()
    q.enqueue(seed('v', 'voice', body, { mimetype: 'audio/mp4' }))
    await until(() => status('v') === 'ready')
    assert.equal(called, 0)
  })

  it('Vorschaufehler macht den Download nicht ungueltig', async () => {
    const body = Buffer.from('kein-bild')
    behaviour = async () => Readable.from([body])
    const q = mk({
      thumbnail: async () => {
        throw new Error('kein Bild')
      },
    })
    q.start()
    q.enqueue(seed('t', 'image', body))
    await until(() => status('t') === 'ready')
    assert.equal(one(env.db, 'SELECT thumbnail_path FROM media WHERE message_id = ?', 't').thumbnail_path, null)
  })

  it('stop() wartet auf laufende Downloads und beendet sich auch bei haengendem Job nach dem Zeitlimit', async () => {
    let fail!: (e: Error) => void
    behaviour = () => new Promise<Readable>((_, rej) => (fail = rej))
    env.cfg.media.stallTimeoutMs = 5000
    const q = mk()
    q.start()
    q.enqueue(seed('x', 'image', Buffer.from('x')))
    await until(() => q.size.active === 1)
    const t0 = Date.now()
    await q.stop(150)
    assert.ok(Date.now() - t0 < 1000)
    assert.equal(env.jobs.getJob('x')?.messageId, 'x', 'Auftrag bleibt fuer den naechsten Start erhalten')
    fail(boom(404)) // Aufraeumen: haengenden Job beenden, bevor die Testumgebung geschlossen wird
    await q.whenIdle()
  })

  it('run() wirft nie, auch wenn der Zustandsspeicher beim Herunterfahren schon zu ist', async () => {
    let fail!: (e: Error) => void
    behaviour = () => new Promise<Readable>((_, rej) => (fail = rej))
    const q = mk()
    q.start()
    q.enqueue(seed('y', 'image', Buffer.from('x')))
    await until(() => typeof fail === 'function')
    const rejections: unknown[] = []
    const onRej = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      env.jobs.close() // simuliert: DBs wurden vor Ende des Jobs geschlossen
      fail(boom(500))
      await sleep(100)
    } finally {
      process.off('unhandledRejection', onRej)
    }
    assert.deepEqual(rejections, [])
  })

  it('keine Inhalte im Log: weder Dateinamen noch Pfade', async () => {
    const body = Buffer.from('pdf')
    behaviour = async () => Readable.from([body])
    const q = mk()
    q.start()
    q.enqueue(seed('doc', 'document', body, { fileName: 'Geheim-Dateiname-4711.pdf' }))
    await until(() => status('doc') === 'ready')
    const log = env.lines.join('\n')
    assert.ok(log.length > 0)
    assert.ok(!log.includes('Geheim-Dateiname-4711'))
    assert.ok(!log.includes(env.cfg.paths.mediaDir))
  })
})
