import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'

/**
 * Schluessel in der settings-Tabelle. Der gemeinsame Vertrag legt nur die Tabelle fest. Festlegung beim
 * Zusammenfuehren: Die Schluessel der Nutzer-Einstellungen heissen wie die Felder von GET/PUT /api/settings
 * (Web-Dienst schreibt sie, Ingest und Cleanup lesen sie); die Verbindungsschluessel gehoeren dem Ingest.
 * Alles an einer Stelle, damit eine Umbenennung trivial ist.
 */
export const SETTING_KEYS = {
  /** Aufbewahrung Nachrichten in Tagen (1/3/7/14/30). Geschrieben vom Web-Dienst, gelesen von Ingest und Cleanup. */
  retentionMessagesDays: 'retentionDays',
  /** Aufbewahrung Medien in Tagen. Geschrieben vom Web-Dienst, gelesen von Ingest und Cleanup. */
  retentionMediaDays: 'retentionMediaDays',
  /**
   * Download-Regeln als JSON: { image|voice|video|document: { mode: 'auto'|'off', maxMb: number } }.
   * Geschrieben vom Web-Dienst, gelesen vom Ingest (siehe downloadPolicy.ts).
   */
  downloadRules: 'downloadRules',
  /** 'connecting' | 'connected' | 'disconnected' | 'needs_qr'. Geschrieben vom Ingest. */
  connectionStatus: 'connection.status',
  /** Aktueller QR-Rohwert (leer, wenn keiner aktiv). Geschrieben vom Ingest, vom Web-Dienst fuer GET /api/qr gelesen. */
  connectionQr: 'connection.qr',
  /** Laufende Nummer des aktuellen QR (erhoeht sich bei jedem neuen QR). */
  connectionQrSeq: 'connection.qr_seq',
  /** Maschinenlesbarer Grund zum Status (z. B. 'logged_out', 'connection_lost'). */
  connectionReason: 'connection.reason',
  /** Unix-Sekunden der letzten Statusaenderung. */
  connectionUpdatedAt: 'connection.updated_at',
  /** Unix-Sekunden, seit wann die aktuelle Verbindung steht (leer, wenn nicht verbunden). */
  connectionSince: 'connection.connected_since',
  /** Steuerkanal Web -> Ingest: Web schreibt 'connect' (POST /api/connect), Ingest quittiert durch Leeren des Werts. */
  connectionCommand: 'connection.command',
} as const

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'needs_qr'

export type MediaKind = 'image' | 'voice' | 'video' | 'document'

export interface IngestConfig {
  paths: {
    db: string
    authDir: string
    mediaDir: string
    /** Teil der gemeinsamen Zielstruktur; der Ingest-Dienst nutzt es NICHT (Teildateien entstehen als .part neben dem Ziel). */
    tmpDir: string
    /** Privater SQLite-Speicher des Ingest-Dienstes (Medien-Deskriptoren, Namenscache). */
    stateDb: string
  }
  retention: { messagesDays: number; mediaDays: number }
  media: {
    maxConcurrentDownloads: number
    maxQueueLength: number
    maxRetries: number
    retryBaseMs: number
    retryCapMs: number
    stallTimeoutMs: number
    maxBytes: Record<MediaKind, number>
    autoDownload: Record<MediaKind, boolean>
    thumbnailShortSide: number
    convertVoice: boolean
    ffmpegPath: string
    ffmpegTimeoutMs: number
    /**
     * Einmal-Ansehen-Medien (Foto, Video, Sprachnachricht) wie normale Medien speichern. Ab Werk aus: Sie
     * sind fuer "einmal" gedacht, und ob WhatsApp den Schluessel an verknuepfte Geraete liefert, ist
     * ungeprueft. Bei "aus" schreibt der Ingest nur ein Ja/Nein-Protokoll (viewonce_probe).
     */
    storeViewOnce: boolean
    /** Groesstes Medium, das "Medium jetzt laden" noch holt (ueber die Regel-Grenzen hinaus). */
    forceMaxBytes: number
  }
  connection: {
    backoffStartMs: number
    backoffCapMs: number
    stableAfterMs: number
    commandPollMs: number
    /** Beim Start ohne gespeicherte Kopplung automatisch eine QR-Sitzung beginnen. */
    autoPairOnStart: boolean
  }
  /**
   * Profilbilder (avatars.ts). Ab Werk aus: Jede Abfrage ist eine Anfrage an WhatsApp (iq "w:profile:picture") plus ein
   * HTTPS-Abruf des Bildes. Mit `enabled` fragt der Ingest je Chat hoechstens einmal pro `intervalDays` nach, mit
   * `gapMs` Abstand zwischen zwei Abfragen und hoechstens `maxPerRound` Abfragen am Stueck.
   */
  profiles: {
    enabled: boolean
    intervalDays: number
    gapMs: number
    maxPerRound: number
  }
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Nur fuer die Testinstanz mit Zweitnummer (F07). */
  diagnostics: {
    /** Zaehlt die von der Bibliothek ausgehenden Knoten nach Art (siehe nodeCounter.ts). Ab Werk aus. */
    countOutgoingNodes: boolean
  }
}

const MB = 1024 * 1024

export function defaultConfig(): IngestConfig {
  return {
    paths: {
      db: '/var/lib/waread/db/waread.db',
      authDir: '/var/lib/waread/auth',
      mediaDir: '/var/lib/waread/media',
      tmpDir: '/var/lib/waread/tmp',
      stateDb: '/var/lib/waread/db/ingest-state.db',
    },
    retention: { messagesDays: 3, mediaDays: 3 },
    media: {
      maxConcurrentDownloads: 2,
      maxQueueLength: 500,
      maxRetries: 3,
      retryBaseMs: 30_000,
      retryCapMs: 15 * 60_000,
      stallTimeoutMs: 60_000,
      maxBytes: { image: 10 * MB, voice: 10 * MB, video: 50 * MB, document: 20 * MB },
      autoDownload: { image: true, voice: true, video: false, document: true },
      thumbnailShortSide: 200,
      convertVoice: true,
      ffmpegPath: 'ffmpeg',
      ffmpegTimeoutMs: 60_000,
      storeViewOnce: false,
      forceMaxBytes: 500 * MB,
    },
    connection: {
      backoffStartMs: 5_000,
      backoffCapMs: 10 * 60_000,
      // F05: 10 min. Mit 60 s setzte sich der Backoff nach jeder Minute offener Verbindung zurueck;
      // schloss der Server genau dann, entstanden bis zu 57 Verbindungsaufbauten je Stunde.
      stableAfterMs: 600_000,
      commandPollMs: 3_000,
      // F03: false. Eine QR-Sitzung beginnt nur auf ausdruecklichen Befehl ("Neu verbinden"), nicht bei jedem
      // Prozessstart (Neustart, Reboot, Update). Jede ungewollte Kopplungssitzung ist zusaetzlicher Verkehr.
      autoPairOnStart: false,
    },
    profiles: { enabled: false, intervalDays: 7, gapMs: 15_000, maxPerRound: 40 },
    logLevel: 'info',
    diagnostics: { countOutgoingNodes: false },
  }
}

type Table = Record<string, unknown>

function table(v: unknown): Table {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Table) : {}
}

function pickNum(t: Table, key: string, def: number, min: number, max: number): number {
  const v = t[key]
  if (v === undefined) return def
  const n = typeof v === 'bigint' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`config: Wert fuer "${key}" ungueltig (erwartet Zahl ${min}..${max})`)
  }
  return n
}

function pickBool(t: Table, key: string, def: boolean): boolean {
  const v = t[key]
  if (v === undefined) return def
  if (typeof v !== 'boolean') throw new Error(`config: Wert fuer "${key}" muss true/false sein`)
  return v
}

function pickStr(t: Table, key: string, def: string): string {
  const v = t[key]
  if (v === undefined) return def
  if (typeof v !== 'string' || v.length === 0) throw new Error(`config: Wert fuer "${key}" muss ein nichtleerer String sein`)
  return v
}

export interface LoadConfigOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  /** Testnaht: liefert den Dateiinhalt oder null, wenn die Datei nicht existiert. */
  loadText?: (p: string) => string | null
}

function defaultLoadText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Laedt /etc/waread/config.toml (oder WAREAD_CONFIG). Fehlt die Datei, gelten die Standardwerte
 * der Laufzeit-Zielstruktur. Gelesen werden die Abschnitte [paths], [retention] und [ingest].
 */
export function loadConfig(opts: LoadConfigOptions = {}): IngestConfig {
  const env = opts.env ?? process.env
  const file = opts.path ?? env.WAREAD_CONFIG ?? '/etc/waread/config.toml'
  const text = (opts.loadText ?? defaultLoadText)(file)
  const cfg = defaultConfig()
  if (text === null) return cfg

  let root: Table
  try {
    root = table(parseToml(text))
  } catch {
    // Parser-Fehlertext kann Dateiinhalt zitieren -> bewusst nicht weitergereicht.
    throw new Error('config: config.toml ist kein gueltiges TOML')
  }

  const paths = table(root.paths)
  cfg.paths.db = pickStr(paths, 'db', cfg.paths.db)
  cfg.paths.authDir = pickStr(paths, 'auth_dir', cfg.paths.authDir)
  cfg.paths.mediaDir = pickStr(paths, 'media_dir', cfg.paths.mediaDir)
  cfg.paths.tmpDir = pickStr(paths, 'tmp_dir', cfg.paths.tmpDir)
  cfg.paths.stateDb = path.join(path.dirname(cfg.paths.db), 'ingest-state.db')

  const retention = table(root.retention)
  cfg.retention.messagesDays = pickNum(retention, 'messages_days', cfg.retention.messagesDays, 1, 365)
  cfg.retention.mediaDays = pickNum(retention, 'media_days', cfg.retention.mediaDays, 1, 365)

  const ing = table(root.ingest)
  cfg.paths.stateDb = pickStr(ing, 'state_db', cfg.paths.stateDb)
  cfg.logLevel = pickStr(ing, 'log_level', cfg.logLevel) as IngestConfig['logLevel']
  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) {
    throw new Error('config: log_level muss debug|info|warn|error sein')
  }

  cfg.diagnostics.countOutgoingNodes = pickBool(ing, 'count_outgoing_nodes', cfg.diagnostics.countOutgoingNodes)

  const m = cfg.media
  m.maxConcurrentDownloads = pickNum(ing, 'max_concurrent_downloads', m.maxConcurrentDownloads, 1, 4)
  m.maxQueueLength = pickNum(ing, 'max_queue_length', m.maxQueueLength, 1, 10_000)
  m.maxRetries = pickNum(ing, 'max_retries', m.maxRetries, 0, 10)
  m.retryBaseMs = pickNum(ing, 'retry_base_seconds', m.retryBaseMs / 1000, 1, 3600) * 1000
  m.stallTimeoutMs = pickNum(ing, 'download_stall_timeout_seconds', m.stallTimeoutMs / 1000, 5, 600) * 1000
  for (const kind of ['image', 'voice', 'video', 'document'] as const) {
    m.maxBytes[kind] = Math.floor(pickNum(ing, `max_mb_${kind}`, m.maxBytes[kind] / MB, 0.1, 2048) * MB)
    m.autoDownload[kind] = pickBool(ing, `auto_download_${kind}`, m.autoDownload[kind])
  }
  m.thumbnailShortSide = pickNum(ing, 'thumbnail_short_side', m.thumbnailShortSide, 32, 1024)
  m.convertVoice = pickBool(ing, 'convert_voice', m.convertVoice)
  m.ffmpegPath = pickStr(ing, 'ffmpeg_path', m.ffmpegPath)
  m.ffmpegTimeoutMs = pickNum(ing, 'ffmpeg_timeout_seconds', m.ffmpegTimeoutMs / 1000, 5, 600) * 1000
  m.storeViewOnce = pickBool(ing, 'store_view_once', m.storeViewOnce)
  m.forceMaxBytes = Math.floor(pickNum(ing, 'max_mb_forced', m.forceMaxBytes / MB, 1, 2048) * MB)

  const pr = cfg.profiles
  pr.enabled = pickBool(ing, 'profile_pictures', pr.enabled)
  pr.intervalDays = pickNum(ing, 'profile_pictures_interval_days', pr.intervalDays, 1, 90)
  pr.gapMs = pickNum(ing, 'profile_pictures_gap_seconds', pr.gapMs / 1000, 3, 600) * 1000
  pr.maxPerRound = pickNum(ing, 'profile_pictures_max_per_round', pr.maxPerRound, 1, 500)

  const c = cfg.connection
  c.backoffStartMs = pickNum(ing, 'backoff_start_seconds', c.backoffStartMs / 1000, 1, 600) * 1000
  c.backoffCapMs = pickNum(ing, 'backoff_cap_seconds', c.backoffCapMs / 1000, 5, 3600) * 1000
  c.stableAfterMs = pickNum(ing, 'stable_after_seconds', c.stableAfterMs / 1000, 5, 3600) * 1000
  c.autoPairOnStart = pickBool(ing, 'auto_pair_on_start', c.autoPairOnStart)
  if (c.backoffCapMs < c.backoffStartMs) throw new Error('config: backoff_cap_seconds < backoff_start_seconds')

  return cfg
}
