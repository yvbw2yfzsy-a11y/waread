// Passkey-Sperre: Speicher (Datei), Challenges/Freigaben (Speicher), Ablauf der WebAuthn-Zeremonien.
//
// Modell (Einzelbenutzer):
// - Passkeys werden in einer eigenen Datei gehalten (web.passkey_file, Modus 0600), NICHT in waread.db:
//   Das Datenbankschema ist ein gemeinsamer Vertrag mit Ingest und Cleanup und bleibt unangetastet.
// - "Sperre aktiv" heisst: Anmeldung nur noch mit Passkey. Das Passwort wird dann nicht einmal geprueft.
// - Die Sperre wird erst aktiv, nachdem ein registrierter Passkey in genau dieser Sitzung bestaetigt wurde
//   (Freigabe "lock_on"). Ein nicht funktionierender Passkey sperrt dich so nicht aus.
// - Beim Aktivieren und Deaktivieren aendert sich die Sitzungsepoche: Alle bisherigen Sitzungstoken
//   (auch gestohlene Passwort-Sitzungen) werden ungueltig. Die Epoche steht in der Datei und fliesst in
//   den Signaturschluessel der Token ein (siehe auth.ts).
// - Fehlerverhalten: Existiert die Datei, ist aber unlesbar oder ungueltig, gilt die Sperre als aktiv und
//   ohne Passkeys (geschlossen). Notausstieg: CLI "passkey-admin" (siehe passkey-admin.ts).
// - Sensible Aenderungen bei aktiver Sperre (Passkey hinzufuegen/loeschen, Sperre aus) verlangen eine
//   frische Passkey-Bestaetigung ("Freigabe"): einmalig, 2 Minuten gueltig, an die Sitzung gebunden.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { LoginLimiter } from './auth.js';
import { HttpError } from './http.js';
import { errFields, type Logger } from './log.js';
import {
  type AssertionInput,
  assertionCredentialId,
  COSE_ES256,
  type RegistrationInput,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from './webauthn.js';

export const MAX_CREDENTIALS = 10;
export const MAX_LABEL = 40;

const CHALLENGE_TTL_MS = 180_000;
const GRANT_TTL_MS = 120_000;
const MAX_PENDING_CHALLENGES = 64;
const MAX_PENDING_GRANTS = 32;

export interface PasskeyRecord {
  id: string;
  publicKey: string;
  alg: typeof COSE_ES256;
  counter: number;
  backupEligible: boolean;
  backupState: boolean;
  aaguid: string;
  transports: string[];
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PasskeyState {
  version: 1;
  userHandle: string;
  lock: boolean;
  /** 0 = nie benutzt (Token wie bisher). Jede Aenderung der Sperre setzt eine neue Zufallszahl. */
  epoch: number;
  credentials: PasskeyRecord[];
}

const emptyState = (): PasskeyState => ({
  version: 1,
  userHandle: randomBytes(32).toString('base64url'),
  lock: false,
  epoch: 0,
  credentials: [],
});

/** Zustand bei unlesbarer Datei: gesperrt, keine Passkeys, Epoche, die kein Token je haben kann. */
const failClosedState = (): PasskeyState => ({ version: 1, userHandle: '', lock: true, epoch: -1, credentials: [] });

export function newEpoch(): number {
  return randomInt(1, 2 ** 48);
}

// ---------- Validierung der Datei ----------

const B64URL = /^[A-Za-z0-9_-]{1,2048}$/;

function isRecord(v: unknown): v is PasskeyRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' && B64URL.test(r['id']) &&
    typeof r['publicKey'] === 'string' && B64URL.test(r['publicKey']) &&
    r['alg'] === COSE_ES256 &&
    Number.isInteger(r['counter']) && (r['counter'] as number) >= 0 &&
    typeof r['backupEligible'] === 'boolean' &&
    typeof r['backupState'] === 'boolean' &&
    typeof r['aaguid'] === 'string' && /^[0-9a-f]{32}$/.test(r['aaguid']) &&
    Array.isArray(r['transports']) && (r['transports'] as unknown[]).every((t) => typeof t === 'string') &&
    typeof r['label'] === 'string' && (r['label'] as string).length <= MAX_LABEL &&
    Number.isInteger(r['createdAt']) &&
    (r['lastUsedAt'] === null || Number.isInteger(r['lastUsedAt']))
  );
}

export function parseState(text: string): PasskeyState {
  const v = JSON.parse(text) as unknown;
  if (typeof v !== 'object' || v === null) throw new Error('not an object');
  const s = v as Record<string, unknown>;
  if (s['version'] !== 1) throw new Error('version');
  if (typeof s['userHandle'] !== 'string' || !B64URL.test(s['userHandle'])) throw new Error('userHandle');
  if (typeof s['lock'] !== 'boolean') throw new Error('lock');
  if (!Number.isInteger(s['epoch']) || (s['epoch'] as number) < 0) throw new Error('epoch');
  if (!Array.isArray(s['credentials']) || s['credentials'].length > MAX_CREDENTIALS || !s['credentials'].every(isRecord)) {
    throw new Error('credentials');
  }
  const ids = new Set((s['credentials'] as PasskeyRecord[]).map((c) => c.id));
  if (ids.size !== s['credentials'].length) throw new Error('duplicate credential');
  if (s['lock'] === true && s['credentials'].length === 0) throw new Error('lock without credentials');
  return s as unknown as PasskeyState;
}

// ---------- Datei schreiben ----------

/** Atomar schreiben (temporaere Datei, fsync, rename). Optional Besitzer setzen (CLI als root). */
export function writeStateFile(file: string, state: PasskeyState, owner?: { uid: number; gid: number }): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (owner && typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(tmp, owner.uid, owner.gid);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* Verzeichnis-fsync ist nicht ueberall moeglich; die Datei selbst ist bereits geschrieben */
  }
}

// ---------- Speicher ----------

export class PasskeyStore {
  private current: PasskeyState = emptyState();
  private broken = false;
  private sig = '';
  private lastCheck = -Infinity;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly reloadIntervalMs = 1000,
  ) {
    this.reload();
  }

  get isBroken(): boolean {
    this.maybeReload();
    return this.broken;
  }

  state(): Readonly<PasskeyState> {
    this.maybeReload();
    return this.current;
  }

  private signature(): string {
    try {
      const st = fs.statSync(this.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error';
    }
  }

  private maybeReload(): void {
    const t = this.now();
    if (t - this.lastCheck < this.reloadIntervalMs) return;
    this.lastCheck = t;
    if (this.signature() !== this.sig) this.reload();
  }

  private reload(): void {
    this.lastCheck = this.now();
    this.sig = this.signature();
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Nie eingerichtet (oder per CLI entfernt): keine Sperre. Ein bestehender Zustand wird verworfen.
        this.current = emptyState();
        this.broken = false;
        return;
      }
      this.log.error('passkey_store_unreadable', errFields(err));
      this.current = failClosedState();
      this.broken = true;
      return;
    }
    try {
      this.current = parseState(text);
      this.broken = false;
    } catch {
      this.log.error('passkey_store_invalid');
      this.current = failClosedState();
      this.broken = true;
    }
  }

  /** Aenderung atomar anwenden: erst schreiben, dann uebernehmen. Wirft bei Fehler; Zustand bleibt dann unveraendert. */
  update(mutate: (s: PasskeyState) => void): void {
    this.maybeReload();
    if (this.broken) throw new HttpError(503, 'passkey_store_broken');
    const next = structuredClone(this.current) as PasskeyState;
    mutate(next);
    parseState(JSON.stringify(next)); // Vor dem Schreiben pruefen: nie eine ungueltige Datei hinterlassen
    writeStateFile(this.file, next);
    this.current = next;
    this.sig = this.signature();
    this.lastCheck = this.now();
  }
}

// ---------- Challenges und Freigaben ----------

export type StepPurpose = 'lock_on' | 'lock_off' | 'register' | 'delete';
export const STEP_PURPOSES: readonly StepPurpose[] = ['lock_on', 'lock_off', 'register', 'delete'];
type ChallengePurpose = 'login' | 'register' | `step:${StepPurpose}`;

interface PendingChallenge {
  challenge: Buffer;
  purpose: ChallengePurpose;
  expires: number;
}

interface PendingGrant {
  purpose: StepPurpose;
  sessionHash: string;
  expires: number;
}

const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface PasskeyServiceOptions {
  cfg: Config['web'];
  store: PasskeyStore;
  log: Logger;
  now?: () => number;
}

export class PasskeyService {
  readonly verifyLimiter: LoginLimiter;
  readonly optionsLimiter: LoginLimiter;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly grants = new Map<string, PendingGrant>();
  private readonly now: () => number;

  constructor(private readonly o: PasskeyServiceOptions) {
    this.now = o.now ?? Date.now;
    const windowMs = o.cfg.loginWindowMinutes * 60_000;
    this.verifyLimiter = new LoginLimiter(o.cfg.loginMaxAttempts, windowMs, this.now);
    this.optionsLimiter = new LoginLimiter(Math.max(30, o.cfg.loginMaxAttempts * 6), windowMs, this.now);
    if (o.store.state().lock && !this.configured) o.log.error('passkey_lock_without_config');
    if (o.store.isBroken) o.log.error('passkey_store_broken');
  }

  // ----- Zustand -----

  get configured(): boolean {
    return this.o.cfg.passkey !== null;
  }

  get rpId(): string | null {
    return this.o.cfg.passkey?.rpId ?? null;
  }

  get origin(): string | null {
    return this.o.cfg.passkey?.origin ?? null;
  }

  get lockActive(): boolean {
    return this.o.store.state().lock;
  }

  /** Sitzungsepoche fuer die Token-Signatur. */
  get epoch(): number {
    return this.o.store.state().epoch;
  }

  /** Passkey-Anmeldung ist moeglich (konfiguriert und mindestens ein Passkey). */
  get loginPossible(): boolean {
    return this.configured && this.o.store.state().credentials.length > 0;
  }

  get sessionSeconds(): number {
    return this.o.cfg.passkeySessionHours * 3600;
  }

  list(): { id: string; label: string; createdAt: number; lastUsedAt: number | null; backupEligible: boolean; backupState: boolean }[] {
    return this.o.store.state().credentials.map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      backupEligible: c.backupEligible,
      backupState: c.backupState,
    }));
  }

  private requireConfigured(): { rpId: string; origin: string } {
    const p = this.o.cfg.passkey;
    if (!p) throw new HttpError(409, 'passkey_not_configured');
    return p;
  }

  // ----- Challenges -----

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.challenges) if (v.expires <= t) this.challenges.delete(k);
    for (const [k, v] of this.grants) if (v.expires <= t) this.grants.delete(k);
  }

  private newChallenge(purpose: ChallengePurpose): { id: string; challenge: Buffer } {
    this.sweep();
    while (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.challenges.keys().next().value as string; // Map behaelt die Einfuegereihenfolge
      this.challenges.delete(oldest);
    }
    const id = randomBytes(18).toString('base64url');
    const challenge = randomBytes(32);
    this.challenges.set(id, { challenge, purpose, expires: this.now() + CHALLENGE_TTL_MS });
    return { id, challenge };
  }

  /** Einmalig: der Eintrag wird in jedem Fall entfernt, auch wenn er abgelaufen oder falsch ist. */
  private takeChallenge(id: unknown, accept: (p: ChallengePurpose) => boolean): PendingChallenge {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw new HttpError(400, 'invalid_body');
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    if (!c || c.expires <= this.now() || !accept(c.purpose)) throw new HttpError(400, 'challenge_expired');
    return c;
  }

  // ----- Optionen fuer den Browser -----

  private assertionOptions(challenge: Buffer): Record<string, unknown> {
    const { rpId } = this.requireConfigured();
    return {
      challenge: challenge.toString('base64url'),
      rpId,
      timeout: 120_000,
      userVerification: 'required',
      allowCredentials: [], // auffindbare Passkeys: Das Geraet zeigt seine eigenen an, nichts wird vorab verraten
    };
  }

  loginOptions(): { challengeId: string; options: Record<string, unknown> } {
    this.requireConfigured();
    if (!this.loginPossible) throw new HttpError(409, 'passkey_unavailable');
    const c = this.newChallenge('login');
    return { challengeId: c.id, options: this.assertionOptions(c.challenge) };
  }

  stepOptions(purpose: StepPurpose): { challengeId: string; options: Record<string, unknown> } {
    this.requireConfigured();
    if (this.o.store.state().credentials.length === 0) throw new HttpError(409, 'passkey_unavailable');
    const c = this.newChallenge(`step:${purpose}`);
    return { challengeId: c.id, options: this.assertionOptions(c.challenge) };
  }

  registerOptions(): { challengeId: string; options: Record<string, unknown> } {
    const { rpId } = this.requireConfigured();
    const st = this.o.store.state();
    if (this.o.store.isBroken) throw new HttpError(503, 'passkey_store_broken');
    if (st.credentials.length >= MAX_CREDENTIALS) throw new HttpError(409, 'too_many_passkeys');
    const c = this.newChallenge('register');
    return {
      challengeId: c.id,
      options: {
        rp: { id: rpId, name: 'waread' },
        user: { id: st.userHandle, name: 'waread', displayName: 'waread' },
        challenge: c.challenge.toString('base64url'),
        pubKeyCredParams: [{ type: 'public-key', alg: COSE_ES256 }],
        timeout: 180_000,
        excludeCredentials: st.credentials.map((k) => ({
          type: 'public-key',
          id: k.id,
          ...(k.transports.length ? { transports: k.transports } : {}),
        })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
      },
    };
  }

  // ----- Pruefung -----

  private assertion(purposeOk: (p: ChallengePurpose) => boolean, challengeId: unknown, credential: unknown): { record: PasskeyRecord; purpose: ChallengePurpose } {
    const { rpId, origin } = this.requireConfigured();
    const pending = this.takeChallenge(challengeId, purposeOk);
    if (typeof credential !== 'object' || credential === null) throw new HttpError(400, 'invalid_body');
    const input = credential as AssertionInput;
    let record: PasskeyRecord | undefined;
    try {
      const id = assertionCredentialId(input);
      record = this.o.store.state().credentials.find((k) => k.id === id);
      if (!record) throw new WebAuthnError('unknown_credential');
      const res = verifyAssertion(input, record, { challenge: pending.challenge, origin, rpId });
      const rec = record;
      try {
        this.o.store.update((s) => {
          const r = s.credentials.find((k) => k.id === rec.id);
          if (r) {
            r.counter = res.counter;
            r.backupState = res.backupState;
            r.lastUsedAt = Math.floor(this.now() / 1000);
          }
        });
      } catch (err) {
        // Die Anmeldung selbst ist gueltig; nur die Buchfuehrung (Zaehler, Zeitstempel) scheiterte.
        this.o.log.warn('passkey_counter_not_saved', errFields(err));
      }
    } catch (err) {
      if (err instanceof WebAuthnError) {
        this.o.log.info('passkey_assertion_failed', { reason: err.code });
        throw new HttpError(401, 'invalid_credentials');
      }
      throw err;
    }
    return { record, purpose: pending.purpose };
  }

  /** Anmeldung mit Passkey. Erfolg = Aufrufer stellt die Sitzung aus. */
  verifyLogin(challengeId: unknown, credential: unknown): void {
    this.assertion((p) => p === 'login', challengeId, credential);
  }

  /** Frische Bestaetigung fuer eine sensible Aenderung. Gibt eine einmalige Freigabe zurueck. */
  verifyStep(challengeId: unknown, credential: unknown, sessionToken: string | undefined): { grant: string; expiresInSeconds: number } {
    let purpose: ChallengePurpose;
    try {
      purpose = this.assertion((p) => p.startsWith('step:'), challengeId, credential).purpose;
    } catch (err) {
      // Die Sitzung ist gueltig, nur der Nachweis misslang: 403 statt 401 (401 heisst fuer den Client "abgemeldet").
      if (err instanceof HttpError && err.status === 401) throw new HttpError(403, err.code);
      throw err;
    }
    this.sweep();
    while (this.grants.size >= MAX_PENDING_GRANTS) this.grants.delete(this.grants.keys().next().value as string);
    const id = randomBytes(18).toString('base64url');
    this.grants.set(id, {
      purpose: purpose.slice('step:'.length) as StepPurpose,
      sessionHash: hashOf(sessionToken ?? ''),
      expires: this.now() + GRANT_TTL_MS,
    });
    return { grant: id, expiresInSeconds: GRANT_TTL_MS / 1000 };
  }

  /** Verbraucht die Freigabe (einmalig), wenn Zweck und Sitzung passen. */
  consumeGrant(grant: unknown, purpose: StepPurpose, sessionToken: string | undefined): void {
    const fail = (): never => {
      throw new HttpError(403, 'step_up_required');
    };
    if (typeof grant !== 'string' || grant.length === 0 || grant.length > 64) return fail();
    const g = this.grants.get(grant);
    this.grants.delete(grant);
    if (!g || g.expires <= this.now() || g.purpose !== purpose || g.sessionHash !== hashOf(sessionToken ?? '')) return fail();
  }

  // ----- Aenderungen -----

  register(challengeId: unknown, credential: unknown, label: unknown): void {
    const { rpId, origin } = this.requireConfigured();
    const pending = this.takeChallenge(challengeId, (p) => p === 'register');
    if (typeof credential !== 'object' || credential === null) throw new HttpError(400, 'invalid_body');
    let name = typeof label === 'string' ? label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (name.length > MAX_LABEL) name = name.slice(0, MAX_LABEL);
    if (name === '') name = `Passkey ${new Date(this.now()).toISOString().slice(0, 10)}`;
    let reg;
    try {
      reg = verifyRegistration(credential as RegistrationInput, { challenge: pending.challenge, origin, rpId });
    } catch (err) {
      if (err instanceof WebAuthnError) {
        this.o.log.info('passkey_registration_failed', { reason: err.code });
        throw new HttpError(400, 'invalid_credential');
      }
      throw err;
    }
    this.o.store.update((s) => {
      if (s.credentials.length >= MAX_CREDENTIALS) throw new HttpError(409, 'too_many_passkeys');
      if (s.credentials.some((k) => k.id === reg.id)) throw new HttpError(409, 'passkey_exists');
      s.credentials.push({
        ...reg,
        label: name,
        createdAt: Math.floor(this.now() / 1000),
        lastUsedAt: null,
      });
    });
    this.o.log.info('passkey_registered');
  }

  /** Sperre ein- oder ausschalten. Setzt eine neue Sitzungsepoche (alle bisherigen Token verfallen). */
  setLock(on: boolean): void {
    this.o.store.update((s) => {
      if (on && s.credentials.length === 0) throw new HttpError(409, 'passkey_unavailable');
      s.lock = on;
      s.epoch = newEpoch();
    });
    this.o.log.info(on ? 'passkey_lock_on' : 'passkey_lock_off');
  }

  remove(id: unknown): void {
    if (typeof id !== 'string' || !B64URL.test(id)) throw new HttpError(400, 'invalid_body');
    this.o.store.update((s) => {
      const i = s.credentials.findIndex((k) => k.id === id);
      if (i < 0) throw new HttpError(404, 'passkey_not_found');
      if (s.lock && s.credentials.length === 1) throw new HttpError(409, 'last_passkey_while_locked');
      s.credentials.splice(i, 1);
    });
    this.o.log.info('passkey_removed');
  }
}

// ---------- Notausstieg (CLI) ----------

function ownerOf(file: string): { uid: number; gid: number } | undefined {
  for (const p of [file, path.dirname(file)]) {
    try {
      const st = fs.statSync(p);
      return { uid: st.uid, gid: st.gid };
    } catch {
      /* naechster Kandidat */
    }
  }
  return undefined;
}

export interface AdminStatus {
  exists: boolean;
  valid: boolean;
  lock: boolean;
  credentials: number;
}

export function adminStatus(file: string): AdminStatus {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, valid: true, lock: false, credentials: 0 };
    return { exists: true, valid: false, lock: true, credentials: 0 };
  }
  try {
    const s = parseState(text);
    return { exists: true, valid: true, lock: s.lock, credentials: s.credentials.length };
  } catch {
    return { exists: true, valid: false, lock: true, credentials: 0 };
  }
}

/** Sperre aus, Passkeys bleiben. Alle Sitzungen verfallen. Ist die Datei ungueltig, wird sie als .broken beiseitegelegt. */
export function adminUnlock(file: string): void {
  const owner = ownerOf(file);
  let state: PasskeyState;
  try {
    state = parseState(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') state = emptyState();
    else {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
      state = emptyState();
    }
  }
  state.lock = false;
  state.epoch = newEpoch();
  writeStateFile(file, state, owner);
}

/** Alles zuruecksetzen: keine Passkeys, keine Sperre, neue Sitzungsepoche. Das Benutzer-Handle bleibt erhalten,
 *  damit ein neu angelegter Passkey den alten Eintrag auf dem Geraet ersetzt statt ihn zu verdoppeln. */
export function adminReset(file: string): void {
  const owner = ownerOf(file);
  const state = emptyState();
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8')) as { userHandle?: unknown };
    if (typeof old.userHandle === 'string' && B64URL.test(old.userHandle)) state.userHandle = old.userHandle;
  } catch {
    /* keine oder unlesbare Datei: neues Handle */
  }
  state.epoch = newEpoch();
  writeStateFile(file, state, owner);
}
