// F02: Eine Schreibsperre auf der geteilten Datenbank (Cleanup-Stapel mit BEGIN IMMEDIATE, woechentlicher VACUUM)
// laenger als busy_timeout (5 s) liess eingehende Nachrichten still verloren gehen: WhatsApp hatte sie schon
// quittiert, der Ingest zaehlte sie als "ignored" und versuchte es nie wieder.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MessageHandler, type MediaSink } from '../src/messageHandler.js'
import type { Database } from '../src/dbClient.js'
import { all, FakeScheduler, makeEnv, type TestEnv } from './support/helpers.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const sink: MediaSink = { enqueue: () => 'queued' }

const msg = (id: string, text = `Text ${id}`) => ({
  key: { id, remoteJid: PN, fromMe: false },
  messageTimestamp: NOW - 60,
  pushName: 'Anna',
  message: { conversation: text },
})

/** Datenbank-Huelle, die Schreibtransaktionen wie bei einer fremden Sperre mit SQLITE_BUSY scheitern laesst. */
function lockable(db: Database): { db: Database; state: { locked: boolean; attempts: number } } {
  const state = { locked: false, attempts: 0 }
  const proxy = new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'transaction') {
        return (fn: (...a: unknown[]) => unknown) => {
          const real = (target as Database).transaction(fn as never) as unknown as Record<string, (...a: unknown[]) => unknown> &
            ((...a: unknown[]) => unknown)
          // better-sqlite3: transaction() liefert eine Funktion mit .immediate/.deferred/.exclusive (db/client.ts nutzt .immediate).
          const guard =
            (call: (...a: unknown[]) => unknown) =>
            (...args: unknown[]) => {
              state.attempts++
              if (state.locked) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
              return call(...args)
            }
          const wrapped = guard(real) as typeof real
          for (const mode of ['immediate', 'deferred', 'exclusive'] as const) {
            if (typeof real[mode] === 'function') wrapped[mode] = guard(real[mode]!.bind(real))
          }
          return wrapped
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database
  return { db: proxy, state }
}

describe('F02: Schreibsperre darf keine Nachricht verlieren', () => {
  let env: TestEnv
  let sched: FakeScheduler
  let handler: MessageHandler
  let lock: ReturnType<typeof lockable>

  const make = (extra: { maxPendingRetries?: number } = {}): MessageHandler =>
    new MessageHandler({
      db: lock.db,
      jobs: env.jobs,
      media: sink,
      cfg: env.cfg,
      log: env.log,
      now: () => NOW,
      scheduler: sched,
      ...extra,
    } as never)
  const count = (): number => all(env.db, 'SELECT id FROM messages').length

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    sched = new FakeScheduler()
    lock = lockable(env.db)
    handler = make()
  })
  afterEach(() => env.close())

  it('gesperrt beim Eintreffen: Nachricht wird nicht verworfen, nicht als "ignored" gezaehlt, nach 5 s gespeichert', () => {
    lock.state.locked = true
    const stats = handler.handleUpsert({ messages: [msg('m1')] })
    assert.deepEqual(stats, { stored: 0, duplicates: 0, dropped: 0, ignored: 0 })
    assert.equal(handler.pendingRetries, 1)
    assert.equal(count(), 0)

    lock.state.locked = false
    sched.advance(4_999)
    assert.equal(count(), 0, 'erst nach der Wartezeit')
    sched.advance(1)
    assert.equal(count(), 1)
    assert.equal(handler.pendingRetries, 0)
    assert.equal(handler.lostMessages, 0)
    assert.equal(sched.pendingTimeouts, 0, 'kein Timer bleibt zurueck')
    const log = env.lines.join('\n')
    assert.ok(log.includes('message_deferred') && log.includes('message_retry_ok'))
    assert.ok(!log.includes('message_failed'))
    assert.ok(!log.includes('Text m1'), 'kein Nachrichtentext im Journal')
  })

  it('anhaltende Sperre: Wartezeiten 5 s, 15 s, 45 s, 2 min, danach wird der Verlust gezaehlt und gemeldet', () => {
    lock.state.locked = true
    handler.handleUpsert({ messages: [msg('m1')] })
    const delays: number[] = []
    for (let i = 0; i < 5 && sched.pendingTimeouts > 0; i++) {
      const d = sched.pendingDelays()[0]!
      delays.push(d)
      sched.advance(d)
    }
    assert.deepEqual(delays, [5_000, 15_000, 45_000, 120_000])
    assert.equal(handler.pendingRetries, 0)
    assert.equal(handler.lostMessages, 1)
    assert.equal(sched.pendingTimeouts, 0)
    assert.equal(count(), 0)
    const lost = env.lines.filter((l) => l.includes('"message_lost"'))
    assert.equal(lost.length, 1)
    assert.ok(lost[0]!.includes('"reason":"busy"'))
    assert.ok(!env.lines.join('\n').includes('Text m1'))
  })

  it('waehrend Nachrichten warten, blockiert eine neue Nachricht die Ereignisschleife nicht noch einmal (kein weiterer Versuch)', () => {
    lock.state.locked = true
    handler.handleUpsert({ messages: [msg('m1')] })
    const attemptsBefore = lock.state.attempts
    handler.handleUpsert({ messages: [msg('m2')] })
    handler.handleUpsert({ messages: [msg('m3')] })
    assert.equal(lock.state.attempts, attemptsBefore, 'kein Datenbankzugriff, solange die Sperre bekannt ist')
    assert.equal(handler.pendingRetries, 3)
  })

  it('ein Wiederholungslauf blockiert hoechstens einmal (erste Sperre beendet den Lauf), Reihenfolge bleibt', () => {
    lock.state.locked = true
    for (const id of ['m1', 'm2', 'm3']) handler.handleUpsert({ messages: [msg(id)] })
    const before = lock.state.attempts
    sched.advance(5_000)
    assert.equal(lock.state.attempts - before, 1, 'nur ein Versuch, dann Pause bis zum naechsten Lauf')
    assert.equal(handler.pendingRetries, 3)

    lock.state.locked = false
    sched.advance(15_000)
    assert.equal(count(), 3)
    const order = all(env.db, 'SELECT id FROM messages ORDER BY rowid').map((r) => r.id)
    assert.deepEqual(order, ['m1', 'm2', 'm3'])
    assert.equal(handler.lostMessages, 0)
  })

  it('Obergrenze der Warteschlange: ueberzaehlige Nachrichten werden als verloren gezaehlt (queue_full), nie unbegrenzt gesammelt', () => {
    handler = make({ maxPendingRetries: 2 })
    lock.state.locked = true
    for (const id of ['m1', 'm2', 'm3']) handler.handleUpsert({ messages: [msg(id)] })
    assert.equal(handler.pendingRetries, 2)
    assert.equal(handler.lostMessages, 1)
    assert.ok(env.lines.some((l) => l.includes('"message_lost"') && l.includes('"reason":"queue_full"')))
  })

  it('andere Fehler (nicht SQLITE_BUSY) werden weiter wie bisher als "ignored" gezaehlt, nicht wiederholt', () => {
    const bad = { key: { id: 'bad', remoteJid: PN }, messageTimestamp: NOW, message: { conversation: 'x' } }
    Object.defineProperty(bad, 'pushName', {
      get() {
        throw new Error('kaputt')
      },
    })
    const stats = handler.handleUpsert({ messages: [bad as never] })
    assert.equal(stats.ignored, 1)
    assert.equal(handler.pendingRetries, 0)
  })

  it('Herunterfahren: flushPending versucht es ein letztes Mal und meldet, was verloren geht', () => {
    lock.state.locked = true
    handler.handleUpsert({ messages: [msg('m1'), msg('m2')] })
    lock.state.locked = false
    handler.flushPending()
    assert.equal(count(), 2)
    assert.equal(handler.pendingRetries, 0)
    assert.equal(sched.pendingTimeouts, 0)

    lock.state.locked = true
    handler.handleUpsert({ messages: [msg('m3')] })
    handler.flushPending()
    assert.equal(handler.lostMessages, 1)
    assert.equal(handler.pendingRetries, 0)
    assert.ok(env.lines.some((l) => l.includes('"message_lost"') && l.includes('"reason":"shutdown"')))
  })

  it('Verlauf (messaging-history.set): ein Paket, das auf eine Sperre trifft, wird wiederholt statt verworfen', async () => {
    lock.state.locked = true
    const msgs = Array.from({ length: 3 }, (_, i) => msg(`h${i}`))
    const p = handler.handleHistory({ messages: msgs })
    assert.equal(count(), 0)
    lock.state.locked = false
    sched.advance(5_000)
    const stats = await p
    assert.equal(stats.stored, 3)
    assert.equal(count(), 3)
  })
})

describe('F02: echte Sperre durch einen zweiten Prozess (wie Cleanup/VACUUM), Lab sim_busy', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
  })
  afterEach(() => env.close())

  it('Sperre 7 s (laenger als busy_timeout 5 s): Nachricht ist nicht weg, sie wird nach Ende der Sperre gespeichert', async () => {
    const sched = new FakeScheduler()
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(${JSON.stringify(env.cfg.paths.db)});
         db.exec('PRAGMA busy_timeout = 100'); db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 7000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await new Promise<void>((res) => child.stdout!.once('data', () => res()))
    const handler = new MessageHandler({ db: env.db, jobs: env.jobs, media: sink, cfg: env.cfg, log: env.log, now: () => NOW, scheduler: sched } as never)
    const stats = handler.handleUpsert({ messages: [msg('real1')] }) // blockiert ~5 s (busy_timeout), dann Sperre weiter da
    assert.equal(stats.ignored, 0, 'nicht als verloren gezaehlt')
    assert.equal(handler.pendingRetries, 1)
    await new Promise((r) => child.once('exit', r)) // Sperre ist weg
    sched.advance(5_000)
    assert.equal(all(env.db, 'SELECT id FROM messages').length, 1)
    assert.equal(handler.lostMessages, 0)
  })
})
