/**
 * Verdrahtung der Bausteine (ohne Prozess-Aspekte wie Sperre, Signale, Verzeichnisse).
 * Getrennt von index.ts, damit der Gesamtweg "Ereignis -> Datenbank -> Medium" testbar ist.
 */
import type { AuthStore } from './authStore.js'
import { AVATAR_ENABLED_KEY, AvatarSync } from './avatars.js'
import type { IngestConfig } from './config.js'
import { IngestCommands } from './commands.js'
import { ConnectionManager } from './connection.js'
import { setSetting, type Database } from './dbClient.js'
import type { JobStore } from './jobStore.js'
import { errorFields, type Logger } from './log.js'
import { MediaQueue } from './mediaQueue.js'
import { convertToAac } from './media/audio.js'
import { createThumbnail } from './media/thumbnail.js'
import { MessageHandler } from './messageHandler.js'
import { StateCommands } from './stateCommand.js'
import type { Scheduler } from './timing.js'
import type { WaLib } from './waLib.js'

export interface ServiceDeps {
  cfg: IngestConfig
  log: Logger
  lib: Pick<WaLib, 'createSocket' | 'downloadMedia'> & Partial<Pick<WaLib, 'downloadProfilePicture'>>
  db: Database
  jobs: JobStore
  auth: AuthStore
  /** Ist ffmpeg aufrufbar? Wenn nein, bleibt das Sprachoriginal erhalten. */
  ffmpegOk: boolean
  /** Testnaehte: Vorschau-/Umwandlungsfunktion und Zeitgeber ersetzen. */
  thumbnail?: (src: string, dest: string) => Promise<{ format?: string } | undefined>
  convertVoice?: (src: string, dest: string) => Promise<void>
  scheduler?: Scheduler
  /** F08: kontrolliertes Beenden bei unheilbarem Fehler (index.ts faehrt herunter, Exit-Code 1). */
  onFatal?: (reason: string) => void
}

export interface Service {
  readonly conn: ConnectionManager
  readonly queue: MediaQueue
  readonly handler: MessageHandler
  start(): void
  stop(): Promise<void>
}

export function createService(d: ServiceDeps): Service {
  const { cfg, log, db, jobs, auth } = d

  // Profilbilder: nur mit profile_pictures = true (Abfrage an WhatsApp beim Oeffnen eines Chats, siehe avatars.ts).
  // Die Verbindung kommt weiter unten.
  let conn: ConnectionManager | null = null
  const downloadPicture = d.lib.downloadProfilePicture
  const avatars =
    cfg.profiles.enabled && downloadPicture
      ? new AvatarSync({
          db,
          cfg: cfg.profiles,
          mediaDir: cfg.paths.mediaDir,
          log,
          isConnected: () => conn?.getStatus() === 'connected',
          askPicture: (jid) => (conn ? conn.profilePicture(jid) : Promise.reject(new Error('not_connected'))),
          download: (url) => downloadPicture(url),
          shrink: (src, dest, side) => createThumbnail(src, dest, side),
          ...(d.scheduler ? { scheduler: d.scheduler } : {}),
        })
      : null
  // Ohne Abruf legt der Web-Dienst keine Befehle "refresh_avatar" ab.
  if (!avatars) setSetting(db, AVATAR_ENABLED_KEY, '0')

  // Der Handler kennt die Aufbewahrung, die Warteschlange braucht sie (isExpired) -> Referenz nachtraeglich setzen.
  let handler: MessageHandler | null = null
  const queue = new MediaQueue({
    db,
    jobs,
    cfg,
    log,
    download: (target) => d.lib.downloadMedia(target),
    thumbnail: d.thumbnail ?? ((src, dest) => createThumbnail(src, dest, cfg.media.thumbnailShortSide)),
    ...(d.ffmpegOk || d.convertVoice
      ? {
          convertVoice:
            d.convertVoice ??
            ((src: string, dest: string) =>
              convertToAac(src, dest, { ffmpegPath: cfg.media.ffmpegPath, timeoutMs: cfg.media.ffmpegTimeoutMs })),
        }
      : {}),
    isExpired: (ts) => (handler ? handler.isExpired(ts, 'media') : false),
    ...(d.scheduler ? { scheduler: d.scheduler } : {}),
  })
  const h = new MessageHandler({ db, jobs, media: queue, cfg, log, ...(d.scheduler ? { scheduler: d.scheduler } : {}) })
  handler = h

  conn = new ConnectionManager({
    db,
    cfg: cfg.connection,
    lib: d.lib,
    auth,
    log,
    ...(d.scheduler ? { scheduler: d.scheduler } : {}),
    ...(d.onFatal ? { onFatal: d.onFatal } : {}),
    // F14: Nach einer Abmeldung gehoeren Namen und Nummernzuordnung dem alten Konto.
    onSessionReset: () => {
      const n = jobs.clearIdentityData()
      log.info('state_identity_cleared', { names: n.names, lid_mappings: n.lidMappings, why: 'logged_out' })
    },
    listeners: {
      'messages.upsert': (arg) => h.handleUpsert(arg),
      // "fuer alle geloescht" und Bearbeitungen: lokal aus ohnehin empfangenen Nachrichten, keine Anfrage an WhatsApp.
      'messages.update': (arg) => h.handleUpdates(arg),
      'messaging-history.set': (arg) => {
        h.handleHistory(arg).catch((err) => log.error('history_failed', errorFields(err)))
      },
      'contacts.upsert': (arg) => h.handleContacts(arg),
      'contacts.update': (arg) => {
        h.handleContacts(arg)
        avatars?.onContactsUpdate(arg) // "Bild entfernt/geaendert": empfangen, keine Anfrage
      },
      'chats.upsert': (arg) => h.handleChats(arg),
      'chats.update': (arg) => h.handleChats(arg),
      'groups.upsert': (arg) => h.handleGroups(arg),
      'groups.update': (arg) => h.handleGroups(arg),
      'lid-mapping.update': (arg) => h.handleLidMapping(arg),
    },
  })

  // F14: Befehle des Web an den privaten Speicher ("Speicher leeren -> alles").
  const stateCommands = new StateCommands({
    db,
    jobs,
    log,
    pollMs: cfg.connection.commandPollMs,
    ...(d.scheduler ? { scheduler: d.scheduler } : {}),
  })

  // Befehle des Web an die Medien-Warteschlange ("Medium jetzt laden") und Aufraeumen zurueckgestellter Schluessel.
  const commands = new IngestCommands({
    db,
    queue,
    ...(avatars ? { avatars } : {}),
    log,
    pollMs: cfg.connection.commandPollMs,
    ...(d.scheduler ? { scheduler: d.scheduler } : {}),
  })

  const connection = conn
  return {
    conn: connection,
    queue,
    handler: h,
    start() {
      queue.recover()
      queue.start()
      stateCommands.start() // vor dem Verbindungsaufbau: ein wartender Befehl wirkt, bevor neue Namen eintreffen
      commands.start()
      connection.start()
      avatars?.start()
    },
    async stop() {
      avatars?.stop()
      commands.stop()
      stateCommands.stop()
      await connection.stop()
      h.flushPending() // F02: wartende Nachrichten ein letztes Mal speichern
      await queue.stop(10_000)
    },
  }
}
