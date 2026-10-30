// Dateiauslieferung: Pfadschutz, HTTP-Range, ETag, Content-Disposition, statische Frontend-Dateien.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { type Ctx, HttpError } from './http.js';

/**
 * Pfad aufloesen und sicherstellen, dass er (nach Symlink-Aufloesung) unterhalb von root liegt.
 * Relative Pfade werden gegen root aufgeloest, absolute bleiben absolut und muessen trotzdem in root liegen.
 */
export async function resolveInside(root: string, p: string): Promise<string | null> {
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  let real: string;
  try {
    real = await fs.promises.realpath(path.resolve(rootReal, p));
  } catch {
    return null;
  }
  return real === rootReal || real.startsWith(rootReal + path.sep) ? real : null;
}

// ---------- MIME ----------

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function mimeFromExt(file: string): string | null {
  return EXT_MIME[path.extname(file).toLowerCase()] ?? null;
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ---------- Content-Disposition ----------

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[\x00-\x1f\x7f"\\/;]/g, '_').trim();
  return base === '' ? 'download' : base.slice(0, 180);
}

export function contentDisposition(kind: 'inline' | 'attachment', filename?: string): string {
  if (kind === 'inline' || !filename) return kind;
  const f = safeFilename(filename);
  const ascii = f.replace(/[^\x20-\x7e]/g, '_');
  const star = encodeURIComponent(f).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// ---------- Range ----------

export type RangeResult = { kind: 'none' } | { kind: 'ok'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * Genau ein Bytebereich wird bedient. Mehrfach-Bereiche und syntaktisch ungueltige Header werden
 * ignoriert (volle 200-Antwort), das ist nach RFC 9110 zulaessig. Nicht erfuellbar -> 416.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/i.exec(header.trim());
  if (!m) return { kind: 'none' };
  const a = m[1]!;
  const b = m[2]!;
  if (a === '' && b === '') return { kind: 'none' };
  if (a !== '' && b !== '' && Number(b) < Number(a)) return { kind: 'none' };
  if (size === 0) return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size) return { kind: 'unsatisfiable' };
  }
  return { kind: 'ok', start, end };
}

// ---------- Ausliefern ----------

export interface ServeOpts {
  contentType: string;
  /** Fertiger Content-Disposition-Wert; weglassen = kein Header. */
  disposition?: string;
  cacheControl: string;
  headers?: Record<string, string>;
}

export async function serveFile(c: Ctx, file: string, o: ServeOpts): Promise<void> {
  const { req, res } = c;
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    throw new HttpError(404, 'not_found');
  }
  let streaming = false;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new HttpError(404, 'not_found');
    const size = st.size;
    const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const base: Record<string, string | number> = {
      'Content-Type': o.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': o.cacheControl,
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      ...(o.headers ?? {}),
    };
    if (o.disposition) base['Content-Disposition'] = o.disposition;

    // If-Range kann nicht gegen einen starken Validator geprueft werden -> Range ignorieren, volle Antwort.
    const range = req.headers['if-range'] ? ({ kind: 'none' } as RangeResult) : parseRange(req.headers['range'], size);

    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end();
      return;
    }
    if (range.kind === 'none' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': o.cacheControl });
      res.end();
      return;
    }

    let status = 200;
    let start = 0;
    let end = size - 1;
    if (range.kind === 'ok') {
      status = 206;
      start = range.start;
      end = range.end;
      base['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    const length = size === 0 ? 0 : end - start + 1;
    base['Content-Length'] = length;
    res.writeHead(status, base);

    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    streaming = true;
    const stream = fh.createReadStream({ start, end, autoClose: true });
    pipeline(stream, res, () => {
      /* Abbruch durch den Client ist normal; pipeline raeumt auf. */
    });
  } finally {
    if (!streaming) await fh.close().catch(() => undefined);
  }
}

// ---------- Statisches Frontend ----------

/**
 * Liefert public/ aus. Dateien mit Endung, die fehlen, ergeben 404; Pfade ohne Endung fallen auf
 * index.html zurueck (SPA). Dotfiles werden nie ausgeliefert.
 */
export async function serveStatic(c: Ctx, root: string): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(c.url.pathname);
  } catch {
    throw new HttpError(400, 'bad_path');
  }
  if (rel.includes('\0')) throw new HttpError(400, 'bad_path');
  const segs = rel.split('/').filter((s) => s !== '');
  if (segs.some((s) => s.startsWith('.'))) return false;
  const wantsFile = segs.length > 0 && !rel.endsWith('/');
  const target = wantsFile ? segs.join('/') : [...segs, 'index.html'].join('/');

  const tryServe = async (relPath: string): Promise<boolean> => {
    const real = await resolveInside(root, relPath);
    if (!real) return false;
    try {
      if (!(await fs.promises.stat(real)).isFile()) return false;
    } catch {
      return false;
    }
    const type = STATIC_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
    await serveFile(c, real, { contentType: type, cacheControl: 'no-cache' });
    return true;
  };

  if (await tryServe(target)) return true;
  const last = segs[segs.length - 1] ?? '';
  if (wantsFile && path.extname(last) !== '') return false; // fehlende Datei mit Endung
  return tryServe('index.html');
}
