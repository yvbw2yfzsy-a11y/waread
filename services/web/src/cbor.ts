// Minimaler CBOR-Decoder (RFC 8949) fuer WebAuthn: attestationObject und COSE-Schluessel.
//
// Bewusst klein und streng, weil die Eingabe vom Browser kommt (also vom Netz):
// - Tiefe, Elementzahl und Laenge sind begrenzt; jede Laenge wird gegen den Puffer geprueft, bevor etwas
//   angelegt wird (keine Speicherbombe aus einem kurzen Eingabepuffer).
// - Unbestimmte Laengen (0x1f) werden abgelehnt (WebAuthn/CTAP2 verwendet sie nicht).
// - Doppelte Map-Schluessel werden abgelehnt (sonst waere der Inhalt mehrdeutig).
// - Nur Schluessel vom Typ Zahl oder Text; Tags werden uebersprungen (Wert zaehlt), Gleitkommazahlen gelesen.
// Ergebnis: Zahl (number; ueber 2^53 bigint), Buffer (Byte-String), string, Array, Map, boolean, null, undefined.

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

export type CborValue = number | bigint | Buffer | string | boolean | null | undefined | CborValue[] | Map<number | string, CborValue>;

const MAX_DEPTH = 8;
const MAX_ITEMS = 512;

interface Cursor {
  buf: Buffer;
  pos: number;
  items: number;
}

function need(c: Cursor, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0 || c.pos + n > c.buf.length) throw new CborError('truncated');
}

function readArg(c: Cursor, info: number): number | bigint {
  if (info < 24) return info;
  if (info === 24) {
    need(c, 1);
    return c.buf[c.pos++]!;
  }
  if (info === 25) {
    need(c, 2);
    const v = c.buf.readUInt16BE(c.pos);
    c.pos += 2;
    return v;
  }
  if (info === 26) {
    need(c, 4);
    const v = c.buf.readUInt32BE(c.pos);
    c.pos += 4;
    return v;
  }
  if (info === 27) {
    need(c, 8);
    const v = c.buf.readBigUInt64BE(c.pos);
    c.pos += 8;
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  throw new CborError('unsupported additional info'); // 28..30 reserviert, 31 = unbestimmte Laenge
}

function toLength(v: number | bigint): number {
  if (typeof v !== 'number') throw new CborError('length too large');
  return v;
}

function readItem(c: Cursor, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('too deep');
  if (++c.items > MAX_ITEMS) throw new CborError('too many items');
  need(c, 1);
  const first = c.buf[c.pos++]!;
  const major = first >> 5;
  const info = first & 0x1f;

  switch (major) {
    case 0:
      return readArg(c, info);
    case 1: {
      const v = readArg(c, info);
      return typeof v === 'number' ? -1 - v : -1n - v;
    }
    case 2: {
      const len = toLength(readArg(c, info));
      need(c, len);
      const out = Buffer.from(c.buf.subarray(c.pos, c.pos + len));
      c.pos += len;
      return out;
    }
    case 3: {
      const len = toLength(readArg(c, info));
      need(c, len);
      let s: string;
      try {
        s = new TextDecoder('utf-8', { fatal: true }).decode(c.buf.subarray(c.pos, c.pos + len));
      } catch {
        throw new CborError('invalid utf-8');
      }
      c.pos += len;
      return s;
    }
    case 4: {
      const len = toLength(readArg(c, info));
      if (len > MAX_ITEMS) throw new CborError('array too long');
      need(c, len); // jedes Element braucht mindestens ein Byte
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) arr.push(readItem(c, depth + 1));
      return arr;
    }
    case 5: {
      const len = toLength(readArg(c, info));
      if (len > MAX_ITEMS) throw new CborError('map too long');
      need(c, len * 2);
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = readItem(c, depth + 1);
        if (typeof k !== 'number' && typeof k !== 'string') throw new CborError('unsupported map key');
        if (map.has(k)) throw new CborError('duplicate map key');
        map.set(k, readItem(c, depth + 1));
      }
      return map;
    }
    case 6:
      readArg(c, info); // Tag-Nummer ignorieren
      return readItem(c, depth + 1);
    default: {
      // Major 7: einfache Werte und Gleitkommazahlen
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) {
        need(c, 2);
        const h = c.buf.readUInt16BE(c.pos);
        c.pos += 2;
        const exp = (h >> 10) & 0x1f;
        const frac = h & 0x3ff;
        const val = exp === 0 ? frac * 2 ** -24 : exp !== 31 ? (frac + 1024) * 2 ** (exp - 25) : frac ? NaN : Infinity;
        return h & 0x8000 ? -val : val;
      }
      if (info === 26) {
        need(c, 4);
        const v = c.buf.readFloatBE(c.pos);
        c.pos += 4;
        return v;
      }
      if (info === 27) {
        need(c, 8);
        const v = c.buf.readDoubleBE(c.pos);
        c.pos += 8;
        return v;
      }
      throw new CborError('unsupported simple value');
    }
  }
}

/** Liest genau ein Element ab `offset`; `length` ist die Zahl der verbrauchten Bytes. */
export function decodeCborPrefix(buf: Buffer, offset = 0): { value: CborValue; length: number } {
  const c: Cursor = { buf, pos: offset, items: 0 };
  const value = readItem(c, 0);
  return { value, length: c.pos - offset };
}

/** Wie decodeCborPrefix, verlangt aber, dass der gesamte Puffer verbraucht wird. */
export function decodeCbor(buf: Buffer): CborValue {
  const { value, length } = decodeCborPrefix(buf, 0);
  if (length !== buf.length) throw new CborError('trailing bytes');
  return value;
}
