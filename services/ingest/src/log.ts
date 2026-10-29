/**
 * Inhaltsfreies Logging (Sicherheits-Baseline): nur Ereignistyp, IDs, Zaehler, Fehlercodes.
 *
 * Schutzmechanismen:
 *  - Ereignisnamen muessen ^[a-z][a-z0-9_]{1,63}$ entsprechen (kein Freitext).
 *  - Felder mit verdaechtigen Namen (text, caption, name, path, ...) werden maskiert.
 *  - Fehler werden nur als Name/Code/Status geloggt, nie mit message (sie kann Inhalte enthalten,
 *    z. B. JSON-Parse-Fehler mit Textausschnitt).
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'
export type FieldValue = string | number | boolean | null | undefined
export type Fields = Record<string, FieldValue>

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const EVENT_RE = /^[a-z][a-z0-9_]{1,63}$/

/** Feldnamen, die nie im Journal erscheinen duerfen. Vergleich in Kleinbuchstaben. */
const REDACT_KEYS = new Set([
  'text',
  'body',
  'caption',
  'filename',
  'file_name',
  'name',
  'subject',
  'title',
  'sender',
  'push_name',
  'pushname',
  'content',
  'message',
  'msg',
  'path',
  'file_path',
  'url',
  'qr',
  'phone',
  'jid_name',
])

const MAX_STRING = 128

export interface Logger {
  debug(ev: string, fields?: Fields): void
  info(ev: string, fields?: Fields): void
  warn(ev: string, fields?: Fields): void
  error(ev: string, fields?: Fields): void
  child(base: Fields): Logger
}

export interface LoggerOptions {
  level?: Level
  /** Zeilen-Senke; Standard: stdout (landet im systemd-Journal). */
  write?: (line: string) => void
  base?: Fields
}

function sanitize(value: FieldValue): FieldValue {
  if (typeof value === 'string' && value.length > MAX_STRING) {
    return value.slice(0, MAX_STRING) + '...'
  }
  return value
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = RANK[opts.level ?? 'info']
  const write =
    opts.write ??
    ((line: string) => {
      process.stdout.write(line + '\n')
    })
  const base = opts.base ?? {}

  const emit = (level: Level, ev: string, fields?: Fields): void => {
    if (RANK[level] < min) return
    const record: Record<string, FieldValue> = {
      lvl: level,
      ev: EVENT_RE.test(ev) ? ev : 'invalid_event',
    }
    for (const src of [base, fields ?? {}]) {
      for (const [k, v] of Object.entries(src)) {
        record[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : sanitize(v)
      }
    }
    write(JSON.stringify(record))
  }

  return {
    debug: (ev, f) => emit('debug', ev, f),
    info: (ev, f) => emit('info', ev, f),
    warn: (ev, f) => emit('warn', ev, f),
    error: (ev, f) => emit('error', ev, f),
    child: (extra) => createLogger({ ...opts, base: { ...base, ...extra } }),
  }
}

/** Fehler -> loggbare Felder ohne message/stack. */
export function errorFields(err: unknown): Fields {
  const e = err as {
    name?: unknown
    code?: unknown
    statusCode?: unknown
    status?: unknown
    output?: { statusCode?: unknown }
  } | null
  if (!e || typeof e !== 'object') return { err_name: typeof err }
  const status = e.output?.statusCode ?? e.statusCode ?? e.status
  const out: Fields = { err_name: typeof e.name === 'string' ? e.name : 'Error' }
  if (typeof e.code === 'string' || typeof e.code === 'number') out.err_code = e.code
  if (typeof status === 'number') out.err_status = status
  return out
}
