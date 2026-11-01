import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { proto } from 'baileys'
import { MessageHandler, type MediaSink } from '../src/messageHandler.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'
import { encryptEdit } from './support/secretEditSupport.js'

const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const LID = '123456789012345@lid'
const SELF_PN = '491700000000@s.whatsapp.net'
const SELF_LID = '999888777666555@lid'
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i))
const noMedia: MediaSink = { enqueue: () => 'disabled' }

/** Nachrichtenbytes wie nach der Entschluesselung: protocolMessage.editedMessage traegt den neuen Inhalt. */
function editPlaintext(target: string, edited: Record<string, unknown>, timestampMs = (NOW - 30) * 1000): Uint8Array {
  const msg = proto.Message.fromObject({
    protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: target, fromMe: true }, editedMessage: edited, timestampMs },
  })
  return proto.Message.encode(msg).finish()
}

const original = (id: string, over: Record<string, unknown> = {}, message: Record<string, unknown> = { conversation: 'Hallo' }) => ({
  type: 'notify',
  messages: [
    {
      key: { id, remoteJid: LID, remoteJidAlt: PN, fromMe: false },
      messageTimestamp: NOW - 120,
      pushName: 'Anna',
      message: { ...message, messageContextInfo: { messageSecret: SECRET } },
      ...over,
    },
  ],
})

const editEnvelope = (
  id: string,
  target: string,
  enc: { iv: Buffer; payload: Buffer },
  key: Record<string, unknown> = { remoteJid: LID, remoteJidAlt: PN, fromMe: false },
  type: number | string = 2,
  targetKey: Record<string, unknown> = { remoteJid: LID, fromMe: true, id: target },
) => ({
  type: 'notify',
  messages: [
    {
      key: { id, ...key },
      messageTimestamp: NOW - 20,
      pushName: 'Anna',
      message: { secretEncryptedMessage: { targetMessageKey: { ...targetKey, id: target }, encPayload: enc.payload, encIv: enc.iv, secretEncType: type } },
    },
  ],
})

describe('MessageHandler: verschluesselte Bearbeitung (secretEncryptedMessage, MESSAGE_EDIT)', () => {
  let env: TestEnv
  let handler: MessageHandler

  const make = (over: Partial<ConstructorParameters<typeof MessageHandler>[0]> = {}): MessageHandler =>
    new MessageHandler({
      db: env.db,
      jobs: env.jobs,
      media: noMedia,
      cfg: env.cfg,
      log: env.log,
      now: () => NOW,
      decodeMessage: (b) => proto.Message.decode(b),
      selfJids: () => [SELF_PN, SELF_LID],
      ...over,
    })
  const text = (id: string): string | undefined => one(env.db, 'SELECT text FROM messages WHERE id = ?', id)?.text
  const events = (type: string): number => one(env.db, 'SELECT COUNT(*) AS n FROM events_outbox WHERE type = ?', type).n
  const logged = (ev: string): string[] => env.lines.filter((l) => l.includes(`"ev":"${ev}"`))

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    handler = make()
  })
  afterEach(() => env.close())

  it('speichert das Geheimnis der Originalnachricht im privaten Speicher, nicht in der gemeinsamen Datenbank', () => {
    handler.handleUpsert(original('M1'))
    const s = env.jobs.getMsgSecret('M1')
    assert.ok(s?.secret.equals(SECRET))
    assert.deepEqual(s?.senders, [LID, PN], 'beide Schreibweisen des Absenders')
    assert.equal(s?.waTimestamp, NOW - 120)
    const dump = JSON.stringify(all(env.db, 'SELECT * FROM messages'))
    assert.ok(!dump.includes(SECRET.toString('base64')) && !dump.includes(SECRET.toString('hex')))
    assert.ok(!env.lines.join('\n').includes(SECRET.toString('base64')), 'nie im Journal')
  })

  it('wendet die Bearbeitung an: neuer Text, bisherige Fassung als Version, keine neue Zeile', () => {
    handler.handleUpsert(original('M1'))
    const enc = encryptEdit(SECRET, 'M1', LID, LID, editPlaintext('M1', { conversation: 'Hallo, neu' }))
    const stats = handler.handleUpsert(editEnvelope('E1', 'M1', enc))
    assert.deepEqual(stats, { stored: 0, duplicates: 0, dropped: 0, ignored: 1 })
    assert.equal(text('M1'), 'Hallo, neu')
    const row = one(env.db, 'SELECT edited, edited_at FROM messages WHERE id = ?', 'M1')
    assert.equal(row.edited, 1)
    assert.equal(row.edited_at, NOW - 30, 'Zeit aus protocolMessage.timestampMs (Millisekunden, Long)')
    assert.deepEqual(all(env.db, 'SELECT version, text FROM message_versions WHERE message_id = ?', 'M1'), [{ version: 1, text: 'Hallo' }])
    assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1, 'keine Zeile "Nicht unterstuetzter Nachrichtentyp"')
    assert.equal(events('message_updated'), 1)
    assert.equal(logged('edit_decrypted').length, 1)
    assert.equal(logged('message_edit_stored').length, 1)
  })

  it('der Suchindex enthaelt danach nur den neuen Text', () => {
    handler.handleUpsert(original('M1', {}, { conversation: 'alteswort' }))
    handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'neueswort' }))))
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'neueswort'").n, 1)
    assert.equal(one(env.db, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'alteswort'").n, 0)
  })

  it('mehrere Bearbeitungen ergeben mehrere Versionen; gleicher Text erzeugt keine neue', () => {
    handler.handleUpsert(original('M1'))
    const send = (id: string, t: string) =>
      handler.handleUpsert(editEnvelope(id, 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: t }))))
    send('E1', 'zwei')
    send('E2', 'drei')
    send('E3', 'drei')
    assert.equal(text('M1'), 'drei')
    assert.deepEqual(all(env.db, 'SELECT version, text FROM message_versions ORDER BY version'), [
      { version: 1, text: 'Hallo' },
      { version: 2, text: 'zwei' },
    ])
  })

  it('findet auch den Fall, dass der Absender die Nummer verwendete, die Nachricht aber unter der LID eintraf', () => {
    handler.handleUpsert(original('M1'))
    const enc = encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'ueber Nummer' }))
    handler.handleUpsert(editEnvelope('E1', 'M1', enc))
    assert.equal(text('M1'), 'ueber Nummer')
  })

  it('Original unter LID, Bearbeitung unter Nummer (gemischte Schreibweise)', () => {
    handler.handleUpsert(original('M1'))
    handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', LID, PN, editPlaintext('M1', { conversation: 'gemischt' }))))
    assert.equal(text('M1'), 'gemischt')
  })

  it('akzeptiert die Typ-Angabe als Name (MESSAGE_EDIT) wie als Zahl (2)', () => {
    handler.handleUpsert(original('M1'))
    handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'per Name' })), undefined, 'MESSAGE_EDIT'))
    assert.equal(text('M1'), 'per Name')
  })

  it('Bearbeitung einer Bildunterschrift', () => {
    handler.handleUpsert(
      original('M1', {}, {
        imageMessage: { caption: 'alt', mimetype: 'image/jpeg', mediaKey: Buffer.from('k'), fileLength: 10, directPath: '/x' },
      }),
    )
    handler.handleUpsert(
      editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { imageMessage: { caption: 'neu', mimetype: 'image/jpeg' } }))),
    )
    assert.equal(text('M1'), 'neu')
  })

  it('der Klartext darf den neuen Inhalt auch direkt tragen (ohne protocolMessage)', () => {
    handler.handleUpsert(original('M1'))
    const direct = proto.Message.encode(proto.Message.fromObject({ conversation: 'direkt' })).finish()
    handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, direct)))
    assert.equal(text('M1'), 'direkt')
  })

  it('Gruppe: Absender und Bearbeiter sind der Teilnehmer', () => {
    const G = '120363000000000001@g.us'
    handler.handleUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'G1', remoteJid: G, participant: LID, participantAlt: PN, fromMe: false },
          messageTimestamp: NOW - 100,
          message: { conversation: 'Gruppentext', messageContextInfo: { messageSecret: SECRET } },
        },
      ],
    })
    assert.deepEqual(env.jobs.getMsgSecret('G1')?.senders, [LID, PN])
    const enc = encryptEdit(SECRET, 'G1', PN, PN, editPlaintext('G1', { conversation: 'Gruppentext neu' }))
    handler.handleUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'GE1', remoteJid: G, participant: LID, participantAlt: PN, fromMe: false },
          messageTimestamp: NOW - 10,
          message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: G, fromMe: false, id: 'G1', participant: PN }, encPayload: enc.payload, encIv: enc.iv, secretEncType: 2 } },
        },
      ],
    })
    assert.equal(text('G1'), 'Gruppentext neu')
  })

  it('eigene Nachricht, vom eigenen Handy bearbeitet: Bearbeiter ist das eigene Konto', () => {
    handler.handleUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'O1', remoteJid: PN, fromMe: true },
          messageTimestamp: NOW - 100,
          message: { conversation: 'von mir', messageContextInfo: { messageSecret: SECRET } },
        },
      ],
    })
    assert.deepEqual(env.jobs.getMsgSecret('O1')?.senders, [SELF_PN, SELF_LID])
    const enc = encryptEdit(SECRET, 'O1', SELF_LID, SELF_LID, editPlaintext('O1', { conversation: 'von mir, neu' }))
    handler.handleUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'OE1', remoteJid: PN, fromMe: true },
          messageTimestamp: NOW - 10,
          message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: PN, fromMe: true, id: 'O1' }, encPayload: enc.payload, encIv: enc.iv, secretEncType: 2 } },
        },
      ],
    })
    assert.equal(text('O1'), 'von mir, neu')
  })

  describe('wenn etwas fehlt oder nicht stimmt, entsteht nie eine Zeile und nie eine falsche Aenderung', () => {
    const noRow = () => assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 1)

    it('Geheimnis der Originalnachricht unbekannt (Nachricht kam vor dieser Version)', () => {
      handler.handleUpsert(original('M1', {}, { conversation: 'Hallo' }))
      env.jobs.clearIdentityData()
      const stats = handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'x' }))))
      assert.equal(stats.ignored, 1)
      assert.equal(text('M1'), 'Hallo')
      noRow()
      assert.equal(logged('edit_secret_missing').length, 1)
    })

    it('Original gar nicht gespeichert: nichts passiert, nur eine Journalzeile', () => {
      const stats = handler.handleUpsert(editEnvelope('E1', 'UNBEKANNT', encryptEdit(SECRET, 'UNBEKANNT', PN, PN, editPlaintext('UNBEKANNT', { conversation: 'x' }))))
      assert.equal(stats.ignored, 1)
      assert.equal(one(env.db, 'SELECT COUNT(*) AS n FROM messages').n, 0)
      assert.equal(logged('edit_secret_missing').length, 1)
    })

    it('beschaedigte Nutzlast', () => {
      handler.handleUpsert(original('M1'))
      const enc = encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'x' }))
      enc.payload[3] = (enc.payload[3] ?? 0) ^ 0xff
      handler.handleUpsert(editEnvelope('E1', 'M1', enc))
      assert.equal(text('M1'), 'Hallo')
      noRow()
      assert.equal(logged('edit_decrypt_failed').length, 1)
    })

    it('von einem Fremden gefaelscht: verschluesselt unter anderer JID als der des Absenders', () => {
      handler.handleUpsert(original('M1'))
      const forged = encryptEdit(SECRET, 'M1', PN, '491799999999@s.whatsapp.net', editPlaintext('M1', { conversation: 'gefaelscht' }))
      handler.handleUpsert(editEnvelope('E1', 'M1', forged))
      assert.equal(text('M1'), 'Hallo')
      noRow()
      assert.equal(logged('edit_decrypt_failed').length, 1)
    })

    it('falsches Geheimnis', () => {
      handler.handleUpsert(original('M1'))
      handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(Buffer.alloc(32, 4), 'M1', PN, PN, editPlaintext('M1', { conversation: 'x' }))))
      assert.equal(text('M1'), 'Hallo')
      noRow()
    })

    it('ohne Lesefunktion fuer Nachrichtenbytes: Hinweis im Journal, keine Aenderung', () => {
      handler = make({ decodeMessage: undefined as never })
      handler.handleUpsert(original('M1'))
      handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'x' }))))
      assert.equal(text('M1'), 'Hallo')
      assert.equal(logged('edit_decode_unavailable').length, 1)
    })

    it('Klartext ist keine lesbare Nachricht', () => {
      handler.handleUpsert(original('M1'))
      handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))))
      assert.equal(text('M1'), 'Hallo')
      noRow()
      assert.equal(logged('edit_decode_failed').length, 1)
    })

    it('Bearbeitung ohne Text (z. B. nur ein Sticker): keine Aenderung, Journal nennt nur Feldnamen', () => {
      handler.handleUpsert(original('M1'))
      handler.handleUpsert(
        editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { stickerMessage: { mimetype: 'image/webp' } }))),
      )
      assert.equal(text('M1'), 'Hallo')
      assert.equal(logged('edit_without_text').length, 1)
      assert.match(logged('edit_without_text')[0] ?? '', /stickerMessage/)
    })

    it('unvollstaendige Huelle (ohne Nutzlast oder Ziel)', () => {
      handler.handleUpsert(original('M1'))
      const bad = editEnvelope('E1', 'M1', { iv: Buffer.alloc(12), payload: Buffer.alloc(20) })
      ;(bad.messages[0]!.message.secretEncryptedMessage as any).encPayload = undefined
      handler.handleUpsert(bad)
      const bad2 = editEnvelope('E2', 'M1', { iv: Buffer.alloc(12), payload: Buffer.alloc(20) })
      ;(bad2.messages[0]!.message.secretEncryptedMessage as any).targetMessageKey = {}
      handler.handleUpsert(bad2)
      assert.equal(text('M1'), 'Hallo')
      noRow()
      assert.equal(logged('edit_invalid').length, 2)
    })

    it('andere verschluesselte Arten (Termin-Bearbeitung) erzeugen ebenfalls keine Zeile', () => {
      handler.handleUpsert(original('M1'))
      const stats = handler.handleUpsert(editEnvelope('E1', 'M1', { iv: Buffer.alloc(12), payload: Buffer.alloc(20) }, undefined, 1))
      assert.equal(stats.ignored, 1)
      assert.equal(stats.stored, 0)
      noRow()
    })
  })

  it('Journal: nur Kennungen und Arten, nie Textinhalte oder Geheimnisse', () => {
    handler.handleUpsert(original('M1'))
    handler.handleUpsert(editEnvelope('E1', 'M1', encryptEdit(SECRET, 'M1', PN, PN, editPlaintext('M1', { conversation: 'streng geheimer Text' }))))
    const journal = env.lines.join('\n')
    assert.ok(!journal.includes('streng geheimer Text') && !journal.includes('Hallo'))
    assert.ok(!journal.includes(PN) && !journal.includes(LID))
  })

  it('Geheimnisse werden nach Aufbewahrung plus zwei Tagen entfernt', () => {
    handler.handleUpsert(original('OLD', { messageTimestamp: NOW - 2 * 86_400 }))
    handler.handleUpsert(original('NEW', { messageTimestamp: NOW - 60 }))
    assert.equal(env.jobs.countMsgSecrets(), 2)
    assert.equal(handler.purgeSecrets(), 0, 'beide liegen innerhalb von 3 + 2 Tagen')
    const later = make({ now: () => NOW + 4 * 86_400 })
    assert.equal(later.purgeSecrets(), 1, 'nur die aeltere faellt heraus (Zeitstempel vor NOW - 1 Tag)')
    assert.ok(env.jobs.getMsgSecret('NEW'))
    assert.equal(env.jobs.getMsgSecret('OLD'), undefined)
  })

  it('Nachrichten ohne Geheimnis (aeltere Apps, Verlauf) werden wie bisher gespeichert', () => {
    handler.handleUpsert({ type: 'notify', messages: [{ key: { id: 'P1', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 5, message: { conversation: 'ohne' } }] })
    assert.equal(env.jobs.getMsgSecret('P1'), undefined)
    assert.equal(text('P1'), 'ohne')
  })

  it('ein Geheimnis falscher Laenge wird nicht gespeichert', () => {
    handler.handleUpsert({
      type: 'notify',
      messages: [{ key: { id: 'P2', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 5, message: { conversation: 'x', messageContextInfo: { messageSecret: Buffer.alloc(16) } } }],
    })
    assert.equal(env.jobs.getMsgSecret('P2'), undefined)
    assert.equal(text('P2'), 'x')
  })
})
