import type { App } from '../context.js';
import { HttpError, queryBool, queryInt, queryString, type Router, sendJson } from '../http.js';
import { buildFtsQuery, MESSAGE_TYPES, type MessageType, searchMessages } from '../queries.js';

export function registerSearchRoutes(r: Router, app: App): void {
  const hide = app.cfg.web.hideDeletedContent;

  // GET /api/search?q=&chatId=&type=&from=&to=&onlyNew=[&limit=]
  r.add('GET', '/api/search', (c) => {
    const q = (queryString(c, 'q', 200) ?? '').trim();
    const chatId = queryString(c, 'chatId', 512);
    const typeRaw = queryString(c, 'type', 16);
    if (typeRaw !== null && !(MESSAGE_TYPES as readonly string[]).includes(typeRaw)) {
      throw new HttpError(400, 'invalid_parameter', { parameter: 'type' });
    }
    const type = typeRaw as MessageType | null;
    const from = queryInt(c, 'from', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
    const to = queryInt(c, 'to', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
    const onlyNew = queryBool(c, 'onlyNew');
    const limit = queryInt(c, 'limit', { min: 1, max: 200, def: 100 })!;

    const fts = q === '' ? null : buildFtsQuery(q);
    if (q !== '' && fts === null) {
      sendJson(c.res, 200, []); // nur Sonderzeichen: nichts Suchbares
      return;
    }
    // Ohne Suchtext muss mindestens ein Filter gesetzt sein (sonst wuerde alles geliefert).
    if (fts === null && chatId === null && type === null && from === null && to === null && !onlyNew) {
      throw new HttpError(400, 'q_or_filter_required');
    }
    sendJson(c.res, 200, searchMessages(app.db, { fts, chatId, type, from, to, onlyNew, limit }, hide));
  });
}
