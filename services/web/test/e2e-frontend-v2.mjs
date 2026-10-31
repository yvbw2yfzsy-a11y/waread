// Optionaler Browser-Test fuer die Oberflaeche ab Datenbank-Version 2 (nicht Teil von `npm test`):
// Zitate, Bearbeitungsverlauf, "Vom Absender geloescht", Schild, Einmal-Medien, "Medium jetzt laden", Stumm,
// Sprachnachricht-Layout, Speicher leeren in zwei Wegen, Zwei-Spalten-Layout mit langer Chatliste.
// Voraussetzungen: alles gebaut (npm run build), Playwright mit Chromium (NICHT in package.json:
// `npm install --no-save playwright && npx playwright install chromium`). Aufruf: node test/e2e-frontend-v2.mjs
// Startet den echten Web-Dienst mit echtem db/dist/client.js auf 127.0.0.1:18941 und fuellt eine temporaere Datenbank.
// Der Ingest laeuft hier nicht: Der Befehl "Medium jetzt laden" wird nur auf Ablage in ingest_commands geprueft.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const imp = (p) => import(pathToFileURL(p).href);
const D = ROOT + '/services/web/dist/';
const { createApp } = await imp(D + 'app.js');
const { buildConfig } = await imp(D + 'config.js');
const { initDbClient, openDatabase, migrate } = await imp(D + 'db.js');
const { createLogger } = await imp(D + 'log.js');
const client = await imp(ROOT + '/db/dist/client.js');
await initDbClient(ROOT + '/db/dist/client.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e2-'));
const mediaDir = path.join(tmp, 'media');
fs.mkdirSync(path.join(mediaDir, 'A'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const put = (name, buf) => fs.writeFileSync(path.join(mediaDir, 'A', name), buf);
put('img.png', png); put('img_t.png', png); put('sticker.webp', webp); put('voice.m4a', Buffer.alloc(300));
put('doc1__Mietvertrag Entwurf.pdf', Buffer.from('%PDF-1.4 x'));

const dbFile = path.join(tmp, 'w.db');
const db = openDatabase(dbFile);
migrate(db);
const now = Math.floor(Date.now() / 1000);
const MIN = 60, H = 3600, DAY = 86400;
const A = '4915111222333@s.whatsapp.net', G = '120363111-1612345678@g.us', G2 = '120363999888777-1599999999@g.us';
const PAK = '4915222000118@s.whatsapp.net';
const chat = (id, name, isGroup, last) => client.upsertChat(db, { id, name, isGroup, lastActivityAt: last });
const tt = (h, m) => now - h * H - m * MIN;
function mv(chatId, id, ts, type, text, o = {}) {
  client.insertMessageIfNotExists(db, {
    id, chatId, sender: o.sender ?? (o.dir === 'out' ? 'Ich' : 'Anna'), waTimestamp: ts, receivedAt: ts, direction: o.dir ?? 'in', type,
    ...(text ? { text } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(o.replyText ? { replyText: o.replyText } : {}),
    ...(o.replySender ? { replySender: o.replySender } : {}), ...(o.replyType ? { replyType: o.replyType } : {}), ...(o.viewOnce ? { viewOnce: true } : {}),
  });
  if (o.media) client.setMediaStatus(db, id, o.media);
}
const ready = (file, mime, size, extra = {}) => ({ filePath: `A/${file}`, mimeType: mime, sizeBytes: size, status: 'ready', ...extra });

chat(A, 'Anna Schneider', false, tt(0, 5));
mv(A, 'a0', tt(5, 0), 'text', 'Wann kommst du morgen? Wir wollten gegen 18 Uhr essen.');
client.markSeen(db, { chatId: A, all: true });
mv(A, 'q1', tt(1, 10), 'text', 'Wann kommst du morgen?');
mv(A, 'q2', tt(1, 9), 'text', 'Gegen sechs.', { dir: 'out', replyTo: 'q1' });
mv(A, 'q3', tt(1, 8), 'text', 'Das war eine Antwort auf eine alte Nachricht.', { replyTo: 'weg-1', replyText: 'Bringst du den Kuchen mit?', replySender: 'Bert', replyType: 'text' });
mv(A, 'q4', tt(1, 7), 'text', 'Antwort auf ein Foto', { replyTo: 'weg-2', replyType: 'image', replySender: 'Lisa' });
mv(A, 'e1', tt(1, 6), 'text', 'Treffen um 18 Uhr am Bahnhof');
client.applyMessageEdit(db, 'e1', 'Treffen um 18:30 Uhr am Bahnhof', tt(1, 5));
client.applyMessageEdit(db, 'e1', 'Treffen um 19 Uhr am Hauptbahnhof', tt(1, 4));
mv(A, 'd1', tt(1, 3), 'text', 'Das hier habe ich wohl besser nicht geschrieben.');
client.markMessageDeleted(db, 'd1', tt(1, 2));
mv(A, 'd2', tt(1, 2), 'image', 'Gelöschtes Foto', { media: ready('img.png', 'image/png', 70, { thumbnailPath: 'A/img_t.png' }) });
client.markMessageDeleted(db, 'd2', tt(1, 1));
mv(A, 'p1', tt(1, 0), 'text', 'Die Adresse: Hafenstraße 12, Rostock. Bitte aufheben!');
client.setMessageProtected(db, 'p1', true, tt(0, 50));
mv(A, 'o1', tt(0, 45), 'system', 'Einmal-Foto (nicht gespeichert)', { viewOnce: true });
mv(A, 'o2', tt(0, 44), 'image', null, { viewOnce: true, media: ready('img.png', 'image/png', 70, { thumbnailPath: 'A/img_t.png' }) });
mv(A, 'o3', tt(0, 43), 'voice', null, { viewOnce: true, media: ready('voice.m4a', 'audio/mp4', 300, { durationSeconds: 21 }) });
client.setMessageProtected(db, 'o3', true, tt(0, 40));
mv(A, 'l1', tt(0, 42), 'video', 'Video, nicht geladen', { media: { mimeType: 'video/mp4', sizeBytes: 38 * 1024 * 1024, durationSeconds: 94, status: 'expired', skipReason: 'rule_off', loadable: true } });
mv(A, 'l2', tt(0, 41), 'image', null, { media: { mimeType: 'image/jpeg', sizeBytes: 14 * 1024 * 1024, status: 'failed', skipReason: 'too_large', loadable: true } });
mv(A, 'l3', tt(0, 39), 'video', null, { media: { mimeType: 'video/mp4', sizeBytes: 2 * 1024 * 1024, status: 'expired', skipReason: 'retention' } });
mv(A, 'l4', tt(0, 38), 'image', null, { media: { mimeType: 'image/jpeg', status: 'expired' } });
mv(A, 'doc1', tt(0, 37), 'document', null, { media: ready('doc1__Mietvertrag Entwurf.pdf', 'application/pdf', 182400) });
mv(A, 's1', tt(0, 36), 'image', null, { media: ready('sticker.webp', 'image/webp', webp.length) });
mv(A, 'f1', tt(0, 35), 'text', 'Ich schreibe *fett*, _kursiv_, ~weg~ und `code`: https://example.org/a_b_c');
mv(A, 'last', tt(0, 5), 'text', 'Bis später!');

chat(G, 'Familie', true, tt(0, 12));
mv(G, 'g1', tt(0, 12), 'text', 'Wer bringt am Sonntag den Kuchen mit?', { sender: 'Lisa' });
chat(G2, '', true, tt(2, 0));
mv(G2, 'n1', tt(2, 0), 'text', 'Hallo zusammen, ich bin neu hier.', { sender: 'Unbekannt' });
chat('4915222000111@s.whatsapp.net', 'Bob Meier', false, tt(0, 30));
mv('4915222000111@s.whatsapp.net', 'b1', tt(0, 30), 'voice', null, { sender: 'Bob Meier', media: ready('voice.m4a', 'audio/mp4', 300, { durationSeconds: 63 }) });
chat('4915222000112@s.whatsapp.net', 'Dr. Katharina von Hohenstein-Schwarzenberg (Praxis)', false, tt(0, 55));
mv('4915222000112@s.whatsapp.net', 'k1', tt(0, 55), 'text', 'Ihr Termin ist bestätigt.', { sender: 'Praxis' });
chat('4915222000114@s.whatsapp.net', '+49 152 22000114', false, tt(3, 0));
mv('4915222000114@s.whatsapp.net', 'n2', tt(3, 0), 'text', 'Ihre Sendung wird heute zugestellt.', { sender: '+49 152 22000114' });
chat(PAK, 'Paketdienst', false, tt(0, 40));
for (let i = 0; i < 120; i++) mv(PAK, `pk${i}`, now - 2 * DAY + i * 1200, 'text', `Statusmeldung ${i + 1}`, { sender: 'Paketdienst' });
// Viele Chats: die Liste ist hoeher als das Fenster (Fehlerbild des Zwei-Spalten-Layouts)
for (let i = 1; i <= 14; i++) {
  const id = `49152300${String(i).padStart(4, '0')}@s.whatsapp.net`;
  chat(id, `Kontakt ${i}`, false, tt(6 + i, 0));
  mv(id, `kc${i}`, tt(6 + i, 0), 'text', `Nachricht von Kontakt ${i}`, { sender: `Kontakt ${i}` });
  client.markSeen(db, { chatId: id, all: true });
}
client.setSetting(db, 'chat.muted', JSON.stringify([PAK]));
client.setSetting(db, 'connection.status', 'connected');
client.setSetting(db, 'connection.since', String(now - 6 * H));

const PORT = 18941;
const cfg = buildConfig({ web: { port: PORT, password_hash: '$argon2id$test', public_dir: ROOT + '/services/web/public/dist', session_secret_file: path.join(tmp, 'k') }, paths: { db: dbFile, media_dir: mediaDir } });
const running = createApp({ cfg, db, log: createLogger('error', () => {}), verifier: async (h, p) => p === 'pw-test-123456' });
await running.listen();
const BASE = `http://127.0.0.1:${PORT}/`;

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); } };
const dbq = (sql, ...p) => db.prepare(sql).all(...p);

const browser = await chromium.launch();
const problems = [];
async function open(kind) {
  const opts = kind === 'phone'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', timezoneId: 'Europe/Berlin' };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/401/.test(m.text())) problems.push(`[${kind}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${kind}] pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.fill('input[type=password]', 'pw-test-123456');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-item', { timeout: 10000 });
  return { ctx, page };
}
const settle = (page, ms = 500) => page.waitForTimeout(ms);
const row = (page, id) => page.locator(`.msg-row[data-id="${id}"]`);

// ---- Chatliste ----
{
  const { ctx, page } = await open('phone');
  await settle(page, 800);
  const item = (t) => page.locator('.chat-item', { hasText: t }).first();
  ok('Liste: Sprachnachricht zeigt Dauer 1:03', (await item('Bob Meier').innerText()).includes('1:03'));
  ok('Liste: Gruppenvorschau mit Absender', (await item('Familie').locator('.chat-preview').innerText()).startsWith('Lisa:'));
  ok('Liste: namenlose Gruppe lesbar', (await item('Unbenannte Gruppe').count()) === 1);
  ok('Liste: Initialen "KP"', (await item('Hohenstein').locator('.avatar').innerText()).trim() === 'KP');
  ok('Liste: Rufnummer als Name -> "#"', (await item('+49 152').locator('.avatar').innerText()).trim() === '#');
  const pak = item('Paketdienst');
  ok('Liste: stummer Chat mit Symbol, ohne Neu-Zeichen', (await pak.locator('.chat-muted').count()) === 1 && (await pak.locator('.badge-new').count()) === 0);
  ok('Tab-Zaehler zaehlt stumme Chats nicht', (await page.locator('.tab-badge').innerText().catch(() => '')) !== '99+');
  await ctx.close();
}

// ---- Desktop-Layout mit langer Chatliste ----
{
  const { ctx, page } = await open('desktop');
  await page.click('.chat-item:has-text("Anna Schneider")');
  await page.waitForSelector('.msg-row');
  await settle(page, 1200);
  const m = await page.evaluate(() => ({
    inner: innerHeight, doc: document.documentElement.scrollHeight,
    nav: document.querySelector('.glass-nav')?.getBoundingClientRect().bottom ?? 0,
    footer: document.querySelector('.readonly-bar')?.getBoundingClientRect().bottom ?? 0,
  }));
  ok('Desktop: Seite scrollt nicht, Navigation und Fussleiste im Fenster', m.doc === m.inner && m.nav <= m.inner && m.footer <= m.inner, m);
  await ctx.close();
}

// ---- Chat ----
let anna;
{
  const { ctx, page } = await open('phone');
  anna = { ctx, page };
  await page.click('.chat-item:has-text("Anna Schneider")');
  await page.waitForSelector('.msg-row');
  await settle(page, 1800);
  ok('Chat: schmale Leiste statt schwebender Pille', (await page.locator('.new-bar:not([hidden])').count()) === 1 && (await page.locator('.seen-pill').count()) === 0);
  const bar = await page.locator('.new-bar').boundingBox();
  const head = await page.locator('.chat-head').boundingBox();
  ok('Leiste liegt direkt unter der Kopfzeile', Math.abs(bar.y - (head.y + head.height)) <= 1, [bar, head]);
  await page.evaluate(() => document.querySelector('.messages').scrollTo(0, 99999));
  await settle(page, 600);

  const q2 = row(page, 'q2');
  await q2.scrollIntoViewIfNeeded();
  const q2t = await q2.locator('.quote').innerText();
  ok('Zitat mit Original: Name und Text', q2t.includes('Anna') && q2t.includes('Wann kommst du morgen?'), q2t);
  const q3t = await row(page, 'q3').locator('.quote').innerText();
  ok('Zitat ohne Original: Kurzzitat und Absender', q3t.includes('Bert') && q3t.includes('Bringst du den Kuchen mit?'), q3t);
  const q4t = await row(page, 'q4').locator('.quote').innerText();
  ok('Zitat ohne Text: Absender und Art', q4t.includes('Lisa') && q4t.includes('Foto'), q4t);
  ok('Zitat ohne Original nicht anklickbar, mit Original anklickbar', (await row(page, 'q3').locator('.quote-link').count()) === 0 && (await q2.locator('.quote-link').count()) === 1);

  const e1 = row(page, 'e1');
  await e1.scrollIntoViewIfNeeded();
  await e1.locator('.meta-edit').click();
  await page.waitForSelector('.modal-panel .version');
  const vt = await page.locator('.modal-panel').innerText();
  ok('Versionen: Original, Fassung 2, Aktuell', vt.includes('Original') && vt.includes('Treffen um 18 Uhr am Bahnhof') && vt.includes('Fassung 2') && vt.includes('18:30') && vt.includes('Aktuell') && vt.includes('19 Uhr am Hauptbahnhof'), vt);
  await page.keyboard.press('Escape');
  ok('Versionen: Escape schliesst', (await page.locator('.modal-panel').count()) === 0);

  const d1t = await row(page, 'd1').innerText();
  ok('Geloescht: Beschriftung und Text sichtbar', d1t.includes('Vom Absender gelöscht') && d1t.includes('besser nicht geschrieben'), d1t);
  ok('Geloescht (Foto): Beschriftung, Bild noch da', (await row(page, 'd2').innerText()).includes('Vom Absender gelöscht') && (await row(page, 'd2').locator('.photo').count()) === 1);

  const p1 = row(page, 'p1');
  await p1.scrollIntoViewIfNeeded();
  ok('Schild: Symbol an geschuetzter Nachricht', (await p1.locator('.meta-shield').count()) === 1);
  await p1.locator('.text').click({ position: { x: 20, y: 10 } });
  await page.waitForSelector('.modal-panel.sheet');
  ok('Sheet: bei geschuetzter Nachricht "Schutz aufheben"', (await page.locator('.sheet-item', { hasText: 'Schutz aufheben' }).count()) === 1);
  await page.keyboard.press('Escape');

  const q1 = row(page, 'q1');
  await q1.scrollIntoViewIfNeeded();
  await q1.locator('.text').click({ position: { x: 20, y: 10 } });
  await page.waitForSelector('.modal-panel.sheet');
  await page.locator('.sheet-item', { hasText: 'Mit Schild schützen' }).click();
  await page.waitForSelector('.toast');
  await settle(page, 400);
  ok('Schild setzen: Datenbank und Symbol', dbq("SELECT protected_at FROM messages WHERE id = 'q1'")[0]?.protected_at > 0 && (await q1.locator('.meta-shield').count()) === 1);

  ok('Einmal (nicht gespeichert): Hinweistext', (await row(page, 'o1').innerText()).includes('nicht gespeichert'));
  ok('Einmal-Foto: Beschriftung und Bild', (await row(page, 'o2').locator('.tag-once').innerText()).includes('Einmal-Foto') && (await row(page, 'o2').locator('.photo').count()) === 1);
  const o3 = row(page, 'o3');
  ok('Einmal-Sprachnachricht: Beschriftung, Player, Schild', (await o3.locator('.tag-once').innerText()).includes('Einmal-Sprachnachricht') && (await o3.locator('.voice').count()) === 1 && (await o3.locator('.meta-shield').count()) === 1);

  const l1 = row(page, 'l1');
  await l1.scrollIntoViewIfNeeded();
  const l1t = await l1.innerText();
  ok('Platzhalter Video: Groesse, Grund, Knopf, kein falscher Text', l1t.includes('38,0 MB') && l1t.includes('Download-Regel') && l1t.includes('Jetzt laden') && !l1t.includes('Aufbewahrung gelöscht'), l1t);
  const l2t = await row(page, 'l2').innerText();
  ok('Platzhalter zu gross: Text und Knopf', l2t.includes('Zu groß') && l2t.includes('Jetzt laden'), l2t);
  const l3t = await row(page, 'l3').innerText();
  ok('Platzhalter nach Aufbewahrung: ehrlicher Text, kein Knopf', l3t.includes('Nach Ablauf der Aufbewahrung gelöscht') && !l3t.includes('Jetzt laden'), l3t);
  ok('Platzhalter ohne bekannten Grund: neutraler Text', (await row(page, 'l4').innerText()).includes('Datei nicht (mehr) gespeichert'));
  await l1.locator('button:has-text("Jetzt laden")').click();
  await settle(page, 600);
  const cmds = dbq('SELECT type, payload_json FROM ingest_commands');
  ok('Jetzt laden: Befehl liegt in der Datenbank, Platzhalter zeigt "Wird geladen"', cmds.length === 1 && cmds[0].type === 'load_media' && JSON.parse(cmds[0].payload_json).messageId === 'l1' && (await l1.innerText()).includes('Wird geladen'), cmds);

  const f1 = row(page, 'f1');
  await f1.scrollIntoViewIfNeeded();
  ok('Formatierung: fett, kursiv, durchgestrichen, Code; Link bleibt heil', (await f1.locator('strong').innerText()) === 'fett' && (await f1.locator('em').innerText()) === 'kursiv' && (await f1.locator('s').innerText()) === 'weg' && (await f1.locator('.mono').innerText()) === 'code' && (await f1.locator('a.link').innerText()) === 'https://example.org/a_b_c');
  const mf = await page.request.get(BASE + 'manifest.webmanifest');
  const icon = await page.request.get(BASE + 'apple-touch-icon.png');
  ok('Manifest und Home-Bildschirm-Symbol werden ausgeliefert', mf.ok() && (await mf.json()).name === 'waread' && icon.ok() && (icon.headers()['content-type'] ?? '').includes('image/png'), [mf.status(), icon.status()]);

  const doc = row(page, 'doc1');
  await doc.scrollIntoViewIfNeeded();
  ok('Dokument zeigt den Dateinamen, Download traegt ihn', (await doc.locator('.doc-name').innerText()) === 'Mietvertrag Entwurf.pdf' && (await doc.locator('.doc-dl').getAttribute('download')) === 'Mietvertrag Entwurf.pdf');
  const st = row(page, 's1');
  await st.scrollIntoViewIfNeeded();
  ok('Sticker: kleine Darstellung ohne Blase', (await st.locator('.photo.sticker').count()) === 1 && (await st.locator('.bubble.is-sticker').count()) === 1);

  await o3.scrollIntoViewIfNeeded();
  const wave = await o3.locator('.wave').boundingBox();
  const speed = await o3.locator('.speed').boundingBox();
  const play = await o3.locator('.play').boundingBox();
  const bub = await o3.locator('.bubble').boundingBox();
  const gap = speed.x - (wave.x + wave.width);
  ok('Geschwindigkeitstaste rechts neben der Audiospur, kleiner Abstand, in der Blase', gap >= 4 && gap <= 16 && Math.abs(speed.y + speed.height / 2 - (play.y + play.height / 2)) < 12 && speed.x + speed.width <= bub.x + bub.width + 0.5, { gap, speed, wave });
  ok('Taste mindestens 44 x 40 px, Audiospur mindestens 100 px', speed.width >= 44 && speed.height >= 40 && wave.width >= 100, { speed, wave });

  await page.evaluate(() => document.querySelector('.messages').scrollTo(0, 0));
  await page.locator('.chat-head .mute').click();
  await settle(page, 500);
  ok('Stumm: gespeichert und Knopf gedrueckt', dbq("SELECT value FROM settings WHERE key = 'chat.muted'")[0].value.includes('4915111222333') && (await page.locator('.chat-head .mute').getAttribute('aria-pressed')) === 'true');
  await page.locator('.chat-head .mute').click();
  await settle(page, 400);
  ok('Stumm wieder aus', !dbq("SELECT value FROM settings WHERE key = 'chat.muted'")[0].value.includes('4915111222333'));

  // Profilbild: Oeffnen eines Chats legt (nur bei eingeschaltetem Abruf) einen Befehl fuer den Ingest ab, sonst nichts.
  const avatarCmds = () => dbq("SELECT payload_json AS p FROM ingest_commands WHERE type = 'refresh_avatar'").map((x) => JSON.parse(x.p).chatId);
  ok('Profilbild aus: Oeffnen legt keinen Befehl ab', avatarCmds().length === 0, avatarCmds());
  client.setSetting(db, 'avatars.enabled', '1');
  await page.evaluate((id) => { location.hash = '#/chats/' + encodeURIComponent(id); }, '4915222000111@s.whatsapp.net');
  await page.waitForSelector('.msg-row[data-id="b1"]');
  await settle(page, 500);
  ok('Profilbild an: Oeffnen legt genau einen Befehl fuer diesen Chat ab', avatarCmds().join() === '4915222000111@s.whatsapp.net', avatarCmds());
  client.setSetting(db, 'avatars.enabled', '0');
  await page.evaluate((id) => { location.hash = '#/chats/' + encodeURIComponent(id); }, A);
  await page.waitForSelector('.msg-row');
}

// ---- Einstellungen und Loeschwege ----
{
  const page = anna.page;
  await page.evaluate(() => { location.hash = '#/settings'; });
  await settle(page, 1500);
  const sel = await page.locator('.form-row.stack').first().locator('select').nth(1).boundingBox();
  ok('Download-Regeln: Auswahlfelder gestapelt und breit genug', sel.width >= 120, sel);
  const card = page.locator('.card.danger-zone');
  await card.scrollIntoViewIfNeeded();
  const usageText = await page.locator('.protected-line').innerText();
  ok('Speicher nennt geschuetzte Nachrichten und "kein Backup"', usageText.includes('Mit Schild geschützt') && usageText.includes('kein Backup'), usageText);
  await card.locator('select').first().selectOption('all');
  await settle(page, 300);
  ok('Zwei getrennte Knoepfe zum Leeren', (await card.locator('button:has-text("ohne geschützte")').count()) === 1 && (await card.locator('button:has-text("auch geschützte")').count()) === 1);
  const protectedBefore = dbq('SELECT COUNT(*) AS n FROM messages WHERE protected_at IS NOT NULL')[0].n;
  ok('Vorbedingung: geschuetzte Nachrichten vorhanden', protectedBefore >= 3, protectedBefore);

  await card.locator('button:has-text("ohne geschützte")').click();
  await settle(page, 300);
  const panel1 = await card.locator('.confirm-panel').innerText();
  ok('Weg 1: Text nennt, dass geschuetzte bleiben und welches Wort', panel1.includes('außer den geschützten') && panel1.includes('bleiben erhalten') && panel1.includes('LÖSCHEN'), panel1);
  const go1 = card.locator('.confirm-panel .btn.danger');
  ok('Weg 1: Knopf zunaechst gesperrt', await go1.isDisabled());
  await card.locator('.confirm-panel input').fill('GESCHÜTZTE LÖSCHEN');
  ok('Weg 1: das Wort des extremen Wegs reicht nicht', await go1.isDisabled());
  await card.locator('.confirm-panel input').fill('löschen');
  ok('Weg 1: "löschen" (klein) schaltet frei', !(await go1.isDisabled()));
  await go1.click();
  await page.waitForSelector('.toast');
  await settle(page, 800);
  ok('Weg 1: nur geschuetzte Nachrichten bleiben', dbq('SELECT COUNT(*) AS n FROM messages')[0].n === protectedBefore, [dbq('SELECT COUNT(*) AS n FROM messages')[0].n, protectedBefore]);
  ok('Weg 1: Dateien geschuetzter Medien bleiben', dbq("SELECT COUNT(*) AS n FROM media WHERE status = 'ready'")[0].n >= 1);

  await card.scrollIntoViewIfNeeded();
  await card.locator('select').first().selectOption('all');
  await card.locator('button:has-text("auch geschützte")').click();
  await settle(page, 300);
  const panel2 = await card.locator('.confirm-panel').innerText();
  ok('Weg 2: extremer Schritt gekennzeichnet, Zahl, "kein Backup", Wort', panel2.includes('Extremer Schritt') && panel2.includes(`${protectedBefore} geschützte`) && panel2.includes('kein Backup') && panel2.includes('GESCHÜTZTE LÖSCHEN'), panel2);
  const go2 = card.locator('.confirm-panel .btn.danger');
  await card.locator('.confirm-panel input').fill('LÖSCHEN');
  ok('Weg 2: das normale Wort reicht nicht', await go2.isDisabled());
  await card.locator('.confirm-panel input').fill('geschützte löschen');
  ok('Weg 2: eigenes Wort schaltet frei', !(await go2.isDisabled()));
  await go2.click();
  await settle(page, 1200);
  ok('Weg 2: alles weg, auch geschuetzte, Versionen und Suchindex', dbq('SELECT COUNT(*) AS n FROM messages')[0].n === 0 && dbq('SELECT COUNT(*) AS n FROM message_versions')[0].n === 0 && dbq('SELECT COUNT(*) AS n FROM messages_fts')[0].n === 0);
  await anna.ctx.close();
}

ok('keine Konsolenfehler, Warnungen oder CSP-Verletzungen', problems.length === 0, problems);
await browser.close();
await running.close?.();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
for (const f of failures) console.log('FAIL: ' + f);
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
