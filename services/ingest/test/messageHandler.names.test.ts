import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MessageHandler, type MediaSink } from '../src/messageHandler.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const PN2 = '491709999999@s.whatsapp.net'
const LID = '123456789012345@lid'
const GROUP = '120363000000000001@g.us'
const noMedia: MediaSink = { enqueue: () => 'disabled' }

const text = (id: string, remoteJid: string, extra: Record<string, unknown> = {}) => ({
  type: 'notify',
  messages: [{ key: { id, remoteJid, fromMe: false, ...extra }, messageTimestamp: NOW - 60, message: { conversation: 'Hallo Welt' } }],
})

describe('MessageHandler: Chatnamen werden sofort nachgezogen, wenn ein Name bekannt wird', () => {
  let env: TestEnv
  let handler: MessageHandler
  const name = (id: string): string | null | undefined => one(env.db, 'SELECT name FROM chats WHERE id = ?', id)?.name
  const reloads = (): number => one(env.db, "SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'history_synced'").n

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    handler = new MessageHandler({ db: env.db, jobs: env.jobs, media: noMedia, cfg: env.cfg, log: env.log, now: () => NOW })
  })
  afterEach(() => env.close())

  it('Kontaktname nach der ersten Nachricht: der Chat heisst sofort so, nicht erst nach der naechsten Nachricht', () => {
    handler.handleUpsert(text('m1', PN))
    assert.equal(name(PN), '+491701234567', 'ohne bekannten Namen: die Nummer')
    handler.handleContacts([{ id: PN, name: 'Anna Beispiel' }])
    assert.equal(name(PN), 'Anna Beispiel')
    assert.equal(reloads(), 1, 'die Oberflaeche laedt die Chatliste neu')
  })

  it('der Suchindex folgt: die Nachrichten sind danach unter dem neuen Namen auffindbar', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleContacts([{ id: PN, name: 'Zebrafink' }])
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'zebrafink'").n, 1)
  })

  it('legt nie einen Chat an: unbekannte Kontakte bleiben ohne Chat', () => {
    handler.handleContacts([{ id: PN2, name: 'Niemand' }])
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM chats').n, 0)
    assert.equal(reloads(), 0)
  })

  it('gleicher Name: keine Aenderung, kein Ereignis', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleContacts([{ id: PN, name: 'Anna' }])
    handler.handleContacts([{ id: PN, name: 'Anna' }])
    assert.equal(name(PN), 'Anna')
    assert.equal(reloads(), 1, 'nur beim ersten Mal')
  })

  it('ein niedriger bewerteter Name (Push-Name) ueberschreibt einen Kontaktnamen nicht', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleContacts([{ id: PN, name: 'Anna Beispiel' }])
    handler.handleContacts([{ id: PN, notify: 'anni <3' }])
    assert.equal(name(PN), 'Anna Beispiel')
  })

  it('ein Push-Name wird uebernommen, solange es nichts Besseres gibt', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleContacts([{ id: PN, notify: 'Anni' }])
    assert.equal(name(PN), 'Anni')
  })

  it('Kontakt mit LID und Nummer: der Name gilt, und der LID-Chat geht im Nummern-Chat auf (siehe messageHandler.lidChats.test.ts)', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleUpsert(text('m2', LID))
    assert.equal(name(LID), null, 'LID-Chat ohne Namen')
    handler.handleContacts([{ id: PN, lid: LID, phoneNumber: PN, name: 'Anna Beispiel' }])
    assert.equal(name(PN), 'Anna Beispiel')
    assert.equal(name(LID), undefined, 'es gibt nur noch einen Chat')
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', PN).n, 2)
  })

  it('LID ohne bekannte Zuordnung: der Chat bekommt den Namen, den die LID selbst traegt', () => {
    handler.handleUpsert(text('m2', LID))
    handler.handleContacts([{ id: LID, notify: 'Unbekannt Anna' }])
    assert.equal(name(LID), 'Unbekannt Anna')
  })

  it('Gruppenname: der bestehende Gruppenchat wird umbenannt', () => {
    handler.handleUpsert({
      type: 'notify',
      messages: [{ key: { id: 'g1', remoteJid: GROUP, participant: PN, fromMe: false }, messageTimestamp: NOW - 60, message: { conversation: 'Hallo' } }],
    })
    assert.equal(name(GROUP), null, 'Gruppe ohne bekannten Namen')
    handler.handleGroups([{ id: GROUP, subject: 'Familie' }])
    assert.equal(name(GROUP), 'Familie')
    handler.handleGroups([{ id: GROUP, subject: 'Familie 2' }])
    assert.equal(name(GROUP), 'Familie 2', 'eine Umbenennung der Gruppe')
  })

  it('Chat-Namen aus chats.upsert und chats.update', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleChats([{ id: PN, name: 'Anna Chat' }])
    assert.equal(name(PN), 'Anna Chat')
    handler.handleChats([{ id: PN, displayName: 'Anna Neu' }])
    assert.equal(name(PN), 'Anna Neu')
  })

  it('leere und fehlerhafte Eintraege stoeren nicht', () => {
    handler.handleUpsert(text('m1', PN))
    handler.handleContacts([{ id: PN, name: '   ' }, { name: 'ohne ID' }, null, { id: 5 }] as any)
    handler.handleChats([{ id: PN }, null, { name: 'ohne ID' }] as any)
    handler.handleGroups([{ id: GROUP }, { subject: 'ohne ID' }, null] as any)
    handler.handleContacts(undefined)
    assert.equal(name(PN), '+491701234567')
    assert.equal(reloads(), 0)
  })

  it('der Verlauf beim Koppeln benennt bestehende Chats ebenfalls um', async () => {
    handler.handleUpsert(text('m1', PN))
    await handler.handleHistory({ contacts: [{ id: PN, name: 'Anna Beispiel' }], chats: [], messages: [] })
    assert.equal(name(PN), 'Anna Beispiel')
  })

  it('ein Fehler beim Umbenennen (z. B. Schreibsperre) bricht nichts ab und steht ohne Inhalt im Journal', () => {
    handler.handleUpsert(text('m1', PN))
    env.db.exec('DROP TRIGGER IF EXISTS trg_chats_au_name')
    env.db.exec('ALTER TABLE chats RENAME TO chats_weg')
    assert.doesNotThrow(() => handler.handleContacts([{ id: PN, name: 'Anna Beispiel' }]))
    assert.equal(env.lines.filter((l) => l.includes('"ev":"chat_rename_failed"')).length, 1)
    assert.ok(!env.lines.join('\n').includes('Anna Beispiel'))
    assert.equal(all(env.db, "SELECT 1 FROM events_outbox WHERE type = 'history_synced'").length, 0)
  })
})
