import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import type { Level } from './log.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  web: {
    /** Pflicht. Der Dienst lauscht immer nur auf 127.0.0.1. */
    port: number;
    /** Argon2id-Hash im PHC-Format ($argon2id$...). */
    passwordHash: string;
    sessionDays: number;
    sessionSecretFile: string;
    /** Pfad-Attribut des Session-Cookies; hinter Nginx z. B. "/waread/". */
    cookiePath: string;
    /** 'auto' = Secure, wenn die Anfrage ueber HTTPS kam (X-Forwarded-Proto vom lokalen Nginx). */
    cookieSecure: 'auto' | boolean;
    loginMaxAttempts: number;
    loginWindowMinutes: number;
    /** Optional: Origin-Header bei schreibenden Anfragen gegen Host pruefen (Nginx muss Host durchreichen). */
    checkOrigin: boolean;
    /** Inhalt geloeschter Nachrichten (Text, Medien) nicht ausliefern. */
    hideDeletedContent: boolean;
    publicDir: string;
    logLevel: Level;
    maxSseClients: number;
    /** Passkey-Sperre: nur wenn beide Werte gesetzt sind, sonst null (Funktion aus). */
    passkey: { rpId: string; origin: string } | null;
    /** Ablage der Passkeys (Modus 0600, vom Dienstbenutzer beschreibbar). */
    passkeyFile: string;
    /** Laufzeit einer Sitzung, die per Passkey angemeldet wurde. */
    passkeySessionHours: number;
  };
  paths: {
    db: string;
    mediaDir: string;
    /** Optional: Pfad zum DB-Modul (db/client). Leer = Standardsuche (siehe db.ts). */
    dbModule: string | undefined;
  };
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function table(root: Table, key: string): Table {
  const v = root[key];
  if (v === undefined) return {};
  if (!isTable(v)) throw new ConfigError(`[${key}] muss eine Tabelle sein`);
  return v;
}

function optStr(t: Table, section: string, key: string, def: string): string {
  const v = t[key];
  if (v === undefined) return def;
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${section}.${key} muss ein nicht leerer String sein`);
  return v;
}

function optInt(t: Table, section: string, key: string, def: number, min: number, max: number): number {
  const v = t[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${section}.${key} muss eine ganze Zahl zwischen ${min} und ${max} sein`);
  }
  return v;
}

function optBool(t: Table, section: string, key: string, def: boolean): boolean {
  const v = t[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new ConfigError(`${section}.${key} muss true oder false sein`);
  return v;
}

/** Standard fuer public/: <Paketwurzel>/public, ausgehend von dist/ (dist/config.js -> ../public). */
function defaultPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../public/dist'); // gebautes Frontend (services/web/public/dist)
}

/**
 * WebAuthn verlangt einen Host-Namen als RP-ID (keine IP-Adresse) und einen sicheren Kontext (HTTPS,
 * Ausnahme localhost). Origin muss exakt so lauten, wie ihn der Browser meldet (Schema + Host [+ Port]).
 */
function passkeyConfig(rpId: unknown, origin: unknown): { rpId: string; origin: string } | null {
  if (rpId === undefined && origin === undefined) return null;
  if (rpId === undefined || origin === undefined) {
    throw new ConfigError('web.passkey_rp_id und web.passkey_origin muessen zusammen gesetzt werden');
  }
  if (typeof rpId !== 'string' || typeof origin !== 'string') {
    throw new ConfigError('web.passkey_rp_id und web.passkey_origin muessen Strings sein');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(rpId) || /^[0-9.]+$/.test(rpId)) {
    throw new ConfigError('web.passkey_rp_id muss ein Host-Name in Kleinbuchstaben sein (keine IP-Adresse, kein Schema, kein Port)');
  }
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new ConfigError('web.passkey_origin ist keine gueltige URL');
  }
  if (u.origin !== origin) {
    throw new ConfigError('web.passkey_origin muss genau der Origin sein (Schema://Host[:Port], ohne Pfad und ohne Schraegstrich am Ende)');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) {
    throw new ConfigError('web.passkey_origin muss mit https:// beginnen (WebAuthn verlangt einen sicheren Kontext; nur localhost darf http sein)');
  }
  if (u.hostname !== rpId && !u.hostname.endsWith('.' + rpId)) {
    throw new ConfigError('web.passkey_rp_id muss der Host von web.passkey_origin oder ein uebergeordneter Domain-Name sein');
  }
  return { rpId, origin };
}

export function buildConfig(raw: Table, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): Config {
  const web = table(raw, 'web');
  const paths = table(raw, 'paths');

  if (web['port'] === undefined) throw new ConfigError('web.port fehlt (muss zum Nginx-Eintrag passen)');
  const port = optInt(web, 'web', 'port', 0, 1024, 65535);

  const inline = web['password_hash'];
  const file = web['password_hash_file'];
  if ((inline === undefined) === (file === undefined)) {
    throw new ConfigError('Genau eines von web.password_hash oder web.password_hash_file muss gesetzt sein');
  }
  let passwordHash: string;
  if (inline !== undefined) {
    if (typeof inline !== 'string') throw new ConfigError('web.password_hash muss ein String sein');
    passwordHash = inline.trim();
  } else {
    if (typeof file !== 'string' || file === '') throw new ConfigError('web.password_hash_file muss ein Pfad sein');
    try {
      passwordHash = readFile(file).trim();
    } catch {
      throw new ConfigError('web.password_hash_file nicht lesbar');
    }
  }
  if (!passwordHash.startsWith('$argon2id$')) {
    throw new ConfigError('Passwort-Hash muss ein Argon2id-Hash im PHC-Format sein ($argon2id$...)');
  }

  const cookiePath = optStr(web, 'web', 'cookie_path', '/');
  if (!/^\/[\x21-\x3a\x3c-\x7e]*$/.test(cookiePath)) {
    throw new ConfigError('web.cookie_path enthaelt unzulaessige Zeichen');
  }

  let cookieSecure: 'auto' | boolean = 'auto';
  const cs = web['cookie_secure'];
  if (cs !== undefined) {
    if (cs === 'auto' || typeof cs === 'boolean') cookieSecure = cs;
    else throw new ConfigError('web.cookie_secure muss "auto", true oder false sein');
  }

  const level = optStr(web, 'web', 'log_level', 'info');
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
    throw new ConfigError('web.log_level muss debug, info, warn oder error sein');
  }

  return {
    web: {
      port,
      passwordHash,
      sessionDays: optInt(web, 'web', 'session_days', 30, 1, 365),
      sessionSecretFile: optStr(web, 'web', 'session_secret_file', '/var/lib/waread/session.key'),
      cookiePath,
      cookieSecure,
      loginMaxAttempts: optInt(web, 'web', 'login_max_attempts', 5, 1, 100),
      loginWindowMinutes: optInt(web, 'web', 'login_window_minutes', 15, 1, 1440),
      checkOrigin: optBool(web, 'web', 'check_origin', false),
      hideDeletedContent: optBool(web, 'web', 'hide_deleted_content', true),
      publicDir: optStr(web, 'web', 'public_dir', defaultPublicDir()),
      logLevel: level,
      maxSseClients: optInt(web, 'web', 'max_sse_clients', 16, 1, 256),
      passkey: passkeyConfig(web['passkey_rp_id'], web['passkey_origin']),
      passkeyFile: optStr(web, 'web', 'passkey_file', '/var/lib/waread/passkeys.json'),
      passkeySessionHours: optInt(web, 'web', 'passkey_session_hours', 12, 1, 720),
    },
    paths: {
      db: optStr(paths, 'paths', 'db', '/var/lib/waread/db/waread.db'),
      mediaDir: optStr(paths, 'paths', 'media_dir', '/var/lib/waread/media'),
      dbModule: paths['db_module'] === undefined ? undefined : optStr(paths, 'paths', 'db_module', ''),
    },
  };
}

export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Konfigurationsdatei nicht lesbar: ${file}`);
  }
  let raw: Table;
  try {
    raw = parseToml(text) as Table;
  } catch {
    // Meldung bewusst weggelassen: koennte Teile der Datei (Hash) enthalten.
    throw new ConfigError(`TOML-Syntaxfehler in ${file}`);
  }
  return buildConfig(raw);
}
