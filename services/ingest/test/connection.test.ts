import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { openAuthStore, type AuthStore } from '../src/authStore.js'
import { ConnectionManager } from '../src/connection.js'
import { getSetting, setSetting } from '../src/dbClient.js'
import { all, boom, FakeLib, FakeScheduler, fakeAuthLib, makeEnv, one, type TestEnv } from './support/helpers.js'

const QR1 = '2@qr-wert-eins,abc,def'
const QR2 = '2@qr-wert-zwei,abc,def'

describe('ConnectionManager', () => {
  let env: TestEnv
  let sched: FakeScheduler
  let lib: FakeLib
  let auth: AuthStore
  let conn: ConnectionManager
  let received: unknown[]

  const build = (
    opts: { paired?: boolean; autoPair?: boolean; onFatal?: (reason: string) => void; onSessionReset?: () => void } = {},
  ): void => {
    auth = openAuthStore(path.join(env.cfg.paths.authDir, 'auth.db'), fakeAuthLib)
    if (opts.paired) {
      auth.state.creds.me = { id: '491701234567:1@s.whatsapp.net' }
      auth.saveCreds()
    }
    env.cfg.connection.autoPairOnStart = opts.autoPair ?? true
    conn = new ConnectionManager({
      db: env.db,
      cfg: env.cfg.connection,
      lib,
      auth,
      log: env.log,
      listeners: { 'messages.upsert': (a) => received.push(a) },
      ...(opts.onFatal ? { onFatal: opts.onFatal } : {}),
      ...(opts.onSessionReset ? { onSessionReset: opts.onSessionReset } : {}),
      scheduler: sched,
      rng: () => 0, // keine Streuung -> exakte Wartezeiten
      now: () => 1_800_000_000,
    })
  }

  beforeEach(() => {
    env = makeEnv()
    sched = new FakeScheduler()
    lib = new FakeLib()
    received = []
  })
  afterEach(async () => {
    try {
      await conn?.stop()
      assert.deepEqual(lib.unexpectedCalls, [], 'F18/S1: unzulaessiger Zugriff auf den Socket')
    } finally {
      auth?.close()
      env.close()
    }
  })

  const setting = (k: string): string | null => getSetting(env.db, k)
  const status = (): string | null => setting('connection.status')
  const statusEvents = (): any[] =>
    all(env.db, "SELECT payload_json FROM events_outbox WHERE type = 'connection_status' ORDER BY id").map((r) =>
      JSON.parse(r.payload_json),
    )
  const close = (code?: number): void =>
    lib.last.emit('connection.update', { connection: 'close', lastDisconnect: { error: code === undefined ? new Error('x') : boom(code) } })

  it('Start ohne Kopplung: QR wird veroeffentlicht (settings), das Ereignis enthaelt den QR NICHT', () => {
    build()
    conn.start()
    assert.equal(lib.sockets.length, 1)
    assert.equal(status(), 'connecting')

    lib.last.emit('connection.update', { connection: 'connecting', qr: QR1 })
    assert.equal(status(), 'needs_qr')
    assert.equal(setting('connection.qr'), QR1)
    assert.equal(setting('connection.qr_seq'), '1')

    lib.last.emit('connection.update', { qr: QR2 })
    assert.equal(setting('connection.qr'), QR2)
    assert.equal(setting('connection.qr_seq'), '2')

    const evs = statusEvents()
    assert.ok(evs.length >= 3)
    assert.ok(evs.some((e) => e.state === 'needs_qr' && e.hasQr === true && e.qrSeq === 2))
    const raw = all(env.db, 'SELECT payload_json FROM events_outbox')
      .map((r) => r.payload_json)
      .join('\n')
    assert.ok(!raw.includes('qr-wert'), 'der QR darf nicht in der dauerhaften Ereigniswarteschlange liegen')
    assert.ok(!env.lines.join('\n').includes('qr-wert'), 'der QR darf nicht im Log erscheinen')
  })

  it('Kopplung: QR verschwindet, Server verlangt Neustart (515) -> sofort neu, danach connected', () => {
    build()
    conn.start()
    lib.last.emit('connection.update', { qr: QR1 })
    // Baileys: nach dem Scan neue Zugangsdaten + qr:undefined, dann Abbruch mit 515
    lib.last.emit('creds.update', { me: { id: '4917@s.whatsapp.net' } })
    auth.state.creds.me = { id: '4917:2@s.whatsapp.net' } // die Bibliothek mutiert die Zugangsdaten
    lib.last.emit('creds.update', {})
    lib.last.emit('connection.update', { qr: undefined, isNewLogin: true })
    assert.equal(status(), 'connecting')
    assert.equal(setting('connection.qr'), '')

    close(515)
    assert.equal(lib.sockets.length, 2, 'Sofort-Neustart ohne Wartezeit')
    assert.equal(sched.pendingTimeouts, 0)
    assert.equal(lib.authSeen[1], auth.state)

    lib.last.emit('connection.update', { connection: 'open' })
    assert.equal(status(), 'connected')
    assert.equal(setting('connection.connected_since'), '1800000000')
    assert.equal(setting('connection.qr'), '')
  })

  it('creds.update wird sofort dauerhaft gespeichert', () => {
    build()
    conn.start()
    auth.state.creds.registered = true
    auth.state.creds.me = { id: 'x@s.whatsapp.net' }
    lib.last.emit('creds.update', {})
    auth.close()
    const reopened = openAuthStore(path.join(env.cfg.paths.authDir, 'auth.db'), fakeAuthLib)
    assert.equal(reopened.isPaired(), true)
    reopened.close()
    auth = openAuthStore(path.join(env.cfg.paths.authDir, 'auth.db'), fakeAuthLib)
  })

  it('autoPairOnStart=false ohne Kopplung: nichts verbinden, Status needs_qr/not_paired', () => {
    build({ autoPair: false })
    conn.start()
    assert.equal(lib.sockets.length, 0)
    assert.equal(status(), 'needs_qr')
    assert.equal(setting('connection.reason'), 'not_paired')
  })

  it('Verbindungsabbruch: Backoff 5 s, 10 s, 20 s ... und nie eine enge Schleife', () => {
    build({ paired: true })
    conn.start()
    lib.last.emit('connection.update', { connection: 'open' })
    assert.equal(status(), 'connected')

    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      close(408)
      assert.equal(status(), 'disconnected')
      assert.equal(setting('connection.reason'), 'connection_lost')
      assert.equal(sched.pendingTimeouts, 1)
      delays.push(sched.pendingDelays()[0]!)
      const before = lib.sockets.length
      sched.advance(delays.at(-1)! - 1)
      assert.equal(lib.sockets.length, before, 'erst nach Ablauf der Wartezeit')
      sched.advance(1)
      assert.equal(lib.sockets.length, before + 1)
    }
    assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000])
  })

  it('Wartezeit ist nach oben auf 10 min gedeckelt', () => {
    build({ paired: true })
    conn.start()
    let last = 0
    for (let i = 0; i < 14; i++) {
      close(428)
      last = sched.pendingDelays()[0]!
      sched.advance(last)
    }
    assert.equal(last, 600_000)
  })

  it('stabile Verbindung (>= 10 min) setzt den Backoff zurueck', () => {
    build({ paired: true })
    conn.start()
    for (let i = 0; i < 3; i++) {
      close(408)
      sched.advance(sched.pendingDelays()[0]!)
    }
    lib.last.emit('connection.update', { connection: 'open' })
    sched.advance(600_000)
    close(408)
    assert.equal(sched.pendingDelays()[0], 5_000)
  })

  it('F05: eine Verbindung, die nur 60 s offen war, setzt den Backoff NICHT zurueck (sonst bis zu 57 Aufbauten je Stunde)', () => {
    build({ paired: true })
    conn.start()
    close(408)
    sched.advance(5_000)
    lib.last.emit('connection.update', { connection: 'open' })
    sched.advance(60_000)
    close(408)
    assert.equal(sched.pendingDelays()[0], 10_000)
  })

  it('F05: Server schliesst jede Verbindung nach 60 s mit 408 -> hoechstens 12 Aufbauten in einer Stunde (vorher 57)', () => {
    build({ paired: true })
    conn.start()
    lib.last.emit('connection.update', { connection: 'open' })
    const t0 = sched.now
    let sockets = lib.sockets.length
    while (sched.now - t0 < 3_600_000) {
      sched.advance(60_000)
      close(408)
      const wait = sched.pendingDelays()[0]!
      sched.advance(wait)
      if (lib.sockets.length > sockets) {
        sockets = lib.sockets.length
        lib.last.emit('connection.update', { connection: 'open' })
      }
    }
    assert.ok(sockets <= 12, `Aufbauten in einer Stunde: ${sockets}`)
  })

  it('kurze Verbindung (< 60 s) setzt den Backoff NICHT zurueck', () => {
    build({ paired: true })
    conn.start()
    close(408)
    sched.advance(5_000)
    lib.last.emit('connection.update', { connection: 'open' })
    sched.advance(30_000)
    close(408)
    assert.equal(sched.pendingDelays()[0], 10_000)
  })

  it('F18/S1: die Attrappe zeichnet unzulaessige Zugriffe auf (sonst waere der Lebenslauf-Test unten wertlos)', () => {
    build()
    const probe: any = lib.createSocket({ auth: {} })
    probe.sendPresenceUpdate('available')
    probe.readMessages([])
    probe.ev.emit('x')
    probe.ev.on('connection.update', () => {})
    probe.end()
    assert.deepEqual(lib.unexpectedCalls, ['sendPresenceUpdate', 'readMessages', 'ev.emit'])
    lib.unexpectedCalls.length = 0
  })

  it('F18/S1: ueber den ganzen Lebenslauf fasst der Dienst am Socket nur ev.on, ev.off und end an', () => {
    build({ paired: true })
    conn.start()
    lib.last.emit('connection.update', { connection: 'connecting', qr: QR1 })
    lib.last.emit('connection.update', { connection: 'open' })
    close(408)
    sched.advance(3_600_000)
    lib.last.emit('connection.update', { connection: 'open' })
    lib.last.emit('creds.update', {})
    close(515)
    sched.advance(60_000)
    lib.last.emit('connection.update', { connection: 'open' })
    close(401)
    assert.ok(lib.sockets.length >= 3, 'mehrere Sockets, damit der Lauf wirklich Wiederverbindungen enthielt')
    assert.deepEqual(lib.unexpectedCalls, [])
  })

  it('F14: abgemeldet (401) ruft onSessionReset genau einmal; andere Trennungen nicht', () => {
    let resets = 0
    build({ paired: true, onSessionReset: () => void resets++ })
    conn.start()
    lib.last.emit('connection.update', { connection: 'open' })
    close(408)
    sched.advance(3_600_000)
    lib.last.emit('connection.update', { connection: 'open' })
    close(500)
    assert.equal(resets, 0)
    sched.advance(3_600_000)
    lib.last.emit('connection.update', { connection: 'open' })
    close(401)
    assert.equal(resets, 1)
  })

  it('abgemeldet (401): Sitzung geloescht, KEIN Reconnect, Status needs_qr/logged_out, wartet auf Befehl', () => {
    build({ paired: true })
    auth.state.keys.set({ session: { a: { v: 1 } } })
    conn.start()
    lib.last.emit('connection.update', { connection: 'open' })
    close(401)

    assert.equal(status(), 'needs_qr')
    assert.equal(setting('connection.reason'), 'logged_out')
    assert.equal(auth.isPaired(), false)
    assert.equal(auth.state.keys.get('session', ['a'])['a'], null)
    assert.equal(sched.pendingTimeouts, 0, 'kein Reconnect-Timer')
    sched.advance(3_600_000)
    assert.equal(lib.sockets.length, 1, 'keine neue Verbindung ohne ausdruecklichen Befehl')

    // Web fordert neue Kopplung an
    setSetting(env.db, 'connection.command', 'connect')
    sched.advance(3_000)
    assert.equal(lib.sockets.length, 2)
    assert.equal(setting('connection.command'), '', 'Befehl quittiert')
    lib.last.emit('connection.update', { qr: QR1 })
    assert.equal(status(), 'needs_qr')
    assert.equal(setting('connection.qr'), QR1)
  })

  it('ersetzt (440): kein Reconnect (kein Ping-Pong mit der anderen Instanz)', () => {
    build({ paired: true })
    conn.start()
    close(440)
    assert.equal(status(), 'disconnected')
    assert.equal(setting('connection.reason'), 'connection_replaced')
    assert.equal(sched.pendingTimeouts, 0)
  })

  it('verboten (403): kein Reconnect', () => {
    build({ paired: true })
    conn.start()
    close(403)
    assert.equal(status(), 'disconnected')
    assert.equal(setting('connection.reason'), 'forbidden')
    assert.equal(sched.pendingTimeouts, 0)
  })

  it('Sofort-Neustart (515) ist begrenzt: nach 3 in kurzer Zeit gilt wieder der Backoff', () => {
    build({ paired: true })
    conn.start()
    for (let i = 0; i < 3; i++) {
      close(515)
      assert.equal(lib.sockets.length, i + 2)
    }
    close(515)
    assert.equal(lib.sockets.length, 4, 'kein weiterer Sofort-Neustart')
    assert.equal(sched.pendingTimeouts, 1)
    assert.equal(sched.pendingDelays()[0], 5_000)
  })

  it('F05: Sofort-Neustart (515) ist auch bei langsamer Folge begrenzt: nie mehr als 3 ohne Wartezeit je 10 Minuten', () => {
    // Echte Uhr durch die virtuelle ersetzen: das Fenster des Schnellneustarts rechnet mit Date.now().
    const base = 1_700_000_000_000
    mock.method(Date, 'now', () => base + sched.now)
    try {
      build({ paired: true })
      conn.start()
      const immediate: number[] = []
      for (let i = 0; i < 60; i++) {
        lib.last.emit('connection.update', { connection: 'open' })
        sched.advance(60_000)
        const before = lib.sockets.length
        close(515)
        if (lib.sockets.length > before) immediate.push(sched.now)
        else sched.advance(sched.pendingDelays()[0]!)
      }
      let worst = 0
      for (const t of immediate) worst = Math.max(worst, immediate.filter((x) => x >= t && x < t + 600_000).length)
      assert.ok(worst <= 3, `Sofort-Neustarts in 10 Minuten: ${worst}`)
    } finally {
      mock.restoreAll()
    }
  })

  it('QR nicht gescannt (Abbruch ohne Kopplung): wartet im Zustand needs_qr, keine Dauerschleife', () => {
    build()
    conn.start()
    lib.last.emit('connection.update', { qr: QR1 })
    close(408)
    assert.equal(status(), 'needs_qr')
    assert.equal(setting('connection.reason'), 'qr_expired')
    assert.equal(setting('connection.qr'), '', 'abgelaufener QR wird entfernt')
    assert.equal(sched.pendingTimeouts, 0)
    sched.advance(3_600_000)
    assert.equal(lib.sockets.length, 1)
  })

  it('Ereignisse eines beendeten Sockets werden ignoriert', () => {
    build({ paired: true })
    conn.start()
    const old = lib.last
    old.emit('connection.update', { connection: 'open' })
    close(408)
    assert.equal(status(), 'disconnected')
    old.emit('connection.update', { connection: 'open' })
    old.emit('messages.upsert', { messages: [] })
    assert.equal(status(), 'disconnected')
    assert.equal(received.length, 0)
  })

  it('Fachereignisse der Bibliothek werden an die Verarbeiter weitergereicht; Fehler darin stoppen nichts', () => {
    build({ paired: true })
    ;(conn as any).listeners['boom.event'] = () => {
      throw new Error('Geheimtext-4711')
    }
    conn.start()
    lib.last.emit('messages.upsert', { messages: [1] })
    assert.deepEqual(received, [{ messages: [1] }])
    assert.doesNotThrow(() => lib.last.emit('boom.event', {}))
    lib.last.emit('connection.update', { connection: 'open' })
    assert.equal(status(), 'connected')
    assert.ok(!env.lines.join('\n').includes('Geheimtext-4711'))
  })

  it('Socket-Erzeugung schlaegt fehl -> Backoff statt Absturz', () => {
    build({ paired: true })
    lib.failNext = true
    conn.start()
    assert.equal(lib.sockets.length, 0)
    assert.equal(status(), 'disconnected')
    assert.equal(sched.pendingDelays()[0], 5_000)
    sched.advance(5_000)
    assert.equal(lib.sockets.length, 1)
  })

  it('F08: Fehler beim Speichern der Zugangsdaten -> kontrolliertes Beenden statt Weiterlaufen mit ungespeichertem Zustand', () => {
    const fatal: string[] = []
    build({ paired: true, onFatal: (reason) => fatal.push(reason) })
    auth.saveCreds = () => {
      throw Object.assign(new Error('Geheimtext-4711 disk I/O error'), { code: 'SQLITE_IOERR' })
    }
    conn.start()
    lib.last.emit('creds.update', {})
    assert.deepEqual(fatal, ['creds_save_failed'])
    const log = env.lines.join('\n')
    assert.ok(log.includes('creds_save_failed') && log.includes('SQLITE_IOERR'))
    assert.ok(!log.includes('Geheimtext-4711'), 'keine Fehlertexte im Journal')
  })

  it('Befehl "connect" bei bereits aktiver Verbindung wird quittiert, aber ignoriert; unbekannte Befehle auch', () => {
    build({ paired: true })
    conn.start()
    setSetting(env.db, 'connection.command', 'connect')
    sched.advance(3_000)
    assert.equal(lib.sockets.length, 1)
    assert.equal(setting('connection.command'), '')
    setSetting(env.db, 'connection.command', 'logout')
    sched.advance(3_000)
    assert.equal(lib.sockets.length, 1)
    assert.equal(setting('connection.command'), '')
    assert.equal(auth.isPaired(), true, 'ein unbekannter Befehl darf nichts bewirken')
  })

  it('stop(): Socket lokal beenden (kein Abmelden), Status disconnected, keine weitere Verbindung', async () => {
    build({ paired: true })
    conn.start()
    const sock = lib.last
    sock.emit('connection.update', { connection: 'open' })
    await conn.stop()
    assert.equal(sock.ended, true)
    assert.equal(status(), 'disconnected')
    assert.equal(setting('connection.reason'), 'service_stopping')
    sched.advance(3_600_000)
    assert.equal(lib.sockets.length, 1)
    assert.equal(auth.isPaired(), true, 'Sitzung bleibt fuer den naechsten Start erhalten')
  })

  it('stop() waehrend eines geplanten Reconnects verhindert diesen', async () => {
    build({ paired: true })
    conn.start()
    close(408)
    await conn.stop()
    sched.advance(3_600_000)
    assert.equal(lib.sockets.length, 1)
  })

  it('jeder Statuswechsel erzeugt ein connection_status-Ereignis mit Status und Zeit', () => {
    build({ paired: true })
    conn.start()
    lib.last.emit('connection.update', { connection: 'open' })
    close(408)
    const seq = statusEvents().map((e) => e.state)
    assert.deepEqual(seq, ['connecting', 'connected', 'disconnected'])
    assert.ok(statusEvents().every((e) => e.updatedAt === 1_800_000_000))
    assert.equal(one(env.db, "SELECT value FROM settings WHERE key = 'connection.updated_at'").value, '1800000000')
  })

  it('viele Fehlschlaege ohne Zeitablauf erzeugen genau eine Verbindung (keine enge Schleife)', () => {
    build({ paired: true })
    conn.start()
    for (let i = 0; i < 50; i++) {
      // jedes Mal derselbe Socket meldet Abbruch -> nur das erste zaehlt, der Rest ist veraltet
      lib.sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(408) } })
    }
    assert.equal(lib.sockets.length, 1)
    assert.equal(sched.pendingTimeouts, 1)
  })
})
