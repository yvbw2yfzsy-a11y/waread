import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { AVATAR_CHECKED_KEY, AVATAR_PAUSE_KEY, AvatarSync, avatarFileName, isAvatarCandidate } from '../src/avatars.js'
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

function setup(patch: (o: { connected: boolean; pics: Record<string, string | null | Error> }) => void = () => {}) {
  const env = makeEnv((c) => { c.profiles.enabled = true; c.profiles.maxPerRound = 10 })
  const state = { connected: true, pics: {} as Record<string, string | null | Error>, now: 1_000_000 }
  patch(state)
  const queries: string[] = []
  const downloads: string[] = []
  const sync = new AvatarSync({
    db: env.db,
    cfg: env.cfg.profiles,
    mediaDir: env.cfg.paths.mediaDir,
    log: env.log,
    isConnected: () => state.connected,
    query: async (jid) => {
      queries.push(jid)
      const v = state.pics[jid]
      if (v instanceof Error) throw v
      return v ?? null
    },
    download: async (url) => { downloads.push(url); return Buffer.from(`img:${url}`) },
    shrink: async (src, dest) => { fs.copyFileSync(src, dest) },
    scheduler: instant,
    now: () => state.now,
    rng: () => 0.5,
  })
  return { env, state, sync, queries, downloads }
}

const chat = (env: TestEnv, id: string, at: number) => upsertChat(env.db, { id, name: id.slice(0, 6), isGroup: id.endsWith('@g.us'), lastActivityAt: at })
const avatarOf = (env: TestEnv, id: string) =>
  (env.db.prepare('SELECT avatar_path FROM chats WHERE id = ?').get(id) as { avatar_path: string | null }).avatar_path

describe('avatars', () => {
  it('nur Personen und Gruppen, keine Status-/Kanal-Chats; Dateiname ohne Nummer', () => {
    assert.ok(isAvatarCandidate(A) && isAvatarCandidate(G) && isAvatarCandidate('123@lid'))
    assert.ok(!isAvatarCandidate('status@broadcast') && !isAvatarCandidate('1@newsletter'))
    assert.ok(!avatarFileName(A).includes('4915'))
  })

  it('aus (Standard): keine einzige Abfrage', async () => {
    const t = setup()
    t.env.cfg.profiles.enabled = false
    chat(t.env, A, 10)
    t.sync.start()
    await t.sync.tick()
    assert.deepEqual(t.queries, [])
    t.env.close()
  })

  it('Runde: Bild speichern, "kein Bild" loescht, Verweis in chats.avatar_path', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a'; s.pics[G] = null })
    chat(t.env, A, 20); chat(t.env, G, 10)
    t.sync.start()
    await t.sync.tick()
    assert.deepEqual(t.queries, [A, G])
    assert.equal(avatarOf(t.env, A), `avatars/${avatarFileName(A)}`)
    assert.ok(fs.existsSync(path.join(t.env.cfg.paths.mediaDir, 'avatars', avatarFileName(A))))
    assert.equal(avatarOf(t.env, G), null)
    assert.ok(!t.env.lines.join('\n').includes('4915111222333'), 'keine Nummer im Journal')
    t.env.close()
  })

  it('je Chat hoechstens einmal pro Intervall; nach dem Intervall wieder', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    await t.sync.tick()
    await t.sync.tick()
    assert.equal(t.queries.length, 1)
    t.state.now += 7 * 86_400 + 1
    await t.sync.tick()
    assert.equal(t.queries.length, 2)
    t.env.close()
  })

  it('ohne Verbindung keine Abfrage; hoechstens maxPerRound je Runde', async () => {
    const t = setup((s) => { s.connected = false })
    for (let i = 0; i < 5; i++) chat(t.env, `49152300000${i}@s.whatsapp.net`, i)
    t.env.cfg.profiles.maxPerRound = 2
    t.sync.start()
    await t.sync.tick()
    assert.equal(t.queries.length, 0)
    t.state.connected = true
    await t.sync.tick()
    assert.equal(t.queries.length, 2)
    t.env.close()
  })

  it('429 (zu viele Anfragen): Runde bricht ab und ruht einen Tag', async () => {
    const limited = Object.assign(new Error('rate-overlimit'), { data: 429 })
    const t = setup((s) => { s.pics[A] = limited })
    chat(t.env, A, 20); chat(t.env, B, 10)
    t.sync.start()
    await t.sync.tick()
    assert.deepEqual(t.queries, [A])
    assert.equal(Number(getSetting(t.env.db, AVATAR_PAUSE_KEY)), t.state.now + 86_400)
    await t.sync.tick()
    assert.equal(t.queries.length, 1)
    t.env.close()
  })

  it('contacts.update: "removed" loescht ohne Anfrage, "changed" macht faellig', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    t.sync.start()
    await t.sync.tick()
    t.sync.onContactsUpdate([{ id: A, imgUrl: 'removed' }])
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(avatarOf(t.env, A), null)
    assert.equal(t.queries.length, 1)
    t.sync.onContactsUpdate([{ id: A, imgUrl: 'changed' }])
    await t.sync.tick()
    assert.equal(t.queries.length, 2)
    t.env.close()
  })

  it('raeumt Bilder geloeschter Chats weg (nur alte Dateien) und vergisst deren Eintraege', async () => {
    const t = setup((s) => { s.pics[A] = 'https://pps.whatsapp.net/a' })
    chat(t.env, A, 20)
    const dir = path.join(t.env.cfg.paths.mediaDir, 'avatars')
    fs.mkdirSync(dir, { recursive: true })
    const stale = path.join(dir, 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg')
    fs.writeFileSync(stale, 'x')
    const old = new Date(Date.now() - 2 * 3_600_000)
    fs.utimesSync(stale, old, old)
    setSetting(t.env.db, AVATAR_CHECKED_KEY, JSON.stringify({ 'weg@s.whatsapp.net': 1 }))
    t.sync.start()
    await t.sync.tick()
    assert.ok(!fs.existsSync(stale))
    assert.ok(fs.existsSync(path.join(dir, avatarFileName(A))))
    assert.deepEqual(Object.keys(JSON.parse(getSetting(t.env.db, AVATAR_CHECKED_KEY) ?? '{}')), [A])
    t.env.close()
  })
})
