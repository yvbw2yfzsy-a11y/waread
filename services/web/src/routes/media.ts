import path from 'node:path';
import type { App } from '../context.js';
import { contentDisposition, mimeFromExt, resolveInside, serveFile } from '../files.js';
import { HttpError, type Router } from '../http.js';
import { getMediaRow } from '../queries.js';

// Feste Positivliste: nur diese Typen werden inline ausgeliefert, und nur passend zum Nachrichtentyp.
// Alles andere (Dokumente, SVG, HTML, unbekannte Typen) wird als application/octet-stream-Download geliefert.
const INLINE: Record<string, ReadonlySet<string>> = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  voice: new Set(['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/opus': 'audio/ogg',
};

function normalizeMime(m: string | null): string | null {
  if (!m) return null;
  const base = m.split(';')[0]!.trim().toLowerCase();
  if (base === '') return null;
  return ALIASES[base] ?? base;
}

/** Thumbnails: Typ ausschliesslich aus der Dateiendung, nur Bildformate. */
function thumbMime(file: string): string | null {
  const t = mimeFromExt(file);
  return t === 'image/jpeg' || t === 'image/png' || t === 'image/webp' ? t : null;
}

export function registerMediaRoutes(r: Router, app: App): void {
  const hide = app.cfg.web.hideDeletedContent;

  // GET /api/media/:messageId           -> Mediendatei (Range wird unterstuetzt)
  // GET /api/media/:messageId?thumb=1   -> Thumbnail (Ergaenzung zum Vertrag)
  r.add('GET', '/api/media/:messageId', async (c) => {
    const row = getMediaRow(app.db, c.params['messageId']!);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.deleted === 1 && hide) throw new HttpError(404, 'not_found');

    let rel: string;
    let contentType: string;
    let disposition: string;

    if (c.query.get('thumb') === '1') {
      if (!row.thumbnail_path || row.status === 'expired') throw new HttpError(404, 'not_found');
      const t = thumbMime(row.thumbnail_path);
      if (!t) throw new HttpError(404, 'not_found');
      rel = row.thumbnail_path;
      contentType = t;
      disposition = 'inline';
    } else {
      if (row.status !== 'ready' || !row.file_path) {
        throw new HttpError(404, 'media_not_ready', { status: row.status });
      }
      rel = row.file_path;
      const mime = normalizeMime(row.mime_type) ?? mimeFromExt(rel);
      const allowed = INLINE[row.type];
      if (mime && allowed && allowed.has(mime)) {
        contentType = mime;
        disposition = 'inline';
      } else {
        contentType = 'application/octet-stream';
        disposition = contentDisposition('attachment', path.basename(rel));
      }
    }

    const real = await resolveInside(app.cfg.paths.mediaDir, rel);
    if (!real) throw new HttpError(404, 'not_found');

    // Ausgelieferte Dateien duerfen nie Skripte ausfuehren oder etwas nachladen.
    c.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await serveFile(c, real, { contentType, disposition, cacheControl: 'private, max-age=3600' });
  });
}
