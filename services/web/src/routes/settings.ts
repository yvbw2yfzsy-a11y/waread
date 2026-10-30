import type { App } from '../context.js';
import { getSetting, setSetting } from '../db.js';
import { asObject, HttpError, readJson, type Router, sendJson } from '../http.js';
import { withTx, type Db } from '../sqlite.js';

// Schluessel in der settings-Tabelle = Feldnamen der API (Annahme, mit Ingest/Cleanup abzustimmen).
const RETENTION_VALUES = [1, 3, 7, 14, 30] as const;
const DOWNLOAD_TYPES = ['image', 'voice', 'video', 'document'] as const;
type DownloadType = (typeof DOWNLOAD_TYPES)[number];

export interface DownloadRule {
  mode: 'auto' | 'off';
  maxMb: number;
}
export type DownloadRules = Record<DownloadType, DownloadRule>;

export interface SettingsView {
  retentionDays: number;
  retentionMediaDays: number;
  /** 0 = kein Limit */
  storageLimitMb: number;
  downloadRules: DownloadRules;
}

// Vorschlag, noch nicht mit dem Ingest-Team abgestimmt: 'off' = Metadaten speichern, Datei nicht laden.
// Video standardmaessig aus (Ressourcenschonung); die uebrigen Typen mit Groessenlimit.
export const DEFAULT_SETTINGS: SettingsView = {
  retentionDays: 3,
  retentionMediaDays: 3,
  storageLimitMb: 0,
  downloadRules: {
    image: { mode: 'auto', maxMb: 10 },
    voice: { mode: 'auto', maxMb: 10 },
    video: { mode: 'off', maxMb: 50 },
    document: { mode: 'auto', maxMb: 20 },
  },
};

function cloneDefaults(): SettingsView {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SettingsView;
}

function storedInt(db: Db, key: string, def: number, ok: (n: number) => boolean): number {
  const raw = getSetting(db, key);
  if (raw === null || !/^\d{1,9}$/.test(raw)) return def;
  const n = Number(raw);
  return ok(n) ? n : def;
}

function validRule(v: unknown): v is DownloadRule {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r['mode'] === 'auto' || r['mode'] === 'off') &&
    typeof r['maxMb'] === 'number' &&
    Number.isInteger(r['maxMb']) &&
    r['maxMb'] >= 1 &&
    r['maxMb'] <= 500
  );
}

export function readSettings(db: Db): SettingsView {
  const s = cloneDefaults();
  s.retentionDays = storedInt(db, 'retentionDays', s.retentionDays, (n) => (RETENTION_VALUES as readonly number[]).includes(n));
  s.retentionMediaDays = storedInt(db, 'retentionMediaDays', s.retentionMediaDays, (n) =>
    (RETENTION_VALUES as readonly number[]).includes(n),
  );
  s.storageLimitMb = storedInt(db, 'storageLimitMb', s.storageLimitMb, (n) => n >= 0 && n <= 10_000_000);
  const raw = getSetting(db, 'downloadRules');
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const t of DOWNLOAD_TYPES) if (validRule(parsed[t])) s.downloadRules[t] = parsed[t] as DownloadRule;
    } catch {
      /* kaputter Wert -> Standard */
    }
  }
  return s;
}

function intField(body: Record<string, unknown>, key: string, ok: (n: number) => boolean): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || !ok(v)) throw new HttpError(400, 'invalid_setting', { field: key });
  return v;
}

export function registerSettingsRoutes(r: Router, app: App): void {
  r.add('GET', '/api/settings', (c) => {
    sendJson(c.res, 200, readSettings(app.db));
  });

  // Teilaktualisierung: nur mitgeschickte Felder werden geaendert (downloadRules je Typ/Feld).
  r.add('PUT', '/api/settings', async (c) => {
    const body = asObject(await readJson(c));
    const known = new Set(['retentionDays', 'retentionMediaDays', 'storageLimitMb', 'downloadRules']);
    for (const k of Object.keys(body)) if (!known.has(k)) throw new HttpError(400, 'unknown_setting', { field: k });
    if (Object.keys(body).length === 0) throw new HttpError(400, 'empty_update');

    const inRetention = (n: number): boolean => (RETENTION_VALUES as readonly number[]).includes(n);
    const next = readSettings(app.db);
    const writes: [string, string][] = [];

    const rd = intField(body, 'retentionDays', inRetention);
    if (rd !== undefined) {
      next.retentionDays = rd;
      writes.push(['retentionDays', String(rd)]);
    }
    const rm = intField(body, 'retentionMediaDays', inRetention);
    if (rm !== undefined) {
      next.retentionMediaDays = rm;
      writes.push(['retentionMediaDays', String(rm)]);
    }
    const sl = intField(body, 'storageLimitMb', (n) => n >= 0 && n <= 10_000_000);
    if (sl !== undefined) {
      next.storageLimitMb = sl;
      writes.push(['storageLimitMb', String(sl)]);
    }

    if (body['downloadRules'] !== undefined) {
      const dr = asObject(body['downloadRules']);
      if (Object.keys(dr).length === 0) throw new HttpError(400, 'invalid_setting', { field: 'downloadRules' });
      for (const [type, val] of Object.entries(dr)) {
        if (!(DOWNLOAD_TYPES as readonly string[]).includes(type)) {
          throw new HttpError(400, 'invalid_setting', { field: `downloadRules.${type}` });
        }
        const rule = asObject(val);
        const merged: DownloadRule = { ...next.downloadRules[type as DownloadType] };
        let touched = false;
        for (const [k, v] of Object.entries(rule)) {
          if (k === 'mode' && (v === 'auto' || v === 'off')) merged.mode = v;
          else if (k === 'maxMb' && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 500) merged.maxMb = v;
          else throw new HttpError(400, 'invalid_setting', { field: `downloadRules.${type}.${k}` });
          touched = true;
        }
        if (!touched) throw new HttpError(400, 'invalid_setting', { field: `downloadRules.${type}` });
        next.downloadRules[type as DownloadType] = merged;
      }
      writes.push(['downloadRules', JSON.stringify(next.downloadRules)]);
    }

    // Medien koennen nicht laenger leben als ihre Nachricht (media.message_id verweist auf messages).
    if (next.retentionMediaDays > next.retentionDays) {
      throw new HttpError(400, 'media_retention_exceeds_message_retention', {
        retentionDays: next.retentionDays,
        retentionMediaDays: next.retentionMediaDays,
      });
    }

    withTx(app.db, () => {
      for (const [k, v] of writes) setSetting(app.db, k, v);
    });
    app.log.info('settings_updated', { fields: writes.map(([k]) => k).join(',') });
    sendJson(c.res, 200, next);
  });
}
