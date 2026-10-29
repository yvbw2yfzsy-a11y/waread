import type { App } from '../context.js';
import { enqueueCommand, markPlayed, setMessageProtected } from '../db.js';
import { emitMessageUpdated } from '../emit.js';
import { asObject, HttpError, queryInt, queryString, readJson, type Router, sendJson } from '../http.js';
import {
  chatExists,
  getLoadState,
  getPlayedAt,
  getVersions,
  hasPendingLoad,
  isMessageDeleted,
  listMessages,
  messageExists,
} from '../queries.js';

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

  // Bearbeitungsverlauf: aktuelle Fassung und fruehere Fassungen (aelteste zuerst).
  r.add('GET', '/api/messages/:id/versions', (c) => {
    const id = c.params['id']!;
    const v = getVersions(app.db, id);
    if (!v || (hide && isMessageDeleted(app.db, id))) throw new HttpError(404, 'message_not_found');
    sendJson(c.res, 200, v);
  });

  // Schild: geschuetzte Nachrichten loescht weder der Cleanup noch "Speicher leeren" ohne ausdrueckliche Freigabe.
  // Fehlt die Mediendatei, liegen die Schluessel aber bereit, beauftragt das Setzen des Schilds den Ingest zugleich,
  // die Datei jetzt zu holen (ein HTTPS-Abruf an den Medienhost).
  r.add('POST', '/api/messages/:id/protect', async (c) => {
    const id = c.params['id']!;
    if (!messageExists(app.db, id)) throw new HttpError(404, 'message_not_found');
    const body = asObject(await readJson(c));
    const on = body['protected'];
    if (typeof on !== 'boolean') throw new HttpError(400, 'invalid_body', { field: 'protected' });
    setMessageProtected(app.db, id, on);
    let loading = false;
    if (on && getLoadState(app.db, id).loadable && !hasPendingLoad(app.db, id)) {
      enqueueCommand(app.db, 'load_media', { messageId: id });
      loading = true;
    }
    emitMessageUpdated(app.db, [id]);
    app.log.info('message_protect', { on, loading });
    sendJson(c.res, 200, { ok: true, protectedAt: getLoadState(app.db, id).protectedAt, loading });
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
