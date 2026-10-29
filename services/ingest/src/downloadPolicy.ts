/**
 * Download-Regeln je Medientyp.
 *
 * Quelle der Wahrheit ist die Einstellung `downloadRules` in der settings-Tabelle (vom Web-Dienst ueber
 * PUT /api/settings geschrieben, JSON: { image|voice|video|document: { mode: 'auto'|'off', maxMb } }).
 * Fehlt sie oder ist ein Eintrag ungueltig, gelten die Werte aus config.toml ([ingest] auto_download_*, max_mb_*).
 * Dadurch wirkt die Oberflaeche auf neue Downloads, ohne dass der Dienst neu gestartet werden muss.
 *
 * Reine Lesezugriffe auf die eigene Datenbank; nichts davon beruehrt WhatsApp.
 */
import { SETTING_KEYS, type IngestConfig, type MediaKind } from './config.js'
import { getSetting, type Database } from './dbClient.js'

const MB = 1024 * 1024
const KINDS: readonly MediaKind[] = ['image', 'voice', 'video', 'document']
/** Wie lange eine gelesene Einstellung gilt, bevor erneut in die Datenbank geschaut wird. */
const CACHE_MS = 15_000

export interface KindPolicy {
  /** false = Datei nicht laden (die Nachricht selbst wird trotzdem gespeichert). */
  auto: boolean
  maxBytes: number
}

export type PolicyMap = Record<MediaKind, KindPolicy>

function validRule(v: unknown): v is { mode: 'auto' | 'off'; maxMb: number } {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    (r.mode === 'auto' || r.mode === 'off') &&
    typeof r.maxMb === 'number' &&
    Number.isFinite(r.maxMb) &&
    r.maxMb > 0 &&
    r.maxMb <= 2048
  )
}

/** Rein: gespeicherte Regeln (JSON-Text oder null) ueber die Konfigurationswerte legen. */
export function resolvePolicy(raw: string | null, media: IngestConfig['media']): PolicyMap {
  const out = {} as PolicyMap
  for (const k of KINDS) out[k] = { auto: media.autoDownload[k], maxBytes: media.maxBytes[k] }
  if (raw === null || raw === '') return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof parsed !== 'object' || parsed === null) return out
  const rules = parsed as Record<string, unknown>
  for (const k of KINDS) {
    const r = rules[k]
    if (validRule(r)) out[k] = { auto: r.mode === 'auto', maxBytes: Math.floor(r.maxMb * MB) }
  }
  return out
}

export class DownloadPolicy {
  private cache: { at: number; map: PolicyMap } | null = null

  constructor(
    private readonly db: Database,
    private readonly media: IngestConfig['media'],
    private readonly now: () => number = Date.now,
  ) {}

  get(kind: MediaKind): KindPolicy {
    const t = this.now()
    if (!this.cache || t - this.cache.at >= CACHE_MS) {
      let raw: string | null = null
      try {
        raw = getSetting(this.db, SETTING_KEYS.downloadRules)
      } catch {
        // Lesefehler -> Konfigurationswerte; ein Download-Problem darf den Empfang nie stoeren.
      }
      this.cache = { at: t, map: resolvePolicy(raw, this.media) }
    }
    return this.cache.map[kind]
  }
}
