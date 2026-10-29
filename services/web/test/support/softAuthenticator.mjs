// Software-Authenticator fuer Tests: baut Registrierungs- und Anmeldeantworten so, wie ein Browser sie
// an den Server schickt (base64url, WebAuthn-Binaerformate). Echte Schluessel (P-256), echte Signaturen.
// Mit `overrides` lassen sich gezielt fehlerhafte Antworten erzeugen (falscher Origin, fehlendes UV, ...).
import crypto from 'node:crypto';

export const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---------- winziger CBOR-Encoder (Zahlen, Byte-Strings, Text, Map, Array) ----------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const t = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, t.length), t]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported ' + typeof v);
}

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

export class SoftAuthenticator {
  constructor({ rpId, origin, counterMode = 'zero', be = true, bs = true } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.counterMode = counterMode; // 'zero' (wie iCloud-Schluesselbund) oder 'increment'
    this.be = be;
    this.bs = bs;
    this.counter = 0;
    this.credId = crypto.randomBytes(32);
    this.keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  }

  get id() { return b64u(this.credId); }

  coseKey() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  }

  flags(o, base) {
    let f = base;
    if (o.up !== false) f |= FLAG.UP;
    if (o.uv !== false) f |= FLAG.UV;
    if (this.be) f |= FLAG.BE;
    if (this.bs) f |= FLAG.BS;
    return o.flags ?? f;
  }

  nextCounter(o) {
    if (o.signCount !== undefined) return o.signCount;
    if (this.counterMode === 'zero') return 0;
    return ++this.counter;
  }

  /** navigator.credentials.create() -> JSON, wie es der Browser-Client an den Server schickt. */
  create(options, o = {}) {
    const clientData = Buffer.from(JSON.stringify({
      type: o.type ?? 'webauthn.create',
      challenge: o.challenge ?? options.challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: o.crossOrigin ?? false,
    }));
    const cose = o.cose ?? this.coseKey();
    const credId = o.credId ?? this.credId;
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const count = Buffer.alloc(4); count.writeUInt32BE(this.nextCounter(o));
    let authData = Buffer.concat([
      sha256(o.rpId ?? this.rpId), Buffer.from([this.flags(o, FLAG.AT)]), count,
      Buffer.alloc(16), idLen, credId, cbor(cose),
    ]);
    if (o.trailing) authData = Buffer.concat([authData, o.trailing]);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: o.id ?? b64u(credId), rawId: o.rawId ?? b64u(credId), type: o.credType ?? 'public-key',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(o.attestationObject ?? att), transports: ['internal', 'hybrid', 'evil'] },
    };
  }

  /** navigator.credentials.get() -> JSON. */
  get(options, o = {}) {
    const clientData = Buffer.from(JSON.stringify({
      type: o.type ?? 'webauthn.get',
      challenge: o.challenge ?? options.challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: o.crossOrigin ?? false,
    }));
    const count = Buffer.alloc(4); count.writeUInt32BE(this.nextCounter(o));
    const authData = Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([this.flags(o, 0)]), count]);
    const data = Buffer.concat([authData, sha256(clientData)]);
    let sig = crypto.sign('sha256', data, o.signWith ?? this.keys.privateKey);
    if (o.tamperSignature) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0x01; }
    const credId = o.credId ?? this.credId;
    return {
      id: b64u(credId), rawId: b64u(credId), type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: null },
    };
  }
}
