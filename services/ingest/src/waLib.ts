/**
 * EINZIGE Stelle, die die WhatsApp-Bibliothek (Baileys) laedt und benutzt.
 *
 * Die Huelle ("enge Huelle um die Bibliothek", Konzept):
 *   - Nach aussen gibt es nur `WaSocket` mit drei Faehigkeiten: Ereignisse abonnieren (`ev.on` / `ev.off`), die
 *     Verbindung beenden (`end`) und die Profilbild-Adresse eines Chats erfragen (`profilePicture`). Letzteres ist die
 *     einzige Anfrage an WhatsApp, die die Huelle durchreicht; avatars.ts nutzt sie nur mit `profile_pictures = true`.
 *   - Das rohe Baileys-Socket-Objekt verlaesst dieses Modul nie. Methoden zum Senden,
 *     Lesebestaetigen, Presence usw. sind fuer den Rest des Codes deshalb nicht erreichbar.
 *   - Medien werden ueber `downloadMedia` geladen (HTTP-Abruf des verschluesselten Blobs +
 *     lokale Entschluesselung); dabei wird nichts an WhatsApp gesendet. Die Wiederhol-Anfrage an
 *     das Telefon (reuploadRequest) wird bewusst NICHT angebunden.
 *
 * Quellenstand der Schnittstellen: WhiskeySockets/Baileys, Commit 81345be (7.0.0-rc14), Dateien
 * src/Socket/*.ts, src/Utils/{auth-utils,generics,messages-media,use-multi-file-auth-state}.ts.
 * ACHTUNG: Gegen die installierte Bibliothek wurde NICHT gebaut (Registry in der Entwicklungs-
 * umgebung gesperrt). `loadWaLib` prueft deshalb zur Laufzeit, ob alle benoetigten Exporte da sind.
 */
import type { Readable } from 'node:stream'
import type { Logger } from './log.js'
import type { NodeCounter } from './nodeCounter.js'

export interface WaEvents {
  on(event: string, handler: (arg: any) => void): void
  off(event: string, handler: (arg: any) => void): void
}

/** Das gesamte, nach aussen sichtbare Socket-Interface. */
export interface WaSocket {
  readonly ev: WaEvents
  /** Verbindung lokal beenden (KEIN Abmelden am Konto). */
  end(error?: Error): void | Promise<void>
  /**
   * Adresse des Profilbilds (gross, "image") eines Kontakts oder einer Gruppe. Sendet eine Abfrage an WhatsApp
   * (iq type=get, xmlns w:profile:picture), wie WhatsApp Web sie fuer Profilbilder stellt. null: kein Bild oder fuer
   * dieses Konto nicht sichtbar (Fehlercode 401 oder 404; die beiden Faelle lassen sich nicht weiter unterscheiden).
   */
  profilePicture(jid: string): Promise<string | null>
}

export interface SignalKeyStoreLike {
  get(type: string, ids: string[]): any
  set(data: Record<string, Record<string, unknown>>): any
  clear?(): any
}

export interface AuthStateLike {
  creds: any
  keys: SignalKeyStoreLike
}

export interface DownloadTarget {
  mediaKey: Uint8Array
  directPath: string | null
  url: string | null
  hkdfType: string
}

/**
 * F01: Das Ziel eines Medien-Downloads stammt aus der Nachricht des Absenders (Ende-zu-Ende-verschluesselt, der
 * Server prueft es nicht). Die Bibliothek ruft es ohne eigene Pruefung ab: aus `url` nimmt sie den Host, mit `directPath`
 * baut sie `https://<Host><directPath>`, ohne `directPath` nimmt sie `url` unveraendert (auch http). Ohne Pruefung
 * ruft der Pi so einen vom Absender gewaehlten Host ab (Heimnetz, Offenlegung der Adresse).
 * Erlaubt wird nur: https, Host unter whatsapp.net, kein Port, keine Zugangsdaten in der URL, directPath als
 * einfacher Pfad. Welche Hosts WhatsApp heute ausser *.whatsapp.net nutzt, ist UNBEKANNT; Abweisungen werden
 * (ohne URL) mit dem Code `bad_target` gemeldet, damit ein legitimer weiterer Host auffaellt.
 * Rest: Weiterleitungen eines WhatsApp-Hosts folgt die Bibliothek (keine `redirect`-Option durchreichbar).
 */
export class DownloadTargetError extends Error {
  readonly code = 'bad_target'
  constructor(readonly reason: string) {
    super(`bad_target:${reason}`)
    this.name = 'DownloadTargetError'
  }
}

const MEDIA_HOST_SUFFIX = '.whatsapp.net'

function rejectTarget(reason: string): never {
  throw new DownloadTargetError(reason)
}

function checkMediaUrl(value: string): void {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return rejectTarget('url_unparsable')
  }
  if (u.protocol !== 'https:') rejectTarget('url_scheme')
  if (u.username !== '' || u.password !== '') rejectTarget('url_userinfo')
  if (u.port !== '') rejectTarget('url_port')
  const host = u.hostname.toLowerCase()
  if (!host.endsWith(MEDIA_HOST_SUFFIX) || host.length === MEDIA_HOST_SUFFIX.length) rejectTarget('url_host')
}

/** Nur druckbares ASCII ohne Leerzeichen, beginnt mit "/", kein "@" (Userinfo-Trick) und kein "\\". */
const DIRECT_PATH_OK = /^\/[\x21-\x7e]*$/

function checkDirectPath(p: string): void {
  if (!DIRECT_PATH_OK.test(p) || p.includes('@') || p.includes('\\')) rejectTarget('direct_path')
}

/** Wirft `DownloadTargetError`, wenn das Ziel nicht abgerufen werden darf. */
export function checkDownloadTarget(t: DownloadTarget): void {
  if (t.url) checkMediaUrl(t.url)
  if (t.directPath) checkDirectPath(t.directPath)
}

/** Die vom Auth-Speicher benoetigten Teile der Bibliothek. */
export interface AuthLib {
  initAuthCreds(): any
  BufferJSON: { replacer: (k: string, v: any) => any; reviver: (k: string, v: any) => any }
  reviveAppStateSyncKey(obj: unknown): unknown
}

export interface WaLib extends AuthLib {
  createSocket(opts: { auth: AuthStateLike }): WaSocket
  downloadMedia(target: DownloadTarget): Promise<Readable>
  /** Laedt ein Profilbild von der Adresse aus `profilePicture` (HTTPS, nur *.whatsapp.net, ohne Weiterleitung). */
  downloadProfilePicture(url: string): Promise<Buffer>
  /**
   * Liest die Bytes einer WhatsApp-Nachricht (protobuf proto.Message). Rein lokal, ohne Netzwerk. Gebraucht fuer
   * verschluesselte Bearbeitungen: Nach der Entschluesselung (secretEdit.ts) liegt der neue Inhalt als solche Bytes vor.
   */
  decodeMessage(bytes: Uint8Array): unknown
}

/** Obergrenze je Profilbild-Datei (Schutz vor Missbrauch). Wie gross WhatsApps Bilder tatsaechlich sind, ist hier nicht gemessen. */
export const PROFILE_PICTURE_MAX_BYTES = 2 * 1024 * 1024
const PROFILE_PICTURE_TIMEOUT_MS = 20_000

/** pino-kompatible Minimalschnittstelle, wie Baileys sie erwartet (ILogger, src/Utils/logger.ts). */
export interface LibLogger {
  level: string
  child(obj: Record<string, unknown>): LibLogger
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

/**
 * Logger fuer die Bibliothek: verwirft alle Objekte (koennen Nummern, Namen, Knoteninhalte
 * enthalten) und gibt nur Warnungen/Fehler als statischen Text weiter.
 *
 * F07: Nur wenn ausdruecklich ein `counter` uebergeben wird (Testinstanz), steht die Stufe auf "trace". Die Bibliothek
 * erzeugt die Textdarstellung ausgehender Knoten nur bei dieser Stufe (Baileys 7.0.0-rc14, Socket/socket.ts:160-161,
 * Aufruf `logger.trace({ xml, msg: 'xml send' })`). Der Zaehler bekommt nur diese Eintraege und behaelt davon nur die Art
 * des Knotens; geloggt oder weitergegeben wird nichts. Frames, die nicht ueber diesen Pfad laufen (Verbindungsaufbau,
 * Keepalive-Rohframes), zaehlt er nicht.
 */
export function createLibLogger(log: Logger, counter?: NodeCounter): LibLogger {
  const textOf = (a: unknown, b: unknown): string => {
    const s = typeof b === 'string' ? b : typeof a === 'string' ? a : ''
    return s.slice(0, 120)
  }
  const self: LibLogger = {
    level: counter ? 'trace' : 'warn',
    child: () => self,
    trace: (a) => {
      if (!counter || typeof a !== 'object' || a === null) return
      const entry = a as { msg?: unknown; xml?: unknown }
      if (entry.msg === 'xml send') counter.record(entry.xml)
    },
    debug: () => {},
    info: () => {},
    warn: (a, b) => log.warn('lib_warn', { note: textOf(a, b) }),
    error: (a, b) => log.error('lib_error', { note: textOf(a, b) }),
  }
  return self
}

/**
 * Moegliche npm-Namen der Bibliothek. Der Quellbaum, gegen den dies geschrieben wurde (Commit 81345be),
 * nennt sich in seiner package.json "baileys"; "@whiskeysockets/baileys" ist der Name, den ich aus der Erinnerung
 * kenne (NICHT geprueft).
 * Welcher Name zur installierten Version passt, konnte hier NICHT gegen die Registry geprueft werden
 * (Registry gesperrt) - deshalb werden beide der Reihe nach versucht.
 */
const BAILEYS_SPECIFIERS = ['baileys', '@whiskeysockets/baileys'] as const

export type ModuleImporter = (specifier: string) => Promise<any>

const defaultImporter: ModuleImporter = (specifier) => import(specifier)

async function importBaileys(importer: ModuleImporter): Promise<any> {
  let notFound: unknown
  for (const spec of BAILEYS_SPECIFIERS) {
    try {
      return await importer(spec)
    } catch (err) {
      const e = err as { code?: string; message?: string }
      // Nur weiterprobieren, wenn genau dieses Paket fehlt - nicht, wenn eine seiner Abhaengigkeiten fehlt.
      const missingThis = e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message ?? '').includes(`'${spec}'`)
      if (!missingThis) throw err
      notFound = err
    }
  }
  throw notFound
}

const REQUIRED_EXPORTS = [
  'makeWASocket',
  'initAuthCreds',
  'BufferJSON',
  'proto',
  'makeCacheableSignalKeyStore',
  'downloadContentFromMessage',
  'Browsers',
] as const

/**
 * Laedt Baileys dynamisch (kein Compile-Zeit-Bezug auf das Paket) und baut die Huelle. Fehlende Exporte fuehren zu einem klaren Startfehler statt zu einem Fehlverhalten.
 */
export async function loadWaLib(log: Logger, importer: ModuleImporter = defaultImporter, counter?: NodeCounter): Promise<WaLib> {
  const mod: any = await importBaileys(importer)
  const pick = (name: string): any => mod[name] ?? mod.default?.[name]
  const makeWASocket: any = pick('makeWASocket') ?? (typeof mod.default === 'function' ? mod.default : undefined)

  const missing = REQUIRED_EXPORTS.filter((n) => (n === 'makeWASocket' ? !makeWASocket : pick(n) === undefined))
  if (missing.length > 0) {
    throw new Error(`Baileys-API passt nicht zur Erwartung, fehlende Exporte: ${missing.join(', ')}`)
  }
  const proto = pick('proto')
  const libLogger = createLibLogger(log, counter)

  return {
    initAuthCreds: pick('initAuthCreds'),
    BufferJSON: pick('BufferJSON'),
    reviveAppStateSyncKey: (obj) => proto.Message.AppStateSyncKeyData.fromObject(obj),
    decodeMessage: (bytes) => proto.Message.decode(bytes),

    createSocket({ auth }) {
      const raw = makeWASocket({
        auth: { creds: auth.creds, keys: pick('makeCacheableSignalKeyStore')(auth.keys, libLogger) },
        logger: libLogger,
        browser: pick('Browsers').ubuntu('Chrome'),
        // Kein "online" melden. HINWEIS: Die Bibliothek sendet beim Oeffnen trotzdem selbst
        // eine Presence "unavailable" (chats.ts, connection.update open) - nicht abschaltbar.
        markOnlineOnConnect: false,
        // Nur den von WhatsApp ohnehin gelieferten Kurzverlauf; mehr wird verworfen.
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        // Empfangsdienst: es gibt nichts erneut zu senden.
        getMessage: async () => undefined,
      })
      const shell: WaSocket = {
        ev: {
          on: (event, handler) => raw.ev.on(event, handler),
          off: (event, handler) => raw.ev.off(event, handler),
        },
        end: (error) => raw.end(error),
        profilePicture: async (jid) => {
          try {
            const url = await raw.profilePictureUrl(jid, 'image', PROFILE_PICTURE_TIMEOUT_MS)
            return typeof url === 'string' && url !== '' ? url : null
          } catch (err) {
            // Boom aus assertNodeErrorFree: data = Fehlercode der Antwort (401 nicht sichtbar, 404 kein Bild).
            const code = (err as { data?: unknown } | null)?.data
            if (code === 401 || code === 404) return null
            throw err
          }
        },
      }
      return shell
    },

    async downloadProfilePicture(url) {
      checkMediaUrl(url)
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(PROFILE_PICTURE_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`profile_picture_http_${res.status}`)
      const declared = Number(res.headers.get('content-length') ?? '0')
      if (declared > PROFILE_PICTURE_MAX_BYTES) throw new Error('profile_picture_too_large')
      // Stueckweise lesen und bei Ueberschreitung abbrechen: ohne Content-Length landet sonst alles im Speicher.
      const chunks: Buffer[] = []
      let total = 0
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.byteLength
          if (total > PROFILE_PICTURE_MAX_BYTES) throw new Error('profile_picture_too_large')
          chunks.push(Buffer.from(chunk))
        }
      }
      return Buffer.concat(chunks)
    },

    async downloadMedia(target) {
      checkDownloadTarget(target)
      return pick('downloadContentFromMessage')(
        {
          mediaKey: target.mediaKey,
          directPath: target.directPath ?? undefined,
          url: target.url ?? undefined,
        },
        target.hkdfType,
      )
    },
  }
}
