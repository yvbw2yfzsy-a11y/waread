// WebAuthn-Pruefung auf dem Server (W3C WebAuthn Level 3, Abschnitte 7.1 und 7.2), nur mit node:crypto.
//
// Warum selbst geschrieben: In der Zielumgebung ist keine zusaetzliche Bibliothek eingeplant, und der Umfang
// ist klein, weil bewusst nur der eine Fall noetig ist: Einzelbenutzer, ES256 (P-256), Passkey mit
// Benutzerverifikation (Face ID / Touch ID).
//
// Festlegungen (jede ist eine Verschaerfung, keine Lockerung):
// - Nur ES256. Der Server bietet nur diesen Algorithmus an und akzeptiert nichts anderes.
// - Benutzerverifikation (UV) ist Pflicht, Anwesenheit (UP) sowieso.
// - Origin und RP-ID kommen aus der Konfiguration, NIE aus Anfrage-Headern.
// - Attestation wird nicht ausgewertet (attestation: "none"): Herkunft/Modell des Geraets ist hier
//   unerheblich; der Schutz ergibt sich aus der Signaturpruefung bei jeder Anmeldung.
// - Zaehler: Bleibt er bei 0 (iCloud-Schluesselbund-Passkeys tun das), ist das in Ordnung. Sobald einer der
//   beiden Werte ungleich 0 ist, muss der neue strikt groesser sein, sonst Ablehnung (geklontes Geraet).
// - Das Flag "backup eligible" darf sich nach der Registrierung nicht aendern.
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { CborError, type CborValue, decodeCbor, decodeCborPrefix } from './cbor.js';

export class WebAuthnError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WebAuthnError';
  }
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

export const COSE_ES256 = -7;

const MAX_CLIENT_DATA = 4096;
const MAX_ATTESTATION = 16384;
const MAX_AUTH_DATA = 4096;
const MAX_SIGNATURE = 512;
const MAX_CREDENTIAL_ID = 1023;

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);

export interface ExpectedContext {
  /** Die zuvor ausgegebene Challenge (rohe Bytes). */
  challenge: Buffer;
  /** Genau der Origin, den der Browser meldet, z. B. "https://waread.example.org". */
  origin: string;
  /** RP-ID, z. B. "waread.example.org". */
  rpId: string;
}

export interface RegistrationInput {
  id: unknown;
  rawId: unknown;
  type: unknown;
  response: { clientDataJSON: unknown; attestationObject: unknown; transports?: unknown };
}

export interface AssertionInput {
  id: unknown;
  rawId: unknown;
  type: unknown;
  response: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown };
}

export interface RegisteredCredential {
  id: string; // base64url
  publicKey: string; // SPKI-DER, base64url
  alg: typeof COSE_ES256;
  counter: number;
  backupEligible: boolean;
  backupState: boolean;
  aaguid: string; // hex
  transports: string[];
}

export interface StoredForAssertion {
  id: string;
  publicKey: string;
  counter: number;
  backupEligible: boolean;
}

export interface AssertionResult {
  counter: number;
  backupState: boolean;
}

// ---------- Hilfen ----------

function b64urlToBuffer(v: unknown, maxBytes: number, what: string): Buffer {
  if (typeof v !== 'string' || v === '' || v.length > Math.ceil((maxBytes * 4) / 3) + 4) throw new WebAuthnError(`bad_${what}`);
  if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new WebAuthnError(`bad_${what}`);
  const buf = Buffer.from(v, 'base64url');
  if (buf.length === 0 || buf.length > maxBytes) throw new WebAuthnError(`bad_${what}`);
  // Kanonische Form verlangen: dieselbe Zeichenfolge muss beim Zurueckkodieren entstehen.
  if (buf.toString('base64url') !== v) throw new WebAuthnError(`bad_${what}`);
  return buf;
}

const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: unknown;
}

function checkClientData(raw: Buffer, expectedType: string, ctx: ExpectedContext): void {
  let cd: ClientData;
  try {
    cd = JSON.parse(raw.toString('utf8')) as ClientData;
  } catch {
    throw new WebAuthnError('bad_client_data');
  }
  if (typeof cd !== 'object' || cd === null) throw new WebAuthnError('bad_client_data');
  if (cd.type !== expectedType) throw new WebAuthnError('wrong_type');
  if (typeof cd.challenge !== 'string') throw new WebAuthnError('bad_client_data');
  const given = Buffer.from(cd.challenge, 'utf8');
  const expected = Buffer.from(ctx.challenge.toString('base64url'), 'utf8');
  if (!safeEqual(given, expected)) throw new WebAuthnError('wrong_challenge');
  if (typeof cd.origin !== 'string' || cd.origin !== ctx.origin) throw new WebAuthnError('wrong_origin');
  if (cd.crossOrigin === true) throw new WebAuthnError('cross_origin');
}

interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  attested?: { aaguid: Buffer; credentialId: Buffer; cose: CborValue };
}

function parseAuthData(buf: Buffer, requireAttested: boolean): ParsedAuthData {
  if (buf.length < 37 || buf.length > MAX_AUTH_DATA) throw new WebAuthnError('bad_auth_data');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32]!;
  const signCount = buf.readUInt32BE(33);
  let pos = 37;
  let attested: ParsedAuthData['attested'];
  if (flags & FLAG_AT) {
    if (buf.length < pos + 18) throw new WebAuthnError('bad_auth_data');
    const aaguid = buf.subarray(pos, pos + 16);
    const idLen = buf.readUInt16BE(pos + 16);
    pos += 18;
    if (idLen === 0 || idLen > MAX_CREDENTIAL_ID || buf.length < pos + idLen) throw new WebAuthnError('bad_auth_data');
    const credentialId = Buffer.from(buf.subarray(pos, pos + idLen));
    pos += idLen;
    let decoded: { value: CborValue; length: number };
    try {
      decoded = decodeCborPrefix(buf, pos);
    } catch {
      throw new WebAuthnError('bad_public_key');
    }
    pos += decoded.length;
    attested = { aaguid: Buffer.from(aaguid), credentialId, cose: decoded.value };
  } else if (requireAttested) {
    throw new WebAuthnError('no_attested_data');
  }
  if (flags & FLAG_ED) {
    try {
      pos += decodeCborPrefix(buf, pos).length; // Erweiterungen: gelesen, nicht ausgewertet
    } catch {
      throw new WebAuthnError('bad_auth_data');
    }
  }
  if (pos !== buf.length) throw new WebAuthnError('bad_auth_data'); // keine Restbytes dulden
  return { rpIdHash: Buffer.from(rpIdHash), flags, signCount, ...(attested ? { attested } : {}) };
}

function checkFlags(flags: number, rpIdHash: Buffer, rpId: string): void {
  if (!safeEqual(rpIdHash, sha256(rpId))) throw new WebAuthnError('wrong_rp_id');
  if (!(flags & FLAG_UP)) throw new WebAuthnError('user_not_present');
  if (!(flags & FLAG_UV)) throw new WebAuthnError('user_not_verified');
  if (!(flags & FLAG_BE) && flags & FLAG_BS) throw new WebAuthnError('bad_backup_flags');
}

/** COSE_Key (EC2, P-256, ES256) -> SPKI-DER (base64url). Prueft, dass der Punkt auf der Kurve liegt. */
function coseToSpki(cose: CborValue): string {
  if (!(cose instanceof Map)) throw new WebAuthnError('bad_public_key');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const crv = cose.get(-1);
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || alg !== COSE_ES256 || crv !== 1) throw new WebAuthnError('unsupported_algorithm');
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError('bad_public_key');
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
    return (key.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
  } catch {
    throw new WebAuthnError('bad_public_key');
  }
}

function checkIds(input: { id: unknown; rawId: unknown; type: unknown }): Buffer {
  if (input.type !== 'public-key') throw new WebAuthnError('bad_credential_type');
  const raw = b64urlToBuffer(input.rawId, MAX_CREDENTIAL_ID, 'credential_id');
  if (input.id !== input.rawId) throw new WebAuthnError('credential_id_mismatch');
  return raw;
}

// ---------- Registrierung (7.1) ----------

export function verifyRegistration(input: RegistrationInput, ctx: ExpectedContext): RegisteredCredential {
  if (typeof input !== 'object' || input === null || typeof input.response !== 'object' || input.response === null) {
    throw new WebAuthnError('bad_credential');
  }
  const rawId = checkIds(input);
  const clientData = b64urlToBuffer(input.response.clientDataJSON, MAX_CLIENT_DATA, 'client_data');
  const attestation = b64urlToBuffer(input.response.attestationObject, MAX_ATTESTATION, 'attestation');

  checkClientData(clientData, 'webauthn.create', ctx);

  let obj: CborValue;
  try {
    obj = decodeCbor(attestation);
  } catch (e) {
    if (e instanceof CborError) throw new WebAuthnError('bad_attestation');
    throw e;
  }
  if (!(obj instanceof Map)) throw new WebAuthnError('bad_attestation');
  const authDataRaw = obj.get('authData');
  if (!Buffer.isBuffer(authDataRaw)) throw new WebAuthnError('bad_attestation');

  const ad = parseAuthData(authDataRaw, true);
  checkFlags(ad.flags, ad.rpIdHash, ctx.rpId);
  const att = ad.attested!;
  if (!safeEqual(att.credentialId, rawId)) throw new WebAuthnError('credential_id_mismatch');
  const publicKey = coseToSpki(att.cose);

  const transports = Array.isArray((input.response as { transports?: unknown }).transports)
    ? ((input.response as { transports: unknown[] }).transports.filter((t): t is string => typeof t === 'string' && TRANSPORTS.has(t)))
    : [];

  return {
    id: rawId.toString('base64url'),
    publicKey,
    alg: COSE_ES256,
    counter: ad.signCount,
    backupEligible: (ad.flags & FLAG_BE) !== 0,
    backupState: (ad.flags & FLAG_BS) !== 0,
    aaguid: att.aaguid.toString('hex'),
    transports: [...new Set(transports)],
  };
}

// ---------- Anmeldung (7.2) ----------

/** Liest die Credential-ID aus der Antwort (vor der Suche im Speicher). */
export function assertionCredentialId(input: AssertionInput): string {
  if (typeof input !== 'object' || input === null || typeof input.response !== 'object' || input.response === null) {
    throw new WebAuthnError('bad_credential');
  }
  return checkIds(input).toString('base64url');
}

export function verifyAssertion(input: AssertionInput, stored: StoredForAssertion, ctx: ExpectedContext): AssertionResult {
  const rawId = checkIds(input);
  if (rawId.toString('base64url') !== stored.id) throw new WebAuthnError('unknown_credential');
  const clientData = b64urlToBuffer(input.response.clientDataJSON, MAX_CLIENT_DATA, 'client_data');
  const authData = b64urlToBuffer(input.response.authenticatorData, MAX_AUTH_DATA, 'auth_data');
  const signature = b64urlToBuffer(input.response.signature, MAX_SIGNATURE, 'signature');

  checkClientData(clientData, 'webauthn.get', ctx);

  const ad = parseAuthData(authData, false);
  checkFlags(ad.flags, ad.rpIdHash, ctx.rpId);
  if (((ad.flags & FLAG_BE) !== 0) !== stored.backupEligible) throw new WebAuthnError('backup_eligibility_changed');

  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' });
    ok = cryptoVerify('sha256', Buffer.concat([authData, sha256(clientData)]), { key, dsaEncoding: 'der' }, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new WebAuthnError('bad_signature');

  if ((ad.signCount !== 0 || stored.counter !== 0) && ad.signCount <= stored.counter) throw new WebAuthnError('counter_regressed');

  return { counter: ad.signCount, backupState: (ad.flags & FLAG_BS) !== 0 };
}
