/**
 * Bearbeitungen im neuen WhatsApp-Format.
 *
 * Neuere WhatsApp-Apps schicken eine Bearbeitung nicht mehr im Klartext als `protocolMessage.editedMessage`, sondern als
 * `secretEncryptedMessage` vom Typ MESSAGE_EDIT: Der neue Inhalt ist mit einem Schluessel verschluesselt, der aus dem
 * `messageContextInfo.messageSecret` der URSPRUENGLICHEN Nachricht abgeleitet wird. Die Bibliothek (Baileys 7.0.0-rc14)
 * kennt dieses Format nicht und meldet es nur als Nachricht. Ohne diese Datei entstand bei jeder Bearbeitung eine neue
 * Zeile "Nicht unterstuetzter Nachrichtentyp", und die Originalnachricht blieb unveraendert.
 *
 * Verfahren (so beschreiben es whatsmeow, msgsecret.go, und die Rust-Bibliothek wacore, message_edit.rs):
 *   key       = HKDF-SHA256(Eingabe = messageSecret, Salz = leer, Info = Original-ID + Original-Absender + Bearbeiter
 *               + "Message Edit", Laenge 32 Byte)
 *   Klartext  = AES-256-GCM-Entschluesselung (IV 12 Byte, Nutzlast mit angehaengtem 16-Byte-Tag, ohne zusaetzliche Daten)
 * Die JIDs gehen ohne Geraetesuffix (":12") und in der Schreibweise ein, in der sie eintrafen. WhatsApp wechselt derzeit
 * zwischen LID- und Nummernschreibweise; deshalb werden alle bekannten Schreibweisen probiert. Die GCM-Pruefung stellt
 * sicher, dass nur der richtige Treffer zaehlt (eine falsche Kombination liefert nie Klartext).
 *
 * Rein lokal: kein Netzwerk, keine Anfrage an WhatsApp.
 */
import { createDecipheriv, hkdfSync } from 'node:crypto'

/** proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT */
export const SECRET_ENC_TYPE_MESSAGE_EDIT = 2
/** Laenge von messageContextInfo.messageSecret in Byte. */
export const MESSAGE_SECRET_LENGTH = 32

const USE_CASE = 'Message Edit'
const IV_LENGTH = 12
const TAG_LENGTH = 16
/** Obergrenze je Liste, damit eine Nachricht keine unbegrenzte Zahl von Versuchen ausloest. */
const MAX_CANDIDATES = 6

/** Schluessel einer Bearbeitung. Alle JIDs ohne Geraetesuffix. */
export function deriveEditKey(secret: Uint8Array, origMsgId: string, origSender: string, editor: string): Buffer {
  const info = Buffer.concat([
    Buffer.from(origMsgId, 'utf8'),
    Buffer.from(origSender, 'utf8'),
    Buffer.from(editor, 'utf8'),
    Buffer.from(USE_CASE, 'utf8'),
  ])
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32))
}

/** AES-256-GCM-Entschluesselung; null bei falschem Schluessel, falscher Laenge oder beschaedigter Nutzlast. */
export function openEditPayload(key: Uint8Array, iv: Uint8Array, payload: Uint8Array): Buffer | null {
  if (key.length !== 32 || iv.length !== IV_LENGTH || payload.length < TAG_LENGTH) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(payload.subarray(payload.length - TAG_LENGTH)))
    return Buffer.concat([decipher.update(payload.subarray(0, payload.length - TAG_LENGTH)), decipher.final()])
  } catch {
    return null
  }
}

export interface EditDecryptInput {
  /** messageContextInfo.messageSecret der Originalnachricht (32 Byte). */
  secret: Uint8Array
  /** ID der Originalnachricht (targetMessageKey.id). */
  targetId: string
  /** Bekannte Schreibweisen des Original-Absenders (ohne Geraetesuffix). */
  origSenders: readonly string[]
  /** Bekannte Schreibweisen des Bearbeiters (ohne Geraetesuffix). */
  editors: readonly string[]
  iv: Uint8Array
  /** Verschluesselte Nutzlast samt Tag. */
  payload: Uint8Array
}

export interface EditDecryptResult {
  plaintext: Buffer
  /** Welche Schreibweisen gepasst haben (nur zur Diagnose, nie im Journal). */
  origSender: string
  editor: string
}

/** Probiert alle Kombinationen aus Original-Absender und Bearbeiter; null, wenn keine passt. */
export function decryptSecretEdit(i: EditDecryptInput): EditDecryptResult | null {
  if (i.secret.length !== MESSAGE_SECRET_LENGTH || i.targetId === '') return null
  if (i.iv.length !== IV_LENGTH || i.payload.length < TAG_LENGTH) return null
  const origs = [...new Set(i.origSenders)].filter((s) => s !== '').slice(0, MAX_CANDIDATES)
  const editors = [...new Set(i.editors)].filter((s) => s !== '').slice(0, MAX_CANDIDATES)
  // Gleiche Schreibweise zuerst (der Bearbeiter ist in aller Regel der Absender der Originalnachricht).
  const pairs: [string, string][] = []
  for (const o of origs) for (const e of editors) if (o === e) pairs.push([o, e])
  for (const o of origs) for (const e of editors) if (o !== e) pairs.push([o, e])
  for (const [origSender, editor] of pairs) {
    const key = deriveEditKey(i.secret, i.targetId, origSender, editor)
    const plaintext = openEditPayload(key, i.iv, i.payload)
    if (plaintext) return { plaintext, origSender, editor }
  }
  return null
}
