/** Gemeinsame Zeit- und Fehlerhilfen (Backoff, Zeitgeber, Statuscodes). */

export interface BackoffOptions {
  startMs: number
  capMs: number
  /** Anteil, um den die Wartezeit zufaellig NACH UNTEN gestreut wird (0..1). Obergrenze bleibt exakt. */
  jitter?: number
}

/**
 * Exponentieller Backoff: Versuch 0 -> start, 1 -> 2*start, ... gedeckelt bei cap.
 * Jitter nur nach unten: die dokumentierten Grenzen (5 s Start, 10 min Obergrenze) werden nie ueberschritten.
 */
export function nextBackoffMs(attempt: number, opts: BackoffOptions, rng: () => number = Math.random): number {
  const jitter = opts.jitter ?? 0.2
  const exp = Math.min(opts.capMs, opts.startMs * 2 ** Math.max(0, attempt))
  return Math.round(exp * (1 - jitter * rng()))
}

/** Statuscode eines Boom-/HTTP-artigen Fehlers (Baileys wirft Boom mit output.statusCode). */
export function statusCodeOf(err: unknown): number | undefined {
  const e = err as { output?: { statusCode?: unknown }; statusCode?: unknown; status?: unknown } | null | undefined
  const v = e?.output?.statusCode ?? e?.statusCode ?? e?.status
  return typeof v === 'number' ? v : undefined
}

/** Zeitgeber (fuer Tests austauschbar). */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
}
