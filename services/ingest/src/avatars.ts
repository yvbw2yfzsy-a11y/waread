/**
 * Profilbilder der Chats (nur mit `profile_pictures = true` in config.toml, ab Werk aus).
 *
 * Verkehr: je Chat hoechstens eine Abfrage pro `profile_pictures_interval_days` (Standard 7 Tage) an WhatsApp
 * (iq "w:profile:picture", siehe waLib.ts) und, wenn es ein sichtbares Bild gibt, ein HTTPS-Abruf von *.whatsapp.net.
 * Zwischen zwei Abfragen liegen `profile_pictures_gap_seconds` (+/- 30 %), je Runde hoechstens
 * `profile_pictures_max_per_round`. Bei einer Ablehnung wegen zu vieler Anfragen (429) ruht der Abruf einen Tag.
 * Ohne Anfrage: Meldet WhatsApp von sich aus "Bild entfernt" (contacts.update, imgUrl "removed"), wird das lokale Bild
 * geloescht; "Bild geaendert" macht den Chat fuer die naechste Runde faellig.
 *
 * Ablage: <media_dir>/avatars/<Hash>.jpg (192 px kurze Seite), Verweis in chats.avatar_path. Dateinamen enthalten keine
 * Nummer. Der Cleanup-Dienst und "Speicher leeren" lassen avatars/ in Ruhe; verwaiste Bilder raeumt dieses Modul selbst
 * am Ende einer vollstaendigen Runde weg.
 *
 * Ob ein Kontakt dieses Konto blockiert hat, laesst sich daraus NICHT ablesen: "kein Bild" (404) und "nicht sichtbar"
 * (401) entstehen ebenso durch Datenschutz-Einstellungen. docs/PROFILBILDER.md, Abschnitt 4.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IngestConfig } from './config.js'
import { getSetting, setSetting, type Database } from './dbClient.js'
import { errorFields, type Logger } from './log.js'
import { realScheduler, type Scheduler } from './timing.js'

/** Schluessel in der settings-Tabelle: { "<chat-id>": <Unix-Sekunden der letzten Abfrage> }. */
export const AVATAR_CHECKED_KEY = 'avatars.checked'
/** Unix-Sekunden, bis zu denen nach einer 429-Antwort nichts abgefragt wird. */
export const AVATAR_PAUSE_KEY = 'avatars.paused_until'
export const AVATAR_DIR = 'avatars'
const SHORT_SIDE = 192
const TICK_MS = 10 * 60_000
const DAY = 86_400
const MAX_FAILURES_PER_ROUND = 3
/** Frische Dateien nicht wegraeumen (koennten gerade entstehen). */
const PRUNE_MIN_AGE_MS = 3_600_000

export interface AvatarDeps {
  db: Database
  cfg: IngestConfig['profiles']
  mediaDir: string
  log: Logger
  isConnected(): boolean
  /** Profilbild-Adresse oder null (kein Bild / nicht sichtbar). Anfrage an WhatsApp. */
  query(jid: string): Promise<string | null>
  /** HTTPS-Abruf des Bildes. */
  download(url: string): Promise<Buffer>
  /** Verkleinert `src` nach `dest` (JPEG). */
  shrink(src: string, dest: string, shortSide: number): Promise<unknown>
  scheduler?: Scheduler
  now?: () => number
  rng?: () => number
}

/** Chats, fuer die es Profilbilder gibt: Personen (auch @lid) und Gruppen, keine Status-/Kanal-/Broadcast-Chats. */
export function isAvatarCandidate(id: string): boolean {
  return /@(s\.whatsapp\.net|lid|g\.us)$/.test(id)
}

export function avatarFileName(chatId: string): string {
  return `${createHash('sha256').update(chatId).digest('hex').slice(0, 24)}.jpg`
}

function codeOf(err: unknown): unknown {
  return (err as { data?: unknown } | null)?.data
}

export class AvatarSync {
  private readonly d: AvatarDeps
  private readonly sched: Scheduler
  private readonly now: () => number
  private readonly rng: () => number
  private timer: unknown = null
  private running = false
  private stopped = true

  constructor(deps: AvatarDeps) {
    this.d = deps
    this.sched = deps.scheduler ?? realScheduler
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    this.rng = deps.rng ?? Math.random
  }

  start(): void {
    if (!this.d.cfg.enabled) return
    this.stopped = false
    this.timer = this.sched.setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.sched.clearInterval(this.timer)
    this.timer = null
  }

  /** contacts.update: entfernte Bilder ohne Anfrage loeschen, geaenderte fuer die naechste Runde vormerken. */
  onContactsUpdate(updates: unknown): void {
    if (!this.d.cfg.enabled || !Array.isArray(updates)) return
    const checked = this.loadChecked()
    let dirty = false
    for (const u of updates as { id?: unknown; imgUrl?: unknown }[]) {
      if (typeof u?.id !== 'string' || !isAvatarCandidate(u.id)) continue
      if (u.imgUrl === 'removed') {
        void this.removeAvatar(u.id)
        checked[u.id] = this.now()
        dirty = true
      } else if (u.imgUrl === 'changed' && checked[u.id] !== undefined) {
        delete checked[u.id]
        dirty = true
      }
    }
    if (dirty) this.saveChecked(checked)
  }

  /** Eine Runde, wenn faellig. Oeffentlich fuer Tests; im Betrieb ruft der Zeitgeber sie auf. */
  async tick(): Promise<void> {
    if (this.running || this.stopped || !this.d.cfg.enabled || !this.d.isConnected()) return
    const pausedUntil = Number(getSetting(this.d.db, AVATAR_PAUSE_KEY) ?? '0')
    if (this.now() < pausedUntil) return
    this.running = true
    try {
      await this.round()
    } catch (err) {
      this.d.log.error('avatars_round_failed', errorFields(err))
    } finally {
      this.running = false
    }
  }

  private async round(): Promise<void> {
    const { db, cfg, log } = this.d
    const rows = db.prepare('SELECT id, avatar_path FROM chats ORDER BY last_activity_at DESC').all() as {
      id: string
      avatar_path: string | null
    }[]
    const chats = rows.filter((r) => isAvatarCandidate(r.id))
    const checked = this.loadChecked()
    const dueBefore = this.now() - cfg.intervalDays * DAY
    const due = chats.filter((c) => (checked[c.id] ?? 0) <= dueBefore)
    if (due.length === 0) return

    const batch = due.slice(0, cfg.maxPerRound)
    const stats = { asked: 0, found: 0, none: 0, failed: 0 }
    let failures = 0
    for (const [i, chat] of batch.entries()) {
      if (i > 0) await this.wait()
      if (this.stopped || !this.d.isConnected()) break
      stats.asked++
      try {
        const url = await this.d.query(chat.id)
        if (url) {
          await this.store(chat.id, await this.d.download(url))
          stats.found++
        } else {
          await this.removeAvatar(chat.id)
          stats.none++
        }
        checked[chat.id] = this.now()
        this.saveChecked(checked)
        failures = 0
      } catch (err) {
        stats.failed++
        if (codeOf(err) === 429) {
          setSetting(db, AVATAR_PAUSE_KEY, String(this.now() + DAY))
          log.warn('avatars_rate_limited', { pause_hours: 24 })
          break
        }
        log.warn('avatar_failed', errorFields(err))
        if (++failures >= MAX_FAILURES_PER_ROUND) break
      }
    }
    log.info('avatars_round', { ...stats, due: due.length })

    // Erst nach einer Runde, die alles Faellige abgefragt hat, aufraeumen (sonst fehlen noch Verweise).
    if (stats.asked === due.length && stats.failed === 0) await this.prune(new Set(rows.map((r) => r.id)), checked)
  }

  private wait(): Promise<void> {
    const ms = this.d.cfg.gapMs * (0.7 + 0.6 * this.rng())
    return new Promise((resolve) => this.sched.setTimeout(resolve, ms))
  }

  private async store(chatId: string, data: Buffer): Promise<void> {
    const dir = path.join(this.d.mediaDir, AVATAR_DIR)
    await fs.mkdir(dir, { recursive: true })
    const name = avatarFileName(chatId)
    const raw = path.join(dir, `.${name}.download`)
    try {
      await fs.writeFile(raw, data)
      await this.d.shrink(raw, path.join(dir, name), SHORT_SIDE)
    } finally {
      await fs.rm(raw, { force: true })
    }
    this.d.db.prepare('UPDATE chats SET avatar_path = ? WHERE id = ?').run(`${AVATAR_DIR}/${name}`, chatId)
  }

  private async removeAvatar(chatId: string): Promise<void> {
    this.d.db.prepare('UPDATE chats SET avatar_path = NULL WHERE id = ?').run(chatId)
    await fs.rm(path.join(this.d.mediaDir, AVATAR_DIR, avatarFileName(chatId)), { force: true })
  }

  /** Bilder ohne Verweis (Chat geloescht) und Eintraege geloeschter Chats entfernen. */
  private async prune(chatIds: Set<string>, checked: Record<string, number>): Promise<void> {
    const keep = new Set(
      (this.d.db.prepare('SELECT avatar_path FROM chats WHERE avatar_path IS NOT NULL').all() as { avatar_path: string }[])
        .map((r) => path.basename(r.avatar_path)),
    )
    const dir = path.join(this.d.mediaDir, AVATAR_DIR)
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.jpg') || keep.has(name)) continue
      const file = path.join(dir, name)
      const st = await fs.lstat(file).catch(() => null)
      if (st?.isFile() && Date.now() - st.mtimeMs > PRUNE_MIN_AGE_MS) await fs.rm(file, { force: true })
    }
    let dirty = false
    for (const id of Object.keys(checked)) {
      if (!chatIds.has(id)) {
        delete checked[id]
        dirty = true
      }
    }
    if (dirty) this.saveChecked(checked)
  }

  private loadChecked(): Record<string, number> {
    try {
      const v = JSON.parse(getSetting(this.d.db, AVATAR_CHECKED_KEY) ?? '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  private saveChecked(checked: Record<string, number>): void {
    setSetting(this.d.db, AVATAR_CHECKED_KEY, JSON.stringify(checked))
  }
}
