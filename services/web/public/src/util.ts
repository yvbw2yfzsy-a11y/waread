// Small DOM and formatting helpers. No framework, no dependencies.

import type { ConnState } from './types';

type Child = Node | string | number | null | undefined | false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prop = string | number | boolean | null | undefined | ((ev: any) => void);
export type Props = Record<string, Prop>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value as EventListener);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    if (t !== undefined) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

/** Runs fn at most once per animation frame, however often the returned function is called. */
export function coalesce(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(); });
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function statusLabel(s: ConnState): string {
  switch (s) {
    case 'connected': return 'Verbunden';
    case 'connecting': return 'Verbinde …';
    case 'disconnected': return 'Getrennt';
    case 'needs_qr': return 'QR-Code scannen';
  }
}

// ---------------------------------------------------------------------------
// Timestamps. The API contract does not say whether waTimestamp is in seconds
// or milliseconds. Values below 1e12 are treated as seconds. The detected unit
// is remembered so that request parameters (before=, from=, to=) are sent in
// the same unit the server uses.
// ---------------------------------------------------------------------------

let apiUnit: 's' | 'ms' = 's';

export function noteTimestampUnit(ts: number): void {
  if (ts > 0) apiUnit = ts < 1e12 ? 's' : 'ms';
}

export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function toApiTs(ms: number): number {
  return apiUnit === 's' ? Math.floor(ms / 1000) : Math.floor(ms);
}

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekdayLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const dayShort = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const dayShortYear = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const dateNumeric = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function formatTime(ts: number): string {
  return timeFmt.format(toMs(ts));
}

export function formatDateTime(ts: number): string {
  return dateTimeFmt.format(toMs(ts));
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayDiff(ms: number): number {
  return Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000);
}

export function dayKey(ts: number): string {
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Label for date separators inside a chat. */
export function dayLabel(ts: number): string {
  const ms = toMs(ts);
  const diff = dayDiff(ms);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff > 1 && diff < 7) return weekdayLong.format(ms);
  if (new Date(ms).getFullYear() === new Date().getFullYear()) return dayShort.format(ms);
  return dayShortYear.format(ms);
}

/** Short time label for the chat list. */
export function listTime(ts: number): string {
  if (!ts) return '';
  const ms = toMs(ts);
  const diff = dayDiff(ms);
  if (diff === 0) return timeFmt.format(ms);
  if (diff === 1) return 'Gestern';
  if (diff > 1 && diff < 7) return weekdayLong.format(ms);
  return dateNumeric.format(ms);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Avatars: the API contract has no avatar endpoint, so avatars are generated
// from the name (initials on a stable colour) unless the chat carries avatarUrl.
// ---------------------------------------------------------------------------

const PALETTE = ['#e0734f', '#d6a233', '#6fb04c', '#37a98f', '#4aa0d8', '#7d83e0', '#b86bd6', '#d86a9a', '#c5855a', '#7aa05f'];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function colorFor(key: string): string {
  return PALETTE[hashString(key) % PALETTE.length] ?? '#4aa0d8';
}

const TITLE_RE = /^(dr|prof|mr|mrs|ms|herr|frau)\.?$/i;

/**
 * Initials for the avatar. Titles ("Dr.") and tokens without a letter or digit ("+", "(") are skipped, and leading
 * punctuation is stripped ("(Praxis)" -> "P"). Names made only of digits (phone numbers) give "#".
 */
export function initials(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((t) => t !== '' && !TITLE_RE.test(t));
  const words = tokens.filter((t) => /\p{L}/u.test(t));
  if (words.length === 0) return tokens.length > 0 ? '#' : '?';
  const first = [...(words[0] ?? '')][0] ?? '?';
  const last = words.length > 1 ? [...(words[words.length - 1] ?? '')][0] ?? '' : '';
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------------------
// Text: turn http(s) URLs into links without ever using innerHTML.
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export function linkify(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Trailing punctuation usually belongs to the sentence, not the URL.
    const trimmed = url.replace(/[.,;:!?)\]]+$/, '');
    const rest = url.slice(trimmed.length);
    url = trimmed;
    if (start > last) out.push(document.createTextNode(text.slice(last, start)));
    out.push(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, url));
    if (rest) out.push(document.createTextNode(rest));
    last = start + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Splits text at case-insensitive matches of `needle` and wraps matches in <mark>. */
export function highlight(text: string, needle: string): Node[] {
  const n = needle.trim();
  if (!n) return [document.createTextNode(text)];
  const out: Node[] = [];
  const lower = text.toLowerCase();
  const target = n.toLowerCase();
  let pos = 0;
  for (;;) {
    const i = lower.indexOf(target, pos);
    if (i < 0) break;
    if (i > pos) out.push(document.createTextNode(text.slice(pos, i)));
    out.push(el('mark', null, text.slice(i, i + target.length)));
    pos = i + target.length;
  }
  if (pos < text.length) out.push(document.createTextNode(text.slice(pos)));
  return out;
}

// ---------------------------------------------------------------------------
// Local preferences (browser only; never sent anywhere).
// ---------------------------------------------------------------------------

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`waread.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`waread.${key}`, JSON.stringify(value));
  } catch {
    // Private mode or storage disabled: preference simply does not persist.
  }
}
