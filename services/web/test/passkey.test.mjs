// Tests der Passkey-Sperre (WebAuthn-Pruefung, Sperrlogik, Sitzungen, Notausstieg).
//
//   npm run build -w @waread/db && npm run build -w waread-web && node --no-warnings test/passkey.test.mjs
//
// Gegenstelle ist ein Software-Authenticator (test/support/softAuthenticator.mjs) mit echten P-256-Schluesseln
// und echten Signaturen. Der echte Browser-Ablauf (navigator.credentials) wird in test/passkey-e2e.mjs
// mit dem virtuellen Authenticator von Chromium geprueft; Safari/iOS wird hier NICHT geprueft.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { b64u, cbor, FLAG, SoftAuthenticator } from './support/softAuthenticator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.resolve(HERE, '../dist') + '/';
const imp = (p) => import(pathToFileURL(p).href);
const { createApp } = await imp(D + 'app.js');
const { buildConfig, ConfigError } = await imp(D + 'config.js');
const { openDatabase, migrate, initDbClient } = await imp(D + 'db.js');
const { createLogger } = await imp(D + 'log.js');
const { decodeCbor, CborError } = await imp(D + 'cbor.js');
const { verifyRegistration, verifyAssertion, WebAuthnError } = await imp(D + 'webauthn.js');
const { adminStatus, adminUnlock, adminReset, parseState } = await imp(D + 'passkeys.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e instanceof WebAuthnError && e.code === code; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RP = 'waread.test';
const ORIGIN = 'https://waread.test';

// ============ A. CBOR ============
{
  const c = (hex) => Buffer.from(hex, 'hex');
  ok('cbor: Zahlen und Texte', decodeCbor(c('1864')) === 100 && decodeCbor(c('20')) === -1 && decodeCbor(c('627669')) === 'vi');
  const m = decodeCbor(cbor(new Map([[1, 2], [-2, Buffer.from('ab')], ['k', [1, 2]]])));
  ok('cbor: Map mit Zahl-/Text-Schluesseln, Byte-String, Array', m instanceof Map && m.get(1) === 2 && m.get(-2).toString() === 'ab' && m.get('k').length === 2);
  const bad = (name, hex) => { try { decodeCbor(c(hex)); ok(name, false); } catch (e) { ok(name, e instanceof CborError, String(e)); } };
  bad('cbor: abgeschnitten wird abgelehnt', '5a00000005aa');
  bad('cbor: Byte-String mit riesiger Laenge ohne Daten', '5bffffffffffffffff');
  bad('cbor: unbestimmte Laenge wird abgelehnt', '5fff');
  bad('cbor: doppelter Map-Schluessel wird abgelehnt', 'a201020103');
  bad('cbor: Rest-Bytes werden abgelehnt', '0100');
  bad('cbor: Tiefe ueber Grenze (Verschachtelung)', '81'.repeat(40) + '00');
  bad('cbor: Array-Laenge ohne Elemente', '99ffff');
  bad('cbor: ungueltiges UTF-8', '62c328');
}

// ============ B. WebAuthn-Pruefung (direkt) ============
const mkCtx = (challenge) => ({ challenge, origin: ORIGIN, rpId: RP });
{
  const dev = new SoftAuthenticator({ rpId: RP, origin: ORIGIN });
  const ch = crypto.randomBytes(32);
  const opt = { challenge: ch.toString('base64url') };
  const reg = verifyRegistration(dev.create(opt), mkCtx(ch));
  ok('Registrierung: gueltige Antwort wird angenommen', reg.id === dev.id && reg.counter === 0 && reg.backupEligible && reg.backupState && reg.alg === -7, reg);
  ok('Registrierung: nur bekannte Transports bleiben', JSON.stringify(reg.transports) === JSON.stringify(['internal', 'hybrid']), reg.transports);

  const regFail = (name, code, o, c = ch) => ok('Registrierung: ' + name, throwsCode(() => verifyRegistration(dev.create(opt, o), mkCtx(c)), code));
  regFail('falscher Origin', 'wrong_origin', { origin: 'https://evil.test' });
  regFail('Origin mit Port', 'wrong_origin', { origin: 'https://waread.test:8443' });
  regFail('falsche RP-ID', 'wrong_rp_id', { rpId: 'evil.test' });
  regFail('falsche Challenge', 'wrong_challenge', {}, crypto.randomBytes(32));
  regFail('falscher Typ (get statt create)', 'wrong_type', { type: 'webauthn.get' });
  regFail('Benutzerverifikation fehlt (UV)', 'user_not_verified', { uv: false });
  regFail('Anwesenheit fehlt (UP)', 'user_not_present', { up: false });
  regFail('crossOrigin=true', 'cross_origin', { crossOrigin: true });
  { const other = b64u(crypto.randomBytes(32)); regFail('Credential-ID passt nicht zur ID in authData', 'credential_id_mismatch', { id: other, rawId: other }); }
  regFail('id != rawId', 'credential_id_mismatch', { id: b64u(crypto.randomBytes(32)) });
  regFail('Rest-Bytes hinter authData', 'bad_auth_data', { trailing: Buffer.from([1, 2, 3]) });
  regFail('Typ nicht public-key', 'bad_credential_type', { credType: 'password' });
  regFail('anderer Algorithmus (RS256)', 'unsupported_algorithm', { cose: new Map([[1, 3], [3, -257], [-1, Buffer.alloc(256, 1)], [-2, Buffer.from([1, 0, 1])]]) });
  regFail('EC-Schluessel mit falscher Algorithmus-Angabe (EdDSA -8)', 'unsupported_algorithm', { cose: (() => { const k = dev.coseKey(); k.set(3, -8); return k; })() });
  regFail('EC-Schluessel auf anderer Kurve (P-384 laut crv=2)', 'unsupported_algorithm', { cose: (() => { const k = dev.coseKey(); k.set(-1, 2); return k; })() });
  regFail('Punkt nicht auf der Kurve', 'bad_public_key', { cose: new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 2)]]) });
  regFail('BE=0 mit BS=1', 'bad_backup_flags', { flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BS });
  ok('Registrierung: kaputtes attestationObject', throwsCode(() => verifyRegistration(dev.create(opt, { attestationObject: Buffer.from('nope') }), mkCtx(ch)), 'bad_attestation'));
  ok('Registrierung: Eingabe kein Objekt', throwsCode(() => verifyRegistration(null, mkCtx(ch)), 'bad_credential'));
  ok('Registrierung: Felder keine Strings', throwsCode(() => verifyRegistration({ id: 1, rawId: 1, type: 'public-key', response: { clientDataJSON: 1, attestationObject: 2 } }, mkCtx(ch)), 'bad_credential_id'));

  // Anmeldung
  const stored = { id: reg.id, publicKey: reg.publicKey, counter: 0, backupEligible: true };
  const ch2 = crypto.randomBytes(32), opt2 = { challenge: ch2.toString('base64url') };
  const res = verifyAssertion(dev.get(opt2), stored, mkCtx(ch2));
  ok('Anmeldung: gueltige Antwort wird angenommen (Zaehler bleibt 0)', res.counter === 0 && res.backupState === true, res);
  const asFail = (name, code, o, st = stored, c = ch2) => ok('Anmeldung: ' + name, throwsCode(() => verifyAssertion(dev.get(opt2, o), st, mkCtx(c)), code));
  asFail('veraenderte Signatur', 'bad_signature', { tamperSignature: true });
  asFail('Signatur eines anderen Schluessels', 'bad_signature', { signWith: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey });
  asFail('falscher Origin', 'wrong_origin', { origin: 'https://evil.test' });
  asFail('falsche RP-ID', 'wrong_rp_id', { rpId: 'evil.test' });
  asFail('falsche Challenge', 'wrong_challenge', {}, stored, crypto.randomBytes(32));
  asFail('falscher Typ (create statt get)', 'wrong_type', { type: 'webauthn.create' });
  asFail('UV fehlt', 'user_not_verified', { uv: false });
  asFail('UP fehlt', 'user_not_present', { up: false });
  asFail('unbekannte Credential-ID', 'unknown_credential', { credId: crypto.randomBytes(32) });
  asFail('BE geaendert (Backup-Eignung)', 'backup_eligibility_changed', {}, { ...stored, backupEligible: false });
  asFail('Zaehler zurueckgesetzt (Klon): gespeichert 5, neu 5', 'counter_regressed', { signCount: 5 }, { ...stored, counter: 5 });
  asFail('Zaehler zurueckgesetzt: gespeichert 5, neu 3', 'counter_regressed', { signCount: 3 }, { ...stored, counter: 5 });
  asFail('Zaehler 0 nach gespeichert 5', 'counter_regressed', { signCount: 0 }, { ...stored, counter: 5 });
  ok('Anmeldung: Zaehler steigt 5 -> 6 ist in Ordnung', verifyAssertion(dev.get(opt2, { signCount: 6 }), { ...stored, counter: 5 }, mkCtx(ch2)).counter === 6);
  ok('Anmeldung: Zaehler 0 -> 1 ist in Ordnung', verifyAssertion(dev.get(opt2, { signCount: 1 }), stored, mkCtx(ch2)).counter === 1);
}

// ============ C. Konfiguration ============
{
  const base = { port: 18999, password_hash: '$argon2id$x' };
  const cfgOf = (extra) => buildConfig({ web: { ...base, ...extra } });
  ok('Konfig: ohne Passkey-Werte -> aus', cfgOf({}).web.passkey === null);
  ok('Konfig: Standardwerte', cfgOf({}).web.passkeyFile === '/var/lib/waread/passkeys.json' && cfgOf({}).web.passkeySessionHours === 12);
  const good = cfgOf({ passkey_rp_id: 'pi.example.org', passkey_origin: 'https://pi.example.org' }).web.passkey;
  ok('Konfig: gueltig', good?.rpId === 'pi.example.org' && good?.origin === 'https://pi.example.org');
  ok('Konfig: RP-ID = uebergeordnete Domain erlaubt', cfgOf({ passkey_rp_id: 'example.org', passkey_origin: 'https://pi.example.org' }).web.passkey?.rpId === 'example.org');
  ok('Konfig: localhost mit http erlaubt', cfgOf({ passkey_rp_id: 'localhost', passkey_origin: 'http://localhost:8080' }).web.passkey?.origin === 'http://localhost:8080');
  const rej = (name, extra) => { try { cfgOf(extra); ok(name, false); } catch (e) { ok(name, e instanceof ConfigError, String(e)); } };
  rej('Konfig: nur RP-ID', { passkey_rp_id: 'pi.example.org' });
  rej('Konfig: nur Origin', { passkey_origin: 'https://pi.example.org' });
  rej('Konfig: http fuer fremden Host', { passkey_rp_id: 'pi.example.org', passkey_origin: 'http://pi.example.org' });
  rej('Konfig: IP-Adresse als RP-ID', { passkey_rp_id: '192.168.1.5', passkey_origin: 'https://192.168.1.5' });
  rej('Konfig: Origin mit Pfad', { passkey_rp_id: 'pi.example.org', passkey_origin: 'https://pi.example.org/waread/' });
  rej('Konfig: Origin mit Schraegstrich am Ende', { passkey_rp_id: 'pi.example.org', passkey_origin: 'https://pi.example.org/' });
  rej('Konfig: Origin mit Standardport 443', { passkey_rp_id: 'pi.example.org', passkey_origin: 'https://pi.example.org:443' });
  rej('Konfig: RP-ID ist nur das Textende des Hosts (kein Domain-Suffix)', { passkey_rp_id: 'ample.org', passkey_origin: 'https://pi.example.org' });
  rej('Konfig: RP-ID passt nicht zum Origin-Host', { passkey_rp_id: 'other.org', passkey_origin: 'https://pi.example.org' });
  rej('Konfig: RP-ID mit Grossbuchstaben', { passkey_rp_id: 'Pi.Example.org', passkey_origin: 'https://pi.example.org' });
  rej('Konfig: RP-ID mit Port', { passkey_rp_id: 'pi.example.org:8443', passkey_origin: 'https://pi.example.org:8443' });
  rej('Konfig: Sitzungsstunden 0', { passkey_session_hours: 0 });
}

// ============ D. Dienst (HTTP) ============
// Eine Ausnahme mitten im Ablauf darf keine Ergebnisse verschlucken: sie wird als Fehlschlag gezaehlt.
var running;
try {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-pk-'));
const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(mediaDir, { recursive: true });
const pubDir = path.join(tmp, 'public'); fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(pubDir, 'index.html'), '<!doctype html>INDEX');
const dbModulePath = path.resolve(HERE, '../../../db/dist/client.js');
await initDbClient(dbModulePath);
const dbFile = path.join(tmp, 'waread.db');
const db = openDatabase(dbFile); migrate(db);
const pkFile = path.join(tmp, 'passkeys.json');
let clock = 1_800_000_000_000;
const PORT = Number(process.env.SMOKE_PORT ?? 18790) + 20;
const logs = [];
const log = createLogger('debug', (l) => logs.push(l));
const mkCfg = (extra = {}) => buildConfig({
  web: { port: PORT, password_hash: '$argon2id$test', public_dir: pubDir, session_secret_file: path.join(tmp, 'session.key'),
    passkey_rp_id: RP, passkey_origin: ORIGIN, passkey_file: pkFile, passkey_session_hours: 6, login_max_attempts: 5, ...extra },
  paths: { db: dbFile, media_dir: mediaDir },
});
const fakeVerifier = async (hash, pw) => hash === '$argon2id$test' && pw === 'correct horse battery';
const secret = crypto.randomBytes(32);
running = createApp({ cfg: mkCfg(), db, log, verifier: fakeVerifier, secret, passkeyNow: () => clock });
await running.listen();

function call(method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-forwarded-proto': 'https', ...(o.headers ?? {}) };
    let payload;
    if (o.body !== undefined) {
      payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (o.cookie) headers['cookie'] = o.cookie;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json; try { json = JSON.parse(body.toString('utf8')); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const cookieOf = (r) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0];
let ipSeq = 0;
const nextIp = () => `10.20.0.${++ipSeq}`;
const pwLogin = async () => {
  const r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': nextIp() }, body: { password: 'correct horse battery' } });
  return { r, cookie: cookieOf(r) };
};
const dev = new SoftAuthenticator({ rpId: RP, origin: ORIGIN });

/** Frische Passkey-Bestaetigung -> Freigabe. */
async function grantFor(cookie, purpose, device = dev, o = {}) {
  const opts = await call('POST', '/api/passkey/step/options', { cookie, body: { purpose } });
  if (opts.status !== 200) return { opts };
  const ver = await call('POST', '/api/passkey/step/verify', { cookie, headers: { 'x-forwarded-for': nextIp() }, body: { challengeId: opts.json.challengeId, credential: device.get(opts.json.options, o) } });
  return { opts, ver, grant: ver.json?.grant };
}

// -- vor jeder Einrichtung
let r = await call('GET', '/api/auth/state');
ok('Zustand ohne Einrichtung: keine Sperre, kein Passkey-Login (oeffentlich)', r.status === 200 && r.json?.lock === false && r.json?.passkey === false, r.json);
let { cookie: c0 } = await pwLogin();
ok('Passwort-Login ohne Sperre funktioniert wie bisher', c0.startsWith('waread_session=v1.'), c0.slice(0, 30));
r = await call('GET', '/api/passkeys', { cookie: c0 });
ok('Passkey-Uebersicht: konfiguriert, leer, keine Sperre', r.status === 200 && r.json.configured === true && r.json.rpId === RP && r.json.lock === false && r.json.passkeys.length === 0, r.json);
r = await call('POST', '/api/passkey/login/options', { body: {} });
ok('Login-Optionen ohne Passkey -> 409', r.status === 409 && r.json?.error === 'passkey_unavailable', r.json);
r = await call('POST', '/api/passkey/lock/on', { cookie: c0, body: { grant: 'x' } });
ok('Sperre einschalten ohne Freigabe -> 403', r.status === 403 && r.json?.error === 'step_up_required');

// -- jede Passkey-Route verlangt eine Sitzung (ausser den oeffentlichen)
{
  const probes = [
    ['GET', '/api/passkeys'], ['POST', '/api/passkey/step/options'], ['POST', '/api/passkey/step/verify'],
    ['POST', '/api/passkey/register/options'], ['POST', '/api/passkey/register/verify'], ['POST', '/api/passkey/lock/on'],
    ['POST', '/api/passkey/lock/off'], ['POST', '/api/passkey/delete'],
  ];
  const codes = [];
  for (const [m, p] of probes) codes.push((await call(m, p, m === 'POST' ? { body: {} } : {})).status);
  ok('alle Verwaltungsrouten ohne Sitzung -> 401', codes.every((s) => s === 401), codes);
  const bad = await call('GET', '/api/passkeys', { cookie: 'waread_session=v1.9999999999.aa.bb' });
  ok('Verwaltung mit gefaelschtem Token -> 401', bad.status === 401);
}

// -- Challenges sind zufaellig und zweckgebunden
{
  const a = await call('POST', '/api/passkey/register/options', { cookie: c0, body: {} });
  const b = await call('POST', '/api/passkey/register/options', { cookie: c0, body: {} });
  ok('Registrierungs-Challenges sind verschieden und 32 Byte lang', a.json.options.challenge !== b.json.options.challenge && a.json.challengeId !== b.json.challengeId && Buffer.from(a.json.options.challenge, 'base64url').length === 32);
  const bytes = new Set();
  for (let i = 0; i < 20; i++) bytes.add(Buffer.from(a.json.options.challenge, 'base64url')[i]);
  ok('Challenge-Bytes sehen zufaellig aus (mehr als 10 verschiedene Werte)', bytes.size > 10, [...bytes]);
}
r = await call('POST', '/api/passkey/register/options', { cookie: c0, body: {} });
const regOpts = r.json?.options;
ok('Registrierungsoptionen: RP, nur ES256, UV und residentKey Pflicht, keine Attestation', r.status === 200
  && regOpts.rp.id === RP && regOpts.pubKeyCredParams.length === 1 && regOpts.pubKeyCredParams[0].alg === -7
  && regOpts.authenticatorSelection.userVerification === 'required' && regOpts.authenticatorSelection.residentKey === 'required'
  && regOpts.attestation === 'none' && Buffer.from(regOpts.challenge, 'base64url').length === 32 && regOpts.excludeCredentials.length === 0, r.json);
const challengeA = r.json.challengeId;
r = await call('POST', '/api/passkey/register/verify', { cookie: c0, body: { challengeId: challengeA, credential: dev.create(regOpts, { origin: 'https://evil.test' }), label: 'x' } });
ok('Registrierung mit falschem Origin -> 400', r.status === 400 && r.json?.error === 'invalid_credential', r.json);
r = await call('POST', '/api/passkey/register/verify', { cookie: c0, body: { challengeId: challengeA, credential: dev.create(regOpts), label: 'iPhone' } });
ok('Challenge ist nach einem Fehlversuch verbraucht (kein zweiter Versuch)', r.status === 400 && r.json?.error === 'challenge_expired', r.json);
r = await call('POST', '/api/passkey/register/options', { cookie: c0, body: {} });
const regOpts2 = r.json.options, challengeB = r.json.challengeId;
r = await call('POST', '/api/passkey/register/verify', { cookie: c0, body: { challengeId: challengeB, credential: dev.create(regOpts2), label: '  Mein iPhone\u0007  ' } });
ok('Registrierung gueltig -> 200, Passkey gelistet, Bezeichnung bereinigt', r.status === 200 && r.json.passkeys.length === 1 && r.json.passkeys[0].label === 'Mein iPhone' && r.json.passkeys[0].id === dev.id, r.json);
ok('Antwort enthaelt keinen oeffentlichen Schluessel und keinen Zaehler', !JSON.stringify(r.json).includes('publicKey') && !JSON.stringify(r.json).includes('counter'));
r = await call('POST', '/api/passkey/register/verify', { cookie: c0, body: { challengeId: challengeB, credential: dev.create(regOpts2), label: 'again' } });
ok('Replay derselben Challenge -> 400', r.status === 400 && r.json?.error === 'challenge_expired');
r = await call('POST', '/api/passkey/register/options', { cookie: c0, body: {} });
ok('weitere Registrierungsoptionen schliessen vorhandene Passkeys aus (excludeCredentials)', r.status === 200 && r.json.options.excludeCredentials.length === 1 && r.json.options.excludeCredentials[0].id === dev.id, r.json?.options?.excludeCredentials);
r = await call('POST', '/api/passkey/register/verify', { cookie: c0, body: { challengeId: r.json.challengeId, credential: dev.create(r.json.options) } });
ok('derselbe Passkey ein zweites Mal -> 409', r.status === 409 && r.json?.error === 'passkey_exists', r.json);

// Datei: Rechte und Inhalt
{
  const st = fs.statSync(pkFile);
  ok('Passkey-Datei hat Modus 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  const saved = parseState(fs.readFileSync(pkFile, 'utf8'));
  ok('Datei: ein Passkey, Sperre aus, Epoche 0', saved.credentials.length === 1 && saved.lock === false && saved.epoch === 0);
  ok('Datei: Benutzer-Handle ist 32 Zufallsbytes', Buffer.from(saved.userHandle, 'base64url').length === 32);
}

// -- noch keine Sperre: beide Wege gehen
r = await call('GET', '/api/auth/state');
ok('Zustand nach Registrierung: Passkey-Login moeglich, noch keine Sperre', r.json?.lock === false && r.json?.passkey === true, r.json);
ok('Passwort-Login geht weiter, solange die Sperre aus ist', (await pwLogin()).cookie.startsWith('waread_session='));

// -- Sperre einschalten: Freigabe noetig
{
  const bogus = await grantFor(c0, 'lock_on', dev, { tamperSignature: true });
  ok('Freigabe mit falscher Signatur wird verweigert (403, Sitzung bleibt gueltig)', bogus.ver.status === 403 && (await call('GET', '/api/passkeys', { cookie: c0 })).status === 200 && !bogus.grant, bogus.ver.json);
  const wrongDev = new SoftAuthenticator({ rpId: RP, origin: ORIGIN });
  const unknown = await grantFor(c0, 'lock_on', wrongDev);
  ok('Freigabe mit nicht registriertem Passkey wird verweigert (403)', unknown.ver.status === 403);
  const g = await grantFor(c0, 'lock_off');
  const wrongPurpose = await call('POST', '/api/passkey/lock/on', { cookie: c0, body: { grant: g.grant } });
  ok('Freigabe fuer anderen Zweck (lock_off) schaltet die Sperre nicht ein', wrongPurpose.status === 403, wrongPurpose.json);
  const other = await pwLogin();
  const g2 = await grantFor(c0, 'lock_on');
  const stolen = await call('POST', '/api/passkey/lock/on', { cookie: other.cookie, body: { grant: g2.grant } });
  ok('Freigabe ist an die Sitzung gebunden (andere Sitzung -> 403)', stolen.status === 403, stolen.json);
  const reuse = await call('POST', '/api/passkey/lock/on', { cookie: c0, body: { grant: g2.grant } });
  ok('verbrauchte Freigabe ist ungueltig (sie wurde auch beim Fehlversuch verbraucht)', reuse.status === 403);
}

// Alte Sitzungen: eine laufende SSE-Verbindung und zwei Cookies
const sseCookie = (await pwLogin()).cookie;
const preLockCookie = (await pwLogin()).cookie;
let sseEnded = false;
const sseReq = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET', headers: { cookie: sseCookie, 'x-forwarded-proto': 'https' } }, (res) => {
  res.on('data', () => {}); res.on('end', () => { sseEnded = true; }); res.on('close', () => { sseEnded = true; });
});
sseReq.on('error', () => { sseEnded = true; });
sseReq.end();
await sleep(150);

const gOn = await grantFor(c0, 'lock_on');
r = await call('POST', '/api/passkey/lock/on', { cookie: c0, body: { grant: gOn.grant } });
const lockCookie = cookieOf(r);
ok('Sperre einschalten mit gueltiger Freigabe -> 200, neues Cookie, Sperre aktiv', r.status === 200 && r.json.lock === true && lockCookie.startsWith('waread_session=v1.') && lockCookie !== c0, r.json);
ok('Cookie der Passkey-Sitzung: Max-Age = passkey_session_hours (6 h), HttpOnly, SameSite=Strict, Secure', (() => {
  const sc = r.headers['set-cookie'][0];
  return /Max-Age=21600/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Secure/.test(sc);
})(), r.headers['set-cookie']);
r = await call('GET', '/api/chats', { cookie: c0 });
ok('alte Sitzung (vor der Sperre) ist ungueltig -> 401', r.status === 401);
r = await call('GET', '/api/chats', { cookie: preLockCookie });
ok('weitere Passwort-Sitzung (vor der Sperre) ist ungueltig -> 401', r.status === 401);
r = await call('GET', '/api/chats', { cookie: lockCookie });
ok('neue Sitzung funktioniert', r.status === 200);
await sleep(200);
ok('offene Live-Verbindung der alten Sitzung wurde beendet', sseEnded === true);

// -- Passwort-Login bei aktiver Sperre
{
  const ip = nextIp();
  const good = await call('POST', '/api/login', { headers: { 'x-forwarded-for': ip }, body: { password: 'correct horse battery' } });
  const wrong = await call('POST', '/api/login', { headers: { 'x-forwarded-for': ip }, body: { password: 'falsch' } });
  ok('Passwort-Login bei aktiver Sperre: richtiges Passwort -> 403 passkey_required, kein Cookie', good.status === 403 && good.json?.error === 'passkey_required' && !good.headers['set-cookie'], good.json);
  ok('Passwort-Login bei aktiver Sperre: falsches Passwort liefert dieselbe Antwort (kein Hinweis)', wrong.status === 403 && JSON.stringify(wrong.json) === JSON.stringify(good.json));
  ok('Passwort-Login bei aktiver Sperre zaehlt nicht gegen das Passwort-Limit (kein 429 nach 8 Versuchen)', await (async () => {
    let last = 0; for (let i = 0; i < 8; i++) last = (await call('POST', '/api/login', { headers: { 'x-forwarded-for': ip }, body: { password: 'x' } })).status; return last === 403;
  })());
  r = await call('GET', '/api/auth/state');
  ok('Zustand: Sperre aktiv, Passkey-Login moeglich', r.json?.lock === true && r.json?.passkey === true);
}

// -- Passkey-Login
let pkCookie;
{
  const ip = nextIp();
  r = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': ip }, body: {} });
  const o = r.json?.options;
  ok('Login-Optionen: RP-ID, UV Pflicht, keine vorab genannten Passkeys', r.status === 200 && o.rpId === RP && o.userVerification === 'required' && Array.isArray(o.allowCredentials) && o.allowCredentials.length === 0 && Buffer.from(o.challenge, 'base64url').length === 32, r.json);
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': ip }, body: { challengeId: r.json.challengeId, credential: dev.get(o) } });
  pkCookie = cookieOf(r);
  ok('Passkey-Login gueltig -> 200 + Cookie', r.status === 200 && pkCookie.startsWith('waread_session=v1.'), r.json);
  ok('Passkey-Login-Cookie: Max-Age 6 h', /Max-Age=21600/.test(r.headers['set-cookie'][0]));
  r = await call('GET', '/api/chats', { cookie: pkCookie });
  ok('Sitzung nach Passkey-Login funktioniert', r.status === 200);

  // Fehlerfaelle
  const login = async (mut, c = {}, useIp = ip) => {
    const rr = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': useIp }, body: {} });
    return call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': useIp }, body: { challengeId: rr.json.challengeId, credential: dev.get(rr.json.options, mut), ...c } });
  };
  const ipFresh = () => nextIp();
  r = await login({ tamperSignature: true });
  ok('Login mit veraenderter Signatur -> 401 ohne Cookie', r.status === 401 && !r.headers['set-cookie'], r.json);
  r = await login({ origin: 'https://evil.test' });
  ok('Login mit falschem Origin (Phishing-Seite) -> 401', r.status === 401);
  r = await login({ uv: false });
  ok('Login ohne Benutzerverifikation -> 401', r.status === 401);
  r = await login({ credId: crypto.randomBytes(32) });
  ok('Login mit unbekannter Credential-ID -> 401', r.status === 401);
  r = await login({}, { challengeId: 'unbekannt' });
  ok('Login mit unbekannter Challenge -> 400', r.status === 400 && r.json?.error === 'challenge_expired', r.json);
  // Challenge nicht fuer anderen Zweck verwendbar
  const stepCh = await call('POST', '/api/passkey/step/options', { cookie: pkCookie, body: { purpose: 'lock_off' } });
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': ipFresh() }, body: { challengeId: stepCh.json.challengeId, credential: dev.get(stepCh.json.options) } });
  ok('Challenge einer Freigabe laesst sich nicht fuer den Login benutzen', r.status === 400 && !r.headers['set-cookie'], r.json);
  const loginCh = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': ipFresh() }, body: {} });
  r = await call('POST', '/api/passkey/step/verify', { cookie: pkCookie, headers: { 'x-forwarded-for': ipFresh() }, body: { challengeId: loginCh.json.challengeId, credential: dev.get(loginCh.json.options) } });
  ok('Challenge des Logins laesst sich nicht als Freigabe benutzen', r.status === 400 && !r.json?.grant, r.json);
  // Challenge des Logins auch nicht fuer die Registrierung (neuer Passkey ohne Freigabe einschleusen)
  {
    const lc = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': ipFresh() }, body: {} });
    const evil = new SoftAuthenticator({ rpId: RP, origin: ORIGIN });
    const before = (await call('GET', '/api/passkeys', { cookie: pkCookie })).json.passkeys.length;
    r = await call('POST', '/api/passkey/register/verify', { cookie: pkCookie, body: { challengeId: lc.json.challengeId, credential: evil.create(lc.json.options), label: 'Einschleusung' } });
    const after = (await call('GET', '/api/passkeys', { cookie: pkCookie })).json.passkeys.length;
    ok('Challenge des Logins laesst sich nicht fuer die Registrierung benutzen (kein neuer Passkey)', r.status === 400 && after === before, [r.status, r.json, before, after]);
  }
  // Ablauf
  const old = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': ipFresh() }, body: {} });
  clock += 200_000;
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': ipFresh() }, body: { challengeId: old.json.challengeId, credential: dev.get(old.json.options) } });
  ok('abgelaufene Challenge (200 s) -> 400', r.status === 400 && r.json?.error === 'challenge_expired');
  // Rate-Limit
  const ipLim = nextIp();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': ipLim }, body: { challengeId: 'x', credential: {} } })).status);
  ok('Login-Versuche je IP begrenzt: 5 Versuche, dann 429', codes.slice(0, 5).every((s) => s === 400) && codes[5] === 429 && codes[6] === 429, codes);
  const okOther = await login({}, {}, nextIp());
  ok('Limit einer IP sperrt andere IPs nicht', okOther.status === 200, okOther.json);
  // Eingaben
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': nextIp(), 'content-type': 'text/plain' }, body: '{}' });
  ok('Login-Pruefung verlangt application/json (415)', r.status === 415);
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': nextIp() }, body: { challengeId: 'x'.repeat(500), credential: 1 } });
  ok('zu lange Challenge-ID / falsche Typen -> 400', r.status === 400);
  r = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': nextIp() }, body: 'x'.repeat(40_000) });
  ok('zu grosser Body -> 413 oder 400', r.status === 413 || r.status === 400, r.status);
}

// -- Verwaltung bei aktiver Sperre: Freigabe Pflicht
{
  r = await call('POST', '/api/passkey/register/options', { cookie: pkCookie, body: {} });
  ok('Passkey hinzufuegen bei Sperre ohne Freigabe -> 403', r.status === 403 && r.json?.error === 'step_up_required', r.json);
  r = await call('POST', '/api/passkey/delete', { cookie: pkCookie, body: { id: dev.id } });
  ok('Passkey loeschen bei Sperre ohne Freigabe -> 403', r.status === 403);
  r = await call('POST', '/api/passkey/lock/off', { cookie: pkCookie, body: {} });
  ok('Sperre ausschalten ohne Freigabe -> 403', r.status === 403);
  ok('Zustand blieb gesperrt', (await call('GET', '/api/auth/state')).json.lock === true);

  // zweiter Passkey (iPad)
  const ipad = new SoftAuthenticator({ rpId: RP, origin: ORIGIN, counterMode: 'increment' });
  const g = await grantFor(pkCookie, 'register');
  const ro = await call('POST', '/api/passkey/register/options', { cookie: pkCookie, body: { grant: g.grant } });
  ok('Registrierungsoptionen mit Freigabe -> 200', ro.status === 200, ro.json);
  const rv = await call('POST', '/api/passkey/register/verify', { cookie: pkCookie, body: { challengeId: ro.json.challengeId, credential: ipad.create(ro.json.options), label: 'iPad' } });
  ok('zweiter Passkey registriert', rv.status === 200 && rv.json.passkeys.length === 2, rv.json);
  // Anmeldung mit dem iPad (Zaehler steigt) und Klon-Erkennung
  const lo = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': nextIp() }, body: {} });
  const lv = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': nextIp() }, body: { challengeId: lo.json.challengeId, credential: ipad.get(lo.json.options) } });
  ok('Anmeldung mit zweitem Passkey (Zaehler 1)', lv.status === 200);
  const lo2 = await call('POST', '/api/passkey/login/options', { headers: { 'x-forwarded-for': nextIp() }, body: {} });
  const lv2 = await call('POST', '/api/passkey/login/verify', { headers: { 'x-forwarded-for': nextIp() }, body: { challengeId: lo2.json.challengeId, credential: ipad.get(lo2.json.options, { signCount: 1 }) } });
  ok('gleicher Zaehler nochmal (geklonter Authenticator) -> 401', lv2.status === 401);
  const saved = parseState(fs.readFileSync(pkFile, 'utf8'));
  ok('Zaehler und letzte Nutzung gespeichert', saved.credentials.find((k) => k.id === ipad.id).counter === 2 && saved.credentials.every((k) => k.lastUsedAt !== null));

  // loeschen: Freigabe Pflicht, nicht der letzte bei Sperre
  const gd = await grantFor(pkCookie, 'delete');
  const del = await call('POST', '/api/passkey/delete', { cookie: pkCookie, body: { id: ipad.id, grant: gd.grant } });
  ok('Passkey loeschen mit Freigabe -> 200', del.status === 200 && del.json.passkeys.length === 1 && del.json.passkeys[0].id === dev.id, del.json);
  const gd2 = await grantFor(pkCookie, 'delete');
  const last = await call('POST', '/api/passkey/delete', { cookie: pkCookie, body: { id: dev.id, grant: gd2.grant } });
  ok('letzten Passkey bei aktiver Sperre loeschen -> 409', last.status === 409 && last.json?.error === 'last_passkey_while_locked', last.json);
  const gd3 = await grantFor(pkCookie, 'delete');
  const nf = await call('POST', '/api/passkey/delete', { cookie: pkCookie, body: { id: 'AAAA', grant: gd3.grant } });
  ok('unbekannten Passkey loeschen -> 404', nf.status === 404);
}

// -- Persistenz: Neustart des Dienstes
await running.close();
running = createApp({ cfg: mkCfg(), db, log, verifier: fakeVerifier, secret, passkeyNow: () => clock });
await running.listen();
r = await call('GET', '/api/chats', { cookie: pkCookie });
ok('Sitzung ueberlebt den Neustart (Epoche steht in der Datei)', r.status === 200);
r = await call('GET', '/api/auth/state');
ok('Sperre ueberlebt den Neustart', r.json?.lock === true && r.json?.passkey === true);
r = await call('GET', '/api/chats', { cookie: c0 });
ok('alte Sitzung bleibt nach Neustart ungueltig', r.status === 401);

// -- Sperre ausschalten
{
  const g = await grantFor(pkCookie, 'lock_off');
  r = await call('POST', '/api/passkey/lock/off', { cookie: pkCookie, body: { grant: g.grant } });
  const offCookie = cookieOf(r);
  ok('Sperre ausschalten mit Freigabe -> 200, neues Cookie (normale Laufzeit)', r.status === 200 && r.json.lock === false && offCookie !== pkCookie && /Max-Age=2592000/.test(r.headers['set-cookie'][0]), r.headers['set-cookie']);
  ok('Sitzung vor dem Ausschalten ist ungueltig, neue gueltig', (await call('GET', '/api/chats', { cookie: pkCookie })).status === 401 && (await call('GET', '/api/chats', { cookie: offCookie })).status === 200);
  ok('danach geht der Passwort-Login wieder', (await pwLogin()).cookie.startsWith('waread_session='));
  // ohne Sperre: Loeschen braucht keine Freigabe
  const del = await call('POST', '/api/passkey/delete', { cookie: offCookie, body: { id: dev.id } });
  ok('ohne Sperre: Passkey loeschen braucht nur die Sitzung', del.status === 200 && del.json.passkeys.length === 0, del.json);
  r = await call('POST', '/api/passkey/lock/on', { cookie: offCookie, body: { grant: 'x' } });
  ok('Sperre einschalten ohne Passkey geht nicht', r.status === 403 || r.status === 409);
}

// -- Datei beschaedigt: geschlossen
{
  // wieder einrichten
  const { cookie } = await pwLogin();
  const ro = await call('POST', '/api/passkey/register/options', { cookie, body: {} });
  await call('POST', '/api/passkey/register/verify', { cookie, body: { challengeId: ro.json.challengeId, credential: dev.create(ro.json.options), label: 'neu' } });
  const g = await grantFor(cookie, 'lock_on');
  const lk = await call('POST', '/api/passkey/lock/on', { cookie, body: { grant: g.grant } });
  const live = cookieOf(lk);
  ok('Vorbereitung: Sperre wieder aktiv', lk.status === 200 && (await call('GET', '/api/chats', { cookie: live })).status === 200);

  // Datei veraendert (extern, z. B. durch CLI): Dienst bemerkt es nach hoechstens 1 s
  adminUnlock(pkFile);
  clock += 2_000;
  r = await call('GET', '/api/chats', { cookie: live });
  ok('externer Notausstieg (CLI-Funktion unlock) beendet alle Sitzungen binnen 1 s', r.status === 401);
  r = await call('GET', '/api/auth/state');
  ok('nach unlock: Sperre aus, Passkey bleibt', r.json.lock === false && r.json.passkey === true);
  ok('nach unlock: Passwort-Login geht', (await pwLogin()).cookie.startsWith('waread_session='));

  // Beschaedigung
  const g2cookie = (await pwLogin()).cookie;
  const og = await call('POST', '/api/passkey/step/options', { cookie: g2cookie, body: { purpose: 'lock_on' } });
  const gv = await call('POST', '/api/passkey/step/verify', { cookie: g2cookie, headers: { 'x-forwarded-for': nextIp() }, body: { challengeId: og.json.challengeId, credential: dev.get(og.json.options) } });
  const lk2 = await call('POST', '/api/passkey/lock/on', { cookie: g2cookie, body: { grant: gv.json.grant } });
  const live2 = cookieOf(lk2);
  fs.writeFileSync(pkFile, '{kaputt');
  clock += 2_000;
  r = await call('GET', '/api/chats', { cookie: live2 });
  ok('unlesbare Passkey-Datei: bestehende Sitzungen werden ungueltig (geschlossen)', r.status === 401);
  r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': nextIp() }, body: { password: 'correct horse battery' } });
  ok('unlesbare Passkey-Datei: Passwort-Login bleibt gesperrt (403)', r.status === 403 && r.json?.error === 'passkey_required');
  r = await call('GET', '/api/auth/state');
  ok('unlesbare Passkey-Datei: Zustand gesperrt, kein Passkey-Login', r.json.lock === true && r.json.passkey === false, r.json);
  ok('unlesbare Passkey-Datei: Fehler im Journal', logs.some((l) => /passkey_store_invalid/.test(l)));
  // Notausstieg
  ok('adminStatus erkennt die ungueltige Datei', (() => { const s = adminStatus(pkFile); return s.exists && !s.valid && s.lock; })());
  adminUnlock(pkFile);
  ok('adminUnlock legt die kaputte Datei beiseite und schreibt eine gueltige', fs.readdirSync(tmp).some((f) => f.startsWith('passkeys.json.broken-')) && adminStatus(pkFile).valid);
  clock += 2_000;
  r = await call('GET', '/api/auth/state');
  ok('nach Notausstieg: Sperre aus', r.json.lock === false);
  ok('nach Notausstieg: Passwort-Login geht wieder', (await pwLogin()).cookie.startsWith('waread_session='));
}

// -- CLI
{
  const cli = path.join(D, 'passkey-admin.js');
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', cli, ...args], { encoding: 'utf8' });
  const f = path.join(tmp, 'cli-passkeys.json');
  let p = run('status', '--file', f);
  ok('CLI status ohne Datei: keine Sperre', p.status === 0 && /Sperre: aus/.test(p.stdout) && /Passkeys: 0/.test(p.stdout), p.stdout + p.stderr);
  adminReset(f);
  p = run('unlock', '--file', f);
  ok('CLI unlock laeuft durch und meldet Erfolg', p.status === 0 && /entsperrt/i.test(p.stdout), p.stdout + p.stderr);
  p = run('reset', '--file', f);
  ok('CLI reset ohne Bestaetigung wird abgelehnt', p.status !== 0 && /--yes/.test(p.stderr + p.stdout));
  p = run('reset', '--file', f, '--yes');
  ok('CLI reset --yes setzt zurueck', p.status === 0 && adminStatus(f).credentials === 0);
  p = run('unbekannt');
  ok('CLI: unbekannter Befehl -> Exit 2', p.status === 2);
  ok('CLI-Ausgabe enthaelt keine Schluessel', !/publicKey|userHandle/.test(run('status', '--file', f).stdout));
  // userHandle bleibt bei reset erhalten (gleiche Konto-Kennung, damit der iPhone-Eintrag ersetzt statt verdoppelt wird)
  const before = JSON.parse(fs.readFileSync(f, 'utf8')).userHandle;
  run('reset', '--file', f, '--yes');
  ok('reset behaelt das Benutzer-Handle', JSON.parse(fs.readFileSync(f, 'utf8')).userHandle === before);
}

// -- Grenzen: Anzahl Passkeys, Ablauf einer Freigabe
{
  const { cookie } = await pwLogin();
  const devs = [];
  let last;
  for (let i = 0; i < 10; i++) {
    const d = new SoftAuthenticator({ rpId: RP, origin: ORIGIN });
    devs.push(d);
    const ro = await call('POST', '/api/passkey/register/options', { cookie, body: {} });
    last = await call('POST', '/api/passkey/register/verify', { cookie, body: { challengeId: ro.json.challengeId, credential: d.create(ro.json.options), label: 'Geraet ' + i } });
  }
  ok('zehn Passkeys sind erlaubt', last.status === 200 && last.json.passkeys.length === 10, last.json);
  const ro = await call('POST', '/api/passkey/register/options', { cookie, body: {} });
  ok('elfter Passkey -> 409 too_many_passkeys', ro.status === 409 && ro.json?.error === 'too_many_passkeys', ro.json);
  const g = await grantFor(cookie, 'lock_on', devs[0]);
  clock += 130_000;
  const late = await call('POST', '/api/passkey/lock/on', { cookie, body: { grant: g.grant } });
  ok('Freigabe verfaellt nach 2 Minuten -> 403, Sperre bleibt aus', late.status === 403 && (await call('GET', '/api/auth/state')).json.lock === false, late.json);
  const g2 = await grantFor(cookie, 'lock_on', devs[3]);
  const fresh = await call('POST', '/api/passkey/lock/on', { cookie, body: { grant: g2.grant } });
  ok('Freigabe mit einem beliebigen der registrierten Passkeys genuegt', fresh.status === 200 && fresh.json.lock === true, fresh.json);
  adminReset(pkFile);
  clock += 2_000;
  ok('Reset per CLI-Funktion: Sperre aus, keine Passkeys', (await call('GET', '/api/auth/state')).json.lock === false && (await call('GET', '/api/auth/state')).json.passkey === false);
}

// -- Passkey-Funktion nicht konfiguriert
{
  await running.close();
  running = createApp({ cfg: buildConfig({ web: { port: PORT, password_hash: '$argon2id$test', public_dir: pubDir, session_secret_file: path.join(tmp, 'session.key'), passkey_file: path.join(tmp, 'none.json') }, paths: { db: dbFile, media_dir: mediaDir } }), db, log, verifier: fakeVerifier, secret });
  await running.listen();
  const { cookie } = await pwLogin();
  r = await call('GET', '/api/passkeys', { cookie });
  ok('ohne Konfiguration: Uebersicht meldet configured=false', r.status === 200 && r.json.configured === false && r.json.rpId === null, r.json);
  r = await call('POST', '/api/passkey/register/options', { cookie, body: {} });
  ok('ohne Konfiguration: Registrierung -> 409 passkey_not_configured', r.status === 409 && r.json?.error === 'passkey_not_configured', r.json);
  r = await call('POST', '/api/passkey/login/options', { body: {} });
  ok('ohne Konfiguration: Passkey-Login -> 409', r.status === 409);
  ok('ohne Konfiguration: Passwort-Login unveraendert', cookie.startsWith('waread_session=v1.'));
}

} catch (e) {
  ok('Testlauf ohne Abbruch durch Ausnahme', false, String(e?.stack ?? e).split('\n').slice(0, 4));
} finally {
  try { await running?.close(); } catch { /* egal */ }
}
for (const f of failures) console.log('FAIL: ' + f);
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
