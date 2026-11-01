import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { proto } from 'baileys'
import { MessageHandler, type MediaSink } from '../src/messageHandler.js'
import { all, makeEnv, one, type TestEnv } from './support/helpers.js'

/**
 * Prueft die ECHTE Bibliothek (Ereignispuffer und processMessage aus node_modules/baileys) zusammen mit dem Handler:
 * Welche Ereignisse entstehen bei einer Bearbeitung, und wendet waread sie an?
 *   - Klartext-Bearbeitung (protocolMessage MESSAGE_EDIT, auch in der editedMessage-Huelle): die Bibliothek meldet
 *     messages.update, der Handler wendet sie an. Das ist der Weg, den es schon in 0.2.0 gab.
 *   - Verschluesselte Bearbeitung (secretEncryptedMessage): die Bibliothek meldet NUR eine Nachricht; der Handler muss sie
 *     selbst lesen (secretEdit.ts). Faengt die Bibliothek das spaeter selbst ab, schlaegt der letzte Test an: dann pruefen,
 *     ob die Bearbeitung doppelt ankommt (harmlos, sie ist idempotent) und den Test anpassen.
 */
const libDir = path.dirname(fileURLToPath(import.meta.resolve('baileys')))
const NOW = 1_800_000_000
const PN = '491701234567@s.whatsapp.net'
const noMedia: MediaSink = { enqueue: () => 'disabled' }

async function libFns(): Promise<{ makeEventBuffer: (l: any) => any; processMessage: (m: any, o: any) => Promise<void> }> {
  const buffer = await import(pathToFileURL(path.join(libDir, 'Utils', 'event-buffer.js')).href)
  const proc = await import(pathToFileURL(path.join(libDir, 'Utils', 'process-message.js')).href)
  return { makeEventBuffer: buffer.makeEventBuffer, processMessage: proc.default ?? proc.processMessage }
}

const silent: any = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silent }, level: 'silent' }

describe('Bibliothek + Handler: Bearbeitungen', () => {
  let env: TestEnv
  let handler: MessageHandler

  beforeEach(() => {
    env = makeEnv((c) => {
      c.retention = { messagesDays: 3, mediaDays: 3 }
    })
    handler = new MessageHandler({ db: env.db, jobs: env.jobs, media: noMedia, cfg: env.cfg, log: env.log, now: () => NOW })
    handler.handleUpsert({ type: 'notify', messages: [{ key: { id: 'ORIG1', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 100, message: { conversation: 'vorher' } }] })
  })
  afterEach(() => env.close())

  /** Laesst eine eingehende Nachricht durch die echte Bibliothek laufen und gibt deren Ereignisse an den Handler weiter. */
  async function deliver(message: Record<string, unknown>): Promise<{ upserts: string[]; updates: number }> {
    const { makeEventBuffer, processMessage } = await libFns()
    const ev = makeEventBuffer(silent)
    const seen = { upserts: [] as string[], updates: 0 }
    ev.on('messages.upsert', (u: any) => {
      for (const m of u.messages) seen.upserts.push(Object.keys(m.message ?? {}).join('+'))
      handler.handleUpsert(u)
    })
    ev.on('messages.update', (u: any) => {
      seen.updates += u.length
      handler.handleUpdates(u)
    })
    const info = proto.WebMessageInfo.fromObject({ key: { id: 'EDIT1', remoteJid: PN, fromMe: false }, messageTimestamp: NOW - 20, message })
    const run = ev.createBufferedFunction(async () => {
      ev.emit('messages.upsert', { messages: [info], type: 'notify' })
      await processMessage(info, {
        shouldProcessHistoryMsg: false,
        placeholderResendCache: undefined,
        ev,
        creds: { me: { id: '4900000000:1@s.whatsapp.net', lid: '1:1@lid' } },
        signalRepository: {},
        keyStore: {},
        logger: silent,
        options: {},
        getMessage: async () => undefined,
      })
    })
    await run()
    await new Promise((r) => setTimeout(r, 400)) // der Puffer gibt seine Ereignisse nach 100 ms frei
    return seen
  }
  const text = (): string => one(env.db, 'SELECT text FROM messages WHERE id = ?', 'ORIG1').text
  const rows = (): number => one(env.db, 'SELECT COUNT(*) AS n FROM messages').n
  const edit = { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'ORIG1', remoteJid: PN, fromMe: true }, editedMessage: { conversation: 'nachher' }, timestampMs: (NOW - 20) * 1000 }

  it('Klartext-Bearbeitung (protocolMessage): messages.update, vom Handler angewendet, keine neue Zeile', async () => {
    const seen = await deliver({ protocolMessage: edit })
    assert.equal(seen.updates, 1)
    assert.deepEqual(seen.upserts, ['protocolMessage'])
    assert.equal(text(), 'nachher')
    assert.equal(rows(), 1)
    assert.deepEqual(all(env.db, 'SELECT version, text FROM message_versions'), [{ version: 1, text: 'vorher' }])
  })

  it('Klartext-Bearbeitung in der editedMessage-Huelle (so baut sie whatsmeow)', async () => {
    const seen = await deliver({ editedMessage: { message: { protocolMessage: edit } } })
    assert.equal(seen.updates, 1)
    assert.deepEqual(seen.upserts, ['editedMessage'])
    assert.equal(text(), 'nachher')
    assert.equal(rows(), 1)
  })

  it('verschluesselte Bearbeitung: die Bibliothek meldet kein messages.update (deshalb liest der Handler sie selbst)', async () => {
    const seen = await deliver({
      secretEncryptedMessage: { targetMessageKey: { id: 'ORIG1', remoteJid: PN, fromMe: true }, encPayload: Buffer.alloc(40, 1), encIv: Buffer.alloc(12, 2), secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT },
    })
    assert.equal(seen.updates, 0, 'Baileys 7.0.0-rc14 kennt das Format nicht (Quelle: process-message.js, nur protocolMessage)')
    assert.deepEqual(seen.upserts, ['secretEncryptedMessage'])
    assert.equal(text(), 'vorher', 'ohne Geheimnis und Lesefunktion bleibt es bei der alten Fassung')
    assert.equal(rows(), 1, 'und es entsteht keine Zeile "Nicht unterstuetzter Nachrichtentyp"')
  })
})
