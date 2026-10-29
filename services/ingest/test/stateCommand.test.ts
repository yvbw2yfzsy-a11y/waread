// F14: "Speicher leeren -> alles" und Abmelden muessen auch die Namen und die LID<->Nummer-Zuordnung im privaten
// Speicher des Ingest (ingest-state.db) entfernen. Das Web schreibt dafuer einen Befehl in die settings-Tabelle.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { getSetting, setSetting } from '../src/dbClient.js'
import { StateCommands } from '../src/stateCommand.js'
import { FakeScheduler, makeEnv, type TestEnv } from './support/helpers.js'
import type { MediaDescriptor } from '../src/jobStore.js'

const KEY = 'ingest.state_command'

describe('F14: StateCommands (Befehl clear_identity)', () => {
  let env: TestEnv
  let sched: FakeScheduler
  let cmds: StateCommands

  const fill = (): void => {
    env.jobs.upsertName('491701234567@s.whatsapp.net', 'Anna Beispiel', 3)
    env.jobs.setLidMapping('123456789@lid', '491701234567@s.whatsapp.net')
    const descriptor: MediaDescriptor = {
      hkdfType: 'image', mediaKey: 'a2V5', directPath: '/v/x', url: null, fileSha256: null,
      mimetype: 'image/jpeg', fileLength: 1, fileName: null, seconds: null, ptt: false,
    }
    env.jobs.upsertJob({ messageId: 'm1', chatId: 'c1', kind: 'image', descriptor, waTimestamp: 1 }, 1)
  }

  beforeEach(() => {
    env = makeEnv()
    sched = new FakeScheduler()
    cmds = new StateCommands({ db: env.db, jobs: env.jobs, log: env.log, pollMs: 3000, scheduler: sched })
  })
  afterEach(() => {
    cmds.stop()
    env.close()
  })

  it('clear_identity loescht Namen und LID-Zuordnung, laesst die Medienaufgaben stehen und quittiert den Befehl', () => {
    fill()
    setSetting(env.db, KEY, 'clear_identity')
    cmds.start()
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), undefined)
    assert.equal(env.jobs.pnForLid('123456789@lid'), undefined)
    assert.equal(env.jobs.countJobs(), 1, 'Medienaufgaben gehoeren nicht zu diesem Befehl')
    assert.equal(getSetting(env.db, KEY), '', 'Befehl quittiert')
  })

  it('ein schon vor dem Start gesetzter Befehl wird sofort ausgefuehrt, nicht erst nach einem Poll-Takt', () => {
    fill()
    setSetting(env.db, KEY, 'clear_identity')
    cmds.start()
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), undefined)
    assert.equal(sched.now, 0)
  })

  it('ein spaeter gesetzter Befehl wird im naechsten Takt ausgefuehrt', () => {
    cmds.start()
    fill()
    setSetting(env.db, KEY, 'clear_identity')
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), 'Anna Beispiel')
    sched.advance(3000)
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), undefined)
    assert.equal(getSetting(env.db, KEY), '')
  })

  it('leerer oder fehlender Befehl: nichts passiert', () => {
    fill()
    cmds.start()
    setSetting(env.db, KEY, '')
    sched.advance(9000)
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), 'Anna Beispiel')
    assert.equal(env.jobs.pnForLid('123456789@lid'), '491701234567@s.whatsapp.net')
  })

  it('unbekannter Befehl: nichts geloescht, quittiert, Warnung ohne den Befehlstext', () => {
    fill()
    setSetting(env.db, KEY, 'rm -rf GEHEIM-4711')
    cmds.start()
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), 'Anna Beispiel')
    assert.equal(getSetting(env.db, KEY), '')
    const out = env.lines.join('\n')
    assert.ok(out.includes('state_command_unknown'), out)
    assert.ok(!out.includes('GEHEIM-4711') && !out.includes('4917') && !out.includes('Anna'), out)
  })

  it('Protokoll des Loeschens enthaelt nur Anzahlen, keine Namen oder Nummern', () => {
    fill()
    setSetting(env.db, KEY, 'clear_identity')
    cmds.start()
    const out = env.lines.join('\n')
    assert.ok(out.includes('state_identity_cleared'), out)
    assert.ok(!out.includes('4917') && !out.includes('Anna') && !out.includes('123456789'), out)
  })

  it('stop() beendet das Abfragen', () => {
    cmds.start()
    cmds.stop()
    fill()
    setSetting(env.db, KEY, 'clear_identity')
    sched.advance(30_000)
    assert.equal(env.jobs.getName('491701234567@s.whatsapp.net'), 'Anna Beispiel')
  })
})
