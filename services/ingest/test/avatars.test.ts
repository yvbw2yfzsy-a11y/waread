import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { AVATAR_CHECKED_KEY, AVATAR_ENABLED_KEY, AVATAR_PAUSE_KEY, AvatarSync, avatarStem, isAvatarCandidate } from '../src/avatars.js'
import { IngestCommands } from '../src/commands.js'
import { enqueueCommand } from '@waread/db'
import { getSetting, setSetting, upsertChat } from '../src/dbClient.js'
import type { Scheduler } from '../src/timing.js'
import { makeEnv, type TestEnv } from './support/helpers.js'

/** Zeitgeber ohne Wartezeit: setTimeout laeuft sofort im naechsten Mikrotask, Intervalle werden nur gemerkt. */
const instant: Scheduler = {
  setTimeout: (fn) => { queueMicrotask(fn); return 0 },
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
}

const A = '4915111222333@s.whatsapp.net'
const G = '120363111-1612345678@g.us'
const B = '4915222000111@s.whatsapp.net'

function setup(patch: (s: { connected: boolean; pics: Record<string, string | null | Error> }) => void = () => {}) {
  const env = makeEnv((c) => { c.profiles.enabled = true })
  const state = { connected: true, pics: {} as Record<string, string | null | Error>, now: 1_000_000 }
  patch(state)
  const queries: string[] = []
  const sync = new AvatarSync({
    db: env.db,
    cfg: env.cfg.profiles,
    mediaDir: env.cfg.paths.mediaDir,
    log: env.log,
    isConnected: () => state.connected,
    askPicture: async (jid) => {
      queries.push(jid)
      const v = state.pics[jid]
      if (v instanceof Error) throw v
      return v ?? null
    },
    download: async (url) => Buffer.from(`img:${url}`),
    shrink: async (src, dest) => { fs.copyFileSync(src, dest) },
    scheduler: instant,
    now: () => state.now,
  })
  env.cfg.profiles.gapMs = 0
  return { env, state, sync, queries }
}

const chat = (env: TestEnv, id: string, at: number) => upsertChat(env.db, { id, name: id.slice(0, 6), isGroup: id.endsWith('@g.us'), lastActivityAt: at })
const avatarOf = (env: TestEnv, id: string) =>
  (env.db.prepare('SELECT avatar_path FROM chats WHERE id = ?').get(id) as { avatar_path: string | null }).avatar_path
const events = (env: TestEnv) =>
  (env.db.prepare("SELECT payload_json AS p FROM events_outbox WHERE type = 'avatar_updated'").all() as { p: string }[]).map((r) => JSON.parse(r.p).chatId)

describe('avatars: Abruf beim Oeffnen eines Chats', () => {
  it('nur Personen und Gruppen; Dateiname ohne Nummer', () => {
    assert.ok(isAvatarCandidate(A) && isAvatarCandidate(G) && isAvatarCandidate('123@lid'))
    assert.ok(!isAvatarCandidate('status@broadcast') && !isAvatarCandidate('1@newsletter'))
    assert.ok(!avatarStem(A).includes('4915'))
  })

  it('start meldet dem Web-Dienst "eingeschaltet"', () => {
    const t = setup()
    t.sync.start()
    assert.equal(getSetting(t.env.db, AVATAR_ENABLED_KEY), '1')
    t.sync.stop()
    t.env.close()
  })

  it('beim Oeffnen: Bild holen, speichern, Ereignis fuer die Oberflaeche; keine Nummer im Journal', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    assert.equal(t.sync.request(A), 'queued')
    await t.sync.work()
    assert.deepEqual(t.queries, [A])
    const p = avatarOf(t.env, A)
    assert.ok(p?.startsWith(`avatars/${avatarStem(A)}-`) && p.endsWith('.jpg'))
    assert.ok(fs.existsSync(path.join(t.env.cfg.paths.mediaDir, p ?? '')))
    assert.deepEqual(events(t.env), [A])
    assert.ok(!t.env.lines.join('\n').includes('4915111222333'))
    t.sync.stop()
    t.env.close()
  })

  it('erneutes Oeffnen innerhalb des Intervalls: keine Abfrage; danach wieder, altes Bild ersetzt', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    t.sync.request(A)
    await t.sync.work()
    const first = avatarOf(t.env, A)!
    assert.equal(t.sync.request(A), 'fresh')
    t.state.now += 7 * 86_400 + 1
    assert.equal(t.sync.request(A), 'queued')
    await t.sync.work()
    assert.equal(t.queries.length, 2)
    const second = avatarOf(t.env, A)!
    assert.notEqual(second, first, 'neuer Dateiname, damit der Browser nicht das alte Bild zeigt')
    assert.ok(!fs.existsSync(path.join(t.env.cfg.paths.mediaDir, first)))
    t.sync.stop()
    t.env.close()
  })

  it('kein Bild / nicht sichtbar: lokales Bild weg; ohne Verbindung keine Abfrage', async () => {
    const t = setup((s) => { s.pics[G] = null; s.connected = false })
    chat(t.env, G, 10)
    t.env.db.prepare('UPDATE chats SET avatar_path = ? WHERE id = ?').run('avatars/x-1.jpg', G)
    t.sync.start()
    t.sync.request(G)
    await t.sync.work()
    assert.equal(t.queries.length, 0)
    t.state.connected = true
    t.sync.request(G)
    await t.sync.work()
    assert.equal(avatarOf(t.env, G), null)
    t.sync.stop()
    t.env.close()
  })

  it('Tageshoechstzahl und 429 (ruht einen Tag)', async () => {
    const t = setup((s) => { s.pics[A] = Object.assign(new Error('rate-overlimit'), { data: 429 }) })
    chat(t.env, A, 20); chat(t.env, B, 10)
    t.sync.start()
    t.sync.request(A)
    await t.sync.work()
    assert.equal(Number(getSetting(t.env.db, AVATAR_PAUSE_KEY)), t.state.now + 86_400)
    assert.equal(t.sync.request(B), 'paused')
    t.sync.stop()
    t.env.close()

    const u = setup()
    u.env.cfg.profiles.maxPerDay = 1
    chat(u.env, A, 20); chat(u.env, B, 10)
    u.sync.start()
    assert.equal(u.sync.request(A), 'queued')
    assert.equal(u.sync.request(B), 'day_limit')
    await u.sync.work()
    u.sync.stop()
    u.env.close()
  })

  it('contacts.update: "removed" loescht ohne Anfrage, "changed" macht beim naechsten Oeffnen faellig', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    t.sync.request(A)
    await t.sync.work()
    t.sync.onContactsUpdate([{ id: A, imgUrl: 'removed' }])
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(avatarOf(t.env, A), null)
    assert.equal(t.queries.length, 1)
    assert.equal(t.sync.request(A), 'fresh')
    t.sync.onContactsUpdate([{ id: A, imgUrl: 'changed' }])
    assert.equal(t.sync.request(A), 'queued')
    await t.sync.work()
    assert.equal(t.queries.length, 2)
    t.sync.stop()
    t.env.close()
  })

  it('Befehl refresh_avatar: an avatars.ts weitergereicht und quittiert; ohne Abruf nur quittiert', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    const queue = { loadDeferred: () => 'no_keys' as const, purgeDeferred: () => 0 }
    enqueueCommand(t.env.db, 'refresh_avatar', { chatId: A })
    new IngestCommands({ db: t.env.db, queue, avatars: t.sync, log: t.env.log, pollMs: 1000 }).poll()
    await t.sync.work()
    assert.deepEqual(t.queries, [A])
    enqueueCommand(t.env.db, 'refresh_avatar', { chatId: B })
    new IngestCommands({ db: t.env.db, queue, log: t.env.log, pollMs: 1000 }).poll()
    assert.equal((t.env.db.prepare('SELECT COUNT(*) AS n FROM ingest_commands').get() as { n: number }).n, 0)
    t.sync.stop()
    t.env.close()
  })

  it('raeumt Bilder geloeschter Chats weg (nur alte Dateien) und vergisst deren Eintraege', async () => {
    const t = setup()
    chat(t.env, A, 20)
    const dir = path.join(t.env.cfg.paths.mediaDir, 'avatars')
    fs.mkdirSync(dir, { recursive: true })
    const stale = path.join(dir, 'aaaaaaaaaaaaaaaaaaaaaaaa-1.jpg')
    fs.writeFileSync(stale, 'x')
    const old = new Date(Date.now() - 2 * 3_600_000)
    fs.utimesSync(stale, old, old)
    setSetting(t.env.db, AVATAR_CHECKED_KEY, JSON.stringify({ 'weg@s.whatsapp.net': 1, [A]: 5 }))
    t.sync.start()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!fs.existsSync(stale))
    assert.deepEqual(Object.keys(JSON.parse(getSetting(t.env.db, AVATAR_CHECKED_KEY) ?? '{}')), [A])
    t.sync.stop()
    t.env.close()
  })
})
