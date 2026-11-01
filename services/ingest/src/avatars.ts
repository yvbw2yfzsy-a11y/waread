/**
 * Profilbilder der Chats (nur mit `profile_pictures = true` in config.toml, ab Werk aus).
 *
 * Ausloeser ist das Oeffnen eines Chats in der Oberflaeche, wie bei WhatsApp selbst (Beobachtung des Nutzers, hier nicht
 * nachgemessen): Der Web-Dienst legt den Befehl "refresh_avatar" ab (commands.ts), dieser Dienst fragt aber nur, wenn
 * die letzte Abfrage fuer diesen Chat aelter als `profile_pictures_interval_days` (Standard 7 Tage) ist.
 *
 * Verkehr je Abfrage: eine Anfrage an WhatsApp (iq "w:profile:picture", siehe waLib.ts) und, wenn es ein sichtbares Bild
 * gibt, ein HTTPS-Abruf von *.whatsapp.net. Zwischen zwei Abfragen liegen mindestens `profile_pictures_gap_seconds`,
 * je Tag hoechstens `profile_pictures_max_per_day`. Bei einer Ablehnung wegen zu vieler Anfragen (429) ruht der Abruf
 * einen Tag. Ohne Anfrage: Meldet WhatsApp von sich aus "Bild entfernt" (contacts.update, imgUrl "removed"), wird das
 * lokale Bild geloescht; "Bild geaendert" macht den Chat beim naechsten Oeffnen faellig.
 *
 * Ablage: <media_dir>/avatars/<Hash>-<Zeit>.jpg (192 px kurze Seite), Verweis in chats.avatar_path. Der Name aendert sich
 * mit jedem neuen Bild, damit die Oberflaeche nicht das alte aus dem Browser-Zwischenspeicher zeigt. Dateinamen enthalten
 * keine Nummer. Cleanup und "Speicher leeren" lassen avatars/ in Ruhe; verwaiste Bilder raeumt dieses Modul selbst weg.
 *
 * Ob ein Kontakt dieses Konto blockiert hat, laesst sich daraus NICHT ablesen: "kein Bild" (404) und "nicht sichtbar"
 * (401) entstehen ebenso durch Datenschutz-Einstellungen. docs/PROFILBILDER.md, Abschnitt 4.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { IngestConfig } from './config.js'
import { getSetting, pushEvent, setSetting, type Database } from './dbClient.js'
import { errorFields, type Logger } from './log.js'
import { nowSec } from './sqlite.js'
import { realScheduler, type Scheduler } from './timing.js'

/** Schluessel in der settings-Tabelle: { "<chat-id>": <Unix-Sekunden der letzten Abfrage> }. */
export const AVATAR_CHECKED_KEY = 'avatars.checked'
/** Unix-Sekunden, bis zu denen nach einer 429-Antwort nichts abgefragt wird. */
export const AVATAR_PAUSE_KEY = 'avatars.paused_until'
/** '1', wenn der Abruf eingeschaltet ist. Der Web-Dienst legt nur dann Befehle ab. */
export const AVATAR_ENABLED_KEY = 'avatars.enabled'
/** Ereignis an die Oberflaeche (ueber events_outbox): ein Profilbild hat sich geaendert. */
export const EVENT_AVATAR_UPDATED = 'avatar_updated'
export const AVATAR_DIR = 'avatars'
const SHORT_SIDE = 192
const DAY = 86_400
const HOUSEKEEPING_MS = 6 * 3_600_000
/** Frische Dateien nicht wegraeumen (koennten gerade entstehen). */
const PRUNE_MIN_AGE_MS = 3_600_000

export type RefreshResult = 'queued' | 'fresh' | 'not_candidate' | 'paused' | 'day_limit' | 'duplicate'

export interface AvatarDeps {
  db: Database
  cfg: IngestConfig['profiles']
  mediaDir: string
  log: Logger
  isConnected(): boolean
  /** Profilbild-Adresse oder null (kein Bild / nicht sichtbar). Anfrage an WhatsApp. */
  askPicture(jid: string): Promise<string | null>
  /** HTTPS-Abruf des Bildes. */
  download(url: string): Promise<Buffer>
  /** Verkleinert `src` nach `dest` (JPEG). */
  shrink(src: string, dest: string, shortSide: number): Promise<unknown>
  scheduler?: Scheduler
  /** Unix-Sekunden. */
  now?: () => number
}

/** Chats, fuer die es Profilbilder gibt: Personen (auch @lid) und Gruppen, keine Status-/Kanal-/Broadcast-Chats. */
export function isAvatarCandidate(id: string): boolean {
  return /@(s\.whatsapp\.net|lid|g\.us)$/.test(id)
}

/** Fester Teil des Dateinamens je Chat (ohne Nummer). */
export function avatarStem(chatId: string): string {
  return createHash('sha256').update(chatId).digest('hex').slice(0, 24)
}

function codeOf(err: unknown): unknown {
  return (err as { data?: unknown } | null)?.data
}

export class AvatarSync {
  private readonly d: AvatarDeps
  private readonly sched: Scheduler
  private readonly now: () => number
  private readonly waiting: string[] = []
  private housekeepingTimer: unknown = null
  private current: Promise<void> | null = null
  private stopped = true
  private lastQueryAt = 0
  private day = ''
  private dayCount = 0

  constructor(deps: AvatarDeps) {
    this.d = deps
    this.sched = deps.scheduler ?? realScheduler
    this.now = deps.now ?? nowSec
  }

  start(): void {
    this.stopped = false
    setSetting(this.d.db, AVATAR_ENABLED_KEY, '1')
    void this.prune()
    this.housekeepingTimer = this.sched.setInterval(() => void this.prune(), HOUSEKEEPING_MS)
  }

  stop(): void {
    this.stopped = true
    this.waiting.length = 0
    if (this.housekeepingTimer !== null) this.sched.clearInterval(this.housekeepingTimer)
    this.housekeepingTimer = null
  }

  /**
   * Der Chat wurde geoeffnet. Fragt nur, wenn die letzte Abfrage aelter als das Intervall ist (und keine Grenze greift).
   * Die Abfrage selbst laeuft danach im Hintergrund, eine nach der anderen.
   */
  request(chatId: string): RefreshResult {
    if (!isAvatarCandidate(chatId)) return 'not_candidate'
    if ((this.loadChecked()[chatId] ?? 0) > this.now() - this.d.cfg.intervalDays * DAY) return 'fresh'
    if (this.now() < Number(getSetting(this.d.db, AVATAR_PAUSE_KEY) ?? '0')) return 'paused'
    if (this.waiting.includes(chatId)) return 'duplicate'
    this.rollDay()
    if (this.dayCount >= this.d.cfg.maxPerDay) return 'day_limit'
    this.dayCount++ // bei Annahme zaehlen, sonst sieht eine zweite Anfrage den laufenden Eintrag nicht
    this.waiting.push(chatId)
    void this.work()
    return 'queued'
  }

  /** contacts.update: entfernte Bilder ohne Anfrage loeschen, geaenderte beim naechsten Oeffnen neu holen. */
  onContactsUpdate(updates: unknown): void {
    if (!Array.isArray(updates)) return
    const checked = this.loadChecked()
    let dirty = false
    for (const u of updates as { id?: unknown; imgUrl?: unknown }[]) {
      if (typeof u?.id !== 'string' || !isAvatarCandidate(u.id)) continue
      if (u.imgUrl === 'removed') {
        const id = u.id
        void this.removeAvatar(id)
          .then((had) => { if (had) pushEvent(this.d.db, EVENT_AVATAR_UPDATED, { chatId: id }) })
          .catch((err: unknown) => this.d.log.warn('avatar_remove_failed', errorFields(err)))
        checked[u.id] = this.now()
        dirty = true
      } else if (u.imgUrl === 'changed' && checked[u.id] !== undefined) {
        delete checked[u.id]
        dirty = true
      }
    }
    if (dirty) this.saveChecked(checked)
  }

  /** Arbeitet die Warteliste ab; ein laufender Durchgang wird geteilt (Tests koennen so das Ende abwarten). */
  work(): Promise<void> {
    // Kein unbehandelter Fehler: Er wuerde den Prozess beenden (Node-Standard bei unhandled rejection).
    this.current ??= this.drain().catch((err: unknown) => this.d.log.error('avatars_work_failed', errorFields(err))).finally(() => {
      this.current = null
      if (this.waiting.length > 0 && !this.stopped) void this.work()
    })
    return this.current
  }

  private async drain(): Promise<void> {
    for (let chatId = this.waiting.shift(); chatId !== undefined && !this.stopped; chatId = this.waiting.shift()) {
      await this.waitForGap()
      if (this.stopped) break
      if (!this.d.isConnected()) {
        this.dayCount = Math.max(0, this.dayCount - 1)
        this.d.log.info('avatar_skipped', { why: 'not_connected' })
        continue
      }
      if (!(await this.refresh(chatId))) {
        this.waiting.length = 0
        break
      }
    }
  }

  /** Eine Abfrage. false = Abruf ruht (429), Warteliste verwerfen. */
  private async refresh(chatId: string): Promise<boolean> {
    const { db, log } = this.d
    this.lastQueryAt = Date.now()
    try {
      const url = await this.d.askPicture(chatId)
      const changed = url ? (await this.store(chatId, await this.d.download(url)), true) : await this.removeAvatar(chatId)
      const checked = this.loadChecked()
      checked[chatId] = this.now()
      this.saveChecked(checked)
      if (changed) pushEvent(db, EVENT_AVATAR_UPDATED, { chatId })
      log.info('avatar_refreshed', { found: url !== null, today: this.dayCount })
      return true
    } catch (err) {
      if (codeOf(err) === 429) {
        setSetting(db, AVATAR_PAUSE_KEY, String(this.now() + DAY))
        log.warn('avatars_rate_limited', { pause_hours: 24 })
        return false
      }
      log.warn('avatar_failed', errorFields(err))
      return true
    }
  }

  private waitForGap(): Promise<void> {
    const ms = this.lastQueryAt + this.d.cfg.gapMs - Date.now()
    return ms > 0 ? new Promise((resolve) => this.sched.setTimeout(resolve, ms)) : Promise.resolve()
  }

  private rollDay(): void {
    const today = new Date(this.now() * 1000).toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.dayCount = 0
    }
  }

  private async store(chatId: string, data: Buffer): Promise<void> {
    const dir = path.join(this.d.mediaDir, AVATAR_DIR)
    await fs.mkdir(dir, { recursive: true })
    const name = `${avatarStem(chatId)}-${this.now()}.jpg`
    const raw = path.join(dir, `.${name}.download`)
    try {
      await fs.writeFile(raw, data)
      await this.d.shrink(raw, path.join(dir, name), SHORT_SIDE)
    } finally {
      await fs.rm(raw, { force: true })
    }
    const before = this.currentPath(chatId)
    this.d.db.prepare('UPDATE chats SET avatar_path = ? WHERE id = ?').run(`${AVATAR_DIR}/${name}`, chatId)
    if (before && path.basename(before) !== name) await fs.rm(path.join(dir, path.basename(before)), { force: true })
  }

  /** true, wenn es ein Bild gab. */
  private async removeAvatar(chatId: string): Promise<boolean> {
    const before = this.currentPath(chatId)
    if (!before) return false
    this.d.db.prepare('UPDATE chats SET avatar_path = NULL WHERE id = ?').run(chatId)
    await fs.rm(path.join(this.d.mediaDir, AVATAR_DIR, path.basename(before)), { force: true })
    return true
  }

  private currentPath(chatId: string): string | null {
    const r = this.d.db.prepare('SELECT avatar_path FROM chats WHERE id = ?').get(chatId) as { avatar_path: string | null } | undefined
    return r?.avatar_path ?? null
  }

  /** Bilder ohne Verweis (Chat geloescht) und Eintraege geloeschter Chats entfernen. Ohne Netzverkehr. */
  private async prune(): Promise<void> {
    try {
      const rows = this.d.db.prepare('SELECT id, avatar_path FROM chats').all() as { id: string; avatar_path: string | null }[]
      const keep = new Set(rows.filter((r) => r.avatar_path).map((r) => path.basename(r.avatar_path as string)))
      const dir = path.join(this.d.mediaDir, AVATAR_DIR)
      const names = await fs.readdir(dir).catch(() => [] as string[])
      for (const name of names) {
        if (!name.endsWith('.jpg') || keep.has(name)) continue
        const file = path.join(dir, name)
        const st = await fs.lstat(file).catch(() => null)
        if (st?.isFile() && Date.now() - st.mtimeMs > PRUNE_MIN_AGE_MS) await fs.rm(file, { force: true })
      }
      const ids = new Set(rows.map((r) => r.id))
      const checked = this.loadChecked()
      const gone = Object.keys(checked).filter((id) => !ids.has(id))
      if (gone.length > 0) {
        for (const id of gone) delete checked[id]
        this.saveChecked(checked)
      }
    } catch (err) {
      this.d.log.warn('avatars_prune_failed', errorFields(err))
    }
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
