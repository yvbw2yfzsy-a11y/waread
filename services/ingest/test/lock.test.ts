import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { acquireLock, defaultLockSystem, LockHeldError, type LockSystem } from '../src/lock.js'
import { makeTmpDir } from './support/helpers.js'

describe('lock', () => {
  let tmp: ReturnType<typeof makeTmpDir>
  let file: string
  beforeEach(() => {
    tmp = makeTmpDir()
    file = path.join(tmp.dir, 'ingest.lock')
  })
  afterEach(() => tmp.cleanup())

  const sys = (over: Partial<LockSystem> = {}): LockSystem => ({
    pid: 1000,
    isAlive: () => true,
    fingerprint: () => ({ bootId: 'boot-A', startTicks: '111' }),
    now: () => Date.now(),
    ...over,
  })

  it('legt die Sperre mit Modus 0600 an und gibt sie wieder frei', () => {
    const h = acquireLock(file, sys())
    assert.ok(fs.existsSync(file))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(rec.pid, 1000)
    h.release()
    assert.ok(!fs.existsSync(file))
    h.release() // zweites Freigeben ist harmlos
  })

  it('zweite Instanz bei lebendem Halter -> LockHeldError mit PID', () => {
    acquireLock(file, sys({ pid: 1000 }))
    assert.throws(
      () => acquireLock(file, sys({ pid: 2000 })),
      (e) => e instanceof LockHeldError && e.pid === 1000,
    )
  })

  it('verwaiste Sperre (Prozess tot) wird uebernommen', () => {
    acquireLock(file, sys({ pid: 1000 }))
    const h = acquireLock(file, sys({ pid: 2000, isAlive: (p) => p !== 1000 }))
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 2000)
    h.release()
  })

  it('PID wiederverwendet nach Neustart (andere boot_id) -> uebernommen', () => {
    acquireLock(file, sys({ pid: 1000 }))
    const h = acquireLock(
      file,
      sys({ pid: 2000, isAlive: () => true, fingerprint: () => ({ bootId: 'boot-B', startTicks: '111' }) }),
    )
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 2000)
    h.release()
  })

  it('PID wiederverwendet im Betrieb (andere Startzeit) -> uebernommen', () => {
    acquireLock(file, sys({ pid: 1000 }))
    const h = acquireLock(
      file,
      sys({ pid: 2000, fingerprint: (p) => ({ bootId: 'boot-A', startTicks: p === 1000 ? '999' : '222' }) }),
    )
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 2000)
    h.release()
  })

  it('frische, leere Sperrdatei gilt als "im Entstehen" -> nicht uebernehmen', () => {
    fs.writeFileSync(file, '', { mode: 0o600 })
    assert.throws(() => acquireLock(file, sys()), LockHeldError)
  })

  it('alte, kaputte Sperrdatei wird uebernommen', () => {
    fs.writeFileSync(file, '{kaputt', { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(file, old, old)
    const h = acquireLock(file, sys())
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 1000)
    h.release()
  })

  it('release loescht keine fremde Sperre', () => {
    const h = acquireLock(file, sys({ pid: 1000 }))
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, bootId: 'x', startTicks: '1', startedAt: 5 }))
    h.release()
    assert.ok(fs.existsSync(file))
  })

  it('mit dem echten System: eigene Sperre blockiert eine zweite Anforderung', () => {
    const h = acquireLock(file)
    assert.throws(() => acquireLock(file), (e) => e instanceof LockHeldError && e.pid === process.pid)
    h.release()
    const again = acquireLock(file)
    again.release()
  })

  it('echter Fingerabdruck: liefert unter Linux boot_id und Startzeit', { skip: process.platform !== 'linux' }, () => {
    const fp = defaultLockSystem().fingerprint(process.pid)
    assert.ok(fp.bootId && fp.bootId.length > 10)
    assert.match(fp.startTicks ?? '', /^\d+$/)
  })
})
