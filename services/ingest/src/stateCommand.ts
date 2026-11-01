/**
 * F14: Steuerkanal Web -> Ingest fuer den privaten Speicher (ingest-state.db).
 *
 * "Speicher leeren -> alles" loescht in der gemeinsamen Datenbank, kommt aber nicht an `names` (Anzeigenamen) und
 * `lid_map` (LID <-> Telefonnummer) heran: die liegen in der privaten Datei des Ingest. Das Web schreibt deshalb nach
 * einem erfolgreichen "alles" den Befehl `clear_identity` in die settings-Tabelle (Schluessel `ingest.state_command`).
 * Der Befehl bleibt dort stehen, bis der Ingest laeuft: ein Neustart des Dienstes (z. B. beim Kontowechsel) fuehrt ihn
 * beim Start sofort aus, noch vor dem ersten Verbindungsaufbau.
 *
 * Inhaltsfreies Protokoll: nur Ereignisnamen und Anzahlen, nie der Befehlstext (er kommt aus einer geteilten Tabelle).
 */
import { getSetting, setSetting, type Database } from './dbClient.js'
import type { JobStore } from './jobStore.js'
import { errorFields, type Logger } from './log.js'
import { realScheduler, type Scheduler } from './timing.js'

export const STATE_COMMAND_KEY = 'ingest.state_command'

export interface StateCommandsDeps {
  db: Database
  jobs: JobStore
  log: Logger
  pollMs: number
  scheduler?: Scheduler
}

export class StateCommands {
  private readonly sched: Scheduler
  private timer: unknown = null

  constructor(private readonly d: StateCommandsDeps) {
    this.sched = d.scheduler ?? realScheduler
  }

  /** Fuehrt einen schon wartenden Befehl sofort aus und fragt danach regelmaessig ab. */
  start(): void {
    if (this.timer !== null) return
    this.poll()
    this.timer = this.sched.setInterval(() => this.poll(), this.d.pollMs)
  }

  stop(): void {
    if (this.timer !== null) this.sched.clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    let cmd: string | null
    try {
      cmd = getSetting(this.d.db, STATE_COMMAND_KEY)
    } catch (err) {
      this.d.log.warn('state_command_poll_failed', errorFields(err))
      return
    }
    if (!cmd) return
    // Erst ausfuehren, dann quittieren: scheitert das Loeschen, bleibt der Befehl fuer den naechsten Takt stehen.
    if (cmd === 'clear_identity') {
      try {
        const n = this.d.jobs.clearIdentityData()
        this.d.log.info('state_identity_cleared', { names: n.names, lid_mappings: n.lidMappings, msg_secrets: n.msgSecrets })
      } catch (err) {
        this.d.log.error('state_identity_clear_failed', errorFields(err))
        return
      }
    } else {
      this.d.log.warn('state_command_unknown')
    }
    try {
      setSetting(this.d.db, STATE_COMMAND_KEY, '')
    } catch (err) {
      this.d.log.warn('state_command_ack_failed', errorFields(err))
    }
  }
}
