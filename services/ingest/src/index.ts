/**
 * Einstiegspunkt von waread-ingest.
 *
 * Reihenfolge: Rechte (umask) -> Konfiguration -> Verzeichnisse -> Sperre -> Datenbanken ->
 * Bibliothek -> Medien-Warteschlange -> Nachrichten-Handler -> Verbindung. Beenden in umgekehrter Reihenfolge.
 */
import fs from 'node:fs'
import path from 'node:path'
import { openAuthStore, type AuthStore } from './authStore.js'
import { loadConfig } from './config.js'
import { openDb, runMigrations } from './dbClient.js'
import { JobStore } from './jobStore.js'
import { acquireLock, LockHeldError } from './lock.js'
import { createLogger, errorFields } from './log.js'
import { checkFfmpeg } from './media/audio.js'
import { configureSharp } from './media/thumbnail.js'
import { createService } from './service.js'
import { loadWaLib } from './waLib.js'
import { logNodeCounts, NodeCounter } from './nodeCounter.js'

const STATS_INTERVAL_MS = 10 * 60_000

async function main(): Promise<void> {
  // Alles, was dieser Prozess anlegt, ist nur fuer den Dienstbenutzer lesbar (Sitzungsschluessel!).
  process.umask(0o077)

  const cfg = loadConfig()
  const log = createLogger({ level: cfg.logLevel, base: { svc: 'waread-ingest' } })
  log.info('starting', { node: process.version })

  for (const dir of [cfg.paths.authDir, cfg.paths.mediaDir, path.dirname(cfg.paths.db)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  fs.chmodSync(cfg.paths.authDir, 0o700)

  // Nie zwei Instanzen auf denselben Sitzungsdateien.
  let lock
  try {
    lock = acquireLock(path.join(cfg.paths.authDir, 'ingest.lock'))
  } catch (err) {
    if (err instanceof LockHeldError) {
      log.error('lock_held', { holder_pid: err.pid })
      process.exit(75) // EX_TEMPFAIL: systemd darf es spaeter erneut versuchen
    }
    throw err
  }
  // Auch bei einem Startfehler (z. B. Bibliothek fehlt) die Sperre wieder freigeben.
  process.on('exit', () => lock.release())

  // F07: Nur in der Testinstanz (count_outgoing_nodes = true) werden ausgehende Knoten nach Art gezaehlt.
  const nodeCounter = cfg.diagnostics.countOutgoingNodes ? new NodeCounter() : undefined
  const lib = await loadWaLib(log, undefined, nodeCounter)
  const db = openDb(cfg.paths.db)
  runMigrations(db)
  const jobs = JobStore.open(cfg.paths.stateDb)
  const auth: AuthStore = openAuthStore(path.join(cfg.paths.authDir, 'auth.db'), lib)

  configureSharp()
  const ffmpegOk = cfg.media.convertVoice ? await checkFfmpeg(cfg.media.ffmpegPath) : false
  if (cfg.media.convertVoice && !ffmpegOk) log.warn('ffmpeg_missing')

  // F08: die Herunterfahr-Funktion entsteht weiter unten; bis dahin ist der Haken leer.
  let fatal: (reason: string) => void = () => {}
  const service = createService({ cfg, log, lib, db, jobs, auth, ffmpegOk, onFatal: (reason) => fatal(reason) })
  service.start()
  const { conn, queue, handler } = service

  const statsTimer = setInterval(() => {
    const mem = process.memoryUsage()
    const size = queue.size
    log.info('stats', {
      rss_mb: Math.round(mem.rss / 1048576),
      heap_mb: Math.round(mem.heapUsed / 1048576),
      queue_waiting: size.waiting,
      queue_active: size.active,
      msg_pending_retries: handler.pendingRetries,
      msg_lost_total: handler.lostMessages,
      conn: conn.getStatus(),
    })
    if (nodeCounter) logNodeCounts(nodeCounter, log)
  }, STATS_INTERVAL_MS)
  statsTimer.unref()

  let shuttingDown = false
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown', { signal })
    clearInterval(statsTimer)
    if (nodeCounter) logNodeCounts(nodeCounter, log)
    try {
      await service.stop()
    } catch (err) {
      log.error('shutdown_error', errorFields(err))
    }
    for (const close of [() => auth.close(), () => jobs.close(), () => db.close()]) {
      try {
        close()
      } catch {
        /* schon geschlossen */
      }
    }
    lock.release()
    process.exit(code)
  }

  fatal = (reason) => void shutdown(reason, 1)
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('uncaughtException', (err) => {
    log.error('uncaught_exception', errorFields(err))
    void shutdown('uncaughtException', 1)
  })
  process.on('unhandledRejection', (err) => {
    log.error('unhandled_rejection', errorFields(err))
    void shutdown('unhandledRejection', 1)
  })
}

main().catch((err) => {
  // Kein err.message: kann Pfade/Inhalte enthalten. Einzige Ausnahme: der Name eines fehlenden Pakets
  // (hilft bei einer unvollstaendigen Installation und enthaelt keine Nutzerdaten).
  const missing = /Cannot find (?:package|module) '([A-Za-z0-9@/._-]{1,80})'/.exec(String((err as Error | undefined)?.message ?? ''))
  process.stdout.write(
    JSON.stringify({ lvl: 'error', ev: 'fatal_startup', ...errorFields(err), ...(missing ? { missing_module: missing[1] } : {}) }) + '\n',
  )
  process.exit(1)
})
