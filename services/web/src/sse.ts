// Live-Updates: Der Web-Dienst pollt die events_outbox (geschrieben von Ingest/Cleanup/Web selbst)
// und verteilt die Ereignisse als Server-Sent Events an die verbundenen Browser.
//
// Entscheidungen:
// - Fuer new_message / message_updated / media_ready wird der Zustand NEU aus der Datenbank gelesen,
//   statt die Payload des Absenders durchzureichen. Dadurch haben Events dieselbe Form wie die
//   REST-Objekte, enthalten keine Dateisystempfade und beachten hide_deleted_content.
//   Aus der Absender-Payload wird nur die Nachrichten-ID gebraucht.
// - Typ 'qr' wird nie weitergereicht (siehe connection.ts).
// - SSE-IDs sind die Outbox-IDs; Last-Event-ID wird bei Wiederverbindung nachgespielt (soweit noch
//   in der Outbox vorhanden).
import type { ServerResponse } from 'node:http';
import type { App } from './context.js';
import { getSetting, pullEventsSince } from './db.js';
import { HttpError, type Router } from './http.js';
import { errFields, type Logger } from './log.js';
import { type ConnectionState, isConnState } from './connection.js';
import { getMessage } from './queries.js';
import { getRow, runSql, type Db } from './sqlite.js';

export function frame(name: string, data: unknown, id?: number): string {
  return (id !== undefined ? `id: ${id}\n` : '') + `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------- Hub ----------

const MAX_BUFFERED_BYTES = 1_048_576;

export class Hub {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly max: number) {}

  get size(): number {
    return this.clients.size;
  }

  canAdd(): boolean {
    return this.clients.size < this.max;
  }

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    if (!this.timer) {
      this.timer = setInterval(() => this.writeAll(': ping\n\n'), 25_000);
      this.timer.unref();
    }
  }

  broadcast(name: string, data: unknown, id?: number): void {
    this.writeAll(frame(name, data, id));
  }

  closeAll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private writeAll(text: string): void {
    for (const res of [...this.clients]) {
      try {
        res.write(text);
        // Langsame Clients nicht unbegrenzt puffern.
        if (res.writableLength > MAX_BUFFERED_BYTES) {
          this.clients.delete(res);
          res.destroy();
        }
      } catch {
        this.clients.delete(res);
        res.destroy();
      }
    }
  }
}

// ---------- Outbox-Pumpe ----------

export interface OutEvent {
  name: string;
  data: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickId(...candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === 'string' && c !== '' && c.length <= 512) return c;
  return null;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

const KEEP_ROWS = 1000;
const PURGE_EVERY_MS = 60_000;
const FAST_MS = 400;
const IDLE_MS = 2000;
const REPLAY_MAX = 500;

export class EventPump {
  private lastId = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPurge = 0;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly conn: ConnectionState,
    private readonly hub: Hub,
    private readonly log: Logger,
    private readonly hideDeleted: boolean,
  ) {}

  /** Verbindungszustand (und QR) neu aus der settings-Tabelle lesen. Darf nie werfen. */
  syncConnection(): void {
    try {
      this.conn.syncFromSettings((key) => getSetting(this.db, key));
    } catch (err) {
      this.log.error('connection_sync_failed', errFields(err));
    }
  }

  /** Startzustand aus der settings-Tabelle lesen (Verbindung, QR), dann ab dem aktuellen Ende der Outbox pollen. */
  start(): void {
    this.syncConnection();
    try {
      const max = getRow<{ m: number | null }>(this.db, 'SELECT MAX(id) AS m FROM events_outbox');
      this.lastId = max && typeof max.m === 'number' ? max.m : 0;
    } catch (err) {
      this.log.error('outbox_bootstrap_failed', errFields(err));
    }
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sofort pollen (z. B. bevor /api/status antwortet). Gibt die Zahl verarbeiteter Ereignisse zurueck. */
  pollNow(): number {
    let events: { id: number; type: string; payload: unknown }[];
    try {
      events = pullEventsSince(this.db, this.lastId);
    } catch (err) {
      this.log.error('outbox_poll_failed', errFields(err));
      return 0;
    }
    for (const ev of events) {
      if (ev.id <= this.lastId) continue;
      this.lastId = ev.id;
      try {
        this.handle(ev);
      } catch (err) {
        this.log.error('event_handle_failed', { eventType: ev.type, eventId: ev.id, ...errFields(err) });
      }
    }
    this.maybePurge();
    return events.length;
  }

  /** Nachspielen nach Wiederverbindung. Nur bereits gepollte Ereignisse (id <= lastId). */
  replayFrames(afterId: number): string[] {
    if (afterId >= this.lastId) return [];
    let events: { id: number; type: string; payload: unknown }[];
    try {
      events = pullEventsSince(this.db, afterId);
    } catch (err) {
      this.log.error('outbox_replay_failed', errFields(err));
      return [];
    }
    const frames: string[] = [];
    for (const ev of events) {
      if (ev.id > this.lastId) break;
      const out = this.transform(ev);
      if (out) frames.push(frame(out.name, out.data, ev.id));
    }
    return frames.slice(-REPLAY_MAX);
  }

  private schedule(): void {
    if (!this.running) return;
    const delay = this.hub.size > 0 ? FAST_MS : IDLE_MS;
    this.timer = setTimeout(() => {
      this.pollNow();
      this.schedule();
    }, delay);
  }

  private handle(ev: { id: number; type: string; payload: unknown }): void {
    if (ev.type === 'qr') {
      this.conn.applyQr(ev.payload);
      return;
    }
    if (ev.type === 'connection_status') {
      this.conn.applyStatus(ev.payload);
      this.syncConnection(); // autoritativ (inkl. QR) aus der settings-Tabelle
    }
    const out = this.transform(ev);
    if (out) this.hub.broadcast(out.name, out.data, ev.id);
  }

  /** Outbox-Ereignis -> SSE-Ereignis (oder null = nicht weiterleiten). Rein lesend. */
  transform(ev: { id: number; type: string; payload: unknown }): OutEvent | null {
    const p = asRecord(ev.payload);
    switch (ev.type) {
      case 'new_message': {
        const id = pickId(asRecord(p?.['message'])?.['id'], p?.['messageId']);
        if (!id) return null;
        const message = getMessage(this.db, id, this.hideDeleted);
        return message ? { name: 'new_message', data: { chatId: message.chatId, message } } : null;
      }
      case 'message_updated': {
        const id = pickId(p?.['messageId'], asRecord(p?.['message'])?.['id']);
        if (!id) return null;
        const m = getMessage(this.db, id, this.hideDeleted);
        if (!m) return null;
        // Obermenge des Vertrags: zusaetzlich chatId, edited, text (Bearbeitungen sind sonst nicht sichtbar).
        return {
          name: 'message_updated',
          data: {
            messageId: m.id,
            chatId: m.chatId,
            seenAt: m.seenAt,
            playedAt: m.playedAt,
            deleted: m.deleted,
            edited: m.edited,
            text: m.text,
          },
        };
      }
      case 'media_ready': {
        const id = pickId(p?.['messageId']);
        if (!id) return null;
        const m = getMessage(this.db, id, this.hideDeleted);
        if (!m || !m.media) return null;
        const enc = encodeURIComponent(m.id);
        return {
          name: 'media_ready',
          data: {
            messageId: m.id,
            chatId: m.chatId,
            status: m.media.status,
            // Statt Dateisystempfaden: relative API-Pfade (siehe routes.md).
            ...(m.media.hasThumbnail ? { thumbnailPath: `api/media/${enc}?thumb=1` } : {}),
            ...(m.media.status === 'ready' ? { filePath: `api/media/${enc}` } : {}),
          },
        };
      }
      case 'connection_status': {
        if (!p || !isConnState(p['state'])) return null;
        const since = typeof p['since'] === 'number' && Number.isFinite(p['since']) ? p['since'] : undefined;
        return { name: 'connection_status', data: since === undefined ? { state: p['state'] } : { state: p['state'], since } };
      }
      case 'history_synced':
        // Erweiterung ueber den Vertrag hinaus: einmal je Verlaufspaket nach dem Koppeln. Die Oberflaeche
        // laedt daraufhin die Chatliste neu (der Verlauf erzeugt keine einzelnen new_message-Ereignisse).
        return { name: 'history_synced', data: { stored: count(p?.['stored']) } };
      case 'cleanup_done':
        return {
          name: 'cleanup_done',
          data: { deletedMessages: count(p?.['deletedMessages']), deletedMedia: count(p?.['deletedMedia']) },
        };
      default:
        return null;
    }
  }

  /** Outbox klein halten: letzte KEEP_ROWS Zeilen plus je das neueste connection_status-/qr-Ereignis. */
  private maybePurge(): void {
    const now = Date.now();
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    try {
      runSql(
        this.db,
        `DELETE FROM events_outbox
          WHERE id < (SELECT COALESCE(MAX(id), 0) FROM events_outbox) - ?
            AND id NOT IN (SELECT MAX(id) FROM events_outbox WHERE type IN ('connection_status', 'qr') GROUP BY type)`,
        KEEP_ROWS,
      );
    } catch (err) {
      this.log.warn('outbox_purge_failed', errFields(err));
    }
  }
}

// ---------- Route ----------

export function registerSse(r: Router, app: App): void {
  r.add('GET', '/events', (c) => {
    if (!app.hub.canAdd()) throw new HttpError(503, 'too_many_clients');
    const res = c.res;
    const lastRaw = c.req.headers['last-event-id'];
    const lastEventId = typeof lastRaw === 'string' && /^\d{1,15}$/.test(lastRaw) ? Number(lastRaw) : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Alles bis zum hub.add synchron: dadurch kein verpasstes und kein doppeltes Ereignis.
    app.pump.pollNow();
    res.write('retry: 3000\n\n');
    res.write(frame('connection_status', app.conn.getStatus()));
    if (lastEventId !== null) for (const f of app.pump.replayFrames(lastEventId)) res.write(f);
    app.hub.add(res);
  });
}
