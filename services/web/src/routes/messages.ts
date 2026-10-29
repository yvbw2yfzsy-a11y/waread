import type { App } from '../context.js';
import { markPlayed } from '../db.js';
import { emitMessageUpdated } from '../emit.js';
import { HttpError, queryInt, queryString, type Router, sendJson } from '../http.js';
import { chatExists, getPlayedAt, listMessages, messageExists } from '../queries.js';

export function registerMessageRoutes(r: Router, app: App): void {
  const hide = app.cfg.web.hideDeletedContent;

  r.add('GET', '/api/chats/:id/messages', (c) => {
    const chatId = c.params['id']!;
    if (!chatExists(app.db, chatId)) throw new HttpError(404, 'chat_not_found');
    const limit = queryInt(c, 'limit', { min: 1, max: 200, def: 50 })!;
    const before = queryInt(c, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
    const beforeId = queryString(c, 'beforeId', 512);
    sendJson(c.res, 200, listMessages(app.db, chatId, { before, beforeId: before === null ? null : beforeId, limit }, hide));
  });

  r.add('POST', '/api/messages/:id/played', (c) => {
    const id = c.params['id']!;
    if (!messageExists(app.db, id)) throw new HttpError(404, 'message_not_found');
    const before = getPlayedAt(app.db, id);
    markPlayed(app.db, id);
    const after = getPlayedAt(app.db, id);
    if (after !== before) emitMessageUpdated(app.db, [id]);
    sendJson(c.res, 200, { ok: true, playedAt: after });
  });
}
