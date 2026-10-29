// Minimales JSON-Lines-Logging auf stdout (landet im systemd-Journal).
// Regel aus der Sicherheits-Baseline: NIE Nachrichtentexte, Bildunterschriften, Dateinamen oder
// Suchbegriffe loggen. Es gibt deshalb nur Ereignisname + primitive Felder (IDs, Codes, Zahlen).
// Fehlertexte werden bewusst nicht uebernommen (SQLite-/FTS-Fehlermeldungen koennen Suchbegriffe enthalten).

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(ev: string, fields?: Fields): void;
  info(ev: string, fields?: Fields): void;
  warn(ev: string, fields?: Fields): void;
  error(ev: string, fields?: Fields): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function clean(v: string | number | boolean | null | undefined): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.replace(/[\r\n\t]/g, ' ').slice(0, 200);
  return v;
}

export function createLogger(
  level: Level,
  write: (line: string) => void = (s) => {
    process.stdout.write(s);
  },
): Logger {
  const min = ORDER[level];
  const emit = (lvl: Level, ev: string, fields?: Fields): void => {
    if (ORDER[lvl] < min) return;
    const out: Record<string, unknown> = { lvl, ev };
    if (fields) for (const [k, v] of Object.entries(fields)) out[k] = clean(v);
    write(JSON.stringify(out) + '\n');
  };
  return {
    debug: (ev, f) => emit('debug', ev, f),
    info: (ev, f) => emit('info', ev, f),
    warn: (ev, f) => emit('warn', ev, f),
    error: (ev, f) => emit('error', ev, f),
  };
}

/** Nur Fehlername und -code, nie die Meldung. */
export function errFields(err: unknown): Fields {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { errName: err.name, errCode: typeof code === 'string' || typeof code === 'number' ? code : null };
  }
  return { errName: typeof err };
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
