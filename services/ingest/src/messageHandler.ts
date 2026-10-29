/**
 * Eingehende Nachrichten: Normalisierung (rein, ohne Seiteneffekte) und Schreiben in die Datenbank.
 *
 * Kein Logging von Inhalten: Es werden nur Ereignistyp, Zaehler, IDs und Fehlercodes geloggt.
 * Alle Zeitstempel sind Unix-Sekunden.
 */
import { SETTING_KEYS, type IngestConfig, type MediaKind } from './config.js'
import {
  applyMessageEdit,
  ensureMediaRow,
  getSetting,
  insertMessageIfNotExists,
  markMessageDeleted,
  pushEvent,
  setMediaStatus,
  upsertChat,
  type Database,
  type MessageType,
  type SkipReason,
} from './dbClient.js'
import { NAME_RANK, type JobStore, type MediaDescriptor, type NewMediaJob } from './jobStore.js'
import { errorFields, type Logger } from './log.js'
import { nowSec } from './sqlite.js'
import { realScheduler, type Scheduler } from './timing.js'

// ---------------------------------------------------------------------------------------------
// Rohtypen (strukturell; Auszug aus proto.IWebMessageInfo der Bibliothek)
// ---------------------------------------------------------------------------------------------

export interface RawKey {
  id?: string | null
  remoteJid?: string | null
  fromMe?: boolean | null
  participant?: string | null
  remoteJidAlt?: string | null
  participantAlt?: string | null
}

export interface RawMessage {
  key?: RawKey | null
  message?: any
  messageTimestamp?: unknown
  pushName?: string | null
  messageStubType?: number | null
}

// ---------------------------------------------------------------------------------------------
// JID-Hilfen (bewusst eigene, kleine Implementierung - keine Abhaengigkeit von der Bibliothek)
// ---------------------------------------------------------------------------------------------

export const SELF_LABEL = 'Ich'

/** Entfernt Geraetesuffix (":12") und alte c.us-Domain: "491234:12@s.whatsapp.net" -> "491234@s.whatsapp.net". */
export function normalizeJid(jid: string): string {
  const at = jid.indexOf('@')
  if (at < 0) return jid
  let user = jid.slice(0, at)
  let server = jid.slice(at + 1)
  const colon = user.indexOf(':')
  if (colon >= 0) user = user.slice(0, colon)
  if (server === 'c.us') server = 's.whatsapp.net'
  return `${user}@${server}`
}

export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')
export const isLidJid = (jid: string): boolean => jid.endsWith('@lid')
export const isPnJid = (jid: string): boolean => jid.endsWith('@s.whatsapp.net')

/** Chats, die nicht gespeichert werden: Status-Updates, Broadcast-Listen, Kanaele (Newsletter). */
export function isIgnoredChat(jid: string): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
}

/** "+491234" fuer Telefonnummern-JIDs, sonst undefined. */
export function phoneLabel(jid: string): string | undefined {
  if (!isPnJid(jid)) return undefined
  const user = jid.slice(0, jid.indexOf('@'))
  return /^\d{4,20}$/.test(user) ? `+${user}` : undefined
}

export function toSeconds(ts: unknown): number | null {
  let n: number
  if (typeof ts === 'number') n = ts
  else if (typeof ts === 'string' && /^\d+$/.test(ts)) n = Number(ts)
  else if (ts && typeof ts === 'object' && typeof (ts as { toNumber?: unknown }).toNumber === 'function') {
    n = (ts as { toNumber(): number }).toNumber()
  } else return null
  if (!Number.isFinite(n) || n <= 0) return null
  // Millisekunden-Werte (>= 1e12) defensiv auf Sekunden zurueckfuehren.
  return Math.floor(n >= 1e12 ? n / 1000 : n)
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber(): number }).toNumber()
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toBase64(v: unknown): string | null {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
  if (typeof v === 'string') return v
  return null
}

// ---------------------------------------------------------------------------------------------
// Normalisierung
// ---------------------------------------------------------------------------------------------

export interface NormEnv {
  pnForLid(lid: string): string | undefined
  nameOf(jid: string): string | undefined
  /** Einmal-Ansehen-Medien wie normale Medien speichern (Standard aus, siehe config store_view_once). */
  storeViewOnce?: boolean
}

/**
 * Nur Ja/Nein-Angaben zu einer Einmal-Ansehen-Nachricht, nie Inhalte oder Schluessel. Sie dienen dem Journal
 * (viewonce_probe), damit sich ohne Zweitnummer feststellen laesst, ob WhatsApp die Schluessel an dieses
 * verknuepfte Geraet liefert.
 */
export interface ViewOnceProbe {
  kind: 'image' | 'video' | 'voice' | 'other'
  hasKey: boolean
  hasDirectPath: boolean
  hasUrl: boolean
  hasSha: boolean
}

export interface NormalizedMedia {
  kind: MediaKind
  descriptor: MediaDescriptor
  declaredBytes: number | null
  durationSeconds: number | null
  mimeType: string | null
}

export interface NormalizedMessage {
  id: string
  chatId: string
  chatName: string
  isGroup: boolean
  sender: string
  senderJid: string
  waTimestamp: number
  direction: 'in' | 'out'
  type: MessageType
  text?: string
  replyTo?: string
  pushName?: string
  media?: NormalizedMedia
  /** Einmal-Ansehen-Nachricht (gespeichert oder nur als Hinweis). */
  viewOnce?: boolean
  viewOnceProbe?: ViewOnceProbe
  /** Kurzzitat der Nachricht, auf die geantwortet wurde. */
  replyText?: string
  replySender?: string
  replyType?: string
}

export type NormalizeResult =
  | { kind: 'message'; message: NormalizedMessage }
  | { kind: 'ignored'; reason: string }

/** Platzhaltertexte fuer Nachrichten ohne darstellbaren Inhalt (Anzeigesprache: Deutsch). */
export const PLACEHOLDER = {
  viewOnce: 'Einmal-Ansehen-Medium (nicht gespeichert)',
  viewOnceKind: {
    image: 'Einmal-Foto (nicht gespeichert)',
    video: 'Einmal-Video (nicht gespeichert)',
    voice: 'Einmal-Sprachnachricht (nicht gespeichert)',
  },
  unsupported: 'Nicht unterstützter Nachrichtentyp',
} as const

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
] as const

/** Entpackt Huellen (fluechtige Nachrichten, Einmal-Ansehen, Dokument mit Bildunterschrift). Max. 5 Ebenen. */
function unwrap(content: any): { content: any; viewOnce: boolean } {
  let viewOnce = false
  for (let i = 0; i < 5 && content; i++) {
    let next: any
    for (const w of WRAPPERS) {
      const inner = content[w]?.message
      if (inner) {
        next = inner
        if (w.startsWith('viewOnce')) viewOnce = true
        break
      }
    }
    if (!next) break
    content = next
  }
  return { content, viewOnce }
}

/** Reihenfolge, in der der "eigentliche" Inhaltstyp gesucht wird. */
const CONTENT_TYPES = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'locationMessage',
  'liveLocationMessage',
  'contactMessage',
  'contactsArrayMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
] as const

/** Typen, die nie als Nachricht erscheinen (Steuerung, Reaktionen, Bearbeitungen, Abstimmungen). */
const NON_MESSAGE_KEYS = [
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'editedMessage',
  'keepInChatMessage',
] as const

function resolveJid(jid: string | null | undefined, alt: string | null | undefined, env: NormEnv): string | null {
  if (!jid) return null
  let out = normalizeJid(jid)
  if (isLidJid(out)) {
    const altNorm = alt ? normalizeJid(alt) : undefined
    const pn = altNorm && isPnJid(altNorm) ? altNorm : env.pnForLid(out)
    if (pn) out = pn
  }
  return out
}

function describeContacts(content: any, kind: 'single' | 'array'): string {
  if (kind === 'single') return `👤 Kontakt: ${content.contactMessage?.displayName ?? ''}`.trim()
  const n = content.contactsArrayMessage?.contacts?.length ?? 0
  return `👤 Kontakte: ${content.contactsArrayMessage?.displayName ?? ''} (${n})`.trim()
}

function viewOnceKind(contentType: string): 'image' | 'video' | 'voice' | null {
  if (contentType === 'imageMessage') return 'image'
  if (contentType === 'videoMessage' || contentType === 'ptvMessage') return 'video'
  if (contentType === 'audioMessage') return 'voice'
  return null
}

/** Kurzfassung der zitierten Nachricht (contextInfo.quotedMessage). Steckt in der empfangenen Nachricht, kostet keinen Verkehr. */
function quotedFrom(ctx: any, env: NormEnv): { text?: string; sender?: string; type?: string } | undefined {
  const q = ctx?.quotedMessage
  if (!q || typeof q !== 'object') return undefined
  const { content } = unwrap(q)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  let text: string | undefined
  let type: string | undefined
  if (content?.conversation !== undefined) {
    type = 'text'
    text = str(content.conversation)
  } else if (content?.extendedTextMessage) {
    type = 'text'
    text = str(content.extendedTextMessage.text)
  } else if (content?.imageMessage) {
    type = 'image'
    text = str(content.imageMessage.caption)
  } else if (content?.videoMessage || content?.ptvMessage) {
    type = 'video'
    text = str((content.videoMessage ?? content.ptvMessage).caption)
  } else if (content?.audioMessage) {
    type = 'voice'
  } else if (content?.documentMessage) {
    type = 'document'
    text = str(content.documentMessage.caption) ?? str(content.documentMessage.fileName)
  } else if (content?.stickerMessage) {
    type = 'sticker'
  } else if (content?.locationMessage || content?.liveLocationMessage) {
    type = 'text'
    text = '📍 Standort'
  } else if (content?.contactMessage || content?.contactsArrayMessage) {
    type = 'text'
    text = '👤 Kontakt'
  } else if (content?.pollCreationMessage || content?.pollCreationMessageV2 || content?.pollCreationMessageV3) {
    type = 'text'
    const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3
    text = `📊 Umfrage: ${str(poll?.name) ?? ''}`.trim()
  }
  let sender: string | undefined
  const participant = str(ctx?.participant)
  if (participant) {
    const jid = resolveJid(participant, undefined, env)
    if (jid) sender = env.nameOf(jid) ?? phoneLabel(jid)
  }
  const out: { text?: string; sender?: string; type?: string } = {}
  if (text) out.text = text
  if (sender) out.sender = sender
  if (type) out.type = type
  return Object.keys(out).length > 0 ? out : undefined
}

/** Neuer Text einer Bearbeitung (editedMessage.message): Text oder Bildunterschrift. */
export function editedTextOf(message: any): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const { content } = unwrap(message)
  const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return (
    pick(content?.conversation) ??
    pick(content?.extendedTextMessage?.text) ??
    pick(content?.imageMessage?.caption) ??
    pick(content?.videoMessage?.caption) ??
    pick(content?.documentMessage?.caption)
  )
}

/** WhatsApp-Stub-Typ "Nachricht fuer alle geloescht" (proto WebMessageInfo.StubType.REVOKE). */
const STUB_REVOKE = 1

export function normalizeMessage(raw: RawMessage, env: NormEnv): NormalizeResult {
  const key = raw.key
  if (!key?.id) return { kind: 'ignored', reason: 'no_id' }
  const chatId = resolveJid(key.remoteJid, key.remoteJidAlt, env)
  if (!chatId) return { kind: 'ignored', reason: 'no_chat' }
  if (isIgnoredChat(chatId)) return { kind: 'ignored', reason: 'chat_type' }
  const waTimestamp = toSeconds(raw.messageTimestamp)
  if (waTimestamp === null) return { kind: 'ignored', reason: 'no_timestamp' }
  if (!raw.message) return { kind: 'ignored', reason: raw.messageStubType ? 'stub' : 'no_content' }

  const topLevel = raw.message
  for (const k of NON_MESSAGE_KEYS) {
    if (topLevel[k]) return { kind: 'ignored', reason: 'non_message' }
  }
  const { content, viewOnce: wrappedViewOnce } = unwrap(topLevel)
  for (const k of NON_MESSAGE_KEYS) {
    if (content?.[k]) return { kind: 'ignored', reason: 'non_message' }
  }

  const contentType = CONTENT_TYPES.find((t) => content?.[t] !== undefined && content?.[t] !== null)
  const direction: 'in' | 'out' = key.fromMe ? 'out' : 'in'
  const isGroup = isGroupJid(chatId)

  // Absender
  let senderJid = chatId
  if (isGroup) {
    senderJid = resolveJid(key.participant, key.participantAlt, env) ?? chatId
  }
  const pushName = direction === 'in' && raw.pushName ? raw.pushName : undefined
  const sender =
    direction === 'out' ? SELF_LABEL : (env.nameOf(senderJid) ?? pushName ?? phoneLabel(senderJid) ?? 'Unbekannt')

  // Chatname: Gruppen nur ueber bekannte Namen, Einzelchats zusaetzlich ueber Push-Name/Nummer.
  const chatName = isGroup
    ? (env.nameOf(chatId) ?? '')
    : (env.nameOf(chatId) ?? pushName ?? phoneLabel(chatId) ?? '')

  const base = {
    id: key.id,
    chatId,
    chatName,
    isGroup,
    sender,
    senderJid,
    waTimestamp,
    direction,
    pushName,
  }

  if (!contentType) {
    return { kind: 'message', message: { ...base, type: 'system', text: PLACEHOLDER.unsupported } }
  }

  const body = content[contentType]
  const ctxInfo = typeof body === 'object' ? body?.contextInfo : undefined
  const replyId: unknown = ctxInfo?.stanzaId
  const replyTo = typeof replyId === 'string' && replyId ? replyId : undefined
  const quoted = replyTo ? quotedFrom(ctxInfo, env) : undefined

  // Einmal-Ansehen: Nur Ja/Nein-Angaben zu den Schluesseln ins Protokoll; gespeichert wird nur, wenn store_view_once
  // eingeschaltet ist und die Schluessel da sind. Sonst bleibt es beim Hinweistext (bisheriges Verhalten).
  const isViewOnce = wrappedViewOnce || body?.viewOnce === true
  let probe: ViewOnceProbe | undefined
  const kind1 = isViewOnce ? viewOnceKind(contentType) : null
  if (isViewOnce) {
    probe = {
      kind: kind1 ?? 'other',
      hasKey: toBase64(body?.mediaKey) !== null && toBase64(body?.mediaKey) !== '',
      hasDirectPath: typeof body?.directPath === 'string' && body.directPath !== '',
      hasUrl: typeof body?.url === 'string' && body.url !== '',
      hasSha: toBase64(body?.fileSha256) !== null && toBase64(body?.fileSha256) !== '',
    }
  }
  const msg = (type: MessageType, text: string | undefined, media?: NormalizedMedia): NormalizeResult => ({
    kind: 'message',
    message: {
      ...base,
      type,
      ...(text ? { text } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(quoted?.text ? { replyText: quoted.text } : {}),
      ...(quoted?.sender ? { replySender: quoted.sender } : {}),
      ...(quoted?.type ? { replyType: quoted.type } : {}),
      ...(media ? { media } : {}),
      ...(isViewOnce ? { viewOnce: true } : {}),
      ...(probe ? { viewOnceProbe: probe } : {}),
    },
  })

  if (isViewOnce && !(env.storeViewOnce === true && kind1 !== null && probe?.hasKey === true)) {
    return msg('system', kind1 ? PLACEHOLDER.viewOnceKind[kind1] : PLACEHOLDER.viewOnce)
  }

  switch (contentType) {
    case 'conversation':
      return msg('text', body)
    case 'extendedTextMessage':
      return msg('text', body.text ?? '')
    case 'imageMessage':
      return msg('image', body.caption ?? undefined, mediaOf('image', 'image', body))
    case 'stickerMessage':
      return msg('image', undefined, mediaOf('image', 'sticker', body))
    case 'videoMessage':
      return msg('video', body.caption ?? undefined, mediaOf('video', 'video', body))
    case 'ptvMessage':
      return msg('video', body.caption ?? undefined, mediaOf('video', 'ptv', body))
    case 'audioMessage':
      return msg('voice', undefined, mediaOf('voice', 'audio', body))
    case 'documentMessage':
      return msg('document', body.caption ?? undefined, mediaOf('document', 'document', body))
    case 'locationMessage': {
      const label = [body.name, body.address].filter((x: unknown) => typeof x === 'string' && x).join(', ')
      return msg('text', `📍 Standort${label ? `: ${label}` : ''}`)
    }
    case 'liveLocationMessage':
      return msg('text', `📍 Live-Standort${body.caption ? `: ${body.caption}` : ''}`)
    case 'contactMessage':
      return msg('text', describeContacts(content, 'single'))
    case 'contactsArrayMessage':
      return msg('text', describeContacts(content, 'array'))
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      const options = Array.isArray(body.options)
        ? body.options.map((o: any) => o?.optionName).filter((s: unknown) => typeof s === 'string' && s)
        : []
      return msg('text', `📊 Umfrage: ${body.name ?? ''}${options.length ? `\n${options.map((o: string) => `• ${o}`).join('\n')}` : ''}`)
    }
  }
  return msg('system', PLACEHOLDER.unsupported)
}

function mediaOf(kind: MediaKind, hkdfType: string, body: any): NormalizedMedia {
  const mediaKey = toBase64(body.mediaKey)
  const descriptor: MediaDescriptor = {
    hkdfType,
    mediaKey: mediaKey ?? '',
    directPath: typeof body.directPath === 'string' ? body.directPath : null,
    url: typeof body.url === 'string' ? body.url : null,
    fileSha256: toBase64(body.fileSha256),
    mimetype: typeof body.mimetype === 'string' ? body.mimetype : null,
    fileLength: toNum(body.fileLength),
    fileName: typeof body.fileName === 'string' && body.fileName ? body.fileName : null,
    seconds: toNum(body.seconds),
    ptt: body.ptt === true,
  }
  return {
    kind,
    descriptor,
    declaredBytes: descriptor.fileLength,
    durationSeconds: descriptor.seconds,
    mimeType: descriptor.mimetype,
  }
}

// ---------------------------------------------------------------------------------------------
// MessageHandler
// ---------------------------------------------------------------------------------------------

export type EnqueueResult = 'queued' | 'disabled' | 'too_large' | 'queue_full' | 'duplicate'

/** Schnittstelle zur Medien-Warteschlange (mediaQueue.ts). */
export interface MediaSink {
  enqueue(job: NewMediaJob): EnqueueResult
}

export interface HandlerDeps {
  db: Database
  jobs: JobStore
  media: MediaSink
  cfg: Pick<IngestConfig, 'retention'> & { media?: Pick<IngestConfig['media'], 'storeViewOnce'> }
  log: Logger
  now?: () => number
  /** Zeitgeber fuer die Wiederholung bei Schreibsperre (Tests ersetzen ihn). */
  scheduler?: Scheduler
  /** Wartezeiten der Wiederholungen bei Schreibsperre. Standard: 5 s, 15 s, 45 s, 2 min. */
  retryDelaysMs?: readonly number[]
  /** Hoechstzahl wartender Nachrichten (Speicherschutz). Standard 500. */
  maxPendingRetries?: number
}

export interface HandleStats {
  stored: number
  duplicates: number
  dropped: number
  ignored: number
}

const SETTINGS_CACHE_MS = 30_000
const HISTORY_CHUNK = 100

/**
 * F02: Schreibsperre auf der geteilten Datenbank (Cleanup-Stapel, woechentlicher VACUUM). Der Treiber ist synchron:
 * Die Wartezeit darf NICHT erhoeht werden (60 s Blockade der Ereignisschleife wuerde das Keepalive der Verbindung
 * reissen). Stattdessen wird die Nachricht aus dem Speicher mit asynchroner Wartezeit erneut versucht.
 */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000]
const MAX_PENDING_RETRIES = 500

/** SQLITE_BUSY / SQLITE_LOCKED, auch erweiterte Codes (z. B. SQLITE_BUSY_SNAPSHOT). */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(code)
}

interface PendingMessage {
  raw: RawMessage
  /** Wie viele Wiederholungslaeufe schon an der Sperre gescheitert sind. */
  failedRuns: number
}

export class MessageHandler {
  private readonly db: Database
  private readonly jobs: JobStore
  private readonly media: MediaSink
  private readonly cfg: HandlerDeps['cfg']
  private readonly log: Logger
  private readonly now: () => number
  private retentionCache: { at: number; messagesDays: number; mediaDays: number } | null = null
  private readonly sched: Scheduler
  private readonly retryDelays: readonly number[]
  private readonly maxPending: number
  private pending: PendingMessage[] = []
  private retryTimer: unknown = null
  private lost = 0

  private readonly env: NormEnv

  constructor(deps: HandlerDeps) {
    this.db = deps.db
    this.jobs = deps.jobs
    this.media = deps.media
    this.cfg = deps.cfg
    this.log = deps.log
    this.now = deps.now ?? nowSec
    this.sched = deps.scheduler ?? realScheduler
    this.retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
    this.maxPending = deps.maxPendingRetries ?? MAX_PENDING_RETRIES
    this.env = {
      pnForLid: (lid) => this.jobs.pnForLid(lid),
      nameOf: (jid) => this.jobs.getName(jid) ?? this.nameViaMapping(jid),
      storeViewOnce: deps.cfg.media?.storeViewOnce === true,
    }
  }

  /** Schlaegt einen Namen auch ueber die LID<->PN-Zuordnung nach. */
  private nameViaMapping(jid: string): string | undefined {
    if (isLidJid(jid)) {
      const pn = this.jobs.pnForLid(jid)
      return pn ? this.jobs.getName(pn) : undefined
    }
    return undefined
  }

  // --- Aufbewahrung ---------------------------------------------------------------------------

  /** Aufbewahrung in Tagen: settings-Tabelle (vom Web gesetzt) vor config.toml; gueltig sind ganze Tage 1..365. */
  private retention(): { messagesDays: number; mediaDays: number } {
    const t = Date.now()
    if (this.retentionCache && t - this.retentionCache.at < SETTINGS_CACHE_MS) return this.retentionCache
    const loadDays = (key: string, fallback: number): number => {
      try {
        const v = getSetting(this.db, key)
        const n = v === null ? NaN : Number(v)
        return Number.isInteger(n) && n >= 1 && n <= 365 ? n : fallback
      } catch {
        return fallback
      }
    }
    const messagesDays = loadDays(SETTING_KEYS.retentionMessagesDays, this.cfg.retention.messagesDays)
    const mediaDays = Math.min(loadDays(SETTING_KEYS.retentionMediaDays, this.cfg.retention.mediaDays), messagesDays)
    this.retentionCache = { at: t, messagesDays, mediaDays }
    return this.retentionCache
  }

  /** Gilt eine Nachricht mit diesem WhatsApp-Zeitstempel schon als abgelaufen? */
  isExpired(waTimestamp: number, kind: 'messages' | 'media' = 'messages'): boolean {
    const r = this.retention()
    const days = kind === 'messages' ? r.messagesDays : r.mediaDays
    return waTimestamp < this.now() - days * 86_400
  }

  // --- Ereignis: messages.upsert --------------------------------------------------------------

  handleUpsert(arg: { messages?: RawMessage[]; type?: string }): HandleStats {
    const stats: HandleStats = { stored: 0, duplicates: 0, dropped: 0, ignored: 0 }
    for (const raw of arg.messages ?? []) {
      // Warten schon Nachrichten wegen einer Sperre, kein weiterer (bis zu 5 s blockierender) Versuch: hinten anstellen.
      if (this.pending.length > 0) {
        this.defer(raw, 0)
        continue
      }
      try {
        this.processOne(raw, 'live', stats)
      } catch (err) {
        if (isBusyError(err)) {
          this.defer(raw, 0)
          continue
        }
        stats.ignored++
        this.log.error('message_failed', { msg_id: raw.key?.id ?? null, ...errorFields(err) })
      }
    }
    if (stats.stored + stats.duplicates + stats.dropped + stats.ignored > 0) {
      this.log.debug('upsert_handled', { ...stats, upsert_type: arg.type ?? null })
    }
    return stats
  }

  // --- Ereignis: messages.update (fuer alle geloescht, bearbeitet) -------------------------------------

  /**
   * Die Bibliothek meldet "fuer alle geloescht" und Bearbeitungen als messages.update. Das Ereignis entsteht
   * lokal aus einer ohnehin empfangenen Nachricht; es braucht keine Anfrage an WhatsApp. Andere Aktualisierungen
   * (Zustell- und Lesestatus der eigenen Nachrichten) werden ignoriert. Protokoll ohne Inhalte: nur IDs und Zaehler.
   */
  handleUpdates(updates: { key?: RawKey | null; update?: any }[] | undefined): void {
    for (const u of updates ?? []) this.applyUpdate(u, 0)
  }

  private applyUpdate(u: { key?: RawKey | null; update?: any }, failedRuns: number): void {
    const id = u?.key?.id
    if (typeof id !== 'string' || id === '') return
    const upd = u.update
    try {
      if (upd && upd.message === null && upd.messageStubType === STUB_REVOKE) {
        if (markMessageDeleted(this.db, id, this.now())) {
          pushEvent(this.db, 'message_updated', { messageId: id })
          this.log.info('message_marked_deleted', { msg_id: id })
        }
        return
      }
      const edited = upd?.message?.editedMessage?.message
      if (edited) {
        const text = editedTextOf(edited)
        if (text === undefined) return
        const at = toSeconds(upd.messageTimestamp) ?? this.now()
        const res = applyMessageEdit(this.db, id, text, at)
        if (res.changed) {
          pushEvent(this.db, 'message_updated', { messageId: id })
          this.log.info('message_edit_stored', { msg_id: id, version: res.version })
        }
      }
    } catch (err) {
      if (isBusyError(err) && failedRuns < this.retryDelays.length) {
        const delay = this.retryDelays[failedRuns] ?? 5_000
        this.sched.setTimeout(() => this.applyUpdate(u, failedRuns + 1), delay)
        return
      }
      this.log.error('message_update_failed', { msg_id: id, ...errorFields(err) })
    }
  }

  // --- Wiederholung bei Schreibsperre (F02) -------------------------------------------------------

  /** Nachrichten, die auf ein Ende der Schreibsperre warten. */
  get pendingRetries(): number {
    return this.pending.length
  }

  /** Nachrichten, die trotz Wiederholung nicht gespeichert werden konnten (seit Prozessstart). */
  get lostMessages(): number {
    return this.lost
  }

  private defer(raw: RawMessage, failedRuns: number): void {
    if (this.pending.length >= this.maxPending) {
      this.markLost(raw, 'queue_full')
      return
    }
    this.pending.push({ raw, failedRuns })
    this.log.warn('message_deferred', { msg_id: raw.key?.id ?? null, pending: this.pending.length })
    this.armRetry()
  }

  private armRetry(): void {
    if (this.retryTimer !== null || this.pending.length === 0) return
    const level = Math.min(this.pending[0]!.failedRuns, this.retryDelays.length - 1)
    this.retryTimer = this.sched.setTimeout(() => {
      this.retryTimer = null
      this.runRetries()
    }, this.retryDelays[level] ?? 5_000)
  }

  /** Ein Lauf: der Reihe nach versuchen; die erste Sperre beendet den Lauf (hoechstens eine Blockade je Lauf). */
  private runRetries(): void {
    const queue = this.pending
    this.pending = []
    let i = 0
    for (; i < queue.length; i++) {
      const entry = queue[i]!
      try {
        this.processOne(entry.raw, 'live', { stored: 0, duplicates: 0, dropped: 0, ignored: 0 })
        this.log.info('message_retry_ok', { msg_id: entry.raw.key?.id ?? null, failed_runs: entry.failedRuns })
      } catch (err) {
        if (isBusyError(err)) break
        this.markLost(entry.raw, 'error', err)
      }
    }
    const rest = queue.slice(i).map((e) => ({ raw: e.raw, failedRuns: e.failedRuns + 1 }))
    for (const e of rest) {
      if (e.failedRuns >= this.retryDelays.length) this.markLost(e.raw, 'busy')
      else this.pending.push(e)
    }
    this.armRetry()
  }

  private markLost(raw: RawMessage, reason: string, err?: unknown): void {
    this.lost++
    this.log.error('message_lost', { msg_id: raw.key?.id ?? null, reason, lost_total: this.lost, ...(err ? errorFields(err) : {}) })
  }

  /** Beim Herunterfahren: wartende Nachrichten ein letztes Mal versuchen, den Rest als verloren melden. */
  flushPending(): void {
    if (this.retryTimer !== null) {
      this.sched.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const queue = this.pending
    this.pending = []
    let blocked = false
    for (const entry of queue) {
      if (blocked) {
        this.markLost(entry.raw, 'shutdown')
        continue
      }
      try {
        this.processOne(entry.raw, 'live', { stored: 0, duplicates: 0, dropped: 0, ignored: 0 })
        this.log.info('message_retry_ok', { msg_id: entry.raw.key?.id ?? null, failed_runs: entry.failedRuns })
      } catch (err) {
        blocked = isBusyError(err)
        this.markLost(entry.raw, blocked ? 'shutdown' : 'error', blocked ? undefined : err)
      }
    }
  }

  // --- Ereignis: messaging-history.set --------------------------------------------------------

  /**
   * Verlauf beim Koppeln: alles Aeltere als die Aufbewahrung wird verworfen, Medien werden NICHT
   * nachgeladen (Zeilen entstehen mit Status 'expired'). Verarbeitung in kleinen Paketen mit
   * Pausen dazwischen, damit der Prozess waehrenddessen ansprechbar bleibt.
   */
  async handleHistory(arg: {
    chats?: any[]
    contacts?: any[]
    messages?: RawMessage[]
    lidPnMappings?: { lid?: string; pn?: string }[]
  }): Promise<HandleStats> {
    this.learnLidMappings(arg.lidPnMappings)
    this.learnContacts(arg.contacts)
    this.learnChats(arg.chats)

    const stats: HandleStats = { stored: 0, duplicates: 0, dropped: 0, ignored: 0 }
    const all = arg.messages ?? []
    for (let i = 0; i < all.length; i += HISTORY_CHUNK) {
      const chunk = all.slice(i, i + HISTORY_CHUNK)
      // Je Versuch eigene Zaehler: bei Rollback der Transaktion duerfen sie nicht doppelt zaehlen.
      let local: HandleStats = { stored: 0, duplicates: 0, dropped: 0, ignored: 0 }
      const tx = this.db.transaction(() => {
        local = { stored: 0, duplicates: 0, dropped: 0, ignored: 0 }
        for (const raw of chunk) {
          try {
            this.processOne(raw, 'history', local)
          } catch (err) {
            if (isBusyError(err)) throw err // ganze Transaktion zurueckrollen und spaeter wiederholen
            local.ignored++
            this.log.error('history_message_failed', { msg_id: raw.key?.id ?? null, ...errorFields(err) })
          }
        }
      })
      for (let attempt = 0; ; attempt++) {
        try {
          tx()
          break
        } catch (err) {
          const delay = this.retryDelays[attempt]
          if (!isBusyError(err) || delay === undefined) throw err
          this.log.warn('history_deferred', { attempt: attempt + 1, delay_ms: delay })
          await new Promise<void>((resolve) => this.sched.setTimeout(resolve, delay))
        }
      }
      stats.stored += local.stored
      stats.duplicates += local.duplicates
      stats.dropped += local.dropped
      stats.ignored += local.ignored
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (stats.stored > 0) {
      try {
        pushEvent(this.db, 'history_synced', { stored: stats.stored })
      } catch (err) {
        this.log.warn('event_push_failed', errorFields(err))
      }
    }
    this.log.info('history_handled', { ...stats, total: all.length })
    return stats
  }

  // --- Namen / Zuordnungen --------------------------------------------------------------------

  handleContacts(list: any[] | undefined): void {
    this.learnContacts(list)
  }

  handleChats(list: any[] | undefined): void {
    this.learnChats(list)
  }

  handleGroups(list: any[] | undefined): void {
    for (const g of list ?? []) {
      if (typeof g?.id === 'string' && typeof g?.subject === 'string') {
        this.jobs.upsertName(normalizeJid(g.id), g.subject, NAME_RANK.chat)
      }
    }
  }

  handleLidMapping(m: { lid?: string; pn?: string } | undefined): void {
    this.learnLidMappings(m ? [m] : undefined)
  }

  private learnLidMappings(list: { lid?: string; pn?: string }[] | undefined): void {
    for (const m of list ?? []) {
      if (typeof m?.lid === 'string' && typeof m?.pn === 'string') {
        this.jobs.setLidMapping(normalizeJid(m.lid), normalizeJid(m.pn))
      }
    }
  }

  private learnContacts(list: any[] | undefined): void {
    for (const c of list ?? []) {
      if (typeof c?.id !== 'string') continue
      const ids = new Set<string>([normalizeJid(c.id)])
      if (typeof c.lid === 'string') ids.add(normalizeJid(c.lid))
      if (typeof c.phoneNumber === 'string') ids.add(normalizeJid(c.phoneNumber))
      if (typeof c.lid === 'string' && typeof c.phoneNumber === 'string') {
        this.jobs.setLidMapping(normalizeJid(c.lid), normalizeJid(c.phoneNumber))
      }
      for (const id of ids) {
        if (typeof c.name === 'string') this.jobs.upsertName(id, c.name, NAME_RANK.contact)
        if (typeof c.notify === 'string') this.jobs.upsertName(id, c.notify, NAME_RANK.push)
      }
    }
  }

  private learnChats(list: any[] | undefined): void {
    for (const c of list ?? []) {
      const name = typeof c?.name === 'string' ? c.name : typeof c?.displayName === 'string' ? c.displayName : undefined
      if (typeof c?.id === 'string' && name) {
        this.jobs.upsertName(normalizeJid(c.id), name, NAME_RANK.chat)
      }
      if (typeof c?.id === 'string' && isLidJid(c.id) && typeof c?.pnJid === 'string') {
        this.jobs.setLidMapping(normalizeJid(c.id), normalizeJid(c.pnJid))
      }
    }
  }

  // --- Kern -----------------------------------------------------------------------------------

  private processOne(raw: RawMessage, origin: 'live' | 'history', stats: HandleStats): void {
    const n = normalizeMessage(raw, this.env)
    if (n.kind === 'ignored') {
      stats.ignored++
      this.log.debug('message_ignored', { reason: n.reason })
      return
    }
    const m = n.message
    if (this.isExpired(m.waTimestamp, 'messages')) {
      stats.dropped++
      return
    }
    if (m.pushName) this.jobs.upsertName(m.senderJid, m.pushName, NAME_RANK.push)
    if (m.viewOnceProbe) {
      // Nur Ja/Nein, kein Inhalt. Zeigt im Journal, ob WhatsApp die Schluessel fuer Einmal-Medien an dieses Geraet liefert.
      this.log.info('viewonce_probe', {
        kind: m.viewOnceProbe.kind,
        has_key: m.viewOnceProbe.hasKey,
        has_direct_path: m.viewOnceProbe.hasDirectPath,
        has_url: m.viewOnceProbe.hasUrl,
        has_sha: m.viewOnceProbe.hasSha,
        stored: m.media !== undefined,
      })
    }

    const receivedAt = this.now()
    const tx = this.db.transaction((): { inserted: boolean; job: NewMediaJob | null; deferred: NewMediaJob | null } => {
      let job: NewMediaJob | null = null
      let deferred: NewMediaJob | null = null
      upsertChat(this.db, {
        id: m.chatId,
        name: m.chatName,
        isGroup: m.isGroup,
        lastActivityAt: m.waTimestamp,
      })
      const inserted = insertMessageIfNotExists(this.db, {
        id: m.id,
        chatId: m.chatId,
        sender: m.sender,
        waTimestamp: m.waTimestamp,
        receivedAt,
        direction: m.direction,
        type: m.type,
        text: m.text,
        replyTo: m.replyTo,
        ...(m.viewOnce ? { viewOnce: true } : {}),
        ...(m.replyText ? { replyText: m.replyText } : {}),
        ...(m.replySender ? { replySender: m.replySender } : {}),
        ...(m.replyType ? { replyType: m.replyType } : {}),
      })
      if (!inserted) return { inserted: false, job: null, deferred: null }

      if (m.media) {
        ensureMediaRow(this.db, m.id)
        // Verlaufsmedien werden nicht geladen, bleiben aber auf Wunsch ladbar (Schluessel im privaten Speicher),
        // solange die Medien-Aufbewahrung nicht abgelaufen ist. Abgelaufene sind endgueltig weg.
        const mediaExpired = this.isExpired(m.waTimestamp, 'media')
        const skip: SkipReason | null = mediaExpired ? 'retention' : origin === 'history' ? 'history' : null
        setMediaStatus(this.db, m.id, {
          status: skip ? 'expired' : 'pending',
          ...(skip ? { skipReason: skip, loadable: skip === 'history' } : {}),
          ...(m.media.mimeType ? { mimeType: m.media.mimeType } : {}),
          ...(m.media.declaredBytes !== null ? { sizeBytes: m.media.declaredBytes } : {}),
          ...(m.media.durationSeconds !== null ? { durationSeconds: m.media.durationSeconds } : {}),
        })
        const newJob: NewMediaJob = {
          messageId: m.id,
          chatId: m.chatId,
          kind: m.media.kind,
          descriptor: m.media.descriptor,
          waTimestamp: m.waTimestamp,
        }
        if (skip === null) job = newJob
        else if (skip === 'history') deferred = newJob
      }
      if (origin === 'live') {
        pushEvent(this.db, 'new_message', { chatId: m.chatId, messageId: m.id, type: m.type })
      }
      return { inserted: true, job, deferred }
    })

    const { inserted, job: mediaJob, deferred } = tx()
    if (!inserted) {
      stats.duplicates++
      return
    }
    stats.stored++

    if (deferred) {
      try {
        this.jobs.upsertDeferred(deferred)
      } catch (err) {
        // Ohne Schluessel gibt es kein "jetzt laden"; die Nachricht selbst ist gespeichert.
        this.log.warn('deferred_store_failed', { msg_id: m.id, ...errorFields(err) })
      }
    }
    if (mediaJob) {
      const result = this.media.enqueue(mediaJob)
      if (result !== 'queued' && result !== 'duplicate') {
        this.log.info('media_not_queued', { msg_id: m.id, reason: result, kind: mediaJob.kind })
      }
    }
  }
}
