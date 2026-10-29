import type { App } from '../context.js';
import { markSeen, setSetting } from '../db.js';
import { emitMessageUpdated } from '../emit.js';
import { mimeFromExt, resolveInside, serveFile } from '../files.js';
import { asObject, HttpError, readJson, type Router, sendJson } from '../http.js';
import { chatExists, getAvatarPath, listChats, mutedChatIds } from '../queries.js';
import { withTx } from '../sqlite.js';

/** Hoechstzahl gleichzeitig stummer Chats (Schutz vor unbegrenztem Wachstum der Einstellung). */
const MAX_MUTED = 1000;

export function registerChatRoutes(r: Router, app: App): void {
  const hide = app.cfg.web.hideDeletedContent;

  r.add('GET', '/api/chats', (c) => {
    sendJson(c.res, 200, listChats(app.db, hide));
  });

  // Ergaenzung zum Vertrag: Profilbild aus dem Avatar-Cache (nur Bilddateien, nur unterhalb von media_dir).
  r.add('GET', '/api/chats/:id/avatar', async (c) => {
    const rel = getAvatarPath(app.db, c.params['id']!);
    if (!rel) throw new HttpError(404, 'not_found');
    const type = mimeFromExt(rel);
    if (!type || !type.startsWith('image/')) throw new HttpError(404, 'not_found');
    const real = await resolveInside(app.cfg.paths.mediaDir, rel);
    if (!real) throw new HttpError(404, 'not_found');
    c.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await serveFile(c, real, { contentType: type, disposition: 'inline', cacheControl: 'private, max-age=3600' });
  });

  // "Stumm": rein lokale Anzeige-Einstellung (settings chat.muted). Der Chat bleibt in der Liste, zaehlt aber nicht in
  // "Neu" und im Abzeichen. Hat nichts mit WhatsApp zu tun.
  r.add('PUT', '/api/chats/:id/mute', async (c) => {
    const chatId = c.params['id']!;
    if (!chatExists(app.db, chatId)) throw new HttpError(404, 'chat_not_found');
    const body = asObject(await readJson(c));
    const muted = body['muted'];
    if (typeof muted !== 'boolean') throw new HttpError(400, 'invalid_body', { field: 'muted' });
    let result = muted;
    withTx(app.db, () => {
      const set = new Set(mutedChatIds(app.db));
      if (muted) {
        if (set.size >= MAX_MUTED && !set.has(chatId)) {
          result = false;
          return;
        }
        set.add(chatId);
      } else {
        set.delete(chatId);
      }
      setSetting(app.db, 'chat.muted', JSON.stringify([...set]));
    });
    if (muted && !result) throw new HttpError(409, 'too_many_muted_chats');
    sendJson(c.res, 200, { ok: true, muted: result });
  });

  r.add('POST', '/api/chats/:id/seen', async (c) => {
    const chatId = c.params['id']!;
    if (!chatExists(app.db, chatId)) throw new HttpError(404, 'chat_not_found');
    const body = asObject(await readJson(c));
    const all = body['all'];
    const upTo = body['upTo'];
    if (all !== undefined && typeof all !== 'boolean') throw new HttpError(400, 'invalid_body');
    if (upTo !== undefined && (typeof upTo !== 'string' || upTo === '' || upTo.length > 512)) {
      throw new HttpError(400, 'invalid_body');
    }
    // Genau eines von beiden: all:true ODER upTo.
    if ((all === true) === (upTo !== undefined)) throw new HttpError(400, 'all_or_upTo_required');

    const ids = all === true ? markSeen(app.db, { chatId, all: true }) : markSeen(app.db, { chatId, upTo: upTo as string });
    emitMessageUpdated(app.db, ids);
    sendJson(c.res, 200, { updated: ids.length });
  });
}
