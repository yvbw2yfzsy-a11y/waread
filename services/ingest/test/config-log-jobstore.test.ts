import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { defaultConfig, loadConfig } from '../src/config.js'
import { JobStore, NAME_RANK, type NewMediaJob } from '../src/jobStore.js'
import { createLogger, errorFields } from '../src/log.js'
import { makeTmpDir, useNodeSqlite } from './support/helpers.js'

describe('config', () => {
  const load = (toml: string | null, env: NodeJS.ProcessEnv = {}) => loadConfig({ env, loadText: () => toml })

  it('fehlende Datei -> Standardwerte (Zielstruktur /var/lib/waread, 3 Tage, 2 Downloads, 10/50 MB)', () => {
    const c = load(null)
    assert.deepEqual(c, defaultConfig())
    assert.equal(c.paths.authDir, '/var/lib/waread/auth')
    assert.equal(c.media.maxConcurrentDownloads, 2)
    assert.equal(c.media.maxBytes.image, 10 * 1024 * 1024)
    assert.equal(c.media.maxBytes.video, 50 * 1024 * 1024)
    assert.equal(c.media.autoDownload.video, false, 'Video ist wie in der Oberflaeche standardmaessig aus')
    assert.equal(c.connection.backoffStartMs, 5_000)
    assert.equal(c.connection.backoffCapMs, 600_000)
  })

  it('leere Datei -> Standardwerte', () => {
    assert.deepEqual(load(''), defaultConfig())
  })

  it('Werte aus [paths], [retention], [ingest] werden uebernommen', () => {
    const c = load(`
[paths]
db = "/srv/w/db/waread.db"
auth_dir = "/srv/w/auth"
media_dir = "/srv/w/media"
[retention]
messages_days = 7
media_days = 1
[ingest]
max_concurrent_downloads = 1
max_mb_image = 8
max_mb_video = 100.5
auto_download_video = false
thumbnail_short_side = 256
convert_voice = false
backoff_start_seconds = 2
backoff_cap_seconds = 120
log_level = "warn"
`)
    assert.equal(c.paths.db, '/srv/w/db/waread.db')
    assert.equal(c.paths.stateDb, '/srv/w/db/ingest-state.db', 'privater Zustandsspeicher liegt neben der Datenbank')
    assert.equal(c.paths.authDir, '/srv/w/auth')
    assert.deepEqual(c.retention, { messagesDays: 7, mediaDays: 1 })
    assert.equal(c.media.maxConcurrentDownloads, 1)
    assert.equal(c.media.maxBytes.image, 8 * 1024 * 1024)
    assert.equal(c.media.maxBytes.video, Math.floor(100.5 * 1024 * 1024))
    assert.equal(c.media.autoDownload.video, false)
    assert.equal(c.media.autoDownload.image, true)
    assert.equal(c.media.thumbnailShortSide, 256)
    assert.equal(c.media.convertVoice, false)
    assert.equal(c.connection.backoffStartMs, 2_000)
    assert.equal(c.connection.backoffCapMs, 120_000)
    assert.equal(c.logLevel, 'warn')
  })

  it('unbekannte Abschnitte/Schluessel (z. B. fuer andere Dienste) stoeren nicht', () => {
    const c = load(`[web]\nport = 8080\n[ingest]\nzukunft = 1\n`)
    assert.deepEqual(c, defaultConfig())
  })

  const bad: [string, string][] = [
    ['messages_days = 0', '[retention]'],
    ['messages_days = 999', '[retention]'],
    ['messages_days = "3"', '[retention]'],
    ['max_concurrent_downloads = 0', '[ingest]'],
    ['max_concurrent_downloads = 50', '[ingest]'],
    ['log_level = "laut"', '[ingest]'],
    ['auto_download_image = "ja"', '[ingest]'],
    ['backoff_start_seconds = 100\nbackoff_cap_seconds = 50', '[ingest]'],
    ['max_mb_image = -1', '[ingest]'],
  ]
  for (const [line, section] of bad) {
    it(`ungueltig: ${line.replace(/\n/g, ' / ')}`, () => {
      assert.throws(() => load(`${section}\n${line}\n`), /config:/)
    })
  }

  it('kaputtes TOML: Fehler zitiert den Dateiinhalt nicht', () => {
    assert.throws(
      () => load('[ingest\ngeheim-4711 = ='),
      (e: Error) => /kein gueltiges TOML/.test(e.message) && !e.message.includes('geheim-4711'),
    )
  })

  it('WAREAD_CONFIG bestimmt den Pfad', () => {
    let asked = ''
    loadConfig({ env: { WAREAD_CONFIG: '/x/y.toml' }, loadText: (p) => ((asked = p), null) })
    assert.equal(asked, '/x/y.toml')
    loadConfig({ env: {}, loadText: (p) => ((asked = p), null) })
    assert.equal(asked, '/etc/waread/config.toml')
  })

  it('echte Datei wird gelesen; fehlende Datei ist kein Fehler', () => {
    const tmp = makeTmpDir()
    try {
      const f = path.join(tmp.dir, 'c.toml')
      fs.writeFileSync(f, '[retention]\nmessages_days = 5\n')
      assert.equal(loadConfig({ path: f }).retention.messagesDays, 5)
      assert.equal(loadConfig({ path: path.join(tmp.dir, 'fehlt.toml') }).retention.messagesDays, 3)
    } finally {
      tmp.cleanup()
    }
  })
})

describe('log', () => {
  const run = (fn: (l: ReturnType<typeof createLogger>) => void, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    const lines: string[] = []
    fn(createLogger({ level, write: (s) => lines.push(s), base: { svc: 't' } }))
    return lines.map((l) => JSON.parse(l))
  }

  it('Format: JSON mit lvl, ev und Feldern; Basisfelder werden ergaenzt', () => {
    const [r] = run((l) => l.info('media_ready', { msg_id: 'abc', bytes: 12 }))
    assert.deepEqual(r, { lvl: 'info', ev: 'media_ready', svc: 't', msg_id: 'abc', bytes: 12 })
  })

  it('Stufen werden gefiltert', () => {
    assert.equal(run((l) => l.debug('x_y'), 'info').length, 0)
    assert.equal(run((l) => l.warn('x_y'), 'error').length, 0)
    assert.equal(run((l) => l.error('x_y'), 'error').length, 1)
  })

  it('verdaechtige Felder werden maskiert (Inhalte, Namen, Pfade, QR)', () => {
    const [r] = run((l) =>
      l.info('test_event', {
        text: 'geheim',
        Caption: 'geheim',
        filename: 'a.pdf',
        name: 'Anna',
        path: '/var/lib/waread/media/x',
        url: 'https://x',
        qr: '2@abc',
        sender: 'Anna',
        phone: '+49',
        msg_id: 'ok',
      }),
    )
    for (const k of ['text', 'Caption', 'filename', 'name', 'path', 'url', 'qr', 'sender', 'phone']) {
      assert.equal(r[k], '[redacted]', k)
    }
    assert.equal(r.msg_id, 'ok')
    assert.ok(!JSON.stringify(r).includes('geheim'))
  })

  it('Ereignisname muss ein Bezeichner sein, Freitext wird nicht geloggt', () => {
    const [r] = run((l) => l.info('Hallo Anna, deine Nummer ist 0170'))
    assert.equal(r.ev, 'invalid_event')
    assert.ok(!JSON.stringify(r).includes('Anna'))
  })

  it('lange Zeichenketten werden gekappt', () => {
    const [r] = run((l) => l.info('long_value', { reason: 'x'.repeat(1000) }))
    assert.ok(r.reason.length < 140)
  })

  it('child() erweitert die Basisfelder', () => {
    const [r] = run((l) => l.child({ part: 'q' }).info('hello_there'))
    assert.equal(r.part, 'q')
    assert.equal(r.svc, 't')
  })

  it('errorFields uebernimmt Name/Code/Status, aber NIE die Fehlermeldung', () => {
    const e = Object.assign(new Error('Geheimtext-4711 in Meldung'), { name: 'SqliteError', code: 'SQLITE_BUSY', output: { statusCode: 428 } })
    const f = errorFields(e)
    assert.deepEqual(f, { err_name: 'SqliteError', err_code: 'SQLITE_BUSY', err_status: 428 })
    assert.ok(!JSON.stringify(f).includes('Geheimtext'))
    assert.deepEqual(errorFields('nur ein String mit Inhalt'), { err_name: 'string' })
    assert.deepEqual(errorFields(null), { err_name: 'object' })
  })
})

describe('JobStore', () => {
  let tmp: ReturnType<typeof makeTmpDir>
  let store: JobStore
  beforeEach(() => {
    useNodeSqlite()
    tmp = makeTmpDir()
    store = JobStore.open(path.join(tmp.dir, 'state.db'))
  })
  afterEach(() => {
    store.close()
    tmp.cleanup()
  })

  const job = (id: string, ts = 100): NewMediaJob => ({
    messageId: id,
    chatId: 'c@s.whatsapp.net',
    kind: 'image',
    waTimestamp: ts,
    descriptor: {
      hkdfType: 'image',
      mediaKey: 'a2V5',
      directPath: '/d',
      url: null,
      fileSha256: 'aGFzaA==',
      mimetype: 'image/jpeg',
      fileLength: 5,
      fileName: null,
      seconds: null,
      ptt: false,
    },
  })

  it('Datei hat Modus 0600', () => {
    assert.equal(fs.statSync(path.join(tmp.dir, 'state.db')).mode & 0o777, 0o600)
  })

  it('Auftrag Rundreise, Versuche, Loeschen, Reihenfolge (neueste zuerst)', () => {
    store.upsertJob(job('a', 100), 1000)
    store.upsertJob(job('b', 200), 1001)
    store.upsertJob(job('a', 999), 2000) // zweites Einreihen aendert nichts
    assert.equal(store.countJobs(), 2)
    assert.deepEqual(store.listJobs().map((j) => j.messageId), ['b', 'a'])
    assert.deepEqual(store.getJob('a'), { ...job('a', 100), attempts: 0, nextAttemptAt: 0, createdAt: 1000, forced: false })
    store.recordAttempt('a', 2, 5000)
    assert.equal(store.getJob('a')?.attempts, 2)
    assert.equal(store.getJob('a')?.nextAttemptAt, 5000)
    store.deleteJob('a')
    assert.equal(store.getJob('a'), undefined)
  })

  it('Namen: hoeherer Rang gewinnt, gleicher Rang aktualisiert, niedriger wird ignoriert, leer ignoriert', () => {
    store.upsertName('j', 'Push', NAME_RANK.push)
    store.upsertName('j', 'Chat', NAME_RANK.chat)
    store.upsertName('j', 'Push2', NAME_RANK.push)
    assert.equal(store.getName('j'), 'Chat')
    store.upsertName('j', 'Kontakt', NAME_RANK.contact)
    store.upsertName('j', 'Kontakt neu', NAME_RANK.contact)
    store.upsertName('j', 'Chat2', NAME_RANK.chat)
    assert.equal(store.getName('j'), 'Kontakt neu')
    store.upsertName('j', '   ', NAME_RANK.contact)
    assert.equal(store.getName('j'), 'Kontakt neu')
    assert.equal(store.getName('unbekannt'), undefined)
  })

  it('LID-Zuordnung', () => {
    store.setLidMapping('1@lid', 'a@s.whatsapp.net')
    store.setLidMapping('1@lid', 'b@s.whatsapp.net')
    assert.equal(store.pnForLid('1@lid'), 'b@s.whatsapp.net')
    assert.equal(store.pnForLid('2@lid'), undefined)
  })

  it('F14: clearIdentityData leert Namen, LID-Zuordnung und Nachrichten-Geheimnisse, nicht die Medienaufgaben, und meldet die Anzahl', () => {
    store.upsertJob(job('a'), 1)
    store.upsertName('j1', 'Anna', NAME_RANK.chat)
    store.upsertName('j2', 'Bert', NAME_RANK.push)
    store.setLidMapping('1@lid', 'a@s.whatsapp.net')
    store.putMsgSecret('m1', ['1@lid'], Buffer.alloc(32, 7), 100, 1)
    assert.deepEqual(store.clearIdentityData(), { names: 2, lidMappings: 1, msgSecrets: 1 })
    assert.equal(store.getName('j1'), undefined)
    assert.equal(store.pnForLid('1@lid'), undefined)
    assert.equal(store.getMsgSecret('m1'), undefined)
    assert.equal(store.countJobs(), 1)
    assert.deepEqual(store.clearIdentityData(), { names: 0, lidMappings: 0, msgSecrets: 0 })
  })

  it('Nachrichten-Geheimnisse: speichern, lesen, erste Fassung gilt, Aufraeumen nach Alter', () => {
    const s1 = Buffer.alloc(32, 1)
    const s2 = Buffer.alloc(32, 2)
    store.putMsgSecret('m1', ['1@lid', 'a@s.whatsapp.net', '1@lid'], s1, 100, 1)
    const got = store.getMsgSecret('m1')
    assert.deepEqual(got?.senders, ['1@lid', 'a@s.whatsapp.net'], 'Doppelte entfallen')
    assert.ok(got?.secret.equals(s1))
    assert.equal(got?.waTimestamp, 100)
    store.putMsgSecret('m1', ['x'], s2, 999, 2)
    assert.ok(store.getMsgSecret('m1')?.secret.equals(s1), 'ein vorhandenes Geheimnis wird nicht ueberschrieben')
    store.putMsgSecret('m2', [], s2, 500, 3)
    assert.equal(store.countMsgSecrets(), 2)
    assert.equal(store.pruneMsgSecrets(200), 1, 'nur das Aeltere (Zeitstempel 100) faellt weg')
    assert.equal(store.getMsgSecret('m1'), undefined)
    assert.deepEqual(store.getMsgSecret('m2')?.senders, [])
    assert.equal(store.getMsgSecret('gibt-es-nicht'), undefined)
  })

  it('Nachrichten-Geheimnisse ueberleben das Wiederoeffnen', () => {
    store.putMsgSecret('m1', ['1@lid'], Buffer.alloc(32, 5), 100, 1)
    store.close()
    store = JobStore.open(path.join(tmp.dir, 'state.db'))
    assert.ok(store.getMsgSecret('m1')?.secret.equals(Buffer.alloc(32, 5)))
  })

  it('Zustand ueberlebt Wiederoeffnen', () => {
    store.upsertJob(job('a'), 1)
    store.upsertName('j', 'Name', NAME_RANK.chat)
    store.close()
    store = JobStore.open(path.join(tmp.dir, 'state.db'))
    assert.equal(store.countJobs(), 1)
    assert.equal(store.getName('j'), 'Name')
  })
})
