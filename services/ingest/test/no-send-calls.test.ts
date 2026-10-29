import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ALLOWED_NAMES, checkShell, FORBIDDEN_NAMES, listSourceFiles, scanSource, scanTree, words } from './support/scanForbidden.js'

/**
 * KRITISCHER SICHERHEITSTEST.
 *
 * Der Dienst darf gegenueber WhatsApp nichts senden: keine Lesebestaetigung, keinen Online-/Presence-
 * Status, keine Nachricht. Dieser Test scannt den gesamten Quellcode (src/) per AST und schlaegt fehl,
 * sobald ein Bezeichner oder bezeichnerartiger String eines der Woerter "read", "presence" oder "send"
 * enthaelt oder einem verbotenen Namen entspricht. Er laeuft in `npm test` und vor `npm run build` (prebuild).
 *
 * Grenzen (ehrlich): Der Test ist eine statische Namenspruefung plus Strukturpruefung der Huelle. Er kann
 * NICHT beweisen, was die Bibliothek (Baileys) intern selbst sendet - siehe README, Abschnitt
 * "Interner Verkehr der Bibliothek".
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '..', 'src')

describe('no-send-calls: Quellcode', () => {
  it('src/ existiert und enthaelt Dateien (kein leerer Scan, der trivial besteht)', () => {
    const files = listSourceFiles(srcDir)
    assert.ok(files.length >= 10, `zu wenige Dateien gefunden: ${files.length}`)
    assert.ok(files.some((f) => f.endsWith('waLib.ts')))
    assert.ok(files.some((f) => f.endsWith(path.join('media', 'audio.ts'))))
  })

  it('kein verbotener Name im gesamten Quellcode', () => {
    const findings = scanTree(srcDir)
    const text = findings.map((f) => `${path.relative(srcDir, f.file)}:${f.line} ${f.reason}`).join('\n')
    assert.deepEqual(findings, [], `Verbotene Aufrufe/Namen gefunden:\n${text}`)
  })

  it('die Huelle nutzt vom rohen Socket nur ev.on, ev.off und end', () => {
    const src = fs.readFileSync(path.join(srcDir, 'waLib.ts'), 'utf8')
    assert.deepEqual(checkShell(src), [])
  })

  it('Architektur: nur waLib.ts importiert die WhatsApp-Bibliothek', () => {
    const offenders: string[] = []
    for (const f of listSourceFiles(srcDir)) {
      const text = fs.readFileSync(f, 'utf8')
      const mentions = /baileys/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))
      if (mentions && path.basename(f) !== 'waLib.ts') offenders.push(path.relative(srcDir, f))
    }
    assert.deepEqual(offenders, [], 'Baileys darf nur in waLib.ts vorkommen')
  })

  it('Architektur: ausser waLib.ts gibt es kein dynamisches import()/require() ausser better-sqlite3', () => {
    const offenders: string[] = []
    for (const f of listSourceFiles(srcDir)) {
      if (path.basename(f) === 'waLib.ts') continue
      const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*([^)]*)\)/g)) {
        const arg = (m[1] ?? '').trim()
        if (arg !== `'better-sqlite3'`) offenders.push(`${path.relative(srcDir, f)}: ${arg}`)
      }
    }
    assert.deepEqual(offenders, [])
  })
})

describe('no-send-calls: der Waechter selbst (Negativtests)', () => {
  const bad = [
    `sock.readMessages([key])`,
    `await sock.sendPresenceUpdate('available')`,
    `sock.sendMessage(jid, { text: 'x' })`,
    `sock['sendMessage'](jid, {})`,
    `const { sendReceipt } = sock`,
    `sock.chatModify({ markRead: true }, jid)`,
    `sock.logout()`,
    `sock.query(node)`,
    `sock.groupMetadata(jid)`,
    `sock.relayMessage(jid, m, {})`,
    `function send_presence_update() {}`,
    `const readReceiptsEnabled = false`,
    `class Foo { sendText() {} }`,
    `sock.updateMediaMessage(m)`,
  ]
  for (const code of bad) {
    it(`erkennt: ${code}`, () => {
      assert.ok(scanSource('x.ts', code).length > 0, `nicht erkannt: ${code}`)
    })
  }

  const good = [
    `const x = readFileSync(p)`,
    `sock.ev.on('messages.upsert', h)`,
    `const spread = 1`, // "spread" enthaelt "read" nur als Teilstring, nicht als Wort
    `const already = 1`,
    `// sock.readMessages(key) im Kommentar`,
    `/* sendPresenceUpdate */ const a = 1`,
    `const thread = 1; const bread = 2`,
    `const msg = 'hello world'`,
    `const lead = 1`,
  ]
  for (const code of good) {
    it(`laesst durch: ${code}`, () => {
      assert.deepEqual(scanSource('x.ts', code), [], `faelschlich erkannt: ${code}`)
    })
  }

  it('Wortzerlegung', () => {
    assert.deepEqual(words('sendPresenceUpdate'), ['send', 'presence', 'update'])
    assert.deepEqual(words('media_ready'), ['media', 'ready'])
    assert.deepEqual(words('XMLHttpRequest'), ['xml', 'http', 'request'])
    assert.deepEqual(words('readMessages'), ['read', 'messages'])
  })

  it('Erlaubnisliste ist minimal und enthaelt nur lokale Dateisystem-Namen', () => {
    assert.deepEqual([...ALLOWED_NAMES].sort(), ['readFileSync'])
  })

  it('Verbotsliste enthaelt die kritischen Namen', () => {
    for (const n of ['logout', 'chatModify', 'relayMessage', 'query', 'groupMetadata']) {
      assert.ok(FORBIDDEN_NAMES.has(n), n)
    }
  })

  it('die Strukturpruefung der Huelle schlaegt bei Missbrauch an', () => {
    const tampered = `
      interface WaSocket { readonly ev: any; end(): void; extra(): void }
      const raw = make()
      const shell = { ev: { on: (e, h) => raw.ev.on(e, h) }, end: () => raw.end(), x: () => raw.foo() }
    `
    const problems = checkShell(tampered)
    assert.ok(problems.some((p) => p.includes('WaSocket')))
    assert.ok(problems.some((p) => p.includes('raw.foo')))

    const leaked = `const raw = make(); return raw`
    assert.ok(checkShell(leaked).length > 0)
  })
})
