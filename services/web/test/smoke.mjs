// Smoke-Test des Web-Dienstes (Zusatz, nicht Teil der geforderten Lieferung).
//
//   npm run build -w @waread/db && npm run build -w waread-web && npm test -w waread-web
//   SMOKE_DB_MODULE=/pfad/zu/db/dist/client.js SMOKE_PORT=18787 npm test -w waread-web
//
// Startet den kompilierten Dienst (dist/) auf 127.0.0.1:SMOKE_PORT (und SMOKE_PORT+1) mit einer temporaeren
// Datenbank und prueft die HTTP-Schnittstelle (Auth, Rate-Limit, Range, Suche, Einstellungen, Speicher, SSE,
// Verbindungsstatus/QR aus der settings-Tabelle, POST /api/connect ...).
// Datenbankseite: der ECHTE, kompilierte db/dist/client.js (Schema, Trigger, FTS-Mapping inklusive).
// Das Argon2-Paket wird durch eine Testpruefung ersetzt; hash-wasm und qrcode werden hier NICHT geprueft.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.resolve(HERE, '../dist') + '/';
const dbModulePath = process.env.SMOKE_DB_MODULE ?? path.resolve(HERE, '../../../db/dist/client.js');
const imp = (p) => import(pathToFileURL(p).href);
const { createApp } = await imp(D + 'app.js');
const { buildConfig } = await imp(D + 'config.js');
const { openDatabase, migrate, pushEvent, initDbClient, DbModuleError } = await imp(D + 'db.js');
const { createLogger } = await imp(D + 'log.js');
const { Auth, LoginLimiter } = await imp(D + 'auth.js');
const { parseRange } = await imp(D + 'files.js');
const { buildFtsQuery } = await imp(D + 'queries.js');
const clientNs = await imp(dbModulePath);
const client = { ...(clientNs.default ?? {}), ...clientNs };

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Umgebung ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-'));
const mediaDir = path.join(tmp, 'media');
const pubDir = path.join(tmp, 'public');
fs.mkdirSync(path.join(mediaDir, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(mediaDir, 'A/2023-11-14'), { recursive: true });
fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOPSECRET');
fs.writeFileSync(path.join(pubDir, 'index.html'), '<!doctype html><title>x</title>INDEX');
fs.writeFileSync(path.join(pubDir, 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(pubDir, '.env'), 'HIDDEN');
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256));
const imgBuf = bytes(2000, 1), voiceBuf = bytes(1000, 2), vidBuf = bytes(500, 3);
fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/a3.jpg'), imgBuf);
fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/a3_thumb.jpg'), bytes(100, 9));
fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/a4.m4a'), voiceBuf);
fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/doc.pdf'), Buffer.from('%PDF-1.4 fake'));
fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
fs.mkdirSync(path.join(mediaDir, 'G/2023-11-14'), { recursive: true });
fs.writeFileSync(path.join(mediaDir, 'G/2023-11-14/video.mp4'), vidBuf);
fs.writeFileSync(path.join(mediaDir, 'avatars/anna.jpg'), bytes(300, 5));
fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(mediaDir, 'link.jpg'));
// F18/O2: Geschwisterordner, dessen Name mit dem Namen des Media-Roots BEGINNT ("media" -> "media-evil").
fs.mkdirSync(path.join(tmp, 'media-evil'));
fs.writeFileSync(path.join(tmp, 'media-evil', 'x.jpg'), 'EVIL-SIBLING');

// DB-Modul-Laden: Fehlerfaelle, dann Standardsuche (../../db/dist/client.js relativ zu services/web)
for (const [label, p] of [['fehlender Pfad', '/nicht/vorhanden.js']]) {
  try { await initDbClient(p); ok('initDbClient ' + label + ' wirft DbModuleError', false); }
  catch (e) { ok('initDbClient ' + label + ' wirft DbModuleError', e instanceof DbModuleError && e.message.includes('/nicht/vorhanden.js'), String(e.message)); }
}
{
  const bad = path.join(tmp, 'bad-client.cjs');
  fs.writeFileSync(bad, 'exports.openDb = () => 1;');
  try { await initDbClient(bad); ok('initDbClient unvollstaendiges Modul wirft', false); }
  catch (e) { ok('initDbClient unvollstaendiges Modul wirft mit Funktionsliste', e instanceof DbModuleError && /runMigrations/.test(e.message) && /pullEventsSince/.test(e.message), String(e.message)); }
}
await initDbClient(dbModulePath);
const dbFile = path.join(tmp, 'waread.db');
const db = openDatabase(dbFile);
migrate(db);
const T = 1_700_000_000;
const A = '4915111@s.whatsapp.net', G = '12345-678@g.us', E = 'leer@s.whatsapp.net', N = 'nonname@s.whatsapp.net', X = 'trav@s.whatsapp.net';
client.upsertChat(db, { id: A, name: 'Anna', isGroup: false, avatarPath: 'avatars/anna.jpg', lastActivityAt: T + 11 });
client.upsertChat(db, { id: G, name: 'Familie', isGroup: true, lastActivityAt: T + 21 });
client.upsertChat(db, { id: E, name: 'Leer', isGroup: false, lastActivityAt: T });
client.upsertChat(db, { id: N, name: '', isGroup: false, lastActivityAt: T + 30 });
client.upsertChat(db, { id: X, name: 'Trav', isGroup: false, lastActivityAt: T + 40 });
const msg = (id, chatId, ts, type, text, direction = 'in', extra = {}) =>
  client.insertMessageIfNotExists(db, { id, chatId, sender: 'sender-' + id, waTimestamp: ts, receivedAt: ts + 1, direction, type, text, ...extra });
msg('a1', A, T + 1, 'text', 'Hallo Welt GEHEIMTEXT');
msg('a2', A, T + 2, 'text', 'Grüße aus Berlin');
msg('a3', A, T + 3, 'image', 'Foto vom See');
msg('a4', A, T + 4, 'voice', '');
msg('a5', A, T + 5, 'text', 'Antwort von mir', 'out');
msg('a6', A, T + 6, 'document', 'Rechnung');
msg('a7', A, T + 7, 'image', 'boese');
msg('a8', A, T + 8, 'text', 'geloeschter Text');
msg('a9', A, T + 9, 'image', 'noch nicht geladen');
msg('a10', A, T + 10, 'text', 'gleiche Sekunde eins');
msg('a11', A, T + 10, 'text', 'gleiche Sekunde zwei');
msg('g1', G, T + 20, 'text', 'Gruppe Hallo');
msg('g2', G, T + 21, 'video', 'Film');
msg('n1', N, T + 30, 'text', 'Nummer');
msg('x1', X, T + 40, 'image', 'traversal');
msg('x2', X, T + 41, 'image', 'symlink');
db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run('a8');
client.setMediaStatus(db, 'a3', { filePath: 'A/2023-11-14/a3.jpg', thumbnailPath: 'A/2023-11-14/a3_thumb.jpg', mimeType: 'image/jpeg', sizeBytes: 2000, status: 'ready' });
client.setMediaStatus(db, 'a4', { filePath: path.join(mediaDir, 'A/2023-11-14/a4.m4a'), mimeType: 'audio/mp4', sizeBytes: 1000, durationSeconds: 3.5, status: 'ready' });
client.setMediaStatus(db, 'a6', { filePath: 'A/2023-11-14/doc.pdf', mimeType: 'application/pdf', sizeBytes: 13, status: 'ready' });
client.setMediaStatus(db, 'a7', { filePath: 'A/2023-11-14/evil.svg', mimeType: 'image/svg+xml', sizeBytes: 100, status: 'ready' });
client.setMediaStatus(db, 'a9', { status: 'pending' });
client.setMediaStatus(db, 'g2', { filePath: 'G/2023-11-14/video.mp4', mimeType: 'video/mp4', sizeBytes: 500, status: 'ready' });
client.setMediaStatus(db, 'x1', { filePath: '../secret.txt', mimeType: 'image/jpeg', sizeBytes: 9, status: 'ready' });
client.setMediaStatus(db, 'x2', { filePath: 'link.jpg', mimeType: 'image/jpeg', sizeBytes: 9, status: 'ready' });
db.prepare('UPDATE media SET status = ? WHERE message_id = ?').run('ready', 'a3'); // sicherstellen

const logs = [];
const log = createLogger('debug', (l) => logs.push(l));
const PORT = Number(process.env.SMOKE_PORT ?? 18787);
const cfg = buildConfig({
  // passkey_file im Temp-Ordner: Der Standardpfad /var/lib/waread/passkeys.json gehört auf einem Pi mit installiertem waread dem
  // Benutzer waread. Ein anderer Benutzer (z. B. beim Bau durch install.sh) bekäme "unlesbar", die Sperre bliebe zu, kein Login ginge.
  web: { port: PORT, password_hash: '$argon2id$test', public_dir: pubDir, session_secret_file: path.join(tmp, 'session.key'), passkey_file: path.join(tmp, 'none.json'), login_max_attempts: 5, hide_deleted_content: true },
  paths: { db: dbFile, media_dir: mediaDir },
});
const fakeVerifier = async (hash, pw) => { await sleep(5); return hash === '$argon2id$test' && pw === 'correct horse battery'; };
const running = createApp({ cfg, db, log, verifier: fakeVerifier });
await running.listen();

// ---------- HTTP-Helfer ----------
function call(method, p, o = {}, port = PORT) {
  // Wie die Oberflaeche (api.ts): Schreibende Anfragen tragen immer application/json, auch ohne Daten ("{}"). `raw: true`
  // schickt sie ohne Content-Type, um die Sperre selbst zu pruefen.
  if (o.body === undefined && (method === 'POST' || method === 'PUT') && !o.raw) o = { ...o, body: {} };
  return new Promise((resolve, reject) => {
    const headers = { ...(o.headers ?? {}) };
    let payload;
    if (o.body !== undefined) {
      payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (o.cookie) headers['cookie'] = o.cookie;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json; try { json = JSON.parse(body.toString('utf8')); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    // F13: Eine Route, die ohne Sitzung einen Dauerstrom oeffnet (z. B. /events), darf den Test nicht haengen lassen.
    req.setTimeout(10_000, () => req.destroy(new Error('Zeitueberschreitung: ' + method + ' ' + p)));
    if (payload) req.write(payload);
    req.end();
  });
}
async function login(ip) {
  const r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': ip }, body: { password: 'correct horse battery' } });
  const sc = r.headers['set-cookie']?.[0] ?? '';
  return { r, cookie: sc.split(';')[0] };
}

// ================= Tests =================
// -- Basis & Header
let r = await call('GET', '/healthz');
ok('healthz 200 ohne Login', r.status === 200 && r.body.toString().startsWith('OK'));
ok('CSP gesetzt', /default-src 'self'/.test(r.headers['content-security-policy'] ?? ''), r.headers['content-security-policy']);
ok('nosniff', r.headers['x-content-type-options'] === 'nosniff');
ok('Listen nur 127.0.0.1', running.server.address().address === '127.0.0.1', running.server.address());
r = await call('GET', '/api/chats');
ok('chats ohne Session -> 401', r.status === 401 && r.json?.error === 'unauthorized');
r = await call('GET', '/events');
ok('events ohne Session -> 401', r.status === 401);
r = await call('GET', '/api/media/a3');
ok('media ohne Session -> 401', r.status === 401);
r = await call('GET', '/api/does-not-exist');
ok('unbekannte API ohne Session -> 404 (Routen sind nicht geheim, nichts wird verraten)', r.status === 404);
r = await call('DELETE', '/api/chats');
ok('DELETE -> 405', r.status === 405);

// -- Login
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=x' });
ok('login falscher Content-Type -> 415', r.status === 415, r.status);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.1' }, body: '{kaputt' });
ok('login kaputtes JSON -> 400', r.status === 400, r.status);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.1' }, body: { password: 5 } });
ok('login Passwort kein String -> 400', r.status === 400);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.1' }, body: { password: 'x'.repeat(2000) } });
ok('login Passwort zu lang -> 400', r.status === 400);
// 10.0.0.1 hat bisher 4 Versuche verbraucht (415, 400, 400, 400 zaehlen mit) -> 5. falsch = 401, 6. = 429
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.2' }, body: { password: 'falsch' } });
ok('login falsch -> 401', r.status === 401 && r.json?.error === 'invalid_credentials' && !r.headers['set-cookie']);
for (let i = 0; i < 4; i++) await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.9' }, body: { password: 'falsch' } });
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.9' }, body: { password: 'falsch' } });
ok('5. Fehlversuch noch 401', r.status === 401, r.status);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.9' }, body: { password: 'falsch' } });
ok('6. Versuch -> 429 + Retry-After', r.status === 429 && Number(r.headers['retry-after']) > 0, [r.status, r.headers['retry-after']]);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.9' }, body: { password: 'correct horse battery' } });
ok('auch richtiges Passwort waehrend Sperre -> 429', r.status === 429);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.9' }, body: { password: 'falsch' } });
ok('XFF-Spoofing (vorangestellte IP) umgeht Sperre nicht', r.status === 429, r.status);
r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.55' }, body: { password: 'falsch' } });
ok('andere IP nicht gesperrt', r.status === 401);

const { r: lr, cookie } = await login('10.0.0.3');
const sc = lr.headers['set-cookie']?.[0] ?? '';
ok('login ok 200', lr.status === 200 && lr.json?.ok === true);
ok('Cookie HttpOnly+SameSite=Strict+Path=/', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && /Max-Age=\d+/.test(sc), sc);
ok('Cookie ohne Secure bei HTTP', !/Secure/.test(sc), sc);
const lr2 = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.4', 'x-forwarded-proto': 'https' }, body: { password: 'correct horse battery' } });
ok('Cookie Secure bei X-Forwarded-Proto=https', /Secure/.test(lr2.headers['set-cookie']?.[0] ?? ''));
// erfolgreicher Login setzt Zaehler zurueck
for (let i = 0; i < 3; i++) await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.7' }, body: { password: 'falsch' } });
await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.7' }, body: { password: 'correct horse battery' } });
for (let i = 0; i < 3; i++) r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.7' }, body: { password: 'falsch' } });
ok('Erfolg setzt Zaehler zurueck', r.status === 401, r.status);

r = await call('GET', '/api/status', { cookie: cookie + 'x' });
ok('manipuliertes Token -> 401', r.status === 401);

// -- F13: JEDE registrierte Route ohne Sitzung. Nur die Whitelist darf oeffentlich sein; alles andere muss 401 liefern.
{
  // Bewusst ausgeschrieben: eine neue oeffentliche Route macht diesen Test rot, bis sie hier begruendet eingetragen ist.
  const PUBLIC_WHITELIST = [
    'GET /healthz',                       // Update-/Rollback-Pruefung, verraet nur "laeuft"
    'POST /api/login',                    // Anmeldung selbst
    'POST /api/logout',                   // loescht nur das eigene Cookie
    'GET /api/auth/state',                // Login-Seite muss wissen, ob Passkey-Sperre aktiv ist
    'POST /api/passkey/login/options',    // Passkey-Anmeldung, Teil 1
    'POST /api/passkey/login/verify',     // Passkey-Anmeldung, Teil 2
  ];
  const routes = running.routes;
  const label = (x) => x.method + ' ' + x.pattern;
  const publicNow = routes.filter((x) => x.public).map(label).sort();
  ok('F13: oeffentliche Routen == Whitelist', JSON.stringify(publicNow) === JSON.stringify([...PUBLIC_WHITELIST].sort()), publicNow);
  const guarded = routes.filter((x) => !PUBLIC_WHITELIST.includes(label(x)));
  ok('F13: Plausibilitaet: mindestens 20 geschuetzte Routen gefunden (kein leerer Durchlauf)', guarded.length >= 20, guarded.length);
  for (const x of guarded) {
    const concrete = x.pattern.replace(/:\w+/g, 'a3');
    const rr = await call(x.method, concrete);
    ok('F13: ' + label(x) + ' ohne Sitzung -> 401', rr.status === 401 && rr.json?.error === 'unauthorized', rr.status);
    if (x.method === 'GET') {
      const rh = await call('HEAD', concrete);
      ok('F13: HEAD ' + x.pattern + ' ohne Sitzung -> 401', rh.status === 401, rh.status);
    }
  }
}
r = await call('GET', '/api/status', { cookie });
ok('status initial disconnected', r.status === 200 && r.json?.state === 'disconnected', r.json);

// -- Status / QR
r = await call('GET', '/api/qr', { cookie });
ok('qr ohne Eintrag -> 404', r.status === 404);
// Verbindungszustand und QR liegen in der settings-Tabelle (Ingest schreibt, siehe services/ingest/src/config.ts);
// das Outbox-Ereignis 'connection_status' ist nur der Anstoss.
const setConn = (state, since, qr) => {
  client.setSetting(db, 'connection.status', state);
  client.setSetting(db, 'connection.connected_since', since === undefined ? '' : String(since));
  client.setSetting(db, 'connection.qr', qr ?? '');
  pushEvent(db, 'connection_status', { state, ...(since !== undefined ? { since } : {}) });
};
setConn('needs_qr', undefined, 'ROHTEXT-AUS-BAILEYS');
r = await call('GET', '/api/status', { cookie });
ok('status needs_qr', r.json?.state === 'needs_qr' && r.json?.since === undefined, r.json);
r = await call('GET', '/api/qr', { cookie });
// Ohne das Paket qrcode (Sandbox des Erstellers): 503. Mit dem Paket (normale Installation, npm ci): eine Daten-URL.
ok('qr Rohtext: 503 ohne qrcode-Paket, sonst Daten-URL', (r.status === 503 && r.json?.error === 'qr_render_unavailable') || (r.status === 200 && r.json?.qr?.startsWith('data:image/svg+xml;base64,')), [r.status, r.json?.error]);
client.setSetting(db, 'connection.qr', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
r = await call('GET', '/api/qr', { cookie });
ok('qr SVG -> Daten-URL', r.status === 200 && r.json?.qr?.startsWith('data:image/svg+xml;base64,'), r.json);
setConn('connected', 222, '');
r = await call('GET', '/api/qr', { cookie });
ok('qr nach connected -> 404', r.status === 404);
r = await call('GET', '/api/status', { cookie });
ok('status connected', r.json?.state === 'connected' && r.json?.since === 222);

// -- Chats
r = await call('GET', '/api/chats', { cookie });
const chats = r.json ?? [];
ok('chats 200', r.status === 200 && Array.isArray(chats));
ok('leerer Chat ausgeblendet', !chats.some((c) => c.id === E), chats.map((c) => c.id));
ok('Sortierung nach letzter Nachricht', chats.map((c) => c.id).join() === [X, N, G, A].join(), chats.map((c) => c.id));
const ca = chats.find((c) => c.id === A);
ok('unreadCount Anna = 9 (ohne out/deleted)', ca?.unreadCount === 9, ca);
ok('Preview letzte Nachricht', ca?.lastMessagePreview === 'gleiche Sekunde zwei', ca);
ok('hasAvatar', ca?.hasAvatar === true && chats.find((c) => c.id === G).hasAvatar === false);
ok('Name-Fallback ohne Namen', chats.find((c) => c.id === N)?.name === 'nonname', chats.find((c) => c.id === N));
ok('isGroup', chats.find((c) => c.id === G)?.isGroup === true);
ok('Chat-Objekt ohne Dateisystempfade', !JSON.stringify(chats).includes(mediaDir));

// -- Avatar
r = await call('GET', `/api/chats/${encodeURIComponent(A)}/avatar`, { cookie });
ok('avatar 200 image/jpeg', r.status === 200 && r.headers['content-type'] === 'image/jpeg' && r.body.length === 300, [r.status, r.headers['content-type']]);
r = await call('GET', `/api/chats/${encodeURIComponent(G)}/avatar`, { cookie });
ok('avatar ohne Bild -> 404', r.status === 404);
ok('avatarUrl mit Version (Dateiname) nur bei Bild', ca?.avatarUrl === `api/chats/${encodeURIComponent(A)}/avatar?v=anna.jpg` && chats.find((c) => c.id === G).avatarUrl === undefined, ca?.avatarUrl);

// -- Profilbild beim Oeffnen: nur ein Befehl an den Ingest, nur wenn eingeschaltet, keiner doppelt
const avatarCmds = () => db.prepare("SELECT payload_json AS p FROM ingest_commands WHERE type = 'refresh_avatar'").all().map((x) => JSON.parse(x.p).chatId);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/avatar/refresh`, { cookie });
ok('avatar/refresh ausgeschaltet: 200, kein Befehl', r.status === 200 && r.json?.queued === false && avatarCmds().length === 0, [r.status, r.json]);
client.setSetting(db, 'avatars.enabled', '1');
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/avatar/refresh`, { cookie });
const r2 = await call('POST', `/api/chats/${encodeURIComponent(A)}/avatar/refresh`, { cookie });
ok('avatar/refresh eingeschaltet: 202, genau ein Befehl', r.status === 202 && r2.status === 202 && avatarCmds().join() === A, [r.status, r2.status, avatarCmds()]);
r = await call('POST', `/api/chats/${encodeURIComponent('weg@s.whatsapp.net')}/avatar/refresh`, { cookie });
ok('avatar/refresh unbekannter Chat -> 404', r.status === 404);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/avatar/refresh`);
ok('avatar/refresh ohne Sitzung -> 401', r.status === 401);
db.prepare("DELETE FROM ingest_commands WHERE type = 'refresh_avatar'").run();
client.setSetting(db, 'avatars.enabled', '0');

// -- Nachrichten
const mp = (chat, q = '') => `/api/chats/${encodeURIComponent(chat)}/messages${q}`;
r = await call('GET', mp(A), { cookie });
let msgs = r.json ?? [];
ok('messages 200, aufsteigend sortiert', r.status === 200 && msgs.length === 11 && msgs[0].id === 'a1' && msgs[msgs.length - 1].id === 'a11', msgs.map((m) => m.id));
const a3 = msgs.find((m) => m.id === 'a3');
ok('media-Objekt', a3?.media?.status === 'ready' && a3.media.mimeType === 'image/jpeg' && a3.media.sizeBytes === 2000 && a3.media.hasThumbnail === true, a3);
ok('media ohne Dateipfade', !JSON.stringify(msgs).includes('a3.jpg'));
const a8 = msgs.find((m) => m.id === 'a8');
ok('geloeschte Nachricht: text=null, deleted=true', a8?.text === null && a8?.deleted === true && a8?.media === null, a8);
ok('Felder bool/number', msgs[0].edited === false && msgs[0].seenAt === null && typeof msgs[0].waTimestamp === 'number');
r = await call('GET', mp(A, '?limit=3'), { cookie });
ok('limit=3 liefert die letzten 3 (aufsteigend)', r.json?.map((m) => m.id).join() === 'a9,a10,a11', r.json?.map((m) => m.id));
r = await call('GET', mp(A, `?limit=2&before=${T + 10}`), { cookie });
ok('before (exklusiv) ohne beforeId', r.json?.map((m) => m.id).join() === 'a8,a9', r.json?.map((m) => m.id));
r = await call('GET', mp(A, '?limit=2'), { cookie });
const firstPage = r.json; // a10,a11 (gleiche Sekunde)
r = await call('GET', mp(A, `?limit=2&before=${firstPage[1].waTimestamp}&beforeId=a11`), { cookie });
ok('beforeId: gleiche Sekunde stabil (a10 wird nicht uebersprungen)', r.json?.map((m) => m.id).join() === 'a9,a10', r.json?.map((m) => m.id));
r = await call('GET', mp('gibt-es-nicht'), { cookie });
ok('unbekannter Chat -> 404', r.status === 404);
r = await call('GET', mp(A, '?limit=0'), { cookie });
ok('limit=0 -> 400', r.status === 400);
r = await call('GET', mp(A, '?limit=500'), { cookie });
ok('limit=500 -> 400', r.status === 400);
r = await call('GET', mp(A, '?before=abc'), { cookie });
ok('before=abc -> 400', r.status === 400);

// -- Medien
const media = (id, q = '', h = {}, m = 'GET') => call(m, `/api/media/${id}${q}`, { cookie, headers: h });
r = await media('a3');
ok('media voll: 200, image/jpeg, inline, Accept-Ranges', r.status === 200 && r.headers['content-type'] === 'image/jpeg' && r.headers['content-disposition'] === 'inline' && r.headers['accept-ranges'] === 'bytes' && r.body.equals(imgBuf), [r.status, r.headers['content-type'], r.headers['content-disposition']]);
ok('media: nosniff + sandbox-CSP', r.headers['x-content-type-options'] === 'nosniff' && /sandbox/.test(r.headers['content-security-policy']));
r = await media('a4', '', { range: 'bytes=0-1' });
ok('Safari-Probe bytes=0-1 -> 206', r.status === 206 && r.headers['content-range'] === 'bytes 0-1/1000' && r.body.length === 2 && r.body.equals(voiceBuf.subarray(0, 2)), [r.status, r.headers['content-range']]);
ok('voice inline audio/mp4', r.headers['content-type'] === 'audio/mp4' && r.headers['content-disposition'] === 'inline');
r = await media('a4', '', { range: 'bytes=100-199' });
ok('Range Mitte', r.status === 206 && r.headers['content-range'] === 'bytes 100-199/1000' && r.body.equals(voiceBuf.subarray(100, 200)) && r.headers['content-length'] === '100');
r = await media('a4', '', { range: 'bytes=900-' });
ok('Range offenes Ende', r.status === 206 && r.body.equals(voiceBuf.subarray(900)) && r.headers['content-range'] === 'bytes 900-999/1000');
r = await media('a4', '', { range: 'bytes=-50' });
ok('Range Suffix', r.status === 206 && r.body.equals(voiceBuf.subarray(950)) && r.headers['content-range'] === 'bytes 950-999/1000');
r = await media('a4', '', { range: 'bytes=990-5000' });
ok('Range Ende ueber Dateiende wird gekappt', r.status === 206 && r.headers['content-range'] === 'bytes 990-999/1000');
r = await media('a4', '', { range: 'bytes=5000-6000' });
ok('Range nicht erfuellbar -> 416', r.status === 416 && r.headers['content-range'] === 'bytes */1000', [r.status, r.headers['content-range']]);
r = await media('a4', '', { range: 'bytes=0-1,5-6' });
ok('Mehrfach-Range -> volle 200', r.status === 200 && r.body.length === 1000);
r = await media('a4', '', { range: 'bytes=9-3' });
ok('ungueltiger Range -> ignoriert (200)', r.status === 200);
r = await media('a4', '', { range: 'bytes=0-1', 'if-range': 'W/"x"' });
ok('If-Range -> volle 200', r.status === 200 && r.body.length === 1000);
r = await media('a4', '', {}, 'HEAD');
ok('HEAD: Header ja, Body nein', r.status === 200 && r.headers['content-length'] === '1000' && r.body.length === 0);
const etag = (await media('a3')).headers['etag'];
r = await media('a3', '', { 'if-none-match': etag });
ok('If-None-Match -> 304', r.status === 304 && r.body.length === 0, r.status);
r = await media('a6');
ok('Dokument: attachment + octet-stream', r.status === 200 && r.headers['content-type'] === 'application/octet-stream' && /^attachment; filename="doc.pdf"/.test(r.headers['content-disposition']), [r.headers['content-type'], r.headers['content-disposition']]);
r = await media('a7');
ok('SVG als "image" wird NIE inline ausgeliefert', r.status === 200 && r.headers['content-type'] === 'application/octet-stream' && /^attachment/.test(r.headers['content-disposition']), [r.headers['content-type'], r.headers['content-disposition']]);
r = await media('g2');
ok('video inline video/mp4', r.status === 200 && r.headers['content-type'] === 'video/mp4' && r.headers['content-disposition'] === 'inline');
r = await media('a3', '?thumb=1');
ok('Thumbnail', r.status === 200 && r.headers['content-type'] === 'image/jpeg' && r.body.length === 100, [r.status, r.headers['content-type']]);
r = await media('a4', '?thumb=1');
ok('kein Thumbnail -> 404', r.status === 404);
r = await media('a9');
ok('pending -> 404 media_not_ready', r.status === 404 && r.json?.error === 'media_not_ready' && r.json?.status === 'pending', r.json);
r = await media('a8');
ok('geloeschte Nachricht -> 404', r.status === 404);
r = await media('a1');
ok('Nachricht ohne Medien -> 404', r.status === 404);
r = await media('nope');
ok('unbekannte ID -> 404', r.status === 404);
r = await media('x1');
ok('Pfad ../secret.txt -> 404 (Traversal)', r.status === 404 && !r.body.toString().includes('TOPSECRET'), r.status);
r = await media('x2');
ok('Symlink aus media_dir heraus -> 404', r.status === 404 && !r.body.toString().includes('TOPSECRET'), r.status);
// F18/O2: Pfade in den Geschwisterordner "media-evil" (gleicher Namensanfang wie der Root) muessen abgelehnt werden.
for (const [label, fp] of [['relativ', '../media-evil/x.jpg'], ['absolut', path.join(tmp, 'media-evil', 'x.jpg')]]) {
  client.setMediaStatus(db, 'x1', { filePath: fp, mimeType: 'image/jpeg', sizeBytes: 12, status: 'ready' });
  r = await media('x1');
  ok('F18/O2: Geschwisterordner media-evil (' + label + ') -> 404', r.status === 404 && !r.body.toString().includes('EVIL-SIBLING'), r.status);
}
client.setMediaStatus(db, 'x1', { filePath: '../secret.txt', mimeType: 'image/jpeg', sizeBytes: 9, status: 'ready' });

// -- F18/O6: Lesende Routen (GET/HEAD) aendern nichts in der Datenbank (kein Seen/Played/Status als Nebenwirkung)
{
  const tables = ['messages', 'media', 'chats', 'settings', 'events_outbox'];
  const snapshot = () => JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  const before = snapshot();
  const gets = [
    '/api/chats', `/api/chats/${encodeURIComponent(A)}/messages`, `/api/chats/${encodeURIComponent(A)}/messages?onlyNew=1`,
    '/api/search?q=hallo', '/api/status', '/api/settings', '/api/storage/usage', '/api/media/a3', '/api/media/a4',
    `/api/chats/${encodeURIComponent(A)}/avatar`, '/api/passkeys', '/api/auth/state', '/healthz',
  ];
  for (const p of gets) {
    await call('GET', p, { cookie });
    await call('HEAD', p, { cookie });
  }
  const after = snapshot();
  ok('F18/O6: GET/HEAD-Routen aendern keine Datenbankzeile (messages, media, chats, settings, events_outbox)', before === after);
  ok('F18/O6: Plausibilitaet: der Schnappschuss ist nicht leer', before.length > 500, before.length);
}

// -- Seen / Played
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: {} });
ok('seen ohne all/upTo -> 400', r.status === 400, r.json);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: { all: true, upTo: 'a3' } });
ok('seen mit all+upTo -> 400', r.status === 400);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: { all: 'ja' } });
ok('seen all kein bool -> 400', r.status === 400);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: 'x=1', headers: { 'content-type': 'text/plain' } });
ok('seen mit text/plain -> 415 (CSRF-Haertung)', r.status === 415);

// Zweite Sperre gegen Anfragen fremder Seiten: JEDE schreibende Anfrage verlangt application/json, auch ohne Body. Eine
// "einfache" Anfrage (kein Content-Type, kein Preflight) kam frueher bei connect, avatar/refresh, played und load durch.
{
  const bodyless = [
    ['POST', '/api/connect'],
    ['POST', `/api/chats/${encodeURIComponent(A)}/avatar/refresh`],
    ['POST', '/api/messages/a4/played'],
    ['POST', '/api/media/a9/load'],
    ['POST', `/api/chats/${encodeURIComponent(A)}/seen`],
    ['POST', '/api/storage/clear'],
    ['PUT', '/api/settings'],
    ['PUT', `/api/chats/${encodeURIComponent(A)}/mute`],
  ];
  for (const [m, path] of bodyless) {
    const bare = await call(m, path, { cookie, raw: true });
    ok(`${m} ${path.replace(/%40/g, '@').slice(0, 40)} ohne Content-Type -> 415`, bare.status === 415 && bare.json?.error === 'unsupported_media_type', bare.status);
    const form = await call(m, path, { cookie, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    ok(`${m} ${path.replace(/%40/g, '@').slice(0, 40)} als Formular -> 415`, form.status === 415, form.status);
  }
  const noSession = await call('POST', '/api/connect', { raw: true });
  ok('ohne Sitzung gilt weiter zuerst 401 (nicht 415)', noSession.status === 401, noSession.status);
  const logoutBare = await call('POST', '/api/logout', { raw: true });
  ok('logout ohne Content-Type -> 415 (auch oeffentliche schreibende Routen)', logoutBare.status === 415, logoutBare.status);
  const loginBare = await call('POST', '/api/login', { raw: true, headers: { 'x-forwarded-for': '10.9.9.9' } });
  ok('login ohne Content-Type -> 415', loginBare.status === 415, loginBare.status);
  const unknown = await call('POST', '/api/gibt-es-nicht', { cookie, raw: true });
  ok('unbekannte Route bleibt 404 (nicht 415)', unknown.status === 404, unknown.status);
  const wrongMethod = await call('DELETE', '/api/connect', { cookie, raw: true });
  ok('falsche Methode bleibt 405', wrongMethod.status === 405, wrongMethod.status);
  const okJson = await call('POST', '/api/connect', { cookie });
  ok('mit application/json (auch ohne Daten) geht es durch: 202', okJson.status === 202, okJson.status);
  const charset = await call('POST', '/api/connect', { cookie, body: {}, headers: { 'content-type': 'Application/JSON; charset=UTF-8' } });
  ok('Content-Type mit Gross-/Kleinschreibung und charset wird erkannt', charset.status === 202, charset.status);
}
r = await call('POST', `/api/chats/nope/seen`, { cookie, body: { all: true } });
ok('seen unbekannter Chat -> 404', r.status === 404);
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: { upTo: 'a3' } });
ok('seen upTo a3 -> a1,a2,a3 (3)', r.status === 200 && r.json?.updated === 3, r.json);
r = await call('GET', '/api/chats', { cookie });
ok('unread nach upTo = 6', r.json.find((c) => c.id === A).unreadCount === 6, r.json.find((c) => c.id === A));
r = await call('POST', `/api/chats/${encodeURIComponent(A)}/seen`, { cookie, body: { all: true } });
ok('seen all -> Rest (6 sichtbare + geloeschte a8 im Stub = 7)', r.json?.updated === 7, r.json);
r = await call('GET', '/api/chats', { cookie });
ok('unread nach all = 0', r.json.find((c) => c.id === A).unreadCount === 0);
r = await call('POST', '/api/messages/a4/played', { cookie });
ok('played -> playedAt gesetzt', r.status === 200 && typeof r.json?.playedAt === 'number', r.json);
const p1 = r.json.playedAt;
const nEv = db.prepare("SELECT COUNT(*) AS n FROM events_outbox WHERE type='message_updated'").get().n;
ok('seen/played erzeugen message_updated-Ereignisse (3 + 7 + 1)', nEv === 11, nEv);
r = await call('POST', '/api/messages/a4/played', { cookie });
ok('played zweimal -> kein weiteres Ereignis', db.prepare("SELECT COUNT(*) AS n FROM events_outbox WHERE type='message_updated'").get().n === nEv && r.json.playedAt === p1);
r = await call('POST', '/api/messages/nope/played', { cookie });
ok('played unbekannt -> 404', r.status === 404);

// -- Suche
const search = (qs) => call('GET', '/api/search?' + qs, { cookie });
r = await search('q=hallo');
ok('Suche "hallo" -> a1 + g1', r.status === 200 && r.json.map((m) => m.id).sort().join() === 'a1,g1', r.json?.map((m) => m.id));
ok('Suchtreffer haben chatName', r.json.find((m) => m.id === 'a1')?.chatName === 'Anna');
r = await search('q=hal');
ok('Praefix "hal"', r.json.map((m) => m.id).sort().join() === 'a1,g1');
r = await search('q=' + encodeURIComponent('gruße'));
ok('Diakritika: "gruße" findet "Grüße" (ü wird gefaltet)', r.json.map((m) => m.id).join() === 'a2', r.json?.map((m) => m.id));
r = await search('q=' + encodeURIComponent('GRÜSSE'));
ok('Bekannte Grenze: ß wird vom unicode61-Tokenizer NICHT zu ss gefaltet', r.status === 200 && r.json.length === 0, r.json?.map((m) => m.id));
r = await search('q=hallo&chatId=' + encodeURIComponent(A));
ok('Filter chatId', r.json.map((m) => m.id).join() === 'a1');
r = await search('q=hallo&type=text&from=' + (T + 10) + '&to=' + (T + 30));
ok('Filter type/from/to', r.json.map((m) => m.id).join() === 'g1', r.json?.map((m) => m.id));
r = await search('q=geloeschter');
ok('geloeschte Nachrichten nicht auffindbar', r.json.length === 0, r.json);
for (const evil of ['"', '*', 'AND', 'OR NOT', 'foo:bar', '(', ')', 'NEAR(', '-', 'a" OR "b', "'; DROP TABLE messages; --", '^', '{', '}', '\\', '%', '😀', 'text:Hallo', 'hallo OR 1=1', '"unterminated', '   ']) {
  const rr = await search('q=' + encodeURIComponent(evil));
  ok('Suche robust gegen ' + JSON.stringify(evil), rr.status === 200 || rr.status === 400, [rr.status, rr.json]);
}
ok('Tabelle messages nach Injection-Versuch noch da', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 16);
r = await search('q=');
ok('ohne q und ohne Filter -> 400', r.status === 400 && r.json?.error === 'q_or_filter_required');
r = await search('onlyNew=1');
ok('nur Filter onlyNew: gesehene sind raus (Anna komplett gesehen)', r.status === 200 && !r.json.some((m) => m.chatId === A), r.json?.map((m) => m.id));
ok('onlyNew liefert noch ungesehene (g1, g2, n1, x1, x2)', r.json.map((m) => m.id).sort().join() === 'g1,g2,n1,x1,x2', r.json?.map((m) => m.id));
r = await search('q=hallo&type=bogus');
ok('ungueltiger type -> 400', r.status === 400);
r = await search('q=hallo&onlyNew=vielleicht');
ok('ungueltiges onlyNew -> 400', r.status === 400);
ok('buildFtsQuery', buildFtsQuery('Hallo  "Welt"') === '"Hallo" "Welt"*' && buildFtsQuery('***') === null && buildFtsQuery('a b') === '"a" "b"*', [buildFtsQuery('Hallo  "Welt"')]);

// -- Settings
r = await call('GET', '/api/settings', { cookie });
ok('settings Defaults', r.status === 200 && r.json?.retentionDays === 3 && r.json?.retentionMediaDays === 3 && r.json?.storageLimitMb === 0 && r.json?.downloadRules?.video?.mode === 'off', r.json);
const put = (b) => call('PUT', '/api/settings', { cookie, body: b });
r = await put({ retentionDays: 7 });
ok('PUT retentionDays=7', r.status === 200 && r.json?.retentionDays === 7 && client.getSetting(db, 'retentionDays') === '7', r.json);
r = await put({ retentionDays: 5 });
ok('retentionDays=5 (nicht erlaubt) -> 400', r.status === 400 && r.json?.field === 'retentionDays');
r = await put({ retentionDays: '7' });
ok('retentionDays als String -> 400', r.status === 400);
r = await put({ retentionMediaDays: 14 });
ok('Medien laenger als Nachrichten -> 400', r.status === 400 && r.json?.error === 'media_retention_exceeds_message_retention', r.json);
r = await put({ retentionDays: 14, retentionMediaDays: 14 });
ok('beide gemeinsam gueltig', r.status === 200 && r.json.retentionMediaDays === 14);
r = await put({ retentionDays: 1 });
ok('Verkuerzen unter Medien-Aufbewahrung -> 400', r.status === 400, r.json);
r = await put({ storageLimitMb: 2048 });
ok('storageLimitMb', r.status === 200 && r.json.storageLimitMb === 2048);
r = await put({ storageLimitMb: -1 });
ok('storageLimitMb negativ -> 400', r.status === 400);
r = await put({ downloadRules: { video: { mode: 'auto' } } });
ok('downloadRules Teilupdate (maxMb bleibt)', r.status === 200 && r.json.downloadRules.video.mode === 'auto' && r.json.downloadRules.video.maxMb === 50 && r.json.downloadRules.image.maxMb === 10, r.json);
r = await put({ downloadRules: { audio: { mode: 'auto' } } });
ok('downloadRules unbekannter Typ -> 400', r.status === 400);
r = await put({ downloadRules: { image: { mode: 'manual' } } });
ok('downloadRules ungueltiger Modus -> 400', r.status === 400);
r = await put({ downloadRules: { image: { maxMb: 0 } } });
ok('downloadRules maxMb=0 -> 400', r.status === 400);
r = await put({ foo: 1 });
ok('unbekanntes Feld -> 400', r.status === 400 && r.json?.error === 'unknown_setting');
r = await put({});
ok('leeres Update -> 400', r.status === 400);
r = await call('GET', '/api/settings', { cookie });
ok('Einstellungen persistent gelesen', r.json.retentionDays === 14 && r.json.storageLimitMb === 2048 && r.json.downloadRules.video.mode === 'auto');

// -- SSE
function sse(cookieHdr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET', headers: { cookie: cookieHdr, accept: 'text/event-stream', ...headers } }, (res) => {
      const c = { res, status: res.statusCode, headers: res.headers, data: '', req };
      res.setEncoding('utf8');
      res.on('data', (d) => (c.data += d));
      resolve(c);
    });
    req.on('error', reject);
    req.end();
  });
}
async function waitFor(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; }
const s1 = await sse(cookie);
ok('SSE 200 text/event-stream', s1.status === 200 && /text\/event-stream/.test(s1.headers['content-type']) && /no-cache/.test(s1.headers['cache-control']) && s1.headers['x-accel-buffering'] === 'no', [s1.status, s1.headers]);
ok('SSE initial connection_status', await waitFor(() => /event: connection_status\ndata: \{"state":"connected","since":222\}/.test(s1.data)), s1.data);
msg('s1', A, T + 100, 'text', 'Live Nachricht SEKRET');
pushEvent(db, 'new_message', { chatId: A, message: { id: 's1', whatever: 'ignored' } });
ok('SSE new_message (aus DB neu gelesen)', await waitFor(() => /event: new_message/.test(s1.data) && /"id":"s1"/.test(s1.data) && /"chatId":"4915111@s\.whatsapp\.net"/.test(s1.data)), s1.data);
client.setMediaStatus(db, 's1', { filePath: 'A/2023-11-14/a3.jpg', thumbnailPath: 'A/2023-11-14/a3_thumb.jpg', mimeType: 'image/jpeg', sizeBytes: 5, status: 'ready' });
pushEvent(db, 'media_ready', { messageId: 's1', filePath: '/var/lib/waread/media/geheim/pfad.jpg' });
ok('SSE media_ready mit API-Pfaden statt Dateisystempfaden', await waitFor(() => /event: media_ready\ndata: \{[^\n]*"filePath":"api\/media\/s1"/.test(s1.data) && /"thumbnailPath":"api\/media\/s1\?thumb=1"/.test(s1.data)), s1.data);
ok('SSE leakt keinen Dateisystempfad', !s1.data.includes('/var/lib/waread') && !s1.data.includes(mediaDir));
pushEvent(db, 'qr', { qr: 'GEHEIMER-QR' }); // alte Konvention, wird nie weitergereicht
pushEvent(db, 'message_updated', { messageId: 's1' });
pushEvent(db, 'unbekannter_typ', { x: 1 });
pushEvent(db, 'cleanup_done', { deletedMessages: 2, deletedMedia: 1, extra: 'x' });
ok('SSE message_updated (Obermenge: seenAt, playedAt, deleted, edited, text, deletedAt, editedAt, editCount, protectedAt)', await waitFor(() => /event: message_updated\ndata: \{"messageId":"s1","chatId":"[^"]+","seenAt":null,"playedAt":null,"deleted":false,"deletedAt":null,"edited":false,"editedAt":null,"editCount":0,"protectedAt":null,"text":"Live Nachricht SEKRET"\}/.test(s1.data)), s1.data);
ok('SSE cleanup_done', await waitFor(() => /event: cleanup_done\ndata: \{"deletedMessages":2,"deletedMedia":1\}/.test(s1.data)), s1.data);
ok('SSE leitet qr NIE weiter', !s1.data.includes('GEHEIMER-QR') && !/event: qr/.test(s1.data));
ok('SSE leitet unbekannte Typen nicht weiter', !/unbekannter_typ/.test(s1.data));
ok('SSE-Frames haben id:', /\nid: \d+\nevent: new_message/.test(s1.data) || /^id: \d+\nevent:/m.test(s1.data));
const lastIdMatch = [...s1.data.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
const cut = lastIdMatch[0];
// Wiederverbindung mit Last-Event-ID -> Nachspielen
const s2 = await sse(cookie, { 'last-event-id': String(cut) });
await waitFor(() => /event: cleanup_done/.test(s2.data));
ok('Last-Event-ID: spaetere Ereignisse werden nachgespielt, fruehere nicht', /event: cleanup_done/.test(s2.data) && (lastIdMatch.length < 2 || !new RegExp(`^id: ${cut}$`, 'm').test(s2.data)), s2.data);
ok('Replay enthaelt kein qr', !s2.data.includes('GEHEIMER-QR'));
// Verbindungsstatus live
setConn('needs_qr', undefined, 'GEHEIMER-QR-2');
ok('SSE connection_status live', await waitFor(() => /event: connection_status\ndata: \{"state":"needs_qr"\}/.test(s1.data)), s1.data);
ok('SSE leitet den QR aus den settings nie weiter', !s1.data.includes('GEHEIMER-QR-2'));
r = await call('POST', '/api/connect', { cookie });
ok('POST /api/connect -> 202 und Befehl in settings', r.status === 202 && client.getSetting(db, 'connection.command') === 'connect', [r.status, r.json]);
r = await call('POST', '/api/connect', {});
ok('POST /api/connect ohne Anmeldung -> 401', r.status === 401, r.status);
pushEvent(db, 'history_synced', { stored: 42, secret: 'x' });
ok('SSE history_synced (nur stored)', await waitFor(() => /event: history_synced\ndata: \{"stored":42\}/.test(s1.data)), s1.data);
pushEvent(db, 'avatar_updated', { chatId: A, path: '/geheim' });
ok('SSE avatar_updated (nur chatId)', await waitFor(() => new RegExp(`event: avatar_updated\ndata: \\{"chatId":"${A.replace(/[.]/g, '\\.')}"\\}`).test(s1.data)), s1.data);
s1.req.destroy(); s2.req.destroy();
await sleep(100);
ok('Hub raeumt getrennte Clients auf', running.app.hub.size === 0, running.app.hub.size);

// -- Speicher
r = await call('GET', '/api/storage/usage', { cookie });
const u = r.json;
ok('usage: Struktur', r.status === 200 && typeof u.totalBytes === 'number' && Array.isArray(u.perChat) && Array.isArray(u.perType) && typeof u.dbBytes === 'number', u);
ok('usage: mediaBytes = Summe ready (2000+1000+13+100+500+9+9+5)', u.mediaBytes === 2000 + 1000 + 13 + 100 + 500 + 9 + 9 + 5, u.mediaBytes);
ok('usage: perType image/voice/video/document', ['image', 'voice', 'video', 'document'].every((t) => u.perType.some((x) => x.type === t)), u.perType);
ok('usage: perChat enthaelt Namen + Zaehler', u.perChat.find((c) => c.chatId === A)?.name === 'Anna' && u.perChat.find((c) => c.chatId === A).messageCount === 12, u.perChat);
ok('usage: limitBytes aus Einstellung', u.limitBytes === 2048 * 1024 * 1024);
ok('usage: Platte', u.diskFreeBytes === null || typeof u.diskFreeBytes === 'number');
const clear = (b) => call('POST', '/api/storage/clear', { cookie, body: b });
r = await clear({ scope: 'all' });
ok('clear ohne confirm -> 400', r.status === 400 && r.json?.error === 'confirm_required');
r = await clear({ scope: 'all', confirm: 'true' });
ok('clear confirm als String -> 400', r.status === 400);
r = await clear({ scope: 'all', confirm: 1 });
ok('clear confirm=1 -> 400', r.status === 400);
r = await clear({ scope: 'alles', confirm: true });
ok('clear ungueltiger scope -> 400', r.status === 400 && r.json?.error === 'invalid_scope');
r = await clear({ scope: 'chat', confirm: true });
ok('clear chat ohne chatId -> 400', r.status === 400);
r = await clear({ scope: 'chat', chatId: 'nope', confirm: true });
ok('clear chat unbekannt -> 404', r.status === 404);
ok('nach abgelehnten clears ist nichts geloescht', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 17);
const evBefore = db.prepare("SELECT COUNT(*) AS n FROM events_outbox WHERE type='cleanup_done'").get().n;
r = await clear({ scope: 'chat', chatId: G, confirm: true });
ok('clear chat G: 2 Nachrichten, 1 Datei, 500 Bytes', r.status === 200 && r.json.deletedMessages === 2 && r.json.deletedMedia === 1 && r.json.freedBytes === 500, r.json);
ok('Datei weg, leerer Ordner G/2023-11-14 und G entfernt', !fs.existsSync(path.join(mediaDir, 'G/2023-11-14/video.mp4')) && !fs.existsSync(path.join(mediaDir, 'G')));
ok('FTS bereinigt (Gruppe Hallo nicht mehr auffindbar)', (await search('q=gruppe')).json.length === 0);
ok('andere Chats unberuehrt', db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(A).n === 12);
ok('cleanup_done-Ereignis geschrieben', db.prepare("SELECT COUNT(*) AS n FROM events_outbox WHERE type='cleanup_done'").get().n === evBefore + 1);
const stateCmd = () => client.getSetting(db, 'ingest.state_command') ?? '';
ok('F14: nach "chat"-clear kein Befehl an den Ingest', stateCmd() === '', stateCmd());
r = await clear({ scope: 'media', confirm: true });
ok('F14: nach "media"-clear kein Befehl an den Ingest', stateCmd() === '', stateCmd());
ok('clear media: Dateien weg, Nachrichten bleiben', r.status === 200 && r.json.deletedMessages === 0 && r.json.deletedMedia >= 4 && !fs.existsSync(path.join(mediaDir, 'A/2023-11-14/a3.jpg')), r.json);
ok('Avatar-Cache unberuehrt', fs.existsSync(path.join(mediaDir, 'avatars/anna.jpg')));
ok('Datei ausserhalb media_dir unberuehrt', fs.existsSync(path.join(tmp, 'secret.txt')));
ok('Medienstatus expired', db.prepare("SELECT COUNT(*) AS n FROM media WHERE status = 'expired'").get().n >= 4);
r = await media('a3');
ok('media nach clear -> 404', r.status === 404);
r = await call('GET', mp(A), { cookie });
ok('Nachrichten nach media-clear noch da, Medienstatus expired', r.json.length === 12 && r.json.find((m) => m.id === 'a3').media.status === 'expired', r.json?.find((m) => m.id === 'a3'));
r = await clear({ scope: 'all', confirm: true });
ok('clear all', r.status === 200 && r.json.deletedMessages > 0 && db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0, r.json);
ok('F14: "alles" beauftragt den Ingest, Namen und Nummernzuordnung zu leeren', stateCmd() === 'clear_identity', stateCmd());
r = await call('GET', '/api/chats', { cookie });
ok('Chats nach clear all leer', r.status === 200 && r.json.length === 0);

// -- Version 2: Zitate, Versionen, Loeschmarke, Schild, "Jetzt laden", Stumm, Dokumentname, Speicher leeren mit/ohne geschuetzte
{
  const T2 = 1_700_001_000;
  client.upsertChat(db, { id: A, name: 'Anna', isGroup: false, lastActivityAt: T2 });
  const mk = (id, ts, o = {}) => client.insertMessageIfNotExists(db, {
    id, chatId: A, sender: o.sender ?? 'Anna', waTimestamp: ts, receivedAt: ts, direction: o.dir ?? 'in', type: o.type ?? 'text',
    text: o.text ?? ('t ' + id), ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(o.replyText ? { replyText: o.replyText } : {}),
    ...(o.replySender ? { replySender: o.replySender } : {}), ...(o.replyType ? { replyType: o.replyType } : {}),
  });
  mk('v1', T2 + 1, { text: 'Wann kommst du?' });
  mk('v2', T2 + 2, { text: 'Gegen sechs', dir: 'out', sender: 'Ich', replyTo: 'v1' });
  mk('v3', T2 + 3, { text: 'Antwort auf Verschwundenes', replyTo: 'weg', replyText: 'Ursprung', replySender: 'Bert', replyType: 'text' });
  mk('v4', T2 + 4, { type: 'video', text: 'Konzert' });
  client.setMediaStatus(db, 'v4', { status: 'expired', mimeType: 'video/mp4', sizeBytes: 38_000_000, skipReason: 'rule_off', loadable: true });
  mk('D1', T2 + 5, { type: 'document', text: 'Rechnung' });
  fs.mkdirSync(path.join(mediaDir, 'A/2023-11-14'), { recursive: true }); // der frühere clear hat leere Ordner entfernt
  fs.writeFileSync(path.join(mediaDir, 'A/2023-11-14/D1__Rechnung März.pdf'), Buffer.from('%PDF-1.4 x'));
  client.setMediaStatus(db, 'D1', { status: 'ready', filePath: 'A/2023-11-14/D1__Rechnung März.pdf', mimeType: 'application/pdf', sizeBytes: 10 });
  mk('v5', T2 + 6, { type: 'voice', text: undefined });
  client.setMediaStatus(db, 'v5', { status: 'ready', filePath: 'A/2023-11-14/a4.m4a', mimeType: 'audio/mp4', sizeBytes: 1000, durationSeconds: 63 });

  r = await call('GET', mp(A), { cookie });
  const m = Object.fromEntries(r.json.map((x) => [x.id, x]));
  ok('V2 Zitat mit vorhandenem Original: Text, Absender, fromMe', m.v2.quoted?.available === true && m.v2.quoted.text === 'Wann kommst du?' && m.v2.quoted.sender === 'Anna' && m.v2.quoted.fromMe === false && m.v2.quoted.id === 'v1', m.v2.quoted);
  ok('V2 Zitat ohne Original: Kurzzitat aus der Antwort', m.v3.quoted?.available === false && m.v3.quoted.text === 'Ursprung' && m.v3.quoted.sender === 'Bert' && m.v3.quoted.type === 'text', m.v3.quoted);
  ok('V2 keine Antwort -> quoted null', m.v1.quoted === null && m.v1.editCount === 0 && m.v1.protectedAt === null && m.v1.viewOnce === false);
  ok('V2 media: skipReason und loadable', m.v4.media.skipReason === 'rule_off' && m.v4.media.loadable === true && m.v5.media.loadable === false, m.v4.media);
  ok('V2 Dokument: Dateiname ohne Nachrichten-ID', m.D1.media.fileName === 'Rechnung März.pdf', m.D1.media);
  r = await media('D1');
  const cd = r.headers['content-disposition'] ?? '';
  ok('V2 Dokument-Download: Dateiname ohne ID im Header', r.status === 200 && cd.includes('Rechnung%20M%C3%A4rz.pdf') && !cd.includes('D1__'), cd);

  // Chatliste: Dauer, Absender, stumm
  r = await call('GET', '/api/chats', { cookie });
  const ca = r.json.find((c) => c.id === A);
  ok('V2 Chatliste: Dauer der letzten Sprachnachricht und Absender', ca.lastMessageType === 'voice' && ca.lastMessageDurationSeconds === 63 && ca.lastMessageSender === 'Anna' && ca.muted === false, ca);
  r = await call('PUT', `/api/chats/${encodeURIComponent(A)}/mute`, { cookie, body: { muted: 'ja' } });
  ok('V2 mute: kein Boolean -> 400', r.status === 400, r.status);
  r = await call('PUT', '/api/chats/nope/mute', { cookie, body: { muted: true } });
  ok('V2 mute: unbekannter Chat -> 404', r.status === 404, r.status);
  r = await call('PUT', `/api/chats/${encodeURIComponent(A)}/mute`, { cookie, body: { muted: true } });
  ok('V2 mute an', r.status === 200 && r.json.muted === true);
  r = await call('GET', '/api/chats', { cookie });
  ok('V2 Chatliste zeigt muted', r.json.find((c) => c.id === A).muted === true);
  r = await call('PUT', `/api/chats/${encodeURIComponent(A)}/mute`, { cookie, body: { muted: false } });
  r = await call('GET', '/api/chats', { cookie });
  ok('V2 mute wieder aus', r.json.find((c) => c.id === A).muted === false && client.getSetting(db, 'chat.muted') === '[]', client.getSetting(db, 'chat.muted'));

  // Bearbeitungsverlauf
  client.applyMessageEdit(db, 'v1', 'Wann kommst du heute?', T2 + 100);
  r = await call('GET', '/api/messages/v1/versions', { cookie });
  ok('V2 versions: aktuelle und fruehere Fassung', r.status === 200 && r.json.current.text === 'Wann kommst du heute?' && r.json.current.editedAt === T2 + 100 && r.json.versions.length === 1 && r.json.versions[0].text === 'Wann kommst du?' && r.json.versions[0].replacedAt === T2 + 100, r.json);
  r = await call('GET', '/api/messages/unbekannt/versions', { cookie });
  ok('V2 versions: unbekannte Nachricht -> 404', r.status === 404);
  r = await call('GET', mp(A), { cookie });
  ok('V2 Nachricht zeigt edited, editedAt, editCount', r.json.find((x) => x.id === 'v1').edited === true && r.json.find((x) => x.id === 'v1').editCount === 1 && r.json.find((x) => x.id === 'v1').editedAt === T2 + 100);

  // Loeschmarke: Standard (Inhalt zeigen) und hide_deleted_content = true (Hauptinstanz)
  client.markMessageDeleted(db, 'v3', T2 + 200);
  const cfg3 = buildConfig({ web: { port: PORT + 2, password_hash: '$argon2id$test', public_dir: pubDir, session_secret_file: path.join(tmp, 'session3.key'), passkey_file: path.join(tmp, 'none.json') }, paths: { db: dbFile, media_dir: mediaDir } });
  ok('V2 Standard: hide_deleted_content ist aus', cfg3.web.hideDeletedContent === false);
  const app3 = createApp({ cfg: cfg3, db, log: createLogger('error', () => {}), verifier: fakeVerifier });
  await app3.listen();
  const l3 = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.7.7.7' }, body: { password: 'correct horse battery' } }, PORT + 2);
  const cookie3 = (l3.headers['set-cookie']?.[0] ?? '').split(';')[0];
  r = await call('GET', mp(A), { cookie: cookie3 }, PORT + 2);
  const d3 = r.json.find((x) => x.id === 'v3');
  ok('V2 geloeschte Nachricht (Standard): Text bleibt, deleted und deletedAt gesetzt', d3.deleted === true && d3.text === 'Antwort auf Verschwundenes' && d3.deletedAt === T2 + 200, d3);
  r = await call('GET', mp(A), { cookie });
  ok('V2 geloeschte Nachricht (hide=true): Text verborgen, Zeitpunkt sichtbar', r.json.find((x) => x.id === 'v3').text === null && r.json.find((x) => x.id === 'v3').deletedAt === T2 + 200);
  await app3.close();

  // Schild und "Jetzt laden"
  r = await call('POST', '/api/messages/v1/protect', { cookie, body: { protected: 'ja' } });
  ok('V2 protect: kein Boolean -> 400', r.status === 400, r.status);
  r = await call('POST', '/api/messages/unbekannt/protect', { cookie, body: { protected: true } });
  ok('V2 protect: unbekannte Nachricht -> 404', r.status === 404);
  r = await call('POST', '/api/messages/v1/protect', { cookie, body: { protected: true } });
  ok('V2 protect an: protectedAt gesetzt, nichts zu laden', r.status === 200 && typeof r.json.protectedAt === 'number' && r.json.loading === false, r.json);
  const cmds = () => db.prepare("SELECT payload_json FROM ingest_commands WHERE type = 'load_media'").all().map((x) => JSON.parse(x.payload_json).messageId);
  ok('V2 protect an ohne ladbares Medium legt keinen Befehl an', cmds().length === 0, cmds());
  r = await call('POST', '/api/messages/v4/protect', { cookie, body: { protected: true } });
  ok('V2 protect an Nachricht mit ladbarem Medium: beauftragt den Ingest', r.status === 200 && r.json.loading === true && cmds().join() === 'v4', [r.json, cmds()]);
  r = await call('POST', '/api/media/v4/load', { cookie });
  ok('V2 load: 202, kein zweiter Befehl fuer dieselbe Nachricht', r.status === 202 && cmds().join() === 'v4', cmds());
  r = await call('POST', '/api/media/v5/load', { cookie });
  ok('V2 load: Medium nicht ladbar -> 409', r.status === 409 && r.json?.error === 'not_loadable', r.json);
  r = await call('POST', '/api/media/unbekannt/load', { cookie });
  ok('V2 load: unbekannt -> 404', r.status === 404);
  r = await call('POST', '/api/media/v4/load');
  ok('V2 load ohne Session -> 401', r.status === 401);
  ok('V2 SSE-Quelle: message_updated fuer protect geschrieben', db.prepare("SELECT COUNT(*) AS n FROM events_outbox WHERE type = 'message_updated' AND payload_json LIKE '%\"v1\"%'").get().n >= 1);

  // Speicher leeren: geschuetzte bleiben, nur includeProtected === true loescht sie
  r = await call('GET', '/api/storage/usage', { cookie });
  ok('V2 usage: geschuetzte Nachrichten gezaehlt', r.json.protectedMessages === 2 && typeof r.json.protectedMediaBytes === 'number', [r.json.protectedMessages, r.json.protectedMediaBytes]);
  r = await clear({ scope: 'all', confirm: true, includeProtected: 'true' });
  ok('V2 clear: includeProtected als String -> 400', r.status === 400 && r.json?.error === 'invalid_body', r.json);
  r = await clear({ scope: 'all', confirm: true, includeProtected: 1 });
  ok('V2 clear: includeProtected=1 -> 400', r.status === 400);
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  r = await clear({ scope: 'all', confirm: true });
  ok('V2 clear all ohne includeProtected: geschuetzte bleiben samt Versionen', r.status === 200 && r.json.keptProtected === 2 && db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 2 && db.prepare('SELECT COUNT(*) AS n FROM message_versions').get().n === 1, [r.json, before]);
  r = await clear({ scope: 'chat', chatId: A, confirm: true, includeProtected: false });
  ok('V2 clear chat mit includeProtected=false: geschuetzte bleiben', r.status === 200 && r.json.deletedMessages === 0 && r.json.keptProtected === 2, r.json);
  r = await clear({ scope: 'media', confirm: true });
  ok('V2 clear media: geschuetztes Medium bleibt', db.prepare("SELECT COUNT(*) AS n FROM messages WHERE protected_at IS NOT NULL").get().n === 2, r.json);
  r = await clear({ scope: 'all', confirm: true, includeProtected: true });
  ok('V2 clear all mit includeProtected=true: alles weg, auch Versionen und Suchindex', r.status === 200 && r.json.keptProtected === 0 && db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM message_versions').get().n === 0 && db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get().n === 0, r.json);
  r = await call('GET', '/api/chats', { cookie });
  ok('V2 Chats danach leer', r.json.length === 0);
}

// -- Statische Dateien
r = await call('GET', '/');
ok('static / -> index.html ohne Login', r.status === 200 && /INDEX/.test(r.body.toString()) && /text\/html/.test(r.headers['content-type']), r.status);
ok('static: CSP + no-cache + ETag', /default-src 'self'/.test(r.headers['content-security-policy']) && r.headers['cache-control'] === 'no-cache' && !!r.headers['etag']);
r = await call('GET', '/app.js');
ok('static js', r.status === 200 && /javascript/.test(r.headers['content-type']));
r = await call('GET', '/chat/abc');
ok('SPA-Fallback fuer Pfade ohne Endung', r.status === 200 && /INDEX/.test(r.body.toString()));
r = await call('GET', '/fehlt.js');
ok('fehlende Datei mit Endung -> 404', r.status === 404);
r = await call('GET', '/.env');
ok('Dotfile -> 404', r.status === 404 && !r.body.toString().includes('HIDDEN'));
r = await call('GET', '/%2e%2e/secret.txt');
ok('Traversal %2e%2e -> kein Zugriff', !r.body.toString().includes('TOPSECRET'), [r.status, r.body.toString().slice(0, 40)]);
r = await call('GET', '/..%2fsecret.txt');
ok('Traversal ..%2f -> kein Zugriff', !r.body.toString().includes('TOPSECRET'), [r.status]);
r = await call('GET', '/%00');
ok('Nullbyte -> 400/404', r.status === 400 || r.status === 404, r.status);
r = await call('GET', '/api/nope', { cookie });
ok('unbekannte API mit Session -> 404 JSON', r.status === 404 && r.json?.error === 'not_found');
r = await call('POST', '/api/chats', { cookie, body: {} });
ok('falsche Methode -> 405 + Allow', r.status === 405 && /GET/.test(r.headers['allow']), r.headers['allow']);

// -- Logout
r = await call('POST', '/api/logout', { cookie });
const lc = r.headers['set-cookie']?.[0] ?? '';
ok('logout loescht Cookie (Max-Age=0)', r.status === 200 && /Max-Age=0/.test(lc) && /HttpOnly/.test(lc), lc);

// -- Auth-Einheiten
{
  let now = 1_000_000_000_000;
  const a = new Auth({ passwordHash: '$argon2id$h1', secret: Buffer.alloc(32, 1), sessionSeconds: 60, verifier: async () => true, now: () => now });
  const t = a.issueToken();
  ok('Token gueltig', a.isValidToken(t));
  now += 59_000; ok('Token kurz vor Ablauf gueltig', a.isValidToken(t));
  now += 2_000; ok('Token abgelaufen', !a.isValidToken(t));
  now = 1_000_000_000_000;
  const b = new Auth({ passwordHash: '$argon2id$h2', secret: Buffer.alloc(32, 1), sessionSeconds: 60, verifier: async () => true, now: () => now });
  ok('anderer Passwort-Hash -> Token ungueltig (Passwortwechsel beendet Sessions)', !b.isValidToken(t));
  const c2 = new Auth({ passwordHash: '$argon2id$h1', secret: Buffer.alloc(32, 2), sessionSeconds: 60, verifier: async () => true, now: () => now });
  ok('anderes Geheimnis -> Token ungueltig', !c2.isValidToken(t));
  ok('Muell-Token', !a.isValidToken('') && !a.isValidToken('v1.1.2.3') && !a.isValidToken('a.b.c.d') && !a.isValidToken(undefined) && !a.isValidToken('v1.9999999999999.aa.' + 'A'.repeat(43)));
  const parts = t.split('.'); parts[1] = String(Number(parts[1]) + 1000);
  ok('Ablaufzeit manipuliert -> ungueltig', !a.isValidToken(parts.join('.')));
  // Warteschlange: seriell + Begrenzung
  let running_ = 0, maxRunning = 0;
  const slow = new Auth({ passwordHash: '$argon2id$h1', secret: Buffer.alloc(32, 1), sessionSeconds: 60, maxPending: 4, verifier: async () => { running_++; maxRunning = Math.max(maxRunning, running_); await sleep(30); running_--; return false; } });
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => slow.verifyPassword('x' + i)));
  ok('Argon2-Pruefungen laufen nie parallel', maxRunning === 1, maxRunning);
  ok('mehr als maxPending -> AuthBusyError', results.filter((x) => x.status === 'rejected' && x.reason?.name === 'AuthBusyError').length === 2, results.map((x) => x.status));
  const lim = new LoginLimiter(2, 1000, () => now);
  ok('Limiter: 2 erlaubt, 3. gesperrt, nach Fenster wieder frei', lim.hit('a').allowed && lim.hit('a').allowed && !lim.hit('a').allowed && (now += 1001, lim.hit('a').allowed));
  ok('parseRange Randfaelle', parseRange('bytes=0-0', 10).end === 0 && parseRange('bytes=0-', 0).kind === 'unsatisfiable' && parseRange('foo', 10).kind === 'none' && parseRange('bytes=-0', 10).kind === 'unsatisfiable' && parseRange('bytes=--1', 10).kind === 'none');
}

// -- Origin-Pruefung (zweite Instanz, opt-in)
{
  const cfg2 = buildConfig({ web: { port: PORT + 1, password_hash: '$argon2id$test', public_dir: pubDir, session_secret_file: path.join(tmp, 'session2.key'), passkey_file: path.join(tmp, 'none.json'), check_origin: true }, paths: { db: dbFile, media_dir: mediaDir } });
  const app2 = createApp({ cfg: cfg2, db, log: createLogger('error', () => {}), verifier: fakeVerifier });
  await app2.listen();
  const body = { password: 'correct horse battery' };
  let rr = await call('POST', '/api/login', { body, headers: { origin: 'http://evil.example', host: 'pi.local' } }, PORT + 1);
  ok('check_origin: fremde Origin -> 403', rr.status === 403, rr.status);
  rr = await call('POST', '/api/login', { body, headers: { origin: 'http://pi.local', host: 'pi.local' } }, PORT + 1);
  ok('check_origin: passende Origin -> 200', rr.status === 200, rr.status);
  rr = await call('POST', '/api/login', { body, headers: { origin: 'http://pi.local', host: '127.0.0.1:1', 'x-forwarded-host': 'pi.local' } }, PORT + 1);
  ok('check_origin: X-Forwarded-Host vom Loopback-Proxy', rr.status === 200, rr.status);
  rr = await call('POST', '/api/login', { body, headers: { origin: 'null' } }, PORT + 1);
  ok('check_origin: Origin "null" -> 403', rr.status === 403, rr.status);
  rr = await call('POST', '/api/login', { body }, PORT + 1);
  ok('check_origin: ohne Origin-Header erlaubt (z. B. curl)', rr.status === 200, rr.status);
  await app2.close();
}

// -- Logs duerfen keine Inhalte enthalten
const allLogs = logs.join('');
for (const secret of ['GEHEIMTEXT', 'SEKRET', 'Grüße', 'geheimwort', 'GEHEIMER-QR', 'correct horse battery', 'drop table', 'DROP TABLE', 'TOPSECRET', '$argon2id']) {
  ok('Log enthaelt nie "' + secret + '"', !allLogs.includes(secret));
}
ok('Log ist gueltiges JSON-Lines', logs.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
ok('Log enthaelt Ereignisse (Plausibilitaet)', allLogs.includes('"ev":"login_ok"') && allLogs.includes('"ev":"login_rate_limited"') && allLogs.includes('"ev":"storage_cleared"'));
ok('Keine unerwarteten Server-Fehler', !allLogs.includes('request_failed') && !allLogs.includes('event_handle_failed') && !allLogs.includes('outbox_poll_failed'), logs.filter((l) => /request_failed|event_handle_failed|outbox/.test(l)));

// -- Aufraeumen / Shutdown
const t0 = Date.now();
await running.close();
ok('close() beendet zuegig', Date.now() - t0 < 3000, Date.now() - t0);
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
for (const f of failures) console.log('FAIL: ' + f);
process.exit(fail ? 1 : 0);
