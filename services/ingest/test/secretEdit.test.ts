import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decryptSecretEdit, deriveEditKey, openEditPayload } from '../src/secretEdit.js'
import { encryptEdit } from './support/secretEditSupport.js'

const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const ID = '3EB0A1B2C3D4E5F6A7B8'
const PN = '491700000001@s.whatsapp.net'
const LID = '123456789012345@lid'
const OTHER = '491700000002@s.whatsapp.net'

describe('deriveEditKey', () => {
  // Erwartete Schluessel unabhaengig mit Python (hmac/hashlib, RFC 5869 von Hand, Salz = 32 Nullbytes) berechnet.
  it('Schluessel stimmt mit einer unabhaengigen HKDF-Rechnung ueberein (Nummer)', () => {
    assert.equal(deriveEditKey(SECRET, ID, PN, PN).toString('hex'), '7a8e3589937182c37db39923d326f90bfaffeb17473c5eba4cfbcf0dcc2d9b6b')
  })
  it('Schluessel stimmt mit einer unabhaengigen HKDF-Rechnung ueberein (LID)', () => {
    assert.equal(deriveEditKey(SECRET, ID, LID, LID).toString('hex'), '4478e81fdd0abf9f8e5e5e185308449551e4d1e00222a0eb42b42f73458c375e')
  })
  it('jede Eingabe veraendert den Schluessel (ID, Original-Absender, Bearbeiter, Geheimnis)', () => {
    const base = deriveEditKey(SECRET, ID, PN, PN).toString('hex')
    assert.notEqual(deriveEditKey(SECRET, ID + 'x', PN, PN).toString('hex'), base)
    assert.notEqual(deriveEditKey(SECRET, ID, OTHER, PN).toString('hex'), base)
    assert.notEqual(deriveEditKey(SECRET, ID, PN, OTHER).toString('hex'), base)
    assert.notEqual(deriveEditKey(Buffer.alloc(32, 9), ID, PN, PN).toString('hex'), base)
  })
})

describe('openEditPayload', () => {
  it('liefert den Klartext und lehnt falschen Schluessel, falsche IV-Laenge und kurze Nutzlast ab', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, Buffer.from('neuer Inhalt'))
    const key = deriveEditKey(SECRET, ID, PN, PN)
    assert.equal(openEditPayload(key, iv, payload)?.toString(), 'neuer Inhalt')
    assert.equal(openEditPayload(deriveEditKey(SECRET, ID, OTHER, OTHER), iv, payload), null)
    assert.equal(openEditPayload(key, iv.subarray(0, 11), payload), null)
    assert.equal(openEditPayload(key, Buffer.concat([iv, Buffer.from([0])]), payload), null)
    assert.equal(openEditPayload(key, iv, payload.subarray(0, 15)), null)
    assert.equal(openEditPayload(key.subarray(0, 16), iv, payload), null)
  })
  it('jede Veraenderung der Nutzlast (auch am Tag) wird erkannt', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, Buffer.from('abc'))
    const key = deriveEditKey(SECRET, ID, PN, PN)
    for (let i = 0; i < payload.length; i++) {
      const bad = Buffer.from(payload)
      bad[i] = (bad[i] ?? 0) ^ 1
      assert.equal(openEditPayload(key, iv, bad), null, `Byte ${i}`)
    }
  })
  it('leerer Klartext ist gueltig (nur der Tag)', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, Buffer.alloc(0))
    assert.equal(openEditPayload(deriveEditKey(SECRET, ID, PN, PN), iv, payload)?.length, 0)
  })
})

describe('decryptSecretEdit', () => {
  const plain = Buffer.from([1, 2, 3, 4, 5])

  it('findet die passende Schreibweise: Absender trug die Nummer, die Bearbeitung kommt mit LID', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, plain)
    const r = decryptSecretEdit({ secret: SECRET, targetId: ID, origSenders: [LID, PN], editors: [LID, PN], iv, payload })
    assert.ok(r)
    assert.deepEqual([...r.plaintext], [...plain])
    assert.equal(r.origSender, PN)
    assert.equal(r.editor, PN)
  })

  it('gemischte Schreibweise (Original unter LID, Bearbeiter unter Nummer) wird gefunden', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, LID, PN, plain)
    const r = decryptSecretEdit({ secret: SECRET, targetId: ID, origSenders: [PN, LID], editors: [PN, LID], iv, payload })
    assert.equal(r?.origSender, LID)
    assert.equal(r?.editor, PN)
  })

  it('ein anderer Bearbeiter als der Original-Absender wird nur mit seiner JID gelesen (Schutz vor Faelschung)', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, OTHER, plain)
    assert.equal(decryptSecretEdit({ secret: SECRET, targetId: ID, origSenders: [PN], editors: [PN], iv, payload }), null)
    assert.ok(decryptSecretEdit({ secret: SECRET, targetId: ID, origSenders: [PN], editors: [OTHER], iv, payload }))
  })

  it('falsches Geheimnis, falsche ID, beschaedigte Nutzlast: null', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, plain)
    const base = { targetId: ID, origSenders: [PN], editors: [PN], iv, payload }
    assert.ok(decryptSecretEdit({ ...base, secret: SECRET }))
    assert.equal(decryptSecretEdit({ ...base, secret: Buffer.alloc(32, 3) }), null)
    assert.equal(decryptSecretEdit({ ...base, secret: SECRET, targetId: 'andere-id' }), null)
    assert.equal(decryptSecretEdit({ ...base, secret: SECRET, payload: Buffer.alloc(20, 1) }), null)
  })

  it('ungueltige Eingaben liefern null statt zu werfen', () => {
    const { iv, payload } = encryptEdit(SECRET, ID, PN, PN, plain)
    const ok = { secret: SECRET, targetId: ID, origSenders: [PN], editors: [PN], iv, payload }
    assert.equal(decryptSecretEdit({ ...ok, secret: Buffer.alloc(31) }), null)
    assert.equal(decryptSecretEdit({ ...ok, secret: Buffer.alloc(0) }), null)
    assert.equal(decryptSecretEdit({ ...ok, targetId: '' }), null)
    assert.equal(decryptSecretEdit({ ...ok, iv: Buffer.alloc(16) }), null)
    assert.equal(decryptSecretEdit({ ...ok, payload: Buffer.alloc(3) }), null)
    assert.equal(decryptSecretEdit({ ...ok, origSenders: [] }), null)
    assert.equal(decryptSecretEdit({ ...ok, editors: ['', ''] }), null)
  })

  it('begrenzt die Zahl der Versuche je Liste auf 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => `x${i}@lid`)
    const inside = encryptEdit(SECRET, ID, 'x5@lid', 'x5@lid', plain)
    const outside = encryptEdit(SECRET, ID, 'x7@lid', 'x7@lid', plain)
    const run = (e: { iv: Buffer; payload: Buffer }) =>
      decryptSecretEdit({ secret: SECRET, targetId: ID, origSenders: many, editors: many, iv: e.iv, payload: e.payload })
    assert.ok(run(inside), 'Stelle 6 von 10 wird noch probiert')
    assert.equal(run(outside), null, 'Stelle 8 von 10 nicht mehr')
  })
})
