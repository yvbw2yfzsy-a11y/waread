// API client for the waread REST contract (wire format: services/web/routes.md).
// Read-only by design: the only POST endpoints used are login/logout, passkey
// management (/api/passkey/*, local to waread), local seen/played markers, settings,
// storage clearing and "reconnect" (a command to the waread ingest service, not a
// WhatsApp message). Nothing here can send anything to WhatsApp.

import type { Json } from './webauthnClient';
import type {
  AuthState, PasskeyOverview, PasskeyStepPurpose,
  Chat, ChatPreview, ClearResult, ClearScope, DownloadKind, DownloadMaxMb, DownloadRules, MediaInfo, Message,
  MessageType, MessageVersions, QuotedRef, SearchFilters, SearchHit, Settings, StatusInfo, StorageUsage, ConnState,
} from './types';
import { noteTimestampUnit, toApiTs } from './util';

/**
 * Prefix for all server URLs. Empty = relative to the page, so the app works
 * under a sub path such as /waread/ (nginx strips the prefix). If set, it must
 * end with "/". All paths below are written with a leading slash for readability
 * and are made relative by apiUrl().
 */
export const BASE = '';

export function apiUrl(path: string): string {
  return BASE + path.replace(/^\/+/, '');
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 30_000);
  try {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctrl.signal,
    };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(apiUrl(path), init);
    // A wrong password / passkey on the login screen is not an expired session.
    if (res.status === 401 && path !== '/api/login' && path !== '/api/passkey/login/verify') unauthorizedHandler?.();
    return res;
  } finally {
    window.clearTimeout(timer);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  // The message is the server's machine-readable error code (e.g. "invalid_credentials").
  let msg = `Fehler ${res.status}`;
  try {
    const data: unknown = await res.json();
    if (isObj(data)) msg = str(data.error) ?? str(data.message) ?? msg;
  } catch {
    // body was not JSON; keep the generic message
  }
  return new ApiError(res.status, msg);
}

async function json(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await request(method, path, body);
  if (!res.ok) throw await errorFrom(res);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

// ---------------------------------------------------------------------------
// Normalization: tolerant reading of loosely specified JSON.
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function normType(v: unknown): MessageType {
  switch (String(v ?? '').toLowerCase()) {
    case 'text': case 'conversation': case 'chat': return 'text';
    case 'image': case 'photo': return 'image';
    case 'audio': case 'ptt': case 'voice': return 'audio';
    case 'video': return 'video';
    case 'document': case 'file': return 'document';
    case 'sticker': return 'sticker';
    default: return 'other';
  }
}

function normMedia(v: unknown): MediaInfo | undefined {
  if (!isObj(v)) return undefined;
  const m: MediaInfo = {};
  const mime = str(v.mimeType) ?? str(v.mimetype);
  if (mime) m.mimeType = mime;
  const size = num(v.sizeBytes) ?? num(v.size);
  if (size !== undefined) m.size = size;
  const dur = num(v.durationSeconds) ?? num(v.durationSec) ?? num(v.seconds);
  if (dur !== undefined) m.durationSec = dur;
  if (v.hasThumbnail === true) m.hasThumbnail = true;
  const fileName = str(v.fileName);
  if (fileName) m.fileName = fileName;
  const pages = num(v.pages);
  if (pages !== undefined) m.pages = pages;
  const w = num(v.width);
  if (w !== undefined) m.width = w;
  const h = num(v.height);
  if (h !== undefined) m.height = h;
  if (Array.isArray(v.waveform)) {
    const wf = v.waveform.map(num).filter((n): n is number => n !== undefined);
    if (wf.length) m.waveform = wf;
  }
  const status = normMediaStatus(v.status);
  if (status) m.status = status;
  const skip = str(v.skipReason);
  if (skip) m.skipReason = skip;
  if (v.loadable === true) m.loadable = true;
  return m;
}

export function normMediaStatus(v: unknown): MediaInfo['status'] | undefined {
  const status = str(v);
  if (status === 'downloading') return 'pending';
  if (status === 'pending' || status === 'ready' || status === 'failed' || status === 'skipped' || status === 'expired') return status;
  return undefined;
}

function normQuoted(v: unknown): QuotedRef | undefined {
  if (!isObj(v)) return undefined;
  const q: QuotedRef = {};
  const id = str(v.id);
  if (id) q.id = id;
  const name = str(v.senderName);
  if (name) q.senderName = name;
  const fromMe = bool(v.fromMe);
  if (fromMe !== undefined) q.fromMe = fromMe;
  const text = str(v.text);
  if (text) q.text = text;
  if (v.type !== undefined && v.type !== null) q.type = normType(v.type);
  const sender = str(v.sender);
  if (sender && !q.senderName) q.senderName = sender;
  if (typeof v.available === 'boolean') q.available = v.available;
  if (v.deleted === true) q.deleted = true;
  return q;
}

export function normMessage(v: unknown, fallbackChatId = ''): Message {
  const r: Raw = isObj(v) ? v : {};
  const ts = num(r.waTimestamp) ?? 0;
  noteTimestampUnit(ts);
  const type = normType(r.type);
  const msg: Message = {
    id: str(r.id) ?? '',
    chatId: str(r.chatId) ?? fallbackChatId,
    waTimestamp: ts,
    fromMe: bool(r.fromMe) ?? str(r.direction) === 'out',
    type,
  };
  const senderName = str(r.senderName) ?? str(r.sender);
  if (senderName) msg.senderName = senderName;
  // The API has one text field: the message text, or the caption for image/video/document.
  const text = str(r.text) ?? str(r.body);
  if (text) {
    if (type === 'image' || type === 'video' || type === 'document') msg.caption = text;
    else msg.text = text;
  }
  const caption = str(r.caption);
  if (caption) msg.caption = caption;
  const quoted = normQuoted(r.quoted);
  if (quoted) msg.quoted = quoted;
  else {
    const replyTo = str(r.replyTo);
    if (replyTo) msg.quoted = { id: replyTo };
  }
  const media = normMedia(r.media);
  if (media) msg.media = media;
  msg.seenAt = r.seenAt === null ? null : num(r.seenAt);
  msg.playedAt = r.playedAt === null ? null : num(r.playedAt);
  if (bool(r.deleted)) msg.deleted = true;
  const deletedAt = num(r.deletedAt);
  if (deletedAt !== undefined) msg.deletedAt = deletedAt;
  if (bool(r.edited)) msg.edited = true;
  const editedAt = num(r.editedAt);
  if (editedAt !== undefined) msg.editedAt = editedAt;
  const editCount = num(r.editCount);
  if (editCount !== undefined && editCount > 0) msg.editCount = editCount;
  if (bool(r.viewOnce)) msg.viewOnce = true;
  msg.protectedAt = r.protectedAt === null ? null : num(r.protectedAt);
  return msg;
}

function normPreview(r: Raw): ChatPreview {
  const lp = r.lastMessagePreview;
  const o = isObj(lp) ? lp : null;
  const p: ChatPreview = {
    type: normType(o?.type ?? r.lastMessageType),
    text: (o ? str(o.text) : str(lp)) ?? '',
  };
  const dur = num(o?.durationSec ?? r.lastMessageDurationSeconds ?? r.lastMessageDurationSec);
  if (dur !== undefined) p.durationSec = dur;
  const pages = num(o?.pages ?? r.lastMessagePages);
  if (pages !== undefined) p.pages = pages;
  const fromMe = bool(o?.fromMe ?? r.lastMessageFromMe) ?? (r.lastMessageDirection === 'out' ? true : r.lastMessageDirection === 'in' ? false : undefined);
  if (fromMe !== undefined) p.fromMe = fromMe;
  if (r.lastMessageDeleted === true) p.text = 'Diese Nachricht wurde gelöscht';
  const sender = str(o?.sender ?? r.lastMessageSender);
  if (sender) p.sender = sender;
  return p;
}

/** The API falls back to the id's local part when a chat has no name; show something readable instead. */
function chatName(id: string, name: string | undefined, isGroup: boolean): string {
  const idName = id.split('@')[0] ?? id;
  if (name === undefined || name === '' || name === idName) {
    if (isGroup) return 'Unbenannte Gruppe';
    return /^\d{6,}$/.test(idName) ? `+${idName}` : idName || id;
  }
  return name;
}

export function normChat(v: unknown): Chat {
  const r: Raw = isObj(v) ? v : {};
  const id = str(r.id) ?? '';
  const jidPhone = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(id)?.[1];
  const rawPhone = str(r.phone)?.replace(/\D/g, '');
  const isGroup = bool(r.isGroup) ?? id.endsWith('@g.us');
  const chat: Chat = {
    id,
    name: chatName(id, str(r.name), isGroup),
    isGroup,
    lastMessageAt: num(r.lastMessageAt) ?? num(r.lastMessageTimestamp) ?? 0,
    preview: normPreview(r),
    unreadCount: num(r.unreadCount) ?? 0,
    muted: r.muted === true,
  };
  noteTimestampUnit(chat.lastMessageAt);
  const phone = rawPhone || jidPhone;
  if (phone) chat.phone = phone;
  const avatar = str(r.avatarUrl);
  if (avatar) chat.avatarUrl = avatar;
  else if (r.hasAvatar === true) chat.avatarUrl = apiUrl(`/api/chats/${encodeURIComponent(id)}/avatar`);
  return chat;
}

const KINDS: DownloadKind[] = ['image', 'audio', 'video', 'document'];
/** UI kind -> key used by the API (the UI says "audio", the API "voice"). */
const RULE_KEY: Record<DownloadKind, string> = { image: 'image', audio: 'voice', video: 'video', document: 'document' };
const DEFAULT_MAX_MB: Record<DownloadKind, number> = { image: 10, audio: 10, video: 50, document: 20 };

function normSettings(v: unknown): Settings {
  const r: Raw = isObj(v) ? v : {};
  const dr = isObj(r.downloadRules) ? r.downloadRules : {};
  const rules = {} as DownloadRules;
  const maxMb = {} as DownloadMaxMb;
  for (const k of KINDS) {
    const rule = isObj(dr[RULE_KEY[k]]) ? (dr[RULE_KEY[k]] as Raw) : {};
    rules[k] = rule.mode === 'off' ? 'off' : 'auto';
    maxMb[k] = num(rule.maxMb) ?? DEFAULT_MAX_MB[k];
  }
  return {
    retentionDays: num(r.retentionDays) ?? 3,
    retentionMediaDays: num(r.retentionMediaDays) ?? 3,
    storageLimitMb: num(r.storageLimitMb) ?? 0,
    downloadRules: rules,
    downloadMaxMb: maxMb,
  };
}

function normState(v: unknown): ConnState {
  const s = str(v);
  return s === 'connected' || s === 'connecting' || s === 'disconnected' || s === 'needs_qr' ? s : 'disconnected';
}

export function normStatus(v: unknown): StatusInfo {
  const r: Raw = isObj(v) ? v : {};
  const s: StatusInfo = { state: normState(r.state) };
  const since = num(r.since);
  if (since !== undefined) s.since = since;
  return s;
}

function sortAsc(list: Message[]): Message[] {
  return list.sort((a, b) => a.waTimestamp - b.waTimestamp || a.id.localeCompare(b.id));
}

function listFrom(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) for (const k of keys) { const x = v[k]; if (Array.isArray(x)) return x; }
  return [];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

function challenge(d: unknown): { challengeId: string; options: Json } {
  const o: Raw = isObj(d) ? d : {};
  const challengeId = str(o.challengeId);
  if (!challengeId || !isObj(o.options)) throw new ApiError(500, 'invalid_response');
  return { challengeId, options: o.options };
}

function overview(d: unknown): PasskeyOverview {
  const o: Raw = isObj(d) ? d : {};
  return {
    configured: o.configured === true,
    rpId: str(o.rpId) ?? null,
    origin: str(o.origin) ?? null,
    lock: o.lock === true,
    sessionHours: num(o.sessionHours) ?? 12,
    passkeys: listFrom(o.passkeys, []).map((x) => {
      const p: Raw = isObj(x) ? x : {};
      return {
        id: str(p.id) ?? '',
        label: str(p.label) ?? '',
        createdAt: num(p.createdAt) ?? 0,
        lastUsedAt: num(p.lastUsedAt) ?? null,
        backupEligible: p.backupEligible === true,
        backupState: p.backupState === true,
      };
    }).filter((p) => p.id !== ''),
  };
}

export const api = {
  async login(password: string): Promise<void> {
    await json('POST', '/api/login', { password });
  },

  async logout(): Promise<void> {
    await json('POST', '/api/logout');
  },

  async status(): Promise<StatusInfo> {
    return normStatus(await json('GET', '/api/status'));
  },

  /** Returns the QR payload (SVG markup or data URL) or null when none is pending (404). */
  async qr(): Promise<string | null> {
    const res = await request('GET', '/api/qr');
    if (res.status === 404) return null;
    if (!res.ok) throw await errorFrom(res);
    const data: unknown = await res.json();
    return isObj(data) ? str(data.qr) ?? null : null;
  },

  async chats(): Promise<Chat[]> {
    return listFrom(await json('GET', '/api/chats'), ['chats']).map(normChat).filter((c) => c.id !== '');
  },

  async messages(chatId: string, before?: { waTimestamp: number; id: string }, limit = 50): Promise<Message[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) {
      // beforeId makes the page boundary exact when several messages share one timestamp.
      qs.set('before', String(before.waTimestamp));
      qs.set('beforeId', before.id);
    }
    const data = await json('GET', `/api/chats/${enc(chatId)}/messages?${qs}`);
    return sortAsc(listFrom(data, ['messages']).map((m) => normMessage(m, chatId)).filter((m) => m.id !== ''));
  },

  async markSeen(chatId: string, body: { all?: boolean; upTo?: string }): Promise<void> {
    await json('POST', `/api/chats/${enc(chatId)}/seen`, body);
  },

  async markPlayed(messageId: string): Promise<void> {
    await json('POST', `/api/messages/${enc(messageId)}/played`);
  },

  /** Shield on/off. Returns whether the server also asked the ingest service to fetch a missing file. */
  async protect(messageId: string, on: boolean): Promise<{ protectedAt: number | null; loading: boolean }> {
    const d = await json('POST', `/api/messages/${enc(messageId)}/protect`, { protected: on });
    const o: Raw = isObj(d) ? d : {};
    return { protectedAt: num(o.protectedAt) ?? null, loading: o.loading === true };
  },

  async versions(messageId: string): Promise<MessageVersions> {
    const d = await json('GET', `/api/messages/${enc(messageId)}/versions`);
    const o: Raw = isObj(d) ? d : {};
    const cur: Raw = isObj(o.current) ? o.current : {};
    return {
      id: str(o.id) ?? messageId,
      current: { text: str(cur.text) ?? null, editedAt: num(cur.editedAt) ?? null },
      versions: listFrom(o.versions, []).map((x) => {
        const v: Raw = isObj(x) ? x : {};
        return { version: num(v.version) ?? 0, text: str(v.text) ?? null, replacedAt: num(v.replacedAt) ?? 0 };
      }),
    };
  },

  /** "Medium jetzt laden": only stores a command; the ingest service fetches the file and reports via media_ready. */
  async loadMedia(messageId: string): Promise<void> {
    await json('POST', `/api/media/${enc(messageId)}/load`);
  },

  /**
   * Chat opened: asks for a fresh profile picture. Only stores a command; the ingest service decides whether the picture
   * is due (and whether profile pictures are switched on at all) and reports a change via avatar_updated.
   */
  async refreshAvatar(chatId: string): Promise<void> {
    await json('POST', `/api/chats/${enc(chatId)}/avatar/refresh`);
  },

  async muteChat(chatId: string, muted: boolean): Promise<void> {
    await json('PUT', `/api/chats/${enc(chatId)}/mute`, { muted });
  },

  async search(f: SearchFilters): Promise<SearchHit[]> {
    const qs = new URLSearchParams();
    if (f.q.trim()) qs.set('q', f.q.trim());
    if (f.chatId) qs.set('chatId', f.chatId);
    if (f.type) qs.set('type', f.type === 'audio' ? 'voice' : f.type);
    // Day boundaries are computed in the browser's local time zone.
    if (f.from) qs.set('from', String(toApiTs(new Date(`${f.from}T00:00:00`).getTime())));
    if (f.to) qs.set('to', String(toApiTs(new Date(`${f.to}T23:59:59`).getTime())));
    if (f.onlyNew) qs.set('onlyNew', '1');
    const data = await json('GET', `/api/search?${qs}`);
    return listFrom(data, ['results', 'hits', 'messages']).map((item): SearchHit => {
      const r: Raw = isObj(item) ? item : {};
      const chatId = str(r.chatId) ?? '';
      const message = normMessage(isObj(r.message) ? r.message : r, chatId);
      const hit: SearchHit = { message };
      const chatName = str(r.chatName);
      if (chatName) hit.chatName = chatName;
      return hit;
    }).filter((h) => h.message.id !== '');
  },

  async getSettings(): Promise<Settings> {
    return normSettings(await json('GET', '/api/settings'));
  },

  async putSettings(s: Settings): Promise<Settings> {
    const downloadRules: Record<string, { mode: string; maxMb: number }> = {};
    for (const k of KINDS) downloadRules[RULE_KEY[k]] = { mode: s.downloadRules[k], maxMb: s.downloadMaxMb[k] };
    const body = {
      retentionDays: s.retentionDays,
      retentionMediaDays: s.retentionMediaDays,
      storageLimitMb: s.storageLimitMb,
      downloadRules,
    };
    const data = await json('PUT', '/api/settings', body);
    return isObj(data) ? normSettings(data) : normSettings(await json('GET', '/api/settings'));
  },

  async storageUsage(): Promise<StorageUsage> {
    const r = await json('GET', '/api/storage/usage');
    const o: Raw = isObj(r) ? r : {};
    return {
      totalBytes: num(o.totalBytes) ?? 0,
      protectedMessages: num(o.protectedMessages) ?? 0,
      protectedMediaBytes: num(o.protectedMediaBytes) ?? 0,
      perChat: listFrom(o.perChat, []).map((x) => {
        const c: Raw = isObj(x) ? x : {};
        const id = str(c.chatId) ?? str(c.id) ?? '';
        return { id, name: str(c.name) ?? str(c.chatName) ?? id, bytes: num(c.mediaBytes) ?? num(c.bytes) ?? num(c.size) ?? 0 };
      }),
      perType: listFrom(o.perType, []).map((x) => {
        const t: Raw = isObj(x) ? x : {};
        return { type: str(t.type) ?? '?', bytes: num(t.mediaBytes) ?? num(t.bytes) ?? num(t.size) ?? 0 };
      }),
    };
  },

  /** Protected messages stay unless includeProtected is true (the extreme variant of "clear storage"). */
  async storageClear(scope: ClearScope, chatId?: string, includeProtected = false): Promise<ClearResult> {
    const body: { scope: ClearScope; chatId?: string; confirm: true; includeProtected?: true } = { scope, confirm: true };
    if (chatId) body.chatId = chatId;
    if (includeProtected) body.includeProtected = true;
    const d = await json('POST', '/api/storage/clear', body);
    const o: Raw = isObj(d) ? d : {};
    return {
      deletedMessages: num(o.deletedMessages) ?? 0,
      deletedMedia: num(o.deletedMedia) ?? 0,
      freedBytes: num(o.freedBytes) ?? 0,
      keptProtected: num(o.keptProtected) ?? 0,
    };
  },

  /** Asks the ingest service to start a new pairing (QR) when it is not connected. 202 = request stored. */
  async connect(): Promise<void> {
    await json('POST', '/api/connect');
  },

  // ---- Passkey lock ----

  async authState(): Promise<AuthState> {
    const d = await json('GET', '/api/auth/state');
    return { lock: isObj(d) && d.lock === true, passkey: isObj(d) && d.passkey === true };
  },

  async passkeyLoginOptions(): Promise<{ challengeId: string; options: Json }> {
    return challenge(await json('POST', '/api/passkey/login/options', {}));
  },

  async passkeyLoginVerify(challengeId: string, credential: Json): Promise<void> {
    await json('POST', '/api/passkey/login/verify', { challengeId, credential });
  },

  async passkeys(): Promise<PasskeyOverview> {
    return overview(await json('GET', '/api/passkeys'));
  },

  async passkeyStepOptions(purpose: PasskeyStepPurpose): Promise<{ challengeId: string; options: Json }> {
    return challenge(await json('POST', '/api/passkey/step/options', { purpose }));
  },

  /** Returns the one-time grant for the sensitive action. */
  async passkeyStepVerify(challengeId: string, credential: Json): Promise<string> {
    const d = await json('POST', '/api/passkey/step/verify', { challengeId, credential });
    const grant = isObj(d) ? str(d.grant) : undefined;
    if (!grant) throw new ApiError(500, 'invalid_response');
    return grant;
  },

  async passkeyRegisterOptions(grant?: string): Promise<{ challengeId: string; options: Json }> {
    return challenge(await json('POST', '/api/passkey/register/options', grant ? { grant } : {}));
  },

  async passkeyRegisterVerify(challengeId: string, credential: Json, label: string): Promise<PasskeyOverview> {
    return overview(await json('POST', '/api/passkey/register/verify', { challengeId, credential, label }));
  },

  async passkeyLock(on: boolean, grant: string): Promise<PasskeyOverview> {
    return overview(await json('POST', on ? '/api/passkey/lock/on' : '/api/passkey/lock/off', { grant }));
  },

  async passkeyDelete(id: string, grant?: string): Promise<PasskeyOverview> {
    return overview(await json('POST', '/api/passkey/delete', grant ? { id, grant } : { id }));
  },

  mediaUrl(messageId: string): string {
    return apiUrl(`/api/media/${enc(messageId)}`);
  },

  /** Only valid when media.hasThumbnail is true (the server answers 404 otherwise). */
  thumbUrl(messageId: string): string {
    return apiUrl(`/api/media/${enc(messageId)}?thumb=1`);
  },
};
