// Kleine HTTP-Hilfsschicht auf node:http: Router, JSON-Antworten, Cookies, Client-IP.
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  query: URLSearchParams;
  params: Record<string, string>;
  ip: string;
  https: boolean;
  cookies: Record<string, string>;
}

export type Handler = (c: Ctx) => void | Promise<void>;
export type Method = 'GET' | 'POST' | 'PUT';

export interface Route {
  method: Method;
  pattern: string;
  segs: string[];
  handler: Handler;
  public: boolean;
}

export type Match =
  | { kind: 'found'; route: Route; params: Record<string, string> }
  | { kind: 'method'; allow: string[] }
  | { kind: 'bad_path' }
  | { kind: 'none' };

function splitPath(p: string): string[] {
  const t = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  return t.split('/').slice(1);
}

export class Router {
  private routes: Route[] = [];

  /** Routen verlangen standardmaessig eine gueltige Session; { public: true } hebt das auf. */
  add(method: Method, pattern: string, handler: Handler, opts: { public?: boolean } = {}): void {
    this.routes.push({ method, pattern, segs: splitPath(pattern), handler, public: opts.public === true });
  }

  /** Nur zur Pruefung (F13): alle registrierten Routen mit ihrem Public-Flag. Aendert nichts am Routing. */
  list(): ReadonlyArray<{ method: Method; pattern: string; public: boolean }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, public: r.public }));
  }

  match(method: string, pathname: string): Match {
    const m = method === 'HEAD' ? 'GET' : method;
    const segs = splitPath(pathname);
    const allow = new Set<string>();
    for (const r of this.routes) {
      if (r.segs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.segs[i]!;
        const s = segs[i]!;
        if (p.startsWith(':')) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(s);
          } catch {
            return { kind: 'bad_path' };
          }
          if (decoded === '') {
            ok = false;
            break;
          }
          params[p.slice(1)] = decoded;
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method === m) return { kind: 'found', route: r, params };
      allow.add(r.method);
    }
    return allow.size > 0 ? { kind: 'method', allow: [...allow] } : { kind: 'none' };
  }
}

// ---------- Antworten ----------

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  sendJson(res, status, { error: code, ...extra }, headers);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// ---------- Anfrage-Eingaben ----------

/**
 * JSON-Body lesen. Verlangt Content-Type application/json: Formular-Posts (text/plain,
 * x-www-form-urlencoded) fremder Seiten werden damit zusaetzlich zu SameSite=Strict abgewiesen.
 */
export async function readJson(c: Ctx, max = 65536): Promise<unknown> {
  const ct = String(c.req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  const declared = Number(c.req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    throw new HttpError(413, 'payload_too_large', undefined, { Connection: 'close' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of c.req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > max) throw new HttpError(413, 'payload_too_large', undefined, { Connection: 'close' });
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'invalid_body');
  return v as Record<string, unknown>;
}

/** Strikt: nur ganze Zahlen aus Ziffern (optional Minus), maximal 15 Stellen. */
export function parseIntStrict(s: string | null): number | null {
  if (s === null) return null;
  if (!/^-?\d{1,15}$/.test(s)) return null;
  return Number(s);
}

// ---------- Cookies ----------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  o: { path: string; maxAgeSec: number; secure: boolean },
): string {
  const parts = [`${name}=${value}`, `Path=${o.path}`, `Max-Age=${o.maxAgeSec}`, 'HttpOnly', 'SameSite=Strict'];
  if (o.maxAgeSec <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------- Client-Herkunft ----------

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * X-Forwarded-* werden nur ausgewertet, wenn die Verbindung vom lokalen Nginx kommt (Loopback).
 * Vom letzten X-Forwarded-For-Eintrag ausgehen: den haengt der vertrauenswuerdige Proxy an, ein
 * vom Client mitgeschickter Wert steht davor und kann das Rate-Limit nicht aushebeln.
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  if (isLoopback(remote)) {
    const raw = req.headers['x-forwarded-for'];
    const v = Array.isArray(raw) ? raw.join(',') : raw;
    if (v) {
      const last = v.split(',').pop()!.trim();
      if (last) return last.slice(0, 64);
    }
  }
  return remote || 'unknown';
}

export function isHttps(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  if (!isLoopback(remote)) return false;
  const raw = req.headers['x-forwarded-proto'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.split(',')[0]!.trim().toLowerCase() === 'https';
}

export function forwardedHost(req: IncomingMessage): string | undefined {
  const remote = req.socket.remoteAddress ?? '';
  if (isLoopback(remote)) {
    const raw = req.headers['x-forwarded-host'];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v === 'string' && v) return v.split(',')[0]!.trim();
  }
  return undefined;
}

// ---------- Sicherheits-Header ----------

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Auf jede Antwort angewandt; einzelne Routen (Medien) duerfen strenger ueberschreiben. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
}

// ---------- Query-Parameter ----------

/** Fehlender Parameter -> def; vorhanden, aber ungueltig oder ausserhalb des Bereichs -> 400. */
export function queryInt(
  c: Ctx,
  name: string,
  o: { min: number; max: number; def: number | null },
): number | null {
  const raw = c.query.get(name);
  if (raw === null || raw === '') return o.def;
  const n = parseIntStrict(raw);
  if (n === null || n < o.min || n > o.max) throw new HttpError(400, 'invalid_parameter', { parameter: name });
  return n;
}

export function queryBool(c: Ctx, name: string): boolean {
  const raw = c.query.get(name);
  if (raw === null || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new HttpError(400, 'invalid_parameter', { parameter: name });
}

export function queryString(c: Ctx, name: string, maxLen: number): string | null {
  const raw = c.query.get(name);
  if (raw === null || raw === '') return null;
  if (raw.length > maxLen) throw new HttpError(400, 'invalid_parameter', { parameter: name });
  return raw;
}
