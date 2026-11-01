// Passkey-Sperre: Anmeldung per WebAuthn und Verwaltung der Passkeys (siehe passkeys.ts fuer das Modell).
//
// Oeffentlich (ohne Sitzung): Zustand der Sperre, Optionen und Pruefung der Passkey-Anmeldung.
// Alles andere verlangt eine Sitzung; bei aktiver Sperre zusaetzlich eine frische Passkey-Bestaetigung
// ("Freigabe") fuer: Passkey hinzufuegen, Passkey loeschen, Sperre ausschalten. Das Einschalten der Sperre
// verlangt sie immer (so ist bewiesen, dass der Passkey funktioniert, bevor das Passwort abgeschaltet wird).
import { COOKIE_NAME } from '../auth.js';
import type { App } from '../context.js';
import { asObject, HttpError, readJson, type Router, sendJson } from '../http.js';
import { STEP_PURPOSES, type StepPurpose } from '../passkeys.js';
import { setSessionCookie } from './auth.js';

function rateLimited(retryAfterSec: number): HttpError {
  return new HttpError(429, 'too_many_attempts', { retryAfterSeconds: retryAfterSec }, { 'Retry-After': String(retryAfterSec) });
}

export function registerPasskeyRoutes(r: Router, app: App): void {
  const pk = app.passkeys;

  // ---------- oeffentlich ----------

  r.add(
    'GET',
    '/api/auth/state',
    (c) => {
      sendJson(c.res, 200, { lock: pk.lockActive, passkey: pk.loginPossible });
    },
    { public: true },
  );

  r.add(
    'POST',
    '/api/passkey/login/options',
    async (c) => {
      const lim = pk.optionsLimiter.hit(c.ip);
      if (!lim.allowed) throw rateLimited(lim.retryAfterSec);
      asObject(await readJson(c, 1024));
      sendJson(c.res, 200, pk.loginOptions());
    },
    { public: true },
  );

  r.add(
    'POST',
    '/api/passkey/login/verify',
    async (c) => {
      // Zaehlen, BEVOR geprueft wird (wie beim Passwort-Login).
      const lim = pk.verifyLimiter.hit(c.ip);
      if (!lim.allowed) {
        app.log.warn('passkey_login_rate_limited', { ip: c.ip });
        throw rateLimited(lim.retryAfterSec);
      }
      const body = asObject(await readJson(c, 16384));
      try {
        pk.verifyLogin(body['challengeId'], body['credential']);
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) app.log.info('passkey_login_failed', { ip: c.ip });
        throw err;
      }
      pk.verifyLimiter.reset(c.ip);
      setSessionCookie(app, c, pk.sessionSeconds);
      app.log.info('passkey_login_ok', { ip: c.ip });
      sendJson(c.res, 200, { ok: true });
    },
    { public: true },
  );

  // ---------- Sitzung erforderlich ----------

  const overview = (): Record<string, unknown> => ({
    configured: pk.configured,
    rpId: pk.rpId,
    origin: pk.origin,
    lock: pk.lockActive,
    sessionHours: app.cfg.web.passkeySessionHours,
    passkeys: pk.list(),
  });

  r.add('GET', '/api/passkeys', (c) => {
    sendJson(c.res, 200, overview());
  });

  r.add('POST', '/api/passkey/step/options', async (c) => {
    const body = asObject(await readJson(c, 1024));
    const purpose = body['purpose'];
    if (typeof purpose !== 'string' || !(STEP_PURPOSES as readonly string[]).includes(purpose)) throw new HttpError(400, 'invalid_body');
    sendJson(c.res, 200, pk.stepOptions(purpose as StepPurpose));
  });

  r.add('POST', '/api/passkey/step/verify', async (c) => {
    const lim = pk.verifyLimiter.hit(c.ip);
    if (!lim.allowed) throw rateLimited(lim.retryAfterSec);
    const body = asObject(await readJson(c, 16384));
    const res = pk.verifyStep(body['challengeId'], body['credential'], c.cookies[COOKIE_NAME]);
    pk.verifyLimiter.reset(c.ip);
    sendJson(c.res, 200, { ok: true, ...res });
  });

  r.add('POST', '/api/passkey/register/options', async (c) => {
    const body = asObject(await readJson(c, 1024));
    if (pk.lockActive) pk.consumeGrant(body['grant'], 'register', c.cookies[COOKIE_NAME]);
    sendJson(c.res, 200, pk.registerOptions());
  });

  r.add('POST', '/api/passkey/register/verify', async (c) => {
    const body = asObject(await readJson(c, 16384));
    pk.register(body['challengeId'], body['credential'], body['label']);
    sendJson(c.res, 200, { ok: true, ...overview() });
  });

  r.add('POST', '/api/passkey/lock/on', async (c) => {
    const body = asObject(await readJson(c, 1024));
    pk.consumeGrant(body['grant'], 'lock_on', c.cookies[COOKIE_NAME]);
    pk.setLock(true);
    app.hub.closeAll(); // offene Live-Verbindungen der alten Sitzungen beenden
    setSessionCookie(app, c, pk.sessionSeconds);
    sendJson(c.res, 200, { ok: true, ...overview() });
  });

  r.add('POST', '/api/passkey/lock/off', async (c) => {
    const body = asObject(await readJson(c, 1024));
    pk.consumeGrant(body['grant'], 'lock_off', c.cookies[COOKIE_NAME]);
    pk.setLock(false);
    app.hub.closeAll();
    setSessionCookie(app, c, app.auth.sessionSeconds);
    sendJson(c.res, 200, { ok: true, ...overview() });
  });

  r.add('POST', '/api/passkey/delete', async (c) => {
    const body = asObject(await readJson(c, 1024));
    if (pk.lockActive) pk.consumeGrant(body['grant'], 'delete', c.cookies[COOKIE_NAME]);
    pk.remove(body['id']);
    sendJson(c.res, 200, { ok: true, ...overview() });
  });
}
