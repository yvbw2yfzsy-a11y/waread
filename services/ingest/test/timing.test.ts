import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyDisconnect, DISCONNECT_CODE } from '../src/connection.js'
import { nextBackoffMs, statusCodeOf } from '../src/timing.js'
import { boom } from './support/helpers.js'

describe('nextBackoffMs', () => {
  const opts = { startMs: 5_000, capMs: 600_000 }

  it('verdoppelt ab 5 s und deckelt bei 10 min (ohne Jitter)', () => {
    const noJitter = { ...opts, jitter: 0 }
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map((a) => nextBackoffMs(a, noJitter, () => 0.5))
    assert.deepEqual(seq, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000])
  })

  it('Jitter streut nur nach unten: nie ueber der Obergrenze, nie unter 80 %', () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      const exact = Math.min(opts.capMs, opts.startMs * 2 ** attempt)
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const v = nextBackoffMs(attempt, opts, () => r)
        assert.ok(v <= exact, `attempt ${attempt} r ${r}: ${v} > ${exact}`)
        assert.ok(v >= exact * 0.8 - 1, `attempt ${attempt} r ${r}: ${v} < 80 %`)
      }
    }
  })

  it('negative oder riesige Versuchszahlen erzeugen keine Schleife ohne Wartezeit und keinen Ueberlauf', () => {
    assert.equal(nextBackoffMs(-3, { ...opts, jitter: 0 }), 5_000)
    assert.equal(nextBackoffMs(10_000, { ...opts, jitter: 0 }), 600_000)
    assert.ok(nextBackoffMs(1e9, opts, () => 0) > 0)
  })
})

describe('statusCodeOf', () => {
  it('liest Boom-, direkte und HTTP-artige Codes', () => {
    assert.equal(statusCodeOf(boom(401)), 401)
    assert.equal(statusCodeOf({ statusCode: 515 }), 515)
    assert.equal(statusCodeOf({ status: 404 }), 404)
    assert.equal(statusCodeOf({ output: { statusCode: 440 }, statusCode: 1 }), 440)
  })
  it('liefert undefined bei allem anderen', () => {
    for (const v of [undefined, null, 'x', 7, {}, { statusCode: '401' }, new Error('x')]) {
      assert.equal(statusCodeOf(v), undefined)
    }
  })
})

describe('classifyDisconnect', () => {
  it('abgemeldet (401) -> logged_out, kein Reconnect', () => {
    assert.deepEqual(classifyDisconnect(401), { action: 'logged_out', reason: 'logged_out' })
  })
  it('Neustart verlangt (515) -> sofort neu', () => {
    assert.equal(classifyDisconnect(515).action, 'restart_now')
  })
  it('ersetzt (440), verboten (403), Multidevice (411) -> stop', () => {
    for (const c of [440, 403, 411]) assert.equal(classifyDisconnect(c).action, 'stop', String(c))
  })
  it('Verbindungsabbrueche -> reconnect', () => {
    for (const c of [408, 428, 503, 500, undefined, 1234]) {
      assert.equal(classifyDisconnect(c).action, 'reconnect', String(c))
    }
  })

  it('Konstanten stimmen mit Baileys DisconnectReason (Commit 81345be, src/Types/index.ts) ueberein', () => {
    // Werte stammen aus dem gelesenen Quelltext; Abgleich gegen die INSTALLIERTE Version steht noch aus (README).
    assert.deepEqual(
      { ...DISCONNECT_CODE },
      {
        connectionClosed: 428,
        connectionLost: 408,
        connectionReplaced: 440,
        timedOut: 408,
        loggedOut: 401,
        badSession: 500,
        restartRequired: 515,
        multideviceMismatch: 411,
        forbidden: 403,
        unavailableService: 503,
      },
    )
  })
})
