// Verbindungszustand des Ingest-Dienstes und anstehender QR-Code.
//
// Quelle der Wahrheit ist die settings-Tabelle (vom Ingest geschrieben, siehe services/ingest/src/config.ts,
// SETTING_KEYS): connection.status, connection.connected_since, connection.qr. Der QR-Code liegt bewusst
// NICHT in der events_outbox (kurzlebiges Kopplungsgeheimnis); die Outbox-Ereignisse 'connection_status'
// sind nur der Anstoss, den Zustand neu zu lesen. Eine aeltere Konvention (Outbox-Ereignis 'qr' mit
// { qr }) wird weiterhin verstanden (applyQr), vom Ingest aber nicht mehr erzeugt.
// 'qr' wird NIE per SSE weitergereicht: wer den QR-Code sieht, kann das WhatsApp-Konto verknuepfen.

export type ConnState = 'connected' | 'connecting' | 'disconnected' | 'needs_qr';

const STATES: ReadonlySet<string> = new Set(['connected', 'connecting', 'disconnected', 'needs_qr']);

export function isConnState(v: unknown): v is ConnState {
  return typeof v === 'string' && STATES.has(v);
}

export interface StatusView {
  state: ConnState;
  since?: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export class ConnectionState {
  private state: ConnState = 'disconnected';
  private since: number | undefined;
  private qr: string | null = null;

  /** Gibt die bereinigte Statusansicht zurueck oder null, wenn die Payload unbrauchbar ist. */
  applyStatus(payload: unknown): StatusView | null {
    const p = asRecord(payload);
    if (!p || !isConnState(p['state'])) return null;
    this.state = p['state'];
    this.since = typeof p['since'] === 'number' && Number.isFinite(p['since']) ? p['since'] : undefined;
    if (this.state !== 'needs_qr') this.qr = null;
    return this.getStatus();
  }

  /**
   * Zustand aus der settings-Tabelle uebernehmen (autoritativ). `read` liefert den Wert eines Schluessels
   * oder null. Fehlt connection.status noch (Ingest nie gestartet), gilt 'disconnected'.
   */
  syncFromSettings(read: (key: string) => string | null): StatusView {
    const status = read('connection.status');
    this.state = status !== null && isConnState(status) ? status : 'disconnected';
    const sinceRaw = read('connection.connected_since');
    const since = sinceRaw !== null && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    this.since = this.state === 'connected' ? since : undefined;
    const qr = read('connection.qr');
    this.qr = this.state === 'needs_qr' && qr !== null && qr !== '' && qr.length <= 200_000 ? qr : null;
    return this.getStatus();
  }

  applyQr(payload: unknown): void {
    const p = asRecord(payload);
    if (!p) return;
    const q = p['qr'];
    if (q === null) this.qr = null;
    else if (typeof q === 'string' && q.length > 0 && q.length <= 200_000) this.qr = q;
  }

  getStatus(): StatusView {
    return this.since === undefined ? { state: this.state } : { state: this.state, since: this.since };
  }

  /** Roher QR-Inhalt, nur solange der Zustand needs_qr ist. */
  getPendingQr(): string | null {
    return this.state === 'needs_qr' ? this.qr : null;
  }
}

// ---------- QR -> Daten-URL ----------

let lastRendered: { raw: string; dataUrl: string } | null = null;

function svgToDataUrl(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

export class QrUnavailableError extends Error {
  constructor() {
    super('qr_render_unavailable');
    this.name = 'QrUnavailableError';
  }
}

/**
 * Immer als Daten-URL ausliefern. SVG wird nur in <img> verwendet (dort laufen keine Skripte).
 * Rohtext wird mit dem optionalen Paket "qrcode" gerendert (lazy geladen).
 */
export async function toQrDataUrl(raw: string): Promise<string> {
  const t = raw.trim();
  if (/^data:image\/(svg\+xml|png|gif|jpeg|webp)[;,]/i.test(t)) return t;
  if (t.startsWith('<svg') || t.startsWith('<?xml')) return svgToDataUrl(t);
  if (lastRendered && lastRendered.raw === raw) return lastRendered.dataUrl;
  let svg: string;
  try {
    const name = 'qrcode';
    const mod = (await import(name)) as {
      toString?: (text: string, o: Record<string, unknown>) => Promise<string>;
      default?: { toString?: (text: string, o: Record<string, unknown>) => Promise<string> };
    };
    const fn = mod.toString ?? mod.default?.toString;
    if (typeof fn !== 'function') throw new QrUnavailableError();
    svg = await fn(raw, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
    // Schutz gegen ein falsch aufgeloestes toString (Object.prototype.toString liefert "[object Object]").
    if (typeof svg !== 'string' || !svg.includes('<svg')) throw new QrUnavailableError();
  } catch {
    throw new QrUnavailableError();
  }
  const dataUrl = svgToDataUrl(svg);
  lastRendered = { raw, dataUrl };
  return dataUrl;
}
