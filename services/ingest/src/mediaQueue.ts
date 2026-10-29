/**
 * Medien-Warteschlange: Herunterladen, Entschluesseln, Vorschau/Umwandlung, Status in der Datenbank.
 *
 * Eigenschaften:
 *  - hoechstens `maxConcurrentDownloads` (Standard 2) gleichzeitig, FIFO; ein haengender oder
 *    fehlgeschlagener Job blockiert die uebrigen nicht (Wiederholung wird zeitversetzt eingeplant),
 *  - Groessenlimits je Medienart (vorab nach angegebener Laenge, waehrenddessen nach echten Bytes),
 *  - Stillstands-Erkennung (kein Byte fuer `stallTimeoutMs` -> Abbruch und Wiederholung),
 *  - Pruefsumme (SHA-256) gegen die im Deskriptor angegebene fileSha256,
 *  - begrenzte Wiederholungen mit exponentiellem Backoff (Standard 3, Start 30 s),
 *  - Zustand ueberlebt Neustarts (JobStore); beim Start werden unterbrochene Jobs erneut eingereihten.
 *
 * Sicherheit:
 *  - Es wird nichts an WhatsApp gesendet. Abgelaufene Medien (HTTP 403/404/410) werden als
 *    'expired' markiert; eine Neu-Upload-Anfrage an das Telefon wird bewusst NICHT gestellt.
 *  - Dateien entstehen als `<name>.part` und werden erst nach vollstaendigem, geprueftem Download
 *    umbenannt (nie halbe Dateien unter dem Endnamen).
 *  - Pfade enthalten nur bereinigte Segmente (kein "..", keine Trenner).
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IngestConfig, MediaKind } from './config.js'
import {
  ensureMediaRow,
  listMediaIdsByStatus,
  messageExists,
  pushEvent,
  setMediaStatus,
  type Database,
  type MediaStatus,
} from './dbClient.js'
import type { EnqueueResult } from './messageHandler.js'
import { DownloadPolicy } from './downloadPolicy.js'
import type { JobStore, MediaJob, NewMediaJob } from './jobStore.js'
import { errorFields, type Logger } from './log.js'
import { needsConversion } from './media/audio.js'
import { mimeForFormat } from './media/thumbnail.js'
import { nowSec } from './sqlite.js'
import { nextBackoffMs, realScheduler, statusCodeOf, type Scheduler } from './timing.js'
import { DownloadTargetError, type DownloadTarget } from './waLib.js'

export interface QueueDeps {
  db: Database
  jobs: JobStore
  cfg: Pick<IngestConfig, 'paths' | 'media'>
  log: Logger
  download: (target: DownloadTarget) => Promise<Readable>
  /** Vorschaubild erzeugen; fehlt die Funktion, gibt es keine Vorschauen. */
  thumbnail?: (src: string, dest: string) => Promise<{ format?: string } | undefined>
  /** Sprachnachricht nach AAC umwandeln; fehlt die Funktion, bleibt das Original. */
  convertVoice?: (src: string, dest: string) => Promise<void>
  /** Ist ein Medium mit diesem WhatsApp-Zeitstempel ueber die Medien-Aufbewahrung hinaus? */
  isExpired: (waTimestamp: number) => boolean
  scheduler?: Scheduler
  rng?: () => number
  now?: () => number
}

class TooLargeError extends Error {
  constructor() {
    super('too_large')
    this.name = 'TooLargeError'
  }
}
class StallError extends Error {
  constructor() {
    super('stall')
    this.name = 'StallError'
  }
}
class HashMismatchError extends Error {
  constructor() {
    super('hash_mismatch')
    this.name = 'HashMismatchError'
  }
}
class NoKeyError extends Error {
  constructor() {
    super('no_key')
    this.name = 'NoKeyError'
  }
}

interface Verdict {
  retry: boolean
  finalStatus: Extract<MediaStatus, 'failed' | 'expired'>
  code: string
}

/** HTTP-Status, bei denen der Medienlink als abgelaufen gilt (404/410 wie in Baileys; 403 = abgelaufene Signatur, unverifiziert). */
const GONE_STATUS = new Set([403, 404, 410])

export function classifyFailure(err: unknown): Verdict {
  if (err instanceof TooLargeError) return { retry: false, finalStatus: 'failed', code: 'too_large' }
  if (err instanceof NoKeyError) return { retry: false, finalStatus: 'failed', code: 'no_key' }
  // F01: abgewiesenes Ziel bleibt abgewiesen; Wiederholen aendert nichts. Nur der Code im Journal, nie die URL.
  if (err instanceof DownloadTargetError) return { retry: false, finalStatus: 'failed', code: 'bad_target' }
  if (err instanceof HashMismatchError) return { retry: true, finalStatus: 'failed', code: 'hash_mismatch' }
  if (err instanceof StallError) return { retry: true, finalStatus: 'failed', code: 'stall' }
  const status = statusCodeOf(err)
  if (status !== undefined && GONE_STATUS.has(status)) return { retry: false, finalStatus: 'expired', code: `http_${status}` }
  if (status === 400) return { retry: false, finalStatus: 'failed', code: 'http_400' }
  return { retry: true, finalStatus: 'failed', code: status !== undefined ? `http_${status}` : 'error' }
}

// ---------------------------------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------------------------------

/** Macht aus beliebigem Text ein ungefaehrliches Pfadsegment. */
export function safeSegment(input: string, max = 80): string {
  let s = input.replace(/[^A-Za-z0-9._-]/g, '_')
  s = s.replace(/^\.+/, '_') // keine versteckten Dateien, kein ".." als ganzes Segment
  if (s.length === 0) s = '_'
  return s.slice(0, max)
}

/** Originaldateiname -> sicherer Dateiname (Buchstaben/Ziffern inkl. Umlaute, Punkt, Strich, Unterstrich, Leerzeichen). */
export function safeFileName(input: string, max = 100): string {
  const base = input.split(/[\\/]/).pop() ?? ''
  let s = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_').trim()
  if (s.length === 0) s = 'datei'
  if (s.length > max) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : ''
    s = s.slice(0, max - ext.length) + ext
  }
  return s
}

export function utcDate(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10)
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
}

export function extensionFor(mime: string | null, kind: MediaKind): string {
  const base = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const hit = EXT_BY_MIME[base]
  if (hit) return hit
  return kind === 'voice' ? '.ogg' : '.bin'
}

export function mediaDir(mediaRoot: string, chatId: string, waTimestamp: number): string {
  return path.join(mediaRoot, safeSegment(chatId), utcDate(waTimestamp))
}

/** MIME ohne Parameter ("audio/ogg; codecs=opus" -> "audio/ogg"). */
function baseMime(mime: string | null): string | undefined {
  const b = mime?.split(';')[0]?.trim().toLowerCase()
  return b ? b : undefined
}

// ---------------------------------------------------------------------------------------------
// Warteschlange
// ---------------------------------------------------------------------------------------------

export class MediaQueue {
  private readonly db: Database
  private readonly jobs: JobStore
  private readonly cfg: QueueDeps['cfg']
  private readonly log: Logger
  private readonly deps: QueueDeps
  private readonly sched: Scheduler
  private readonly rng: () => number
  private readonly now: () => number
  /** Download-Regeln: settings-Tabelle (Oberflaeche) vor config.toml. */
  private readonly policy: DownloadPolicy

  /** messageId -> frueheste Startzeit (ms). Einfuegereihenfolge = FIFO. */
  private readonly waiting = new Map<string, number>()
  private readonly active = new Set<string>()
  private timer: unknown = null
  private running = false
  private idleWaiters: (() => void)[] = []

  constructor(deps: QueueDeps) {
    this.deps = deps
    this.db = deps.db
    this.jobs = deps.jobs
    this.cfg = deps.cfg
    this.log = deps.log
    this.sched = deps.scheduler ?? realScheduler
    this.rng = deps.rng ?? Math.random
    this.now = deps.now ?? nowSec
    this.policy = new DownloadPolicy(this.db, this.cfg.media)
  }

  get size(): { waiting: number; active: number } {
    return { waiting: this.waiting.size, active: this.active.size }
  }

  // --- Lebenszyklus ---------------------------------------------------------------------------

  start(): void {
    this.running = true
    this.pump()
  }

  /** Haelt an und wartet (max. timeoutMs) auf laufende Downloads. Rest bleibt im JobStore fuer den naechsten Start. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false
    if (this.timer !== null) {
      this.sched.clearTimeout(this.timer)
      this.timer = null
    }
    await this.whenIdle(timeoutMs)
  }

  /** Resolve, sobald nichts mehr aktiv ist (oder nach timeoutMs). Wartende Jobs mit Zeitversatz zaehlen nicht. */
  whenIdle(timeoutMs = 30_000): Promise<void> {
    if (this.active.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs)
      this.idleWaiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /**
   * Neustart-Wiederherstellung: Jobs aus dem JobStore erneut einreihen; Medien-Zeilen im Status
   * 'downloading', zu denen kein Job mehr existiert (Deskriptor verloren), werden auf 'failed' gesetzt.
   */
  recover(): { requeued: number; expired: number; unrecoverable: number } {
    let requeued = 0
    let expired = 0
    for (const job of this.jobs.listJobs()) {
      if (!messageExists(this.db, job.messageId)) {
        this.jobs.deleteJob(job.messageId)
        continue
      }
      if (this.deps.isExpired(job.waTimestamp)) {
        this.finish(job, 'expired', 'retention')
        expired++
        continue
      }
      this.safeStatus(job.messageId, { status: 'pending' })
      this.waiting.set(job.messageId, job.nextAttemptAt * 1000)
      requeued++
    }
    let unrecoverable = 0
    for (const id of listMediaIdsByStatus(this.db, ['downloading'])) {
      if (!this.jobs.getJob(id)) {
        this.safeStatus(id, { status: 'failed' })
        this.emit(id, 'failed')
        unrecoverable++
      }
    }
    this.log.info('media_recovered', { requeued, expired, unrecoverable })
    this.pump()
    return { requeued, expired, unrecoverable }
  }

  // --- Einreihen ------------------------------------------------------------------------------

  enqueue(job: NewMediaJob): EnqueueResult {
    const m = this.cfg.media
    const rule = this.policy.get(job.kind)
    if (!rule.auto) {
      // Download-Regel "aus": Nachricht bleibt, die Datei wird nicht geladen. Das Schema kennt keinen
      // eigenen Status dafuer; 'expired' (= keine Datei vorhanden) verhindert ein ewiges "wird geladen".
      this.safeStatus(job.messageId, { status: 'expired' })
      this.emit(job.messageId, 'expired')
      return 'disabled'
    }
    const declared = job.descriptor.fileLength
    if (declared !== null && declared > rule.maxBytes) {
      this.safeStatus(job.messageId, { status: 'failed' })
      this.emit(job.messageId, 'failed')
      return 'too_large'
    }
    if (this.waiting.has(job.messageId) || this.active.has(job.messageId)) return 'duplicate'
    if (this.waiting.size + this.active.size >= m.maxQueueLength) {
      this.safeStatus(job.messageId, { status: 'failed' })
      this.emit(job.messageId, 'failed')
      return 'queue_full'
    }
    this.jobs.upsertJob(job, this.now())
    this.waiting.set(job.messageId, 0)
    this.pump()
    return 'queued'
  }

  // --- Planung --------------------------------------------------------------------------------

  private pump(): void {
    if (!this.running) return
    const limit = this.cfg.media.maxConcurrentDownloads
    const nowMs = Date.now()
    let nextDue = Infinity
    for (const [id, dueMs] of this.waiting) {
      if (this.active.size >= limit) break
      if (dueMs > nowMs) {
        nextDue = Math.min(nextDue, dueMs)
        continue
      }
      this.waiting.delete(id)
      this.active.add(id)
      void this.run(id)
    }
    if (this.timer !== null) {
      this.sched.clearTimeout(this.timer)
      this.timer = null
    }
    if (nextDue !== Infinity) {
      this.timer = this.sched.setTimeout(() => {
        this.timer = null
        this.pump()
      }, Math.max(0, nextDue - nowMs))
    }
  }

  private async run(id: string): Promise<void> {
    try {
      await this.process(id)
    } catch (err) {
      // process() faengt erwartbare Fehler selbst; hier landet nur Unerwartetes.
      this.log.error('media_job_crashed', { msg_id: id, ...errorFields(err) })
      try {
        this.jobs.deleteJob(id)
      } catch {
        /* Zustandsspeicher schon geschlossen (Herunterfahren) - run() darf nie werfen */
      }
    } finally {
      this.active.delete(id)
      if (this.active.size === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const w of waiters) w()
      }
      this.pump()
    }
  }

  // --- Ein Job --------------------------------------------------------------------------------

  private async process(id: string): Promise<void> {
    const job = this.jobs.getJob(id)
    if (!job) return
    if (!messageExists(this.db, id)) {
      this.jobs.deleteJob(id) // Cleanup hat die Nachricht inzwischen geloescht
      return
    }
    if (this.deps.isExpired(job.waTimestamp)) {
      this.finish(job, 'expired', 'retention')
      return
    }

    const attempt = job.attempts + 1
    this.jobs.recordAttempt(id, attempt, 0)
    this.safeStatus(id, { status: 'downloading' })

    try {
      const result = await this.fetchAndStore(job)
      if (!this.safeStatus(id, { status: 'ready', ...result })) {
        // Nachricht wurde waehrenddessen geloescht -> Dateien wieder entfernen.
        await this.removeFiles(result.filePath, result.thumbnailPath)
        this.jobs.deleteJob(id)
        return
      }
      this.jobs.deleteJob(id)
      this.emit(id, 'ready')
      this.log.info('media_ready', { msg_id: id, kind: job.kind, bytes: result.sizeBytes, attempt })
    } catch (err) {
      const verdict = classifyFailure(err)
      await this.cleanupPartials(job)
      if (verdict.retry && attempt <= this.cfg.media.maxRetries) {
        const delay = nextBackoffMs(
          attempt - 1,
          { startMs: this.cfg.media.retryBaseMs, capMs: this.cfg.media.retryCapMs },
          this.rng,
        )
        this.jobs.recordAttempt(id, attempt, this.now() + Math.ceil(delay / 1000))
        this.waiting.set(id, Date.now() + delay)
        this.safeStatus(id, { status: 'pending' })
        this.log.warn('media_retry_scheduled', { msg_id: id, code: verdict.code, attempt, delay_ms: delay })
      } else {
        this.finish(job, verdict.finalStatus, verdict.code, attempt)
      }
    }
  }

  private finish(job: MediaJob, status: 'failed' | 'expired', code: string, attempt?: number): void {
    this.safeStatus(job.messageId, { status })
    this.jobs.deleteJob(job.messageId)
    this.emit(job.messageId, status)
    this.log.warn('media_final', { msg_id: job.messageId, status, code, attempt: attempt ?? null, kind: job.kind })
  }

  private emit(messageId: string, status: MediaStatus): void {
    try {
      pushEvent(this.db, 'media_ready', { messageId, status })
    } catch (err) {
      this.log.warn('event_push_failed', errorFields(err))
    }
  }

  /** setMediaStatus mit Schutz gegen zwischenzeitlich geloeschte Nachrichten (Fremdschluessel). */
  private safeStatus(messageId: string, patch: Parameters<typeof setMediaStatus>[2]): boolean {
    try {
      ensureMediaRow(this.db, messageId)
      setMediaStatus(this.db, messageId, patch)
      return true
    } catch (err) {
      this.log.warn('media_status_failed', { msg_id: messageId, ...errorFields(err) })
      return false
    }
  }

  // --- Herunterladen & Nachbearbeiten ---------------------------------------------------------

  private paths(job: MediaJob): { dir: string; base: string; finalPath: string } {
    const d = job.descriptor
    const dir = mediaDir(this.cfg.paths.mediaDir, job.chatId, job.waTimestamp)
    const base = safeSegment(job.messageId)
    const name =
      job.kind === 'document' && d.fileName
        ? `${base}__${safeFileName(d.fileName)}`
        : `${base}${extensionFor(d.mimetype, job.kind)}`
    return { dir, base, finalPath: path.join(dir, name) }
  }

  private async fetchAndStore(job: MediaJob): Promise<{
    filePath: string
    thumbnailPath?: string
    mimeType?: string
    sizeBytes: number
    durationSeconds?: number
  }> {
    const d = job.descriptor
    if (!d.mediaKey) throw new NoKeyError()
    const { dir, base, finalPath } = this.paths(job)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    await this.downloadTo(job, finalPath)

    let filePath = finalPath
    let mimeType: string | undefined = baseMime(d.mimetype)
    let thumbnailPath: string | undefined

    if (job.kind === 'image' && this.deps.thumbnail) {
      const dest = path.join(dir, `${base}.thumb.jpg`)
      try {
        const res = await this.deps.thumbnail(finalPath, dest)
        thumbnailPath = dest
        // MIME aus dem Inhalt statt aus der Absender-Angabe
        const sniffed = mimeForFormat(res?.format)
        if (sniffed) mimeType = sniffed
      } catch (err) {
        this.log.warn('thumbnail_failed', { msg_id: job.messageId, ...errorFields(err) })
      }
    }

    if (job.kind === 'voice' && this.deps.convertVoice && needsConversion(d.mimetype)) {
      const dest = path.join(dir, `${base}.m4a`)
      try {
        await this.deps.convertVoice(finalPath, dest)
        await fs.rm(finalPath, { force: true })
        filePath = dest
        mimeType = 'audio/mp4'
      } catch (err) {
        // Rueckfall: Original behalten (Chrome/Firefox spielen Ogg/Opus, Safari ggf. nicht).
        this.log.warn('audio_convert_failed', { msg_id: job.messageId, ...errorFields(err) })
        await fs.rm(dest, { force: true })
      }
    }

    const stat = await fs.stat(filePath)
    return {
      filePath,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: stat.size,
      ...(d.seconds !== null ? { durationSeconds: d.seconds } : {}),
    }
  }

  private async downloadTo(job: MediaJob, finalPath: string): Promise<void> {
    const d = job.descriptor
    const m = this.cfg.media
    const limit = this.policy.get(job.kind).maxBytes
    const part = `${finalPath}.part`
    const hash = createHash('sha256')
    let bytes = 0

    const source = await this.withTimeout(
      this.deps.download({
        mediaKey: Buffer.from(d.mediaKey, 'base64'),
        directPath: d.directPath,
        url: d.url,
        hkdfType: d.hkdfType,
      }),
      m.stallTimeoutMs,
    )

    let stallTimer: NodeJS.Timeout | undefined
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > limit) return cb(new TooLargeError())
        hash.update(chunk)
        armStall()
        cb(null, chunk)
      },
      final(cb) {
        if (stallTimer) clearTimeout(stallTimer)
        cb()
      },
    })
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => meter.destroy(new StallError()), m.stallTimeoutMs)
    }
    armStall()

    try {
      await pipeline(source, meter, createWriteStream(part, { mode: 0o600 }))
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
    }

    if (d.fileSha256 && hash.digest('base64') !== d.fileSha256) throw new HashMismatchError()
    await fs.rename(part, finalPath)
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new StallError()), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  private async cleanupPartials(job: MediaJob): Promise<void> {
    const { finalPath } = this.paths(job)
    await fs.rm(`${finalPath}.part`, { force: true })
  }

  private async removeFiles(...files: (string | undefined)[]): Promise<void> {
    for (const f of files) if (f) await fs.rm(f, { force: true })
  }
}
