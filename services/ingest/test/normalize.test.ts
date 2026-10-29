import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isIgnoredChat,
  normalizeJid,
  normalizeMessage,
  PLACEHOLDER,
  phoneLabel,
  toSeconds,
  type NormEnv,
  type RawMessage,
} from '../src/messageHandler.js'

const TS = 1_800_000_000
const noEnv: NormEnv = { pnForLid: () => undefined, nameOf: () => undefined }
const PN = '491701234567@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

const raw = (message: any, over: Partial<RawMessage> = {}): RawMessage => ({
  key: { id: 'ABC123', remoteJid: PN, fromMe: false },
  messageTimestamp: TS,
  message,
  ...over,
})

function msgOf(r: RawMessage, env: NormEnv = noEnv) {
  const res = normalizeMessage(r, env)
  assert.equal(res.kind, 'message', res.kind === 'ignored' ? res.reason : '')
  return res.kind === 'message' ? res.message : (undefined as never)
}

describe('JID-Hilfen', () => {
  it('normalizeJid entfernt Geraetesuffix und alte Domain', () => {
    assert.equal(normalizeJid('491701234567:12@s.whatsapp.net'), PN)
    assert.equal(normalizeJid('491701234567@c.us'), PN)
    assert.equal(normalizeJid(GROUP), GROUP)
    assert.equal(normalizeJid('ohne-at'), 'ohne-at')
  })
  it('isIgnoredChat', () => {
    assert.equal(isIgnoredChat('status@broadcast'), true)
    assert.equal(isIgnoredChat('123@broadcast'), true)
    assert.equal(isIgnoredChat('123@newsletter'), true)
    assert.equal(isIgnoredChat(PN), false)
    assert.equal(isIgnoredChat(GROUP), false)
  })
  it('phoneLabel', () => {
    assert.equal(phoneLabel(PN), '+491701234567')
    assert.equal(phoneLabel('123@lid'), undefined)
    assert.equal(phoneLabel('abc@s.whatsapp.net'), undefined)
  })
  it('toSeconds: Zahl, String, Long-artig, Millisekunden, Muell', () => {
    assert.equal(toSeconds(TS), TS)
    assert.equal(toSeconds(String(TS)), TS)
    assert.equal(toSeconds({ toNumber: () => TS }), TS)
    assert.equal(toSeconds(TS * 1000), TS)
    for (const bad of [0, -5, NaN, null, undefined, 'abc', {}, Infinity]) assert.equal(toSeconds(bad), null, String(bad))
  })
})

describe('normalizeMessage: Textarten', () => {
  it('einfacher Text', () => {
    const m = msgOf(raw({ conversation: 'Hallo' }))
    assert.equal(m.type, 'text')
    assert.equal(m.text, 'Hallo')
    assert.equal(m.direction, 'in')
    assert.equal(m.chatId, PN)
    assert.equal(m.waTimestamp, TS)
    assert.equal(m.id, 'ABC123')
  })

  it('erweiterter Text mit Antwort-Verweis', () => {
    const m = msgOf(raw({ extendedTextMessage: { text: 'Ja klar', contextInfo: { stanzaId: 'ORIG1' } } }))
    assert.equal(m.text, 'Ja klar')
    assert.equal(m.replyTo, 'ORIG1')
  })

  it('Standort, Kontakt, Umfrage werden zu lesbarem Text', () => {
    assert.match(msgOf(raw({ locationMessage: { name: 'Café', address: 'Hauptstr. 1' } })).text!, /Standort: Café, Hauptstr\. 1/)
    assert.match(msgOf(raw({ contactMessage: { displayName: 'Bob' } })).text!, /Kontakt: Bob/)
    const poll = msgOf(raw({ pollCreationMessageV3: { name: 'Pizza?', options: [{ optionName: 'Ja' }, { optionName: 'Nein' }] } }))
    assert.match(poll.text!, /Umfrage: Pizza\?\n• Ja\n• Nein/)
  })

  it('fluechtige Nachricht (ephemeralMessage) wird entpackt', () => {
    const m = msgOf(raw({ ephemeralMessage: { message: { conversation: 'weg damit' } } }))
    assert.equal(m.text, 'weg damit')
  })

  it('unbekannter Inhaltstyp -> system mit Platzhalter', () => {
    const m = msgOf(raw({ somethingNew: { x: 1 } }))
    assert.equal(m.type, 'system')
    assert.equal(m.text, PLACEHOLDER.unsupported)
  })
})

describe('normalizeMessage: Medien', () => {
  const key = Buffer.from('geheimer-schluessel')
  const sha = Buffer.from('hash')

  it('Bild mit Unterschrift und Deskriptor', () => {
    const m = msgOf(
      raw({
        imageMessage: {
          caption: 'Urlaub',
          mimetype: 'image/jpeg',
          mediaKey: key,
          fileSha256: sha,
          fileLength: { toNumber: () => 12345 },
          directPath: '/v/t62/abc',
          url: 'https://mmg.whatsapp.net/x',
        },
      }),
    )
    assert.equal(m.type, 'image')
    assert.equal(m.text, 'Urlaub')
    assert.equal(m.media?.kind, 'image')
    assert.equal(m.media?.declaredBytes, 12345)
    assert.equal(m.media?.mimeType, 'image/jpeg')
    assert.equal(m.media?.descriptor.mediaKey, key.toString('base64'))
    assert.equal(m.media?.descriptor.fileSha256, sha.toString('base64'))
    assert.equal(m.media?.descriptor.hkdfType, 'image')
    assert.equal(m.media?.descriptor.directPath, '/v/t62/abc')
  })

  it('Sprachnachricht (ptt) mit Dauer', () => {
    const m = msgOf(raw({ audioMessage: { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus', mediaKey: key } }))
    assert.equal(m.type, 'voice')
    assert.equal(m.text, undefined)
    assert.equal(m.media?.kind, 'voice')
    assert.equal(m.media?.durationSeconds, 7)
    assert.equal(m.media?.descriptor.ptt, true)
    assert.equal(m.media?.descriptor.hkdfType, 'audio')
  })

  it('Video und Rundvideo (ptv)', () => {
    assert.equal(msgOf(raw({ videoMessage: { mediaKey: key, caption: 'Clip' } })).media?.descriptor.hkdfType, 'video')
    const ptv = msgOf(raw({ ptvMessage: { mediaKey: key } }))
    assert.equal(ptv.type, 'video')
    assert.equal(ptv.media?.descriptor.hkdfType, 'ptv')
  })

  it('Dokument mit Dateiname; Dateiname steht NICHT im Nachrichtentext', () => {
    const m = msgOf(raw({ documentMessage: { fileName: 'Rechnung.pdf', mimetype: 'application/pdf', mediaKey: key } }))
    assert.equal(m.type, 'document')
    assert.equal(m.text, undefined)
    assert.equal(m.media?.descriptor.fileName, 'Rechnung.pdf')
  })

  it('Dokument mit Unterschrift (documentWithCaptionMessage)', () => {
    const m = msgOf(
      raw({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', caption: 'Bitte lesen', mediaKey: key } } } }),
    )
    assert.equal(m.type, 'document')
    assert.equal(m.text, 'Bitte lesen')
  })

  it('Sticker wird als Bild gespeichert (hkdf "sticker")', () => {
    const m = msgOf(raw({ stickerMessage: { mediaKey: key, mimetype: 'image/webp' } }))
    assert.equal(m.type, 'image')
    assert.equal(m.media?.descriptor.hkdfType, 'sticker')
  })

  it('Einmal-Ansehen: kein Medium, nur Hinweis', () => {
    const a = msgOf(raw({ viewOnceMessageV2: { message: { imageMessage: { mediaKey: key, caption: 'geheim' } } } }))
    assert.equal(a.type, 'system')
    assert.equal(a.text, PLACEHOLDER.viewOnce)
    assert.equal(a.media, undefined)
    const b = msgOf(raw({ imageMessage: { mediaKey: key, viewOnce: true } }))
    assert.equal(b.type, 'system')
    assert.equal(b.media, undefined)
  })

  it('fehlender Medienschluessel ergibt leeren Schluessel im Deskriptor (die Warteschlange meldet no_key)', () => {
    const m = msgOf(raw({ imageMessage: { mimetype: 'image/jpeg' } }))
    assert.equal(m.media?.descriptor.mediaKey, '')
  })
})

describe('normalizeMessage: ignorierte Nachrichten', () => {
  const cases: [string, RawMessage, string][] = [
    ['ohne ID', { key: { remoteJid: PN }, messageTimestamp: TS, message: { conversation: 'x' } }, 'no_id'],
    ['ohne Chat', { key: { id: 'a' }, messageTimestamp: TS, message: { conversation: 'x' } }, 'no_chat'],
    ['Status-Update', raw({ conversation: 'x' }, { key: { id: 'a', remoteJid: 'status@broadcast' } }), 'chat_type'],
    ['Kanal', raw({ conversation: 'x' }, { key: { id: 'a', remoteJid: '1@newsletter' } }), 'chat_type'],
    ['ohne Zeitstempel', raw({ conversation: 'x' }, { messageTimestamp: undefined }), 'no_timestamp'],
    ['ohne Inhalt', raw(undefined), 'no_content'],
    ['Stub ohne Inhalt', raw(undefined, { messageStubType: 28 }), 'stub'],
    ['Protokollnachricht', raw({ protocolMessage: { type: 0 } }), 'non_message'],
    ['Reaktion', raw({ reactionMessage: { text: '👍' } }), 'non_message'],
    ['Umfrage-Stimme', raw({ pollUpdateMessage: {} }), 'non_message'],
    ['verpackte Bearbeitung', raw({ ephemeralMessage: { message: { protocolMessage: { type: 14 } } } }), 'non_message'],
  ]
  for (const [name, r, reason] of cases) {
    it(name, () => {
      const res = normalizeMessage(r, noEnv)
      assert.deepEqual(res, { kind: 'ignored', reason })
    })
  }
})

describe('normalizeMessage: Absender, Chats, LID', () => {
  it('eigene Nachricht: direction out, Absender "Ich"', () => {
    const m = msgOf(raw({ conversation: 'x' }, { key: { id: 'a', remoteJid: PN, fromMe: true } }))
    assert.equal(m.direction, 'out')
    assert.equal(m.sender, 'Ich')
  })

  it('Absenderbezeichnung: Name > Push-Name > Telefonnummer > Unbekannt', () => {
    const named: NormEnv = { pnForLid: () => undefined, nameOf: (j) => (j === PN ? 'Anna' : undefined) }
    assert.equal(msgOf(raw({ conversation: 'x' }, { pushName: 'AnnaPush' }), named).sender, 'Anna')
    assert.equal(msgOf(raw({ conversation: 'x' }, { pushName: 'AnnaPush' })).sender, 'AnnaPush')
    assert.equal(msgOf(raw({ conversation: 'x' })).sender, '+491701234567')
    const lid = raw({ conversation: 'x' }, { key: { id: 'a', remoteJid: '999@lid' } })
    assert.equal(msgOf(lid).sender, 'Unbekannt')
  })

  it('Einzelchat: Chatname aus Name, sonst Push-Name, sonst Nummer', () => {
    assert.equal(msgOf(raw({ conversation: 'x' }, { pushName: 'Pushy' })).chatName, 'Pushy')
    assert.equal(msgOf(raw({ conversation: 'x' })).chatName, '+491701234567')
  })

  it('Gruppe: Chatname nur aus bekanntem Gruppennamen, Absender ist der Teilnehmer', () => {
    const part = '491709999999:7@s.whatsapp.net'
    const r = raw({ conversation: 'x' }, { key: { id: 'g1', remoteJid: GROUP, participant: part }, pushName: 'Bernd' })
    const m = msgOf(r)
    assert.equal(m.isGroup, true)
    assert.equal(m.chatName, '')
    assert.equal(m.senderJid, '491709999999@s.whatsapp.net')
    assert.equal(m.sender, 'Bernd')
    const env: NormEnv = { pnForLid: () => undefined, nameOf: (j) => (j === GROUP ? 'Familie' : undefined) }
    assert.equal(msgOf(r, env).chatName, 'Familie')
  })

  it('Gruppe: Push-Name einer eigenen Nachricht wird nicht als Chatname missbraucht', () => {
    const r = raw({ conversation: 'x' }, { key: { id: 'g1', remoteJid: GROUP, fromMe: true }, pushName: 'Ich selbst' })
    assert.equal(msgOf(r).chatName, '')
  })

  it('LID-Chat wird ueber remoteJidAlt auf die Telefonnummer abgebildet', () => {
    const r = raw({ conversation: 'x' }, { key: { id: 'l1', remoteJid: '55@lid', remoteJidAlt: '491701234567:3@s.whatsapp.net' } })
    assert.equal(msgOf(r).chatId, PN)
  })

  it('LID-Chat wird ueber die gelernte Zuordnung aufgeloest', () => {
    const env: NormEnv = { pnForLid: (l) => (l === '55@lid' ? PN : undefined), nameOf: () => undefined }
    const r = raw({ conversation: 'x' }, { key: { id: 'l1', remoteJid: '55@lid' } })
    assert.equal(msgOf(r, env).chatId, PN)
    assert.equal(msgOf(r).chatId, '55@lid') // ohne Zuordnung bleibt die LID
  })

  it('LID-Teilnehmer in Gruppen wird aufgeloest', () => {
    const r = raw(
      { conversation: 'x' },
      { key: { id: 'g1', remoteJid: GROUP, participant: '77@lid', participantAlt: PN } },
    )
    assert.equal(msgOf(r).senderJid, PN)
  })
})
