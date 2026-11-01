// Browser side of WebAuthn: converts between the server's JSON (base64url) and the
// ArrayBuffer-based browser API. Deliberately does not use PublicKeyCredential.toJSON /
// parse*OptionsFromJSON, which older Safari versions lack.

import { isObj } from './util';

export type Json = Record<string, unknown>;

export function passkeySupported(): boolean {
  return window.isSecureContext && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

function toBuf(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** navigator.credentials.create() with the server's options; result is the JSON the server expects. */
export async function createCredential(options: Json): Promise<Json> {
  const rp = isObj(options.rp) ? options.rp : {};
  const user = isObj(options.user) ? options.user : {};
  const publicKey = {
    rp: { id: String(rp.id), name: String(rp.name) },
    user: { id: toBuf(String(user.id)), name: String(user.name), displayName: String(user.displayName) },
    challenge: toBuf(String(options.challenge)),
    pubKeyCredParams: asList(options.pubKeyCredParams).map((p) => ({ type: 'public-key' as const, alg: Number(p.alg) })),
    timeout: Number(options.timeout) || 180_000,
    excludeCredentials: asList(options.excludeCredentials).map((c) => ({
      type: 'public-key' as const,
      id: toBuf(String(c.id)),
      ...(Array.isArray(c.transports) ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
    authenticatorSelection: isObj(options.authenticatorSelection) ? (options.authenticatorSelection as AuthenticatorSelectionCriteria) : undefined,
    attestation: 'none' as const,
  } satisfies PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('no credential', 'NotAllowedError');
  const res = cred.response as AuthenticatorAttestationResponse;
  const id = toB64u(cred.rawId);
  return {
    id,
    rawId: id,
    type: cred.type,
    response: {
      clientDataJSON: toB64u(res.clientDataJSON),
      attestationObject: toB64u(res.attestationObject),
      transports: typeof res.getTransports === 'function' ? res.getTransports() : [],
    },
  };
}

/** navigator.credentials.get() with the server's options; result is the JSON the server expects. */
export async function getCredential(options: Json): Promise<Json> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toBuf(String(options.challenge)),
    rpId: String(options.rpId),
    timeout: Number(options.timeout) || 120_000,
    userVerification: 'required',
    allowCredentials: asList(options.allowCredentials).map((c) => ({ type: 'public-key' as const, id: toBuf(String(c.id)) })),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('no credential', 'NotAllowedError');
  const res = cred.response as AuthenticatorAssertionResponse;
  const id = toB64u(cred.rawId);
  return {
    id,
    rawId: id,
    type: cred.type,
    response: {
      clientDataJSON: toB64u(res.clientDataJSON),
      authenticatorData: toB64u(res.authenticatorData),
      signature: toB64u(res.signature),
    },
  };
}

/** Short German message for a failed WebAuthn call. */
export function describeWebAuthnError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError': return 'Abgebrochen oder Zeit abgelaufen.';
    case 'InvalidStateError': return 'Auf diesem Gerät gibt es schon einen Passkey für waread.';
    case 'SecurityError': return 'Diese Adresse passt nicht zur Passkey-Einstellung (RP-ID). Bitte die Adresse aus der Konfiguration verwenden.';
    case 'NotSupportedError': return 'Dieses Gerät unterstützt den verlangten Passkey-Typ nicht.';
    case 'AbortError': return 'Abgebrochen.';
    default: return 'Passkey-Vorgang fehlgeschlagen.';
  }
}
