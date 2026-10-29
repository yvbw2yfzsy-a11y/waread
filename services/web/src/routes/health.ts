import type { App } from '../context.js';
import { type Router, sendText } from '../http.js';
import { getRow } from '../sqlite.js';

export function registerHealthRoutes(r: Router, app: App): void {
  // Ohne Session erreichbar (Update-/Rollback-Pruefung). Verraet nichts ausser "laeuft / laeuft nicht".
  r.add(
    'GET',
    '/healthz',
    (c) => {
      try {
        getRow(app.db, 'SELECT 1 AS x FROM messages LIMIT 1');
        sendText(c.res, 200, 'OK\n');
      } catch {
        sendText(c.res, 503, 'database unavailable\n');
      }
    },
    { public: true },
  );
}
