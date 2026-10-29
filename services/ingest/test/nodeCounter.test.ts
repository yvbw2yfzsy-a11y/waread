// F07: Zaehler fuer ausgehende Protokollknoten (nur fuer die Testinstanz mit Zweitnummer).
// Er darf pro Knoten nur "Art" (Tag, type, xmlns) behalten, niemals Inhalt, Kennungen oder Nummern.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { logNodeCounts, NodeCounter } from '../src/nodeCounter.js'
import { memoryLogger } from './support/helpers.js'

// So sieht binaryNodeToString der Bibliothek aus (Baileys 7.0.0-rc14, WABinary/generic-utils.ts): Tag, Attribute in
// einfachen Anfuehrungszeichen, Kinder eingerueckt.
const PRES = `<presence type='unavailable'/>`
const PRES_NAME = `<presence name='Max Mustermann-4711'/>`
const RCPT = `<receipt id='3EB0A1B2C3D4E5F6' to='491701234567@s.whatsapp.net' type='inactive'/>`
const RCPT_PLAIN = `<receipt id='3EB0FFFF' to='491701234567@s.whatsapp.net'/>`
const USYNC = `<iq id='7' to='s.whatsapp.net' type='get' xmlns='usync'>\n\t<usync sid='1' mode='query'>\n\t\t<user>\n\t\t\t<contact>+491701234567</contact>\n\t\t</user>\n\t</usync>\n</iq>`
const MSG = `<message id='3EB01' to='491701234567@s.whatsapp.net' type='text'>\n\t<enc v='2' type='msg'>deadbeefcafe</enc>\n</message>`

describe('F07: NodeCounter', () => {
  it('zaehlt nach Art: Tag, type und xmlns', () => {
    const c = new NodeCounter()
    ;[PRES, PRES, PRES_NAME, RCPT, RCPT_PLAIN, USYNC, MSG].forEach((x) => c.record(x))
    assert.deepEqual(c.snapshot(), {
      'presence:unavailable': 2,
      presence: 1,
      'receipt:inactive': 1,
      receipt: 1,
      'iq:get:usync': 1,
      'message:text': 1,
    })
    assert.equal(c.total, 7)
  })

  it('behaelt keinerlei Inhalt: keine Nummer, Kennung, Name, Text, Hex-Daten im Ergebnis', () => {
    const c = new NodeCounter()
    ;[PRES_NAME, RCPT, USYNC, MSG].forEach((x) => c.record(x))
    const out = JSON.stringify(c.snapshot())
    for (const secret of ['4917', '3EB0', 'Mustermann', '4711', 'deadbeef', 'contact', 'sid', 'whatsapp.net']) {
      assert.ok(!out.includes(secret), `Ergebnis enthaelt "${secret}": ${out}`)
    }
  })

  it('unsichere Attributwerte landen nicht im Schluessel', () => {
    const c = new NodeCounter()
    c.record(`<receipt id='1' type='GEHEIM 4711 +49170'/>`)
    c.record(`<iq id='1' type='get' xmlns='a b "x"'/>`)
    c.record(`<x-und-ein-sehr-langer-tag-name-ueber-der-grenze-von-32-zeichen type='t'/>`)
    const out = JSON.stringify(c.snapshot())
    assert.ok(!out.includes('GEHEIM') && !out.includes('4711') && !out.includes('+49170') && !out.includes('"x"'), out)
    assert.equal(c.total, 3)
  })

  it('Unerwartetes (kein Text, kein Knoten) wird als unparsed gezaehlt und wirft nicht', () => {
    const c = new NodeCounter()
    c.record(undefined)
    c.record(42)
    c.record('kein Knoten 4711')
    assert.deepEqual(c.snapshot(), { unparsed: 3 })
  })

  it('beschraenkt die Zahl der Schluessel (Speicher bleibt klein), der Rest zaehlt unter "other"', () => {
    const c = new NodeCounter()
    for (let i = 0; i < 200; i++) c.record(`<t${i} type='a'/>`)
    const snap = c.snapshot()
    assert.ok(Object.keys(snap).length <= 65, String(Object.keys(snap).length))
    assert.equal(c.total, 200)
    assert.equal(Object.values(snap).reduce((a, b) => a + b, 0), 200)
    assert.ok((snap['other'] ?? 0) > 0)
  })
})

describe('F07: Ausgabe des Zaehlers', () => {
  it('schreibt je Knotenart eine Zeile mit nur "kind" und "n", ohne Inhalte', () => {
    const { log, lines } = memoryLogger()
    const c = new NodeCounter()
    ;[PRES, PRES, RCPT, USYNC, MSG].forEach((x) => c.record(x))
    logNodeCounts(c, log)
    const rows = lines.map((l) => JSON.parse(l))
    assert.deepEqual(
      rows.map((r) => [r.ev, r.kind, r.n]),
      [
        ['lib_node_out', 'iq:get:usync', 1],
        ['lib_node_out', 'message:text', 1],
        ['lib_node_out', 'presence:unavailable', 2],
        ['lib_node_out', 'receipt:inactive', 1],
      ],
    )
    const all = lines.join('\n')
    for (const secret of ['4917', '3EB0', 'deadbeef', 'contact', 'whatsapp.net']) assert.ok(!all.includes(secret), secret)
  })
})
