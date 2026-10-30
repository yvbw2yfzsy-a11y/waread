// Optionaler Browser-Test (nicht Teil von `npm test`): echtes Frontend-Bundle + echter Web-Dienst + echter
// db/dist/client.js hinter einem Praefix-Proxy, der nginx nachahmt (/waread/x -> /x).
// Voraussetzungen: alles gebaut (npm run build), Playwright mit Chromium installiert (NICHT in package.json:
// `npm install --no-save playwright && npx playwright install chromium`). Aufruf: node test/e2e-frontend.mjs
// Prueft: Login, Chatliste, Bubbles (Text/Bild-Thumbnail/Sprache/Dokument), SSE-Live-Nachricht, Einstellungen
// speichern (downloadRules), Fehlertext, "Neu verbinden", QR-Anzeige, keine CSP-Verletzungen.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const imp = (p) => import(pathToFileURL(p).href);
const D = ROOT + '/services/web/dist/';
const { createApp } = await imp(D + 'app.js'); const { buildConfig } = await imp(D + 'config.js');
const { initDbClient, openDatabase, migrate, pushEvent } = await imp(D + 'db.js'); const { createLogger } = await imp(D + 'log.js');
const client = await imp(ROOT + '/db/dist/client.js');
await initDbClient(ROOT + '/db/dist/client.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(path.join(mediaDir, 'A'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(mediaDir, 'A/img.png'), png); fs.writeFileSync(path.join(mediaDir, 'A/img_t.png'), png);
fs.writeFileSync(path.join(mediaDir, 'A/doc.pdf'), '%PDF-1.4 x'); fs.writeFileSync(path.join(mediaDir, 'A/v.m4a'), Buffer.alloc(200));
const dbFile = path.join(tmp, 'w.db'); const db = openDatabase(dbFile); migrate(db);
const T = Math.floor(Date.now() / 1000) - 600;
const A = '4915111@s.whatsapp.net', G = '123-456@g.us';
client.upsertChat(db, { id: A, name: 'Anna', isGroup: false, lastActivityAt: T + 50 });
client.upsertChat(db, { id: G, name: 'Familie', isGroup: true, lastActivityAt: T + 60 });
const msg = (id, chat, ts, type, text, dir = 'in', sender = 'Anna') =>
  client.insertMessageIfNotExists(db, { id, chatId: chat, sender, waTimestamp: ts, receivedAt: ts, direction: dir, type, text });
msg('m1', A, T + 10, 'text', 'Hallo Welt'); msg('m2', A, T + 20, 'image', 'Foto vom See'); msg('m3', A, T + 30, 'voice', null);
msg('m4', A, T + 40, 'document', 'Rechnung Oktober'); msg('m5', A, T + 50, 'text', 'Antwort', 'out', 'Ich');
msg('g1', G, T + 60, 'text', 'Gruppe Hallo', 'in', 'Onkel Bob');
client.setMediaStatus(db, 'm2', { filePath: 'A/img.png', thumbnailPath: 'A/img_t.png', mimeType: 'image/png', sizeBytes: 70, status: 'ready' });
client.setMediaStatus(db, 'm3', { filePath: 'A/v.m4a', mimeType: 'audio/mp4', sizeBytes: 200, durationSeconds: 4, status: 'ready' });
client.setMediaStatus(db, 'm4', { filePath: 'A/doc.pdf', mimeType: 'application/pdf', sizeBytes: 10, status: 'ready' });
client.setSetting(db, 'connection.status', 'disconnected');
const PORT = 18911, PPORT = 18912;
const cfg = buildConfig({ web: { port: PORT, password_hash: '$argon2id$test', public_dir: ROOT + '/services/web/public/dist', session_secret_file: path.join(tmp, 'k'), cookie_path: '/waread/' }, paths: { db: dbFile, media_dir: mediaDir } });
const running = createApp({ cfg, db, log: createLogger('error', () => {}), verifier: async (h, p) => p === 'pw-test-123456' });
await running.listen();
// Praefix-Proxy wie nginx: /waread/x -> /x
const proxy = http.createServer((req, res) => {
  if (req.url === '/waread') { res.writeHead(301, { location: '/waread/' }); return res.end(); }
  if (!req.url.startsWith('/waread/')) { res.writeHead(404); return res.end('proxy-404'); }
  const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url.slice('/waread'.length), method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
await new Promise((r) => proxy.listen(PPORT, '127.0.0.1', r));
const results = []; const ok = (n, c, d) => results.push([n, !!c, d]);
const browser = await chromium.launch(); const page = await browser.newPage();
const bad = []; page.on('console', (m) => { if (/Content Security Policy|Refused to|violat/i.test(m.text())) bad.push(m.text()); });
const failedReq = []; let loggedIn = false; page.on('response', (r) => { if (r.status() >= 400 && loggedIn && !(r.status() === 400 && /api\/settings/.test(r.url())) && !/\/api\/qr/.test(r.url())) failedReq.push(r.status() + ' ' + r.url()); });
await page.goto(`http://127.0.0.1:${PPORT}/waread/`);
await page.waitForSelector('input[type=password]', { timeout: 8000 });
await page.fill('input[type=password]', 'pw-test-123456'); await page.keyboard.press('Enter');
await page.waitForSelector('text=Anna', { timeout: 8000 }); loggedIn = true;
ok('Chatliste zeigt Anna und Familie', (await page.locator('text=Familie').count()) > 0);
await page.screenshot({ path: tmp + '/list.png' });
await page.click('text=Anna'); await page.waitForSelector('text=Hallo Welt', { timeout: 8000 });
ok('Textnachricht sichtbar', await page.locator('text=Hallo Welt').count() > 0);
ok('Bildunterschrift sichtbar', await page.locator('text=Foto vom See').count() > 0);
ok('Dokument-Unterschrift sichtbar', await page.locator('text=Rechnung Oktober').count() > 0);
const imgOk = await page.evaluate(() => { const i = document.querySelector('.photo img'); return i ? { w: i.naturalWidth, src: i.getAttribute('src') } : null; });
ok('Bild (Thumbnail, relativ) geladen', imgOk && imgOk.w === 1 && /api\/media\/m2\?thumb=1$/.test(imgOk.src), imgOk);
ok('Sprachnachricht-Player da', await page.locator('.has-voice').count() === 1);
ok('Dokument-Kachel "Dokument"', await page.locator('.doc-name', { hasText: 'Dokument' }).count() === 1);
await page.screenshot({ path: tmp + '/chat.png' });
// SSE: neue Nachricht live
msg('live1', A, T + 70, 'text', 'LIVE-NACHRICHT'); pushEvent(db, 'new_message', { chatId: A, messageId: 'live1', type: 'text' });
await page.waitForSelector('text=LIVE-NACHRICHT', { timeout: 8000 }); ok('SSE new_message erscheint live (Ingest-Payload ohne message)', true);
// Einstellungen
await page.goto(`http://127.0.0.1:${PPORT}/waread/#/settings`);
await page.waitForSelector('text=Download-Regeln', { timeout: 8000 });
const selCount = await page.locator('select[aria-label^="Download-Regel"]').count();
ok('4 Download-Regeln', selCount === 4, selCount);
await page.selectOption('select[aria-label="Download-Regel Videos"]', 'auto');
await page.selectOption('select[aria-label="Größenlimit Videos"]', '100');
await page.click('button:has-text("Speichern")'); await page.waitForSelector('text=Gespeichert', { timeout: 5000 });
const saved = JSON.parse(client.getSetting(db, 'downloadRules'));
ok('downloadRules in settings gespeichert (video auto/100)', saved.video?.mode === 'auto' && saved.video?.maxMb === 100, saved);
// Fehlerfall Medien > Nachrichten
await page.selectOption('select[aria-label="Aufbewahrung Medien"]', '14');
await page.click('button:has-text("Speichern")'); await page.waitForSelector('text=nicht länger aufbewahrt', { timeout: 5000 });
ok('Fehlertext Medien-Aufbewahrung', true);
await page.screenshot({ path: tmp + '/settings.png', fullPage: true });
// Speicher-Anzeige
ok('Speicherkarte zeigt Typen', await page.locator('text=Nach Typ').count() > 0);
// Verbindung
await page.goto(`http://127.0.0.1:${PPORT}/waread/#/connection`);
await page.waitForSelector('button:has-text("Neu verbinden")', { timeout: 8000 });
await page.click('button:has-text("Neu verbinden")');
await page.waitForTimeout(500);
ok('Neu verbinden schreibt connection.command', client.getSetting(db, 'connection.command') === 'connect');
// needs_qr
client.setSetting(db, 'connection.status', 'needs_qr'); client.setSetting(db, 'connection.qr', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
pushEvent(db, 'connection_status', { state: 'needs_qr', hasQr: true });
await page.waitForSelector('img.qr', { timeout: 10000 }); ok('QR wird angezeigt', true);
await page.screenshot({ path: tmp + '/conn.png' });
ok('keine CSP-Verletzungen', bad.length === 0, bad);
ok('keine fehlgeschlagenen Requests', failedReq.length === 0, failedReq);
await browser.close(); proxy.close(); await running.close?.();
let fail = 0; for (const [n, c, d] of results) { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(d))); }
console.log(`${results.length - fail}/${results.length}; screenshots: ${tmp}`); process.exit(fail ? 1 : 0);
