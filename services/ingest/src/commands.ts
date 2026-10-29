/**
 * Befehle des Web-Dienstes an den Ingest ueber die Tabelle ingest_commands (gemeinsame Datenbank).
 *
 * Der Web-Dienst spricht nie selbst mit WhatsApp oder dem Medienhost. Fuer "Medium jetzt laden" legt er einen Befehl
 * ab; dieser Dienst holt ihn ab, laedt genau dieses Medium (ein HTTPS-Abruf, siehe MediaQueue.loadDeferred) und loescht
 * den Befehl. Zusaetzlich raeumt er regelmaessig zurueckgestellte Schluessel auf (Nachricht weg oder Medien-Aufbewahrung
 * abgelaufen).
 *
 * Inhaltsfreies Protokoll: nur Befehlsart, Nachrichten-ID und Ergebnis.
 */
import { deleteCommand, listCommands, type Database } from './dbClient.js'
import { errorFields, type Logger } from './log.js'
import type { LoadResult } from './mediaQueue.js'
import { realScheduler, type Scheduler } from './timing.js'

export interface CommandsDeps {
  db: Database
  queue: { loadDeferred(messageId: string): LoadResult; purgeDeferred(): number }
  log: Logger
  pollMs: number
  /** Abstand der Aufraeumlaeufe fuer zurueckgestellte Schluessel. Standard 10 Minuten. */
  housekeepingMs?: number
  scheduler?: Scheduler
}

export const COMMAND_LOAD_MEDIA = 'load_media'

export class IngestCommands {
  private readonly sched: Scheduler
  private pollTimer: unknown = null
  private housekeepingTimer: unknown = null

  constructor(private readonly d: CommandsDeps) {
    this.sched = d.scheduler ?? realScheduler
  }

  start(): void {
    if (this.pollTimer !== null) return
    this.housekeeping()
    this.poll()
    this.pollTimer = this.sched.setInterval(() => this.poll(), this.d.pollMs)
    this.housekeepingTimer = this.sched.setInterval(() => this.housekeeping(), this.d.housekeepingMs ?? 600_000)
  }

  stop(): void {
    if (this.pollTimer !== null) this.sched.clearInterval(this.pollTimer)
    if (this.housekeepingTimer !== null) this.sched.clearInterval(this.housekeepingTimer)
    this.pollTimer = null
    this.housekeepingTimer = null
  }

  /** Fuehrt alle wartenden Befehle aus (auch von Tests direkt aufrufbar). */
  poll(): void {
    let cmds: ReturnType<typeof listCommands>
    try {
      cmds = listCommands(this.d.db)
    } catch (err) {
      this.d.log.warn('commands_poll_failed', errorFields(err))
      return
    }
    for (const c of cmds) {
      if (c.type === COMMAND_LOAD_MEDIA) {
        const id = (c.payload as { messageId?: unknown } | null)?.messageId
        if (typeof id === 'string' && id !== '' && id.length <= 512) {
          try {
            const result = this.d.queue.loadDeferred(id)
            this.d.log.info('command_load_media', { msg_id: id, result })
          } catch (err) {
            this.d.log.error('command_load_media_failed', { msg_id: id, ...errorFields(err) })
          }
        } else {
          this.d.log.warn('command_invalid', { type: c.type })
        }
      } else {
        this.d.log.warn('command_unknown', { type: c.type.slice(0, 40) })
      }
      // Erst nach der Ausfuehrung quittieren. Scheitert das Loeschen, laeuft der Befehl beim naechsten Takt noch einmal;
      // loadDeferred meldet dann 'duplicate' oder 'no_keys' und tut nichts Doppeltes.
      try {
        deleteCommand(this.d.db, c.id)
      } catch (err) {
        this.d.log.warn('command_ack_failed', errorFields(err))
      }
    }
  }

  housekeeping(): void {
    try {
      const n = this.d.queue.purgeDeferred()
      if (n > 0) this.d.log.info('deferred_purged', { removed: n })
    } catch (err) {
      this.d.log.warn('deferred_purge_failed', errorFields(err))
    }
  }
}
