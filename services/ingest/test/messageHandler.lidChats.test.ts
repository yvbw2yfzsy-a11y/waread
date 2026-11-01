import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MessageHandler, type MediaSink } from '../src/messageHandler.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const LID = '123456789012345@lid'
const noMedia: MediaSink = { enqueue: () => 'disabled' }

const msg = (id: string, remoteJid: string, text = 'Hallo Welt', extra: Record<string, unknown> = {}) => ({
  type: 'notify',
  messages: [{ key: { id, remoteJid, fromMe: false, ...extra }, messageTimestamp: NOW - 60, pushName: 'Anna', message: { conversation: text } }],
})

describe('MessageHandler: dieselbe Person als LID-Chat und als Nummern-Chat wird ein Chat', () => {
  let env: TestEnv
  let handler: MessageHandler
  let libMap: Map<string, string>
  let libCalls: number

  const make = (over: Partial<ConstructorParameters<typeof MessageHandler>[0]> = {}): MessageHandler =>
    new MessageHandler({
      db: env.db,
      jobs: env.jobs,
      media: noMedia,
      cfg: env.cfg,
      log: env.log,
      now: () => NOW,
      libPnForLid: (lid) => {
        libCalls++
        return libMap.get(lid)
      },
      ...over,
    })
  const chats = (): string[] => all(env.db, 'SELECT id FROM chats ORDER BY id').map((r) => r.id)
  const countIn = (chat: string): number => one(env.db, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', chat).n
  const reloads = (): number => one(env.db, "SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'history_synced'").n

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    libMap = new Map()
    libCalls = 0
    handler = make()
  })
  afterEach(() => env.close())

  it('eine gemeldete Zuordnung fuehrt beide Chats zusammen: der Verlauf liegt danach im Nummern-Chat', () => {
    handler.handleUpsert(msg('a1', LID, 'alt eins'))
    handler.handleUpsert(msg('a2', LID, 'alt zwei'))
    handler.handleUpsert(msg('b1', PN, 'neu'))
    assert.deepEqual(chats(), [LID, PN].sort())
    handler.handleLidMapping({ lid: LID, pn: PN })
    assert.deepEqual(chats(), [PN])
    assert.equal(countIn(PN), 3)
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', LID).n, 0)
    assert.equal(reloads(), 1, 'die Oberflaeche laedt die Chatliste neu')
    assert.equal(env.lines.filter((l) => l.includes('"ev":"lid_chats_merged"')).length, 1)
  })

  it('gibt es den Nummern-Chat noch nicht, wird der LID-Chat zum Nummern-Chat (Name und Verlauf bleiben)', () => {
    handler.handleUpsert(msg('a1', LID, 'einziger Eintrag'))
    env.jobs.upsertName(LID, 'Anna Beispiel', 3)
    handler.handleUpsert(msg('a2', LID, 'noch einer'))
    assert.equal(one(env.db, 'SELECT name FROM chats WHERE id = ?', LID).name, 'Anna Beispiel')
    handler.handleLidMapping({ lid: LID, pn: PN })
    assert.deepEqual(chats(), [PN])
    assert.equal(countIn(PN), 2)
    assert.equal(one(env.db, 'SELECT name FROM chats WHERE id = ?', PN).name, 'Anna Beispiel')
  })

  it('der Suchindex zeigt nach dem Zusammenfuehren den Namen des Nummern-Chats', () => {
    handler.handleUpsert(msg('a1', LID, 'zebrawort'))
    handler.handleUpsert(msg('b1', PN, 'etwas'))
    handler.handleContacts([{ id: PN, name: 'Quokka' }])
    handler.handleLidMapping({ lid: LID, pn: PN })
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'quokka'").n, 2)
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'zebrawort'").n, 1)
  })

  it('Zuordnung der Bibliothek beim Start: bestehende LID-Chats werden zusammengefuehrt, ohne dass etwas gemeldet wurde', () => {
    handler.handleUpsert(msg('a1', LID))
    handler.handleUpsert(msg('b1', PN))
    assert.equal(handler.reconcileLidChats(), 0, 'ohne bekannte Zuordnung passiert nichts')
    assert.deepEqual(chats(), [LID, PN].sort())
    libMap.set(LID, PN)
    assert.equal(handler.reconcileLidChats(), 1)
    assert.deepEqual(chats(), [PN])
    assert.equal(env.jobs.pnForLid(LID), PN, 'die gefundene Zuordnung wird dauerhaft uebernommen')
    assert.equal(handler.reconcileLidChats(), 0, 'ein zweiter Lauf findet nichts mehr')
  })

  it('eine neue Nachricht von einer LID mit bekannter Zuordnung landet gleich im Nummern-Chat', () => {
    libMap.set(LID, PN)
    handler.handleUpsert(msg('a1', LID, 'ueber LID'))
    assert.deepEqual(chats(), [PN])
    assert.equal(countIn(PN), 1)
  })

  it('die Bibliothek wird je LID nur einmal gefragt (danach gilt die uebernommene Zuordnung)', () => {
    libMap.set(LID, PN)
    handler.handleUpsert(msg('a1', LID))
    handler.handleUpsert(msg('a2', LID))
    handler.handleUpsert(msg('a3', LID))
    assert.equal(libCalls, 1)
  })

  it('ohne Zuordnung bleibt der LID-Chat, wie er ist', () => {
    handler.handleUpsert(msg('a1', LID))
    handler.handleLidMapping({ lid: '999@lid', pn: '491700000000@s.whatsapp.net' })
    assert.deepEqual(chats(), [LID])
  })

  it('Kontakt mit LID und Nummer fuehrt ebenfalls zusammen', () => {
    handler.handleUpsert(msg('a1', LID))
    handler.handleUpsert(msg('b1', PN))
    handler.handleContacts([{ id: PN, lid: LID, phoneNumber: PN, name: 'Anna' }])
    assert.deepEqual(chats(), [PN])
    assert.equal(one(env.db, 'SELECT name FROM chats WHERE id = ?', PN).name, 'Anna')
  })

  it('Chat-Eintrag mit pnJid fuehrt zusammen', () => {
    handler.handleUpsert(msg('a1', LID))
    handler.handleChats([{ id: LID, pnJid: PN }])
    assert.deepEqual(chats(), [PN])
  })

  it('Verlauf beim Koppeln: Chats, deren Zuordnung mitkommt, entstehen gar nicht erst doppelt', async () => {
    await handler.handleHistory({
      lidPnMappings: [{ lid: LID, pn: PN }],
      messages: [
        { key: { id: 'h1', remoteJid: LID, fromMe: false }, messageTimestamp: NOW - 100, message: { conversation: 'a' } },
        { key: { id: 'h2', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 90, message: { conversation: 'b' } },
      ],
    })
    assert.deepEqual(chats(), [PN])
    assert.equal(countIn(PN), 2)
  })

  it('Verlauf: kommt die Zuordnung erst nach den Nachrichten (Bibliothek), fuehrt der Abschluss zusammen', async () => {
    const lateLib = make({ libPnForLid: (lid) => (lateLibKnows ? libMap.get(lid) : undefined) })
    let lateLibKnows = false
    libMap.set(LID, PN)
    await lateLib.handleHistory({
      messages: [
        { key: { id: 'h1', remoteJid: LID, fromMe: false }, messageTimestamp: NOW - 100, message: { conversation: 'a' } },
        { key: { id: 'h2', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 90, message: { conversation: 'b' } },
      ],
    })
    assert.deepEqual(chats(), [LID, PN].sort(), 'noch unbekannt')
    lateLibKnows = true
    assert.equal(lateLib.reconcileLidChats(), 1)
    assert.deepEqual(chats(), [PN])
  })

  it('Gruppen und Nummern-Chats werden nie angefasst', () => {
    handler.handleUpsert({
      type: 'notify',
      messages: [{ key: { id: 'g1', remoteJid: '120363000000000001@g.us', participant: LID, fromMe: false }, messageTimestamp: NOW - 60, message: { conversation: 'x' } }],
    })
    handler.handleUpsert(msg('b1', PN))
    libMap.set(LID, PN)
    assert.equal(handler.reconcileLidChats(), 0)
    assert.equal(chats().length, 2)
  })

  it('die Bibliothek wirft oder liefert Muell: keine Zuordnung, kein Absturz', () => {
    const bad = make({
      libPnForLid: () => {
        throw new Error('kaputt')
      },
    })
    bad.handleUpsert(msg('a1', LID))
    assert.deepEqual(chats(), [LID])
    assert.equal(bad.reconcileLidChats(), 0)
  })

  it('ein Fehler beim Zusammenfuehren (z. B. Schreibsperre) bricht nichts ab und aendert nichts', () => {
    handler.handleUpsert(msg('a1', LID))
    handler.handleUpsert(msg('b1', PN))
    libMap.set(LID, PN)
    env.db.exec('DROP TABLE messages_fts_map')
    assert.doesNotThrow(() => handler.reconcileLidChats())
    assert.equal(env.lines.filter((l) => l.includes('"ev":"lid_merge_failed"')).length, 1)
    assert.equal(countIn(LID), 1, 'nichts verschoben (Transaktion zurueckgerollt)')
  })

  it('Journal ohne Namen, Nummern und Texte', () => {
    handler.handleUpsert(msg('a1', LID, 'geheimer Text'))
    handler.handleLidMapping({ lid: LID, pn: PN })
    const journal = env.lines.join('\n')
    assert.ok(!journal.includes('geheimer Text') && !journal.includes('Anna') && !journal.includes('4917012'))
  })
})
