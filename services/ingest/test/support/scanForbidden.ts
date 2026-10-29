import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * Statischer Waechter gegen Sende-/Lesebestaetigungs-/Presence-Aufrufe (AST-basiert).
 *
 * Geprueft werden ALLE Bezeichner (Variablen, Funktionen, Eigenschaften, Parameter) und
 * bezeichnerartige Zeichenkettenliterale (fangen z. B. sock['sendMessage'] ab) im Quellcode.
 * Kommentare zaehlen nicht. Ein Name ist verboten, wenn
 *   - eines seiner Woerter (camelCase/snake_case/Punkt-getrennt) "read", "presence" oder "send" ist, oder
 *   - er in FORBIDDEN_NAMES steht (ausgehende Aktionen ohne diese Woerter, z. B. logout, groupMetadata).
 * Ausnahmen gibt es nur ueber ALLOWED_NAMES (exakte Namen, begruendet).
 */

export const FORBIDDEN_WORDS = new Set(['read', 'presence', 'send'])

/** Ausgehende oder anfragende Bibliotheksfunktionen, die nicht "read/presence/send" im Namen tragen. */
export const FORBIDDEN_NAMES = new Set([
  'logout',
  'requestPairingCode',
  'groupMetadata',
  'groupFetchAllParticipating',
  'profilePictureUrl',
  'onWhatsApp',
  'fetchStatus',
  'fetchPrivacySettings',
  'fetchBlocklist',
  'query',
  'chatModify',
  'relayMessage',
  'updateMediaMessage',
  'reuploadRequest',
  'rejectCall',
  'uploadPreKeys',
  'rotateSignedPreKey',
  'resyncAppState',
  'fetchMessageHistory',
  'requestPlaceholderResend',
  'executeUSyncQuery',
  'appPatch',
  'newsletterFollow',
  'groupAcceptInvite',
  'updateProfileStatus',
  'updateProfilePicture',
])

/**
 * Exakte, bewusste Ausnahmen: Node-Dateisystem-API fuer lokale Dateien (kein WhatsApp-Bezug).
 * Jede Ergaenzung hier ist eine Sicherheitsentscheidung und gehoert ins Review.
 */
export const ALLOWED_NAMES = new Set(['readFileSync'])

export interface Finding {
  file: string
  line: number
  name: string
  reason: string
}

/** "sendPresenceUpdate" -> ["send","presence","update"]; "media_ready" -> ["media","ready"]; "a.b-c" -> ["a","b","c"] */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

function check(name: string): string | null {
  if (ALLOWED_NAMES.has(name)) return null
  if (FORBIDDEN_NAMES.has(name)) return `verbotener Name "${name}"`
  const hit = words(name).find((w) => FORBIDDEN_WORDS.has(w))
  return hit ? `Wort "${hit}" in "${name}"` : null
}

const IDENTIFIER_LIKE = /^[A-Za-z0-9_.:\-$]+$/

export function scanSource(fileName: string, source: string): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const out: Finding[] = []
  const add = (node: ts.Node, name: string, reason: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    out.push({ file: fileName, line: line + 1, name, reason })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const text = node.text.replace(/^#/, '')
      const why = check(text)
      if (why) add(node, text, why)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (IDENTIFIER_LIKE.test(node.text)) {
        const why = check(node.text)
        if (why) add(node, node.text, why)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

export function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

export function scanTree(dir: string): Finding[] {
  return listSourceFiles(dir).flatMap((f) => scanSource(f, fs.readFileSync(f, 'utf8')))
}

/**
 * Strukturpruefung der Huelle in waLib.ts:
 *  - `raw` (das rohe Socket-Objekt) darf nur als raw.ev.on, raw.ev.off und raw.end verwendet werden,
 *  - das Interface WaSocket hat genau die Mitglieder ev und end.
 */
export function checkShell(source: string): string[] {
  const sf = ts.createSourceFile('waLib.ts', source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  const allowed = new Set(['raw.ev.on', 'raw.ev.off', 'raw.end'])
  const used = new Set<string>()

  const chainText = (n: ts.Expression): string | null => {
    if (ts.isIdentifier(n)) return n.text
    if (ts.isPropertyAccessExpression(n)) {
      const left = chainText(n.expression)
      return left === null ? null : `${left}.${n.name.text}`
    }
    return null
  }

  const visit = (node: ts.Node): void => {
    // Jede Verwendung des Bezeichners `raw` ausser der Deklaration pruefen
    if (ts.isIdentifier(node) && node.text === 'raw') {
      const parent = node.parent
      const isDecl = ts.isVariableDeclaration(parent) && parent.name === node
      if (!isDecl) {
        // Ganze Kette nach oben einsammeln
        let top: ts.Node = node
        while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top) top = top.parent
        const text = ts.isPropertyAccessExpression(top) ? chainText(top) : 'raw'
        if (text === null || !allowed.has(text)) problems.push(`unzulaessige Verwendung von raw: ${text}`)
        else used.add(text)
        if (ts.isElementAccessExpression(top.parent)) problems.push('Element-Zugriff auf raw')
      }
    }
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'WaSocket') {
      const members = node.members.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : '?')).sort()
      if (members.join(',') !== 'end,ev') problems.push(`WaSocket hat Mitglieder: ${members.join(',')}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return problems
}
