import { QrUnavailableError, toQrDataUrl } from '../connection.js';
import type { App } from '../context.js';
import { setSetting } from '../db.js';
import { HttpError, type Router, sendJson } from '../http.js';

export function registerStatusRoutes(r: Router, app: App): void {
  r.add('GET', '/api/status', (c) => {
    app.pump.pollNow();
    app.pump.syncConnection();
    sendJson(c.res, 200, app.conn.getStatus());
  });

  r.add('GET', '/api/qr', async (c) => {
    app.pump.pollNow();
    app.pump.syncConnection();
    const raw = app.conn.getPendingQr();
    if (!raw) throw new HttpError(404, 'no_qr');
    try {
      sendJson(c.res, 200, { qr: await toQrDataUrl(raw) });
    } catch (err) {
      if (err instanceof QrUnavailableError) {
        app.log.error('qr_render_unavailable');
        throw new HttpError(503, 'qr_render_unavailable');
      }
      throw err;
    }
  });

  // Erweiterung ueber den Vertrag hinaus (Zusammenfuehrung): "Neu verbinden". Der Web-Dienst spricht nicht mit
  // WhatsApp, er legt nur einen Befehl in die settings-Tabelle; der Ingest-Dienst holt ihn ab, quittiert durch
  // Leeren des Werts und ignoriert ihn, solange eine Verbindung besteht (services/ingest/src/connection.ts).
  r.add('POST', '/api/connect', (c) => {
    setSetting(app.db, 'connection.command', 'connect');
    app.log.info('connect_requested');
    sendJson(c.res, 202, { ok: true });
  });
}
