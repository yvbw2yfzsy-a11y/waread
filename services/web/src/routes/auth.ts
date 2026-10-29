import { AuthBusyError, AuthUnavailableError, COOKIE_NAME } from '../auth.js';
import type { App } from '../context.js';
import { asObject, type Ctx, HttpError, readJson, type Router, sendJson, serializeCookie } from '../http.js';

function cookieSecure(app: App, c: Ctx): boolean {
  const s = app.cfg.web.cookieSecure;
  return s === 'auto' ? c.https : s;
}

export function registerAuthRoutes(r: Router, app: App): void {
  r.add(
    'POST',
    '/api/login',
    async (c) => {
      // Passkey-Sperre aktiv: Das Passwort wird weder geprueft noch bewertet (kein Hinweis, ob es stimmt).
      if (app.passkeys.lockActive) throw new HttpError(403, 'passkey_required');
      // Versuch zaehlen, BEVOR geprueft wird (parallele Versuche duerfen das Limit nicht umgehen).
      const lim = app.limiter.hit(c.ip);
      if (!lim.allowed) {
        app.log.warn('login_rate_limited', { ip: c.ip });
        throw new HttpError(429, 'too_many_attempts', { retryAfterSeconds: lim.retryAfterSec }, {
          'Retry-After': String(lim.retryAfterSec),
        });
      }
      const body = asObject(await readJson(c, 4096));
      const pw = body['password'];
      if (typeof pw !== 'string' || pw.length === 0 || pw.length > 1024) throw new HttpError(400, 'invalid_body');

      let ok: boolean;
      try {
        ok = await app.auth.verifyPassword(pw);
      } catch (err) {
        if (err instanceof AuthBusyError) throw new HttpError(503, 'busy', undefined, { 'Retry-After': '2' });
        if (err instanceof AuthUnavailableError) {
          app.log.error('auth_unavailable');
          throw new HttpError(503, 'auth_unavailable');
        }
        throw err;
      }
      if (!ok) {
        app.log.info('login_failed', { ip: c.ip });
        throw new HttpError(401, 'invalid_credentials');
      }

      app.limiter.reset(c.ip);
      c.res.setHeader(
        'Set-Cookie',
        serializeCookie(COOKIE_NAME, app.auth.issueToken(), {
          path: app.cfg.web.cookiePath,
          maxAgeSec: app.auth.sessionSeconds,
          secure: cookieSecure(app, c),
        }),
      );
      app.log.info('login_ok', { ip: c.ip });
      sendJson(c.res, 200, { ok: true });
    },
    { public: true },
  );

  r.add(
    'POST',
    '/api/logout',
    (c) => {
      c.res.setHeader(
        'Set-Cookie',
        serializeCookie(COOKIE_NAME, '', { path: app.cfg.web.cookiePath, maxAgeSec: 0, secure: cookieSecure(app, c) }),
      );
      sendJson(c.res, 200, { ok: true });
    },
    { public: true },
  );
}
