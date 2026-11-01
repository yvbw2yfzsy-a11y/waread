import { createCipheriv, randomBytes } from 'node:crypto'
import { deriveEditKey } from '../../src/secretEdit.js'

/** Gegenstueck zur Entschluesselung, nur fuer Tests: so verschluesselt der Absender die Bearbeitung. */
export function encryptEdit(
  secret: Uint8Array,
  id: string,
  origSender: string,
  editor: string,
  plaintext: Uint8Array,
): { iv: Buffer; payload: Buffer } {
  const key = deriveEditKey(secret, id, origSender, editor)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const payload = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return { iv, payload }
}
