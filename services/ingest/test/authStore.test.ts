import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openAuthStore } from '../src/authStore.js'
import { fakeAuthLib, makeTmpDir, useNodeSqlite } from './support/helpers.js'

describe('authStore', () => {
  let tmp: ReturnType<typeof makeTmpDir>
  let file: string
  beforeEach(() => {
    useNodeSqlite()
    tmp = makeTmpDir()
    file = path.join(tmp.dir, 'auth.db')
  })
  afterEach(() => tmp.cleanup())

  it('Datei hat Modus 0600; frischer Speicher ist nicht gekoppelt', () => {
    const s = openAuthStore(file, fakeAuthLib)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(s.isPaired(), false)
    s.close()
  })

  it('Zugangsdaten ueberstehen einen Neustart (Buffer-Rundreise)', () => {
    const a = openAuthStore(file, fakeAuthLib)
    a.state.creds.me = { id: '4917@s.whatsapp.net' }
    a.state.creds.registered = true
    a.state.creds.noiseKey = Buffer.from([1, 2, 3, 250])
    a.saveCreds()
    a.close()

    const b = openAuthStore(file, fakeAuthLib)
    assert.equal(b.isPaired(), true)
    assert.ok(Buffer.isBuffer(b.state.creds.noiseKey))
    assert.deepEqual([...b.state.creds.noiseKey], [1, 2, 3, 250])
    b.close()
  })

  it('Schluessel: fehlende IDs -> null, set/get Rundreise, null loescht', () => {
    const s = openAuthStore(file, fakeAuthLib)
    s.state.keys.set({ 'pre-key': { '1': { public: Buffer.from('pub'), private: Buffer.from('priv') } } })
    const got = s.state.keys.get('pre-key', ['1', '2'])
    assert.ok(Buffer.isBuffer(got['1'].public))
    assert.equal(got['1'].public.toString(), 'pub')
    assert.equal(got['2'], null)
    s.state.keys.set({ 'pre-key': { '1': null as never } })
    assert.equal(s.state.keys.get('pre-key', ['1'])['1'], null)
    s.close()
  })

  it('app-state-sync-key wird ueber die Bibliothek wiederhergestellt', () => {
    const s = openAuthStore(file, fakeAuthLib)
    s.state.keys.set({ 'app-state-sync-key': { k1: { keyData: Buffer.from('x') } } })
    const got = s.state.keys.get('app-state-sync-key', ['k1'])['k1']
    assert.equal(got.revived, true)
    s.close()
  })

  it('Mehrfach-Schreiben in einem Stapel ist atomar (Fehler -> nichts geschrieben)', () => {
    const s = openAuthStore(file, fakeAuthLib)
    const circular: any = {}
    circular.self = circular
    assert.throws(() =>
      s.state.keys.set({ 'session': { a: { ok: 1 }, b: circular } }),
    )
    assert.equal(s.state.keys.get('session', ['a'])['a'], null)
    s.close()
  })

  it('wipe + reset: alles weg, frische Zugangsdaten, nicht mehr gekoppelt', () => {
    const s = openAuthStore(file, fakeAuthLib)
    s.state.creds.me = { id: 'x@s.whatsapp.net' }
    s.saveCreds()
    s.state.keys.set({ session: { a: { v: 1 } } })
    assert.equal(s.isPaired(), true)
    s.wipe()
    s.reset()
    assert.equal(s.isPaired(), false)
    assert.equal(s.state.keys.get('session', ['a'])['a'], null)
    s.close()
    const again = openAuthStore(file, fakeAuthLib)
    assert.equal(again.isPaired(), false)
    again.close()
  })
})
