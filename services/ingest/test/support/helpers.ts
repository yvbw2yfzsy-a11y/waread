import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, type IngestConfig } from '../../src/config.js'
import { openDb, runMigrations, type Database } from '../../src/dbClient.js'
import { JobStore } from '../../src/jobStore.js'
import { createLogger, type Logger } from '../../src/log.js'
import { setSqliteDriver } from '../../src/sqlite.js'
import type { Scheduler } from '../../src/timing.js'
import type { AuthLib, WaSocket } from '../../src/waLib.js'
import { nodeSqliteDriver } from './nodeSqliteAdapter.js'

/** Schaltet den Dienst fuer Tests auf node:sqlite um (better-sqlite3 ist hier nicht installierbar). */
export function useNodeSqlite(): void {
  setSqliteDriver(nodeSqliteDriver)
}

export function makeTmpDir(prefix = 'waread-ingest-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Logger, der alle Zeilen einsammelt (zum Pruefen, dass keine Inhalte im Journal landen). */
export function memoryLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): { log: Logger; lines: string[] } {
  const lines: string[] = []
  return { log: createLogger({ level, write: (l) => lines.push(l) }), lines }
}

export function testConfig(dir: string, patch: (c: IngestConfig) => void = () => {}): IngestConfig {
  const cfg = defaultConfig()
  cfg.paths = {
    db: path.join(dir, 'db', 'waread.db'),
    authDir: path.join(dir, 'auth'),
    mediaDir: path.join(dir, 'media'),
    stateDb: path.join(dir, 'db', 'ingest-state.db'),
  }
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true })
  fs.mkdirSync(cfg.paths.authDir, { recursive: true })
  fs.mkdirSync(cfg.paths.mediaDir, { recursive: true })
  patch(cfg)
  return cfg
}

export interface TestEnv {
  dir: string
  cfg: IngestConfig
  db: Database
  jobs: JobStore
  log: Logger
  lines: string[]
  close(): void
}

export function makeEnv(patch: (c: IngestConfig) => void = () => {}): TestEnv {
  useNodeSqlite()
  const tmp = makeTmpDir()
  const cfg = testConfig(tmp.dir, patch)
  const db = openDb(cfg.paths.db)
  runMigrations(db)
  const jobs = JobStore.open(cfg.paths.stateDb)
  const { log, lines } = memoryLogger()
  return {
    dir: tmp.dir,
    cfg,
    db,
    jobs,
    log,
    lines,
    close() {
      for (const c of [() => jobs.close(), () => db.close()]) {
        try {
          c()
        } catch {
          /* schon zu */
        }
      }
      tmp.cleanup()
    },
  }
}

export function all<T = any>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function one<T = any>(db: Database, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

// ---------------------------------------------------------------------------------------------
// Zeitgeber
// ---------------------------------------------------------------------------------------------

interface Timer {
  id: number
  due: number
  fn: () => void
  every?: number
}

/** Manuell vorgestellter Zeitgeber. */
export class FakeScheduler implements Scheduler {
  now = 0
  private seq = 0
  private timers: Timer[] = []

  setTimeout(fn: () => void, ms: number): unknown {
    const t: Timer = { id: ++this.seq, due: this.now + ms, fn }
    this.timers.push(t)
    return t.id
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== h)
  }
  setInterval(fn: () => void, ms: number): unknown {
    const t: Timer = { id: ++this.seq, due: this.now + ms, fn, every: ms }
    this.timers.push(t)
    return t.id
  }
  clearInterval(h: unknown): void {
    this.clearTimeout(h)
  }

  /** Anzahl ausstehender Einmal-Timer (ohne Intervalle). */
  get pendingTimeouts(): number {
    return this.timers.filter((t) => t.every === undefined).length
  }
  /** Wartezeiten der ausstehenden Einmal-Timer, aufsteigend. */
  pendingDelays(): number[] {
    return this.timers
      .filter((t) => t.every === undefined)
      .map((t) => t.due - this.now)
      .sort((a, b) => a - b)
  }

  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const next = this.timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0]
      if (!next) break
      this.now = next.due
      if (next.every !== undefined) next.due += next.every
      else this.timers = this.timers.filter((t) => t !== next)
      next.fn()
    }
    this.now = end
  }
}

// ---------------------------------------------------------------------------------------------
// Falsche Bibliothek
// ---------------------------------------------------------------------------------------------

type Handler = (arg: any) => void

export class FakeSocket implements WaSocket {
  readonly handlers = new Map<string, Handler[]>()
  ended = false
  endError: Error | undefined
  readonly ev = {
    on: (event: string, h: Handler) => {
      const list = this.handlers.get(event) ?? []
      list.push(h)
      this.handlers.set(event, list)
    },
    off: (event: string, h: Handler) => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((x) => x !== h),
      )
    },
  }
  end(error?: Error): void {
    this.ended = true
    this.endError = error
  }
  /** Nur damit die Klasse WaSocket erfuellt; ueber FakeLib zaehlt jeder Aufruf als unerwartet (unexpectedCalls). */
  profilePicture(): Promise<string | null> {
    return Promise.resolve(null)
  }
  emit(event: string, arg?: unknown): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(arg)
  }
  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0
  }
}

/** Fake fuer Pick<WaLib,'createSocket'>: merkt sich alle erzeugten Sockets. */
export class FakeLib {
  readonly sockets: FakeSocket[] = []
  authSeen: unknown[] = []
  failNext = false
  /**
   * F18/S1: Alles, was der Dienst am Socket ausser socket.ev.on/off und socket.end anfasst (z. B. sendPresenceUpdate,
   * readMessages, sendMessage, logout). Ohne diese Aufzeichnung wirft ein solcher Aufruf nur einen TypeError, den
   * Fangnetze im Dienst verschlucken koennen; der Test bliebe gruen.
   */
  readonly unexpectedCalls: string[] = []
  createSocket = (opts: { auth: unknown }): FakeSocket => {
    if (this.failNext) {
      this.failNext = false
      throw new Error('boom')
    }
    this.authSeen.push(opts.auth)
    const s = new FakeSocket()
    this.sockets.push(s)
    return this.watch(s)
  }

  private watch(s: FakeSocket): FakeSocket {
    const note = (name: string): (() => undefined) => {
      this.unexpectedCalls.push(name)
      return () => undefined
    }
    const inert = (p: string | symbol): boolean => typeof p === 'symbol' || p === 'then' || p === 'toJSON'
    const ev = new Proxy(s.ev, {
      get: (t, p, r) => (inert(p) || p === 'on' || p === 'off' ? Reflect.get(t, p, r) : note(`ev.${String(p)}`)),
    })
    return new Proxy(s, {
      get: (t, p, r) => {
        if (p === 'ev') return ev
        if (inert(p) || p === 'end') return Reflect.get(t, p, r)
        return note(String(p))
      },
    })
  }
  get last(): FakeSocket {
    const s = this.sockets[this.sockets.length - 1]
    if (!s) throw new Error('kein Socket erzeugt')
    return s
  }
}

/** AuthLib-Ersatz mit BufferJSON-Verhalten wie in Baileys (Buffer <-> {type:'Buffer',data}). */
export const fakeAuthLib: AuthLib = {
  initAuthCreds: () => ({ noiseKey: Buffer.from('noise'), registered: false, me: undefined }),
  BufferJSON: {
    replacer: (_k, v) => {
      if (v instanceof Uint8Array) return { type: 'Buffer', data: Buffer.from(v).toString('base64') }
      if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
        return { type: 'Buffer', data: Buffer.from(v.data).toString('base64') }
      }
      return v
    },
    reviver: (_k, v) => {
      if (v && typeof v === 'object' && v.type === 'Buffer' && typeof v.data === 'string') {
        return Buffer.from(v.data, 'base64')
      }
      return v
    },
  },
  reviveAppStateSyncKey: (obj) => ({ revived: true, obj }),
}

/** Boom-aehnlicher Fehler mit Statuscode. */
export function boom(statusCode: number): Error {
  const e = new Error('boom') as Error & { output: { statusCode: number } }
  e.output = { statusCode }
  return e
}
