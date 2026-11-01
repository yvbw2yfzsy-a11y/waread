/**
 * Verbindungsverwaltung: Aufbau, QR/Kopplung, Status, Wiederverbindung.
 *
 * Dieses Modul spricht WhatsApp gegenueber ausschliesslich ueber die Huelle `WaSocket`
 * (waLib.ts): Ereignisse abonnieren und Verbindung beenden. Es gibt hier keinen Sende-,
 * Lesebestaetigungs- oder Presence-Aufruf und kann auch keinen geben - die Huelle bietet ihn nicht an.
 *
 * Kommunikation mit dem Web-Dienst (getrennter Prozess, keine Direktverbindung):
 *   - Zustand in der settings-Tabelle (SETTING_KEYS.connection*),
 *   - Statuswechsel zusaetzlich als Ereignis 'connection_status' ({ state, since? ... }) in events_outbox.
 *     Das Ereignis enthaelt den QR-Wert NICHT (der QR ist ein kurzlebiges Kopplungsgeheimnis und
 *     soll nicht in der dauerhaften Ereigniswarteschlange liegen); der Web-Dienst liest ihn bei
 *     Bedarf aus settings (connection.qr, erkennbar an connection.qr_seq).
 *   - Steuerkanal Web -> Ingest: settings 'connection.command' = 'connect'.
 */
import { SETTING_KEYS, type ConnectionStatus, type IngestConfig } from './config.js'
import { getSetting, pushEvent, setSetting, type Database } from './dbClient.js'
import { errorFields, type Logger } from './log.js'
import { nowSec } from './sqlite.js'
import { nextBackoffMs, realScheduler, statusCodeOf, type Scheduler } from './timing.js'
import type { AuthStore } from './authStore.js'
import type { WaLib, WaSocket } from './waLib.js'

// ---------------------------------------------------------------------------------------------
// Klassifikation von Verbindungsabbruechen
// ---------------------------------------------------------------------------------------------

/** Werte aus Baileys' DisconnectReason (src/Types/index.ts). Ein Test vergleicht sie mit der installierten Bibliothek. */
export const DISCONNECT_CODE = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
} as const

export type DisconnectAction =
  /** Automatisch mit Backoff neu verbinden. */
  | 'reconnect'
  /** Sofort neu verbinden (vom Server verlangter Neustart, z. B. direkt nach der Kopplung). */
  | 'restart_now'
  /** Konto hat die Sitzung beendet: Sitzung loeschen, auf neue Kopplung warten. */
  | 'logged_out'
  /** Nicht automatisch neu verbinden; auf Befehl/Neustart warten. */
  | 'stop'

export function classifyDisconnect(code: number | undefined): { action: DisconnectAction; reason: string } {
  switch (code) {
    case DISCONNECT_CODE.loggedOut:
      return { action: 'logged_out', reason: 'logged_out' }
    case DISCONNECT_CODE.restartRequired:
      return { action: 'restart_now', reason: 'restart_required' }
    case DISCONNECT_CODE.connectionReplaced:
      // Eine andere Instanz nutzt dieselbe Sitzung. Neu verbinden wuerde sie verdraengen -> Pingpong.
      return { action: 'stop', reason: 'connection_replaced' }
    case DISCONNECT_CODE.forbidden:
      // Zugriff verweigert (u. a. eingeschraenktes/gesperrtes Konto): nicht gegen die Sperre anrennen.
      return { action: 'stop', reason: 'forbidden' }
    case DISCONNECT_CODE.multideviceMismatch:
      return { action: 'stop', reason: 'multidevice_mismatch' }
    case DISCONNECT_CODE.connectionLost:
      return { action: 'reconnect', reason: 'connection_lost' }
    case DISCONNECT_CODE.connectionClosed:
      return { action: 'reconnect', reason: 'connection_closed' }
    case DISCONNECT_CODE.unavailableService:
      return { action: 'reconnect', reason: 'service_unavailable' }
    case DISCONNECT_CODE.badSession:
      return { action: 'reconnect', reason: 'connection_failure' }
    default:
      return { action: 'reconnect', reason: 'unknown' }
  }
}

// ---------------------------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------------------------

export interface ConnectionDeps {
  db: Database
  cfg: IngestConfig['connection']
  lib: Pick<WaLib, 'createSocket'>
  auth: AuthStore
  log: Logger
  /** Ereignisse der Bibliothek -> Verarbeiter (Nachrichten, Verlauf, Namen). */
  listeners: Record<string, (arg: any) => void>
  scheduler?: Scheduler
  rng?: () => number
  now?: () => number
  /**
   * F08: Unheilbarer Fehler (Zugangsdaten lassen sich nicht speichern). Der Aufrufer faehrt den Dienst kontrolliert
   * herunter; systemd startet ihn neu (und gibt nach 5 Fehlstarts in 5 min sichtbar auf). Weiterlaufen mit
   * ungespeichertem Signal-Zustand wuerde beim naechsten Start zu Entschluesselungsfehlern und Neukopplung fuehren.
   */
  onFatal?: (reason: string) => void
  /** F14: Die Sitzung wurde wegen Abmeldung geloescht; der Aufrufer raeumt Daten des alten Kontos weg. */
  onSessionReset?: () => void
}

interface PublishExtra {
  qr?: string
  reason?: string
}

/**
 * Wie oft ein vom Server verlangter Sofort-Neustart pro Fenster zulaessig ist (Schutz vor Schleifen).
 * F05: Das Fenster ist so lang wie die Stabilitaetszeit (10 min). Bei 60 s war ein Server, der jede Verbindung
 * nach einer Minute mit 515 schliesst, nie begrenzt (60 Aufbauten je Stunde ohne Wartezeit).
 */
const QUICK_RESTART_LIMIT = 3
const QUICK_RESTART_WINDOW_MS = 600_000

export class ConnectionManager {
  private readonly db: Database
  private readonly cfg: IngestConfig['connection']
  private readonly lib: Pick<WaLib, 'createSocket'>
  private readonly auth: AuthStore
  private readonly log: Logger
  private readonly listeners: Record<string, (arg: any) => void>
  private readonly sched: Scheduler
  private readonly rng: () => number
  private readonly now: () => number
  private readonly onFatal: ((reason: string) => void) | undefined
  private readonly onSessionReset: (() => void) | undefined

  private status: ConnectionStatus = 'disconnected'
  private sock: WaSocket | null = null
  /** Erhoeht sich bei jedem Socket-Wechsel; Ereignisse alter Sockets werden verworfen. */
  private gen = 0
  private attempt = 0
  private qrSeq = 0
  private stopped = true
  private reconnectTimer: unknown = null
  private stableTimer: unknown = null
  private pollTimer: unknown = null
  private quickRestarts: number[] = []

  constructor(deps: ConnectionDeps) {
    this.db = deps.db
    this.cfg = deps.cfg
    this.lib = deps.lib
    this.auth = deps.auth
    this.log = deps.log
    this.listeners = deps.listeners
    this.sched = deps.scheduler ?? realScheduler
    this.rng = deps.rng ?? Math.random
    this.now = deps.now ?? nowSec
    this.onFatal = deps.onFatal
    this.onSessionReset = deps.onSessionReset
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  /** Profilbild-Adresse ueber den aktuellen Socket (avatars.ts). Wirft, wenn gerade keine Verbindung steht. */
  profilePicture(jid: string): Promise<string | null> {
    if (this.status !== 'connected' || !this.sock) return Promise.reject(new Error('not_connected'))
    return this.sock.profilePicture(jid)
  }

  start(): void {
    this.stopped = false
    this.pollTimer = this.sched.setInterval(() => this.pollCommand(), this.cfg.commandPollMs)
    if (this.auth.isPaired() || this.cfg.autoPairOnStart) {
      this.connect()
    } else {
      this.enterIdle('needs_qr', 'not_paired')
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    this.gen++
    const sock = this.sock
    this.sock = null
    if (sock) {
      try {
        await sock.end(undefined)
      } catch (err) {
        this.log.warn('socket_end_failed', errorFields(err))
      }
    }
    this.publish('disconnected', { reason: 'service_stopping' })
  }

  // --- Aufbau ---------------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return
    this.clearReconnectTimer()
    const gen = ++this.gen
    this.publish('connecting')

    let sock: WaSocket
    try {
      sock = this.lib.createSocket({ auth: this.auth.state })
    } catch (err) {
      this.log.error('socket_create_failed', errorFields(err))
      this.scheduleReconnect('socket_create_failed')
      return
    }
    this.sock = sock

    const guarded = (name: string, fn: (arg: any) => void) => (arg: any) => {
      if (gen !== this.gen) return
      try {
        fn(arg)
      } catch (err) {
        this.log.error('event_handler_failed', { event_name: name, ...errorFields(err) })
      }
    }

    sock.ev.on('connection.update', guarded('connection.update', (u) => this.onUpdate(u)))
    sock.ev.on(
      'creds.update',
      guarded('creds.update', () => {
        try {
          this.auth.saveCreds()
        } catch (err) {
          this.log.error('creds_save_failed', errorFields(err))
          this.onFatal?.('creds_save_failed')
        }
      }),
    )
    for (const [event, fn] of Object.entries(this.listeners)) {
      sock.ev.on(event, guarded(event, fn))
    }
  }

  private onUpdate(u: { connection?: string; qr?: string; isNewLogin?: boolean; lastDisconnect?: { error?: unknown } }): void {
    if (typeof u.qr === 'string' && u.qr.length > 0) {
      this.qrSeq++
      this.publish('needs_qr', { qr: u.qr })
    } else if ('qr' in u && u.qr === undefined && this.status === 'needs_qr') {
      // QR wurde zurueckgenommen (Kopplung erfolgreich, Verbindung wird gleich neu gestartet).
      this.publish('connecting', { reason: 'pairing' })
    }

    if (u.isNewLogin) this.log.info('pairing_succeeded')

    if (u.connection === 'open') {
      this.clearStableTimer()
      this.stableTimer = this.sched.setTimeout(() => {
        this.attempt = 0
        this.stableTimer = null
      }, this.cfg.stableAfterMs)
      this.publish('connected')
      this.log.info('connection_open')
    } else if (u.connection === 'close') {
      this.onClose(u.lastDisconnect?.error)
    }
  }

  // --- Abbruch --------------------------------------------------------------------------------

  private onClose(err: unknown): void {
    this.clearStableTimer()
    // Ab hier sind weitere Ereignisse des beendeten Sockets irrelevant.
    this.gen++
    this.sock = null
    if (this.stopped) return

    const code = statusCodeOf(err)
    const { action, reason } = classifyDisconnect(code)
    this.log.warn('connection_closed', { code, action, reason })

    switch (action) {
      case 'logged_out':
        this.auth.wipe()
        this.auth.reset()
        try {
          this.onSessionReset?.()
        } catch (err) {
          this.log.error('session_reset_hook_failed', errorFields(err))
        }
        this.enterIdle('needs_qr', 'logged_out')
        return
      case 'stop':
        this.enterIdle('disconnected', reason)
        return
      case 'restart_now':
        if (this.allowQuickRestart()) {
          this.connect()
        } else {
          this.log.warn('quick_restart_limit')
          this.scheduleReconnect('restart_loop')
        }
        return
      case 'reconnect':
        if (!this.auth.isPaired()) {
          // Eine QR-Sitzung ohne Kopplung ist abgelaufen (QR nicht gescannt) - kein Dauerschleifen-Versuch.
          this.enterIdle('needs_qr', 'qr_expired')
        } else {
          this.scheduleReconnect(reason)
        }
        return
    }
  }

  private allowQuickRestart(): boolean {
    const t = Date.now()
    this.quickRestarts = this.quickRestarts.filter((x) => t - x < QUICK_RESTART_WINDOW_MS)
    if (this.quickRestarts.length >= QUICK_RESTART_LIMIT) return false
    this.quickRestarts.push(t)
    return true
  }

  private scheduleReconnect(reason: string): void {
    const delay = nextBackoffMs(this.attempt, { startMs: this.cfg.backoffStartMs, capMs: this.cfg.backoffCapMs }, this.rng)
    this.attempt++
    this.log.info('reconnect_scheduled', { attempt: this.attempt, delay_ms: delay })
    this.publish('disconnected', { reason })
    this.clearReconnectTimer()
    this.reconnectTimer = this.sched.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Wartet auf einen ausdruecklichen Befehl (kein Reconnect-/QR-Loop). */
  private enterIdle(status: ConnectionStatus, reason: string): void {
    this.clearReconnectTimer()
    this.publish(status, { reason })
    this.log.info('connection_idle', { status, reason })
  }

  // --- Steuerkanal ----------------------------------------------------------------------------

  private pollCommand(): void {
    if (this.stopped) return
    let cmd: string | null
    try {
      cmd = getSetting(this.db, SETTING_KEYS.connectionCommand)
    } catch (err) {
      this.log.warn('command_poll_failed', errorFields(err))
      return
    }
    if (!cmd) return
    try {
      setSetting(this.db, SETTING_KEYS.connectionCommand, '')
    } catch (err) {
      this.log.warn('command_ack_failed', errorFields(err))
    }
    if (cmd !== 'connect') {
      this.log.warn('connection_command_unknown')
      return
    }
    if (this.sock) {
      this.log.info('connection_command_ignored', { reason: 'already_active' })
      return
    }
    this.log.info('connection_command_connect')
    this.attempt = 0
    this.connect()
  }

  // --- Status nach aussen ---------------------------------------------------------------------

  private publish(status: ConnectionStatus, extra: PublishExtra = {}): void {
    this.status = status
    const ts = this.now()
    try {
      const tx = this.db.transaction(() => {
        setSetting(this.db, SETTING_KEYS.connectionStatus, status)
        setSetting(this.db, SETTING_KEYS.connectionReason, extra.reason ?? '')
        setSetting(this.db, SETTING_KEYS.connectionUpdatedAt, String(ts))
        setSetting(this.db, SETTING_KEYS.connectionQr, status === 'needs_qr' && extra.qr ? extra.qr : '')
        setSetting(this.db, SETTING_KEYS.connectionQrSeq, String(this.qrSeq))
        if (status === 'connected') setSetting(this.db, SETTING_KEYS.connectionSince, String(ts))
        else setSetting(this.db, SETTING_KEYS.connectionSince, '')
        // Ereignisname und Feld "state"/"since" folgen dem SSE-Vertrag; der Web-Dienst liest den
        // massgeblichen Zustand (und den QR) ohnehin aus der settings-Tabelle.
        pushEvent(this.db, 'connection_status', {
          state: status,
          ...(status === 'connected' ? { since: ts } : {}),
          reason: extra.reason ?? null,
          hasQr: status === 'needs_qr' && Boolean(extra.qr),
          qrSeq: this.qrSeq,
          updatedAt: ts,
        })
      })
      tx()
    } catch (err) {
      // Status-Schreibfehler duerfen die Verbindungslogik nie unterbrechen.
      this.log.error('status_publish_failed', errorFields(err))
    }
  }

  // --- Timer-Hilfen ---------------------------------------------------------------------------

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.sched.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      this.sched.clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer()
    this.clearStableTimer()
    if (this.pollTimer !== null) {
      this.sched.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
