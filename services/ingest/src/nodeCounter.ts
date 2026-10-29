import type { Logger } from './log.js'

/**
 * F07: Zaehler fuer die Knoten, die die Bibliothek selbst an WhatsApp schickt (Receipts, Prekey-Uploads,
 * Abfragen ...). Nur fuer eine Testinstanz mit Zweitnummer gedacht (`[ingest] count_outgoing_nodes`, ab Werk aus),
 * um den Verkehr zu MESSEN statt ihn zu raten.
 *
 * Datenschutz-Regel: Aus jedem Knoten bleibt nur seine ART (Tag, `type`, `xmlns`), jeweils auf ein enges Zeichenmuster
 * geprueft. Der Text des Knotens, Kennungen, Nummern, Namen und Inhalte werden nach dem Parsen verworfen und nie
 * gespeichert, geloggt oder weitergegeben. Es gibt keinen Weg, den Roh-Text wieder herauszuholen.
 */

/** Hoechstzahl verschiedener Schluessel; alles darueber zaehlt unter "other" (begrenzt den Speicher). */
const MAX_KEYS = 64

const TAG = /^<([A-Za-z][A-Za-z0-9_-]{0,31})(?=[\s/>])/
const ATTR = /\s([A-Za-z][A-Za-z0-9:_-]{0,31})='([^']{0,200})'/y
const SAFE_TYPE = /^[A-Za-z0-9_-]{1,32}$/
const SAFE_NS = /^[A-Za-z0-9:._-]{1,40}$/

/** Art des Knotens aus der Textdarstellung der Bibliothek, oder null. Betrachtet nur den ersten Knoten-Kopf. */
export function nodeKind(text: string): string | null {
  const head = text.slice(0, 400)
  const m = TAG.exec(head)
  if (!m) return null
  let kind = m[1]!
  let type: string | undefined
  let ns: string | undefined
  ATTR.lastIndex = m[0].length
  for (let a = ATTR.exec(head); a; a = ATTR.exec(head)) {
    if (a[1] === 'type') type = a[2]
    else if (a[1] === 'xmlns') ns = a[2]
  }
  if (type !== undefined && SAFE_TYPE.test(type)) kind += ':' + type
  if (ns !== undefined && SAFE_NS.test(ns)) kind += ':' + ns
  return kind
}

export class NodeCounter {
  readonly #counts = new Map<string, number>()
  #total = 0

  /** Zaehlt einen Knoten (Textdarstellung). Der Text selbst wird nicht behalten. Wirft nie. */
  record(text: unknown): void {
    this.#total++
    let key = typeof text === 'string' ? nodeKind(text) : null
    if (key === null) key = 'unparsed'
    else if (!this.#counts.has(key) && this.#counts.size >= MAX_KEYS) key = 'other'
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
  }

  get total(): number {
    return this.#total
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.#counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
}

/** Gibt je Knotenart eine inhaltsfreie Zeile aus (`kind`, `n`); `n` ist die Summe seit Prozessstart. */
export function logNodeCounts(counter: NodeCounter, log: Logger): void {
  for (const [kind, n] of Object.entries(counter.snapshot())) log.info('lib_node_out', { kind, n })
}
