// Anwendung zusammenbauen: Router, Request-Verteilung, Server. Ohne Seiteneffekte beim Import
// (server.ts startet den Prozess), damit sich der Dienst in Tests mit Stub-Datenbank betreiben laesst.
import http from 'node:http';
import { Auth, AuthBusyError, COOKIE_NAME, LoginLimiter, loadSessionSecret, type Verifier } from './auth.js';
import type { Config } from './config.js';
import { ConnectionState } from './connection.js';
import type { App } from './context.js';
import { serveStatic } from './files.js';
import {
  applySecurityHeaders,
  clientIp,
  type Ctx,
  forwardedHost,
  HttpError,
  isHttps,
  parseCookies,
  Router,
  sendError,
} from './http.js';
import { errFields, type Logger } from './log.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerPasskeyRoutes } from './routes/passkeys.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerStorageRoutes } from './routes/storage.js';
import { PasskeyService, PasskeyStore } from './passkeys.js';
import type { Db } from './sqlite.js';
import { EventPump, Hub, registerSse } from './sse.js';

/** Der Web-Dienst lauscht ausschliesslich lokal. Bewusst keine Konfigurationsoption. */
export const LISTEN_HOST = '127.0.0.1';

export interface AppOptions {
  cfg: Config;
  db: Db;
  log: Logger;
  /** Nur fuer Tests: Passwortpruefung ersetzen. */
  verifier?: Verifier;
  /** Nur fuer Tests: Session-Geheimnis vorgeben statt Datei zu lesen/anzulegen. */
  secret?: Buffer;
  /** Nur fuer Tests: Uhr der Passkey-Teile (Challenge-Ablauf, Neuladen der Datei). */
  passkeyNow?: () => number;
}

export interface RunningApp {
  app: App;
  server: http.Server;
  /** Nur zur Pruefung (F13): alle registrierten Routen. */
  routes: ReturnType<Router['list']>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT']);

export function createApp(o: AppOptions): RunningApp {
  const { cfg, db, log } = o;
  const secret = o.secret ?? loadSessionSecret(cfg.web.sessionSecretFile, log);
  const passkeyStore = new PasskeyStore(cfg.web.passkeyFile, log, o.passkeyNow);
  const passkeys = new PasskeyService({ cfg: cfg.web, store: passkeyStore, log, ...(o.passkeyNow ? { now: o.passkeyNow } : {}) });
  const auth = new Auth({
    passwordHash: cfg.web.passwordHash,
    secret,
    sessionSeconds: cfg.web.sessionDays * 86_400,
    epoch: () => passkeys.epoch,
    ...(o.verifier ? { verifier: o.verifier } : {}),
  });
  const limiter = new LoginLimiter(cfg.web.loginMaxAttempts, cfg.web.loginWindowMinutes * 60_000);
  const conn = new ConnectionState();
  const hub = new Hub(cfg.web.maxSseClients);
  const pump = new EventPump(db, conn, hub, log, cfg.web.hideDeletedContent);
  const app: App = { cfg, db, log, auth, limiter, conn, hub, pump, passkeys };

  const router = new Router();
  registerHealthRoutes(router, app);
  registerAuthRoutes(router, app);
  registerPasskeyRoutes(router, app);
  registerStatusRoutes(router, app);
  registerChatRoutes(router, app);
  registerMessageRoutes(router, app);
  registerMediaRoutes(router, app);
  registerSearchRoutes(router, app);
  registerSettingsRoutes(router, app);
  registerStorageRoutes(router, app);
  registerSse(router, app);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    let routeLabel = '-';
    applySecurityHeaders(res);
    res.on('finish', () => {
      log.debug('http', { method: req.method, route: routeLabel, status: res.statusCode, ms: Date.now() - started });
    });

    try {
      const method = req.method ?? 'GET';
      if (!METHODS.has(method)) throw new HttpError(405, 'method_not_allowed', undefined, { Allow: 'GET, HEAD, POST, PUT' });

      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        throw new HttpError(400, 'bad_request');
      }
      const ctx: Ctx = {
        req,
        res,
        url,
        query: url.searchParams,
        params: {},
        ip: clientIp(req),
        https: isHttps(req),
        cookies: parseCookies(req.headers.cookie),
      };

      // Optional (Verteidigung in der Tiefe zu SameSite=Strict): Origin muss zum Host passen.
      if (cfg.web.checkOrigin && method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin !== undefined) {
          let originHost = '';
          try {
            originHost = new URL(origin).host;
          } catch {
            /* leer -> unten abgelehnt */
          }
          const expected = forwardedHost(req) ?? req.headers.host;
          if (originHost === '' || originHost !== expected) throw new HttpError(403, 'bad_origin');
        }
      }

      const m = router.match(method, url.pathname);
      if (m.kind === 'bad_path') throw new HttpError(400, 'bad_path');
      if (m.kind === 'method') throw new HttpError(405, 'method_not_allowed', undefined, { Allow: m.allow.join(', ') });

      if (m.kind === 'found') {
        routeLabel = m.route.pattern;
        ctx.params = m.params;
        if (!m.route.public && !auth.isValidToken(ctx.cookies[COOKIE_NAME])) throw new HttpError(401, 'unauthorized');
        await m.route.handler(ctx);
        if (!res.headersSent && !res.writableEnded) throw new HttpError(500, 'no_response');
        return;
      }

      const p = url.pathname;
      const reserved = p === '/api' || p.startsWith('/api/') || p === '/events' || p === '/healthz';
      if ((method === 'GET' || method === 'HEAD') && !reserved) {
        routeLabel = 'static';
        if (await serveStatic(ctx, cfg.web.publicDir)) return;
      }
      throw new HttpError(404, 'not_found');
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendError(res, err.status, err.code, err.extra, err.headers);
        else res.end();
        return;
      }
      if (err instanceof AuthBusyError) {
        if (!res.headersSent) sendError(res, 503, 'busy');
        return;
      }
      log.error('request_failed', { route: routeLabel, ...errFields(err) });
      if (!res.headersSent) sendError(res, 500, 'internal_error');
      else res.destroy();
    }
  }

  const server = http.createServer(
    { keepAliveTimeout: 5_000, headersTimeout: 15_000, requestTimeout: 30_000, maxHeaderSize: 16_384 },
    (req, res) => {
      void handle(req, res);
    },
  );
  server.maxConnections = 128;

  return {
    app,
    server,
    routes: router.list(),
    async listen() {
      pump.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.web.port, LISTEN_HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    async close() {
      pump.stop();
      hub.closeAll();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 2_000);
      await closed;
      clearTimeout(force);
    },
  };
}
