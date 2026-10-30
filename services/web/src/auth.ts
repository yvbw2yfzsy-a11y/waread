// Authentifizierung: Argon2id-Passwortpruefung, signierte Session-Token, Login-Rate-Limit.
//
// Sicherheitsentscheidungen (kurz begruendet):
// - Es gibt genau ein Passwort (Einzelbenutzer-Heimnetz). Der Hash steht in der Konfiguration.
// - Die Argon2id-Pruefung laeuft ueber hash-wasm (WebAssembly, keine native Kompilierung auf dem Pi).
//   Sie wird lazy geladen. Fehlt das Paket oder ist der Hash kaputt, schlaegt der Login GESCHLOSSEN
//   fehl (503) - es gibt keinen Fallback und keinen Umgehungsweg.
// - Pruefungen laufen nacheinander (nie parallel) und mit begrenzter Warteschlange: Argon2 braucht
//   viel Speicher, parallele Logins koennten MemoryMax des Dienstes sprengen.
// - Sessions sind zustandslose HMAC-signierte Token. Der Signaturschluessel wird aus einem
//   persistierten Zufallsgeheimnis UND dem Passwort-Hash abgeleitet: Passwort aendern = alle
//   Sitzungen sind sofort ungueltig. Logout loescht nur das Cookie; ein gestohlenes Token bliebe bis
//   zum Ablauf gueltig (bewusst kein serverseitiger Session-Speicher).
// - Passkey-Sperre: Zusaetzlich fliesst eine "Sitzungsepoche" (siehe passkeys.ts) in den Schluessel ein.
//   Epoche 0 ergibt exakt den bisherigen Schluessel (bestehende Installationen bleiben unveraendert);
//   jede Aenderung der Sperre setzt eine neue Zufallsepoche und macht damit alle bisherigen Token ungueltig.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { errFields, type Logger } from './log.js';

export const COOKIE_NAME = 'waread_session';

export class AuthUnavailableError extends Error {
  constructor() {
    super('auth_unavailable');
    this.name = 'AuthUnavailableError';
  }
}

export class AuthBusyError extends Error {
  constructor() {
    super('auth_busy');
    this.name = 'AuthBusyError';
  }
}

// ---------- Passwortpruefung ----------

export type Verifier = (hash: string, password: string) => Promise<boolean>;

interface HashWasm {
  argon2Verify(o: { password: string; hash: string }): Promise<boolean>;
}

let hashWasm: HashWasm | null = null;

async function loadHashWasm(): Promise<HashWasm> {
  if (hashWasm) return hashWasm;
  try {
    const name = 'hash-wasm'; // Variable: kein Compile-Zeit-Import, Paket wird erst bei Bedarf geladen
    const mod = (await import(name)) as Partial<HashWasm> & { default?: Partial<HashWasm> };
    // UMD/CommonJS-Builds liefern ihre Namen beim ESM-Import teils nur unter "default".
    const api = typeof mod.argon2Verify === 'function' ? mod : mod.default;
    if (!api || typeof api.argon2Verify !== 'function') throw new AuthUnavailableError();
    hashWasm = api as HashWasm;
    return hashWasm;
  } catch {
    throw new AuthUnavailableError();
  }
}

export const argon2Verifier: Verifier = async (hash, password) => {
  const mod = await loadHashWasm();
  try {
    return (await mod.argon2Verify({ password, hash })) === true;
  } catch {
    // z. B. nicht lesbarer Hash in der Konfiguration -> Konfigurationsfehler, kein "falsches Passwort"
    throw new AuthUnavailableError();
  }
};

// ---------- Rate-Limit ----------

export class LoginLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Zaehlt den Versuch sofort (noch vor der Pruefung), damit parallele Versuche das Limit nicht umgehen. */
  hit(ip: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    if (this.hits.size > 1000) this.sweep(t);
    const arr = (this.hits.get(ip) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(ip, arr);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((arr[0]! + this.windowMs - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(ip, arr);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Nach erfolgreichem Login die Zaehlung dieser IP zuruecksetzen. */
  reset(ip: string): void {
    this.hits.delete(ip);
  }

  private sweep(t: number): void {
    for (const [ip, arr] of this.hits) {
      if (arr.every((x) => t - x >= this.windowMs)) this.hits.delete(ip);
    }
  }
}

// ---------- Sessions ----------

export function loadSessionSecret(file: string, log: Logger): Buffer {
  const read = (): Buffer | null => {
    try {
      const hex = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
      log.warn('session_secret_invalid');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('session_secret_unreadable', errFields(err));
    }
    return null;
  };

  const existing = read();
  if (existing) return existing;

  const secret = randomBytes(32);
  try {
    fs.writeFileSync(file, secret.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const again = read();
      if (again) return again;
    }
    // Nicht persistierbar: Sessions ueberleben dann keinen Neustart, funktionieren aber.
    log.warn('session_secret_not_persisted', errFields(err));
    return secret;
  }
}

export interface AuthOptions {
  passwordHash: string;
  secret: Buffer;
  sessionSeconds: number;
  verifier?: Verifier;
  maxPending?: number;
  now?: () => number;
  /** Aktuelle Sitzungsepoche (Passkey-Sperre). Ohne Angabe: 0 = bisheriges Verhalten. */
  epoch?: () => number;
}

export class Auth {
  private keyCache: { epoch: number; key: Buffer } | null = null;
  private readonly verifier: Verifier;
  private readonly maxPending: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly o: AuthOptions) {
    this.verifier = o.verifier ?? argon2Verifier;
    this.maxPending = o.maxPending ?? 4;
    this.now = o.now ?? Date.now;
  }

  get sessionSeconds(): number {
    return this.o.sessionSeconds;
  }

  /** Schluessel zur aktuellen Epoche. Epoche 0 = die urspruengliche Ableitung ("v1"). */
  private currentKey(): Buffer {
    const epoch = this.o.epoch ? this.o.epoch() : 0;
    if (this.keyCache && this.keyCache.epoch === epoch) return this.keyCache.key;
    const label = epoch === 0 ? 'waread-session-v1|' + this.o.passwordHash : `waread-session-v2|${this.o.passwordHash}|${epoch}`;
    const key = createHmac('sha256', this.o.secret).update(label).digest();
    this.keyCache = { epoch, key };
    return key;
  }

  /** `seconds` verkuerzt die Laufzeit (Passkey-Sitzungen); Standard ist web.session_days. */
  issueToken(seconds: number = this.o.sessionSeconds): string {
    const exp = Math.floor(this.now() / 1000) + seconds;
    const payload = `v1.${exp}.${randomBytes(12).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  isValidToken(token: string | undefined): boolean {
    if (!token || token.length > 200) return false;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isInteger(exp) || exp * 1000 <= this.now()) return false;
    const payload = parts.slice(0, 3).join('.');
    const given = Buffer.from(parts[3]!, 'base64url');
    const expected = Buffer.from(this.sign(payload), 'base64url');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Nacheinander abgearbeitet; bei zu langer Warteschlange AuthBusyError. */
  verifyPassword(password: string): Promise<boolean> {
    if (this.pending >= this.maxPending) return Promise.reject(new AuthBusyError());
    this.pending++;
    const run = this.chain.then(() => this.verifier(this.o.passwordHash, password));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending--;
    });
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.currentKey()).update(payload).digest('base64url');
  }
}
