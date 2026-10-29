// Optionaler Browser-Test (nicht Teil von `npm test`): die Passkey-Sperre im ECHTEN Chromium mit dem
// virtuellen Authenticator (Chrome DevTools Protocol, WebAuthn.*). Echtes Frontend-Bundle, echter Web-Dienst,
// echter db/dist/client.js, hinter einem Praefix-Proxy, der nginx nachahmt (/waread/x -> /x).
//
// Voraussetzungen wie test/e2e-frontend.mjs (alles gebaut, Playwright + Chromium). Aufruf:
//   node test/passkey-e2e.mjs
// Adresse ist http://localhost:<Port>: localhost gilt als sicherer Kontext, deshalb funktioniert WebAuthn
// ohne TLS. Safari/iOS ist damit NICHT geprueft; dort gelten dieselben Browser-Schnittstellen, aber es gibt
// keinen automatisierbaren Weg in dieser Umgebung.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const imp = (p) => import(pathToFileURL(p).href);
const D = ROOT + '/services/web/dist/';
const { createApp } = await imp(D + 'app.js'); const { buildConfig } = await imp(D + 'config.js');
const { initDbClient, openDatabase, migrate } = await imp(D + 'db.js'); const { createLogger } = await imp(D + 'log.js');
const client = await imp(ROOT + '/db/dist/client.js');
await initDbClient(ROOT + '/db/dist/client.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-e2e-'));
const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(mediaDir, { recursive: true });
const dbFile = path.join(tmp, 'w.db'); const db = openDatabase(dbFile); migrate(db);
const T = Math.floor(Date.now() / 1000) - 600;
const A = '4915111@s.whatsapp.net';
client.upsertChat(db, { id: A, name: 'Anna', isGroup: false, lastActivityAt: T + 50 });
client.insertMessageIfNotExists(db, { id: 'm1', chatId: A, sender: 'Anna', waTimestamp: T + 10, receivedAt: T + 10, direction: 'in', type: 'text', text: 'Hallo Welt' });
client.setSetting(db, 'connection.status', 'disconnected');
const PORT = 18931, PPORT = 18932;
const ORIGIN = `http://localhost:${PPORT}`;
const pkFile = path.join(tmp, 'passkeys.json');
const cfg = buildConfig({ web: { port: PORT, password_hash: '$argon2id$test', public_dir: ROOT + '/services/web/public/dist', session_secret_file: path.join(tmp, 'k'), cookie_path: '/waread/', passkey_rp_id: 'localhost', passkey_origin: ORIGIN, passkey_file: pkFile, passkey_session_hours: 2 }, paths: { db: dbFile, media_dir: mediaDir } });
const running = createApp({ cfg, db, log: createLogger('error', () => {}), verifier: async (h, p) => p === 'pw-test-123456' });
await running.listen();
const proxy = http.createServer((req, res) => {
  if (req.url === '/waread') { res.writeHead(301, { location: '/waread/' }); return res.end(); }
  if (!req.url.startsWith('/waread/')) { res.writeHead(404); return res.end('proxy-404'); }
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url.slice('/waread'.length), method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
await new Promise((r) => proxy.listen(PPORT, '127.0.0.1', r));
const results = []; const ok = (n, c, d) => results.push([n, !!c, d]);
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.setViewportSize({ width: 390, height: 844 }); // iPhone-Breite
const bad = []; page.on('console', (m) => { if (/Content Security Policy|Refused to|violat/i.test(m.text())) bad.push(m.text()); });
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const URL0 = `http://localhost:${PPORT}/waread/`;
const status = async (p) => page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).status, p);

// 1. Passwort-Login, Einstellungen
await page.goto(URL0);
await page.waitForSelector('input[type=password]', { timeout: 8000 });
ok('Login-Bild ohne Sperre: Passwortfeld, kein Passkey-Knopf (noch keiner eingerichtet)', await page.locator('button:has-text("Mit Passkey anmelden")').count() === 0);
await page.fill('input[type=password]', 'pw-test-123456'); await page.keyboard.press('Enter');
await page.waitForSelector('text=Anna', { timeout: 8000 });
await page.goto(URL0 + '#/settings');
await page.waitForSelector('h2:has-text("Passkey-Sperre")', { timeout: 8000 });
await page.waitForSelector('button:has-text("Passkey auf diesem Gerät erstellen")', { timeout: 8000 });
ok('Einstellungen: Passkey-Karte mit "Sperre aus"', await page.locator('text=Sperre aus').count() === 1);

// 2. Passkey erstellen -> Angebot, die Sperre zu aktivieren
await page.fill('input[aria-label="Bezeichnung des Passkeys"]', 'Test-iPhone');
await page.click('button:has-text("Passkey auf diesem Gerät erstellen")');
await page.waitForSelector('text=Sperre jetzt aktivieren', { timeout: 10000 });
await page.screenshot({ path: tmp + '/settings-offer.png', fullPage: true });
ok('Passkey gespeichert, Angebot zur Sperre erscheint', await page.locator('.passkey-row strong:has-text("Test-iPhone")').count() === 1);
const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
ok('virtueller Authenticator hat genau einen auffindbaren Passkey fuer localhost', creds.length === 1 && creds[0].rpId === 'localhost' && creds[0].isResidentCredential === true, creds.map((c) => [c.rpId, c.isResidentCredential]));
ok('Passwort-Login geht noch (Sperre ist noch aus)', await page.evaluate(async () => (await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-test-123456' }) })).status) === 200);

// 3. Sperre aktivieren
await page.click('button:has-text("Sperre aktivieren")');
await page.waitForSelector('strong:has-text("Sperre aktiv")', { timeout: 10000 });
await page.screenshot({ path: tmp + '/settings-locked.png', fullPage: true });
ok('Sperre aktiv', true);
ok('Sitzung nach Aktivierung funktioniert (neues Cookie)', await status('api/chats') === 200);
ok('Passwort-Login ist jetzt gesperrt (403)', await page.evaluate(async () => (await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-test-123456' }) })).status) === 403);

// 4. "naechstes Mal oeffnen": ohne Cookie -> nur Passkey
await context.clearCookies();
await page.goto(URL0);
await page.waitForSelector('button:has-text("Mit Passkey anmelden")', { timeout: 8000 });
await page.screenshot({ path: tmp + '/login-locked.png' });
ok('naechstes Oeffnen: Sperrbild, kein Passwortfeld', await page.locator('input[type=password]').count() === 0 && await page.locator('text=Anmeldung nur mit Passkey').count() > 0);
ok('ohne Anmeldung kein Zugriff auf Daten', await status('api/chats') === 401);
await page.click('button:has-text("Mit Passkey anmelden")');
await page.waitForSelector('text=Anna', { timeout: 10000 });
ok('Anmeldung mit Passkey -> Chatliste', await status('api/chats') === 200);
const cookies = await context.cookies();
const sess = cookies.find((c) => c.name === 'waread_session');
ok('Sitzungscookie: HttpOnly, SameSite=Strict, Pfad /waread/, Laufzeit etwa 2 h', sess && sess.httpOnly && sess.sameSite === 'Strict' && sess.path === '/waread/' && Math.abs((sess.expires - Date.now() / 1000) - 7200) < 120, sess);

// 5. Zaehler/Nutzung sichtbar
await page.goto(URL0 + '#/settings');
await page.waitForSelector('.passkey-row', { timeout: 8000 });
ok('Passkey-Liste zeigt "zuletzt benutzt"', await page.locator('.passkey-row:has-text("zuletzt benutzt")').count() === 1);

// 6. Falsche Seite (anderer Origin) kann den Passkey nicht benutzen: derselbe Server, aber Origin 127.0.0.1
{
  const p2 = await context.newPage();
  await p2.goto(`http://127.0.0.1:${PPORT}/waread/`);
  await context.clearCookies();
  await p2.reload();
  await p2.waitForSelector('button:has-text("Mit Passkey anmelden")', { timeout: 8000 });
  await p2.click('button:has-text("Mit Passkey anmelden")');
  await p2.waitForSelector('.form-error:not([hidden])', { timeout: 15000 });
  ok('Aufruf ueber andere Adresse (127.0.0.1): Fehlermeldung zur RP-ID, kein Zugriff', /RP-ID/.test(await p2.locator('.form-error:not([hidden])').first().innerText()) && (await p2.evaluate(async () => (await fetch('api/chats')).status)) === 401);
  await p2.close();
}

// 7. Sperre aufheben (Passkey-Bestaetigung), danach wieder Passwort
await page.goto(URL0);
await page.waitForSelector('button:has-text("Mit Passkey anmelden")', { timeout: 8000 });
await page.click('button:has-text("Mit Passkey anmelden")');
await page.waitForSelector('text=Anna', { timeout: 10000 });
await page.goto(URL0 + '#/settings');
await page.waitForSelector('button:has-text("Sperre aufheben")', { timeout: 8000 });
await page.click('button:has-text("Sperre aufheben")');
await page.waitForSelector('text=Sperre aus', { timeout: 10000 });
ok('Sperre aufgehoben', await status('api/chats') === 200);
await context.clearCookies();
await page.goto(URL0);
await page.waitForSelector('input[type=password]', { timeout: 8000 });
ok('danach wieder Passwortfeld plus Passkey-Knopf', await page.locator('button:has-text("Mit Passkey anmelden")').count() === 1);

// 8. Passkey entfernen (Sperre aus: nur Sitzung noetig)
await page.fill('input[type=password]', 'pw-test-123456'); await page.keyboard.press('Enter');
await page.waitForSelector('text=Anna', { timeout: 8000 });
await page.goto(URL0 + '#/settings');
await page.waitForSelector('.passkey-row button:has-text("Entfernen")', { timeout: 8000 });
await page.click('.passkey-row button:has-text("Entfernen")');
await page.click('.passkey-row button:has-text("Wirklich entfernen")');
await page.waitForSelector('button:has-text("Passkey auf diesem Gerät erstellen")', { timeout: 8000 });
ok('Passkey entfernt (Liste leer)', await page.locator('.passkey-row').count() === 0);

ok('keine CSP-Verletzungen', bad.length === 0, bad);
await browser.close(); proxy.close(); await running.close?.();
let fail = 0; for (const [n, c, d] of results) { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(d))); }
console.log(`${results.length - fail}/${results.length}; Bilder: ${tmp}`); process.exit(fail ? 1 : 0);
