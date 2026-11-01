// Central client state with a tiny publish/subscribe layer.
//
// Topics:
//   'chats' | 'status' | 'settings' | 'online'   -> no payload
//   'new:<chatId>'  -> Message appended to a chat
//   'msg:<id>'      -> Message changed (seen, played, deleted, media ready)
//   'sync:<chatId>' -> loaded messages of a chat were merged after a reconnect

import { api } from './api';
import { toast } from './components/toast';
import { mergeMessages } from './messageOrder';
import type { Chat, ChatPreview, MediaInfo, Message, MessageUpdate, Settings, StatusInfo } from './types';
import { debounce } from './util';

type Listener = (payload?: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

export function on(topic: string, fn: Listener): () => void {
  let set = listeners.get(topic);
  if (!set) { set = new Set(); listeners.set(topic, set); }
  set.add(fn);
  return () => { set?.delete(fn); };
}

function emit(topic: string, payload?: unknown): void {
  listeners.get(topic)?.forEach((fn) => fn(payload));
}

const PAGE = 50;

export const state = {
  chats: new Map<string, Chat>(),
  /** Messages per chat, ascending by waTimestamp. */
  messages: new Map<string, Message[]>(),
  byId: new Map<string, Message>(),
  hasMore: new Map<string, boolean>(),
  status: { state: 'connecting' } as StatusInfo,
  settings: null as Settings | null,
  /** False while the SSE stream to the waread server is down. */
  online: true,
  openChatId: null as string | null,
};

export function sortedChats(): Chat[] {
  return [...state.chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/** Unread ("neu") messages over all chats that are not muted. */
export function totalUnread(): number {
  let n = 0;
  for (const c of state.chats.values()) if (!c.muted) n += c.unreadCount;
  return n;
}

/** Unread messages in other (not muted) chats, for the counter on the back button. */
export function unreadElsewhere(chatId: string): number {
  let n = 0;
  for (const c of state.chats.values()) if (!c.muted && c.id !== chatId) n += c.unreadCount;
  return n;
}

/**
 * "New" = incoming, not seen locally, not deleted. Type "other" is what the API calls "system" (placeholders such as
 * "Nicht unterstützter Nachrichtentyp"): the server does not count those, so neither does the client.
 */
export const isNew = (m: Message): boolean => !m.fromMe && !m.seenAt && !m.deleted && m.type !== 'other';

export function previewOf(m: Message): ChatPreview {
  const p: ChatPreview = {
    type: m.type,
    text: m.deleted ? 'Diese Nachricht wurde gelöscht' : m.caption ?? m.text ?? (m.type === 'document' ? m.media?.fileName ?? '' : ''),
    fromMe: m.fromMe,
  };
  if (m.media?.durationSec !== undefined) p.durationSec = m.media.durationSec;
  if (m.media?.pages !== undefined) p.pages = m.media.pages;
  if (m.senderName && !m.fromMe) p.sender = m.senderName;
  return p;
}

// ---------------------------------------------------------------------------
// Status, settings, chats
// ---------------------------------------------------------------------------

export function setStatus(s: StatusInfo): void {
  state.status = s;
  emit('status');
}

export function setOnline(v: boolean): void {
  if (state.online === v) return;
  state.online = v;
  emit('online');
}

export async function loadStatus(): Promise<void> {
  setStatus(await api.status());
}

export async function loadSettings(): Promise<void> {
  state.settings = await api.getSettings();
  emit('settings');
}

export async function saveSettings(s: Settings): Promise<void> {
  state.settings = await api.putSettings(s);
  emit('settings');
}

export async function loadChats(): Promise<void> {
  const list = await api.chats();
  state.chats = new Map(list.map((c) => [c.id, c]));
  emit('chats');
}

export const refreshChatsSoon = debounce(() => {
  loadChats().catch(() => { /* next event or reconnect will retry */ });
}, 1500);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function mergeInto(chatId: string, incoming: Message[], where: 'start' | 'end' = 'end'): Message[] {
  const list = state.messages.get(chatId) ?? [];
  const added = mergeMessages(list, incoming, where);
  for (const m of incoming) state.byId.set(m.id, m);
  state.messages.set(chatId, list);
  return added;
}

/** Loads the newest page of a chat. Replaces nothing that is already loaded. */
export async function loadInitial(chatId: string): Promise<void> {
  const page = await api.messages(chatId, undefined, PAGE);
  mergeInto(chatId, page);
  state.hasMore.set(chatId, page.length >= PAGE);
}

/** Loads one page older than the oldest loaded message. Returns the newly loaded ones. */
export async function loadOlder(chatId: string): Promise<Message[]> {
  const list = state.messages.get(chatId) ?? [];
  const oldest = list[0];
  if (!oldest || state.hasMore.get(chatId) === false) return [];
  const page = await api.messages(chatId, { waTimestamp: oldest.waTimestamp, id: oldest.id }, PAGE);
  const added = mergeInto(chatId, page, 'start'); // aeltere Seite: bei gleicher Sekunde vor den vorhandenen
  state.hasMore.set(chatId, page.length >= PAGE && added.length > 0);
  return added;
}

/** Re-reads the newest page of the open chat after a connection gap. */
export async function syncOpenChat(): Promise<void> {
  const id = state.openChatId;
  if (!id) return;
  const page = await api.messages(id, undefined, PAGE);
  mergeInto(id, page);
  emit(`sync:${id}`);
}

export function onNewMessage(chatId: string, raw: Message): void {
  const msg: Message = { ...raw, chatId: raw.chatId || chatId };
  const loaded = state.messages.has(chatId);
  if (loaded) {
    if (!state.byId.has(msg.id)) { mergeInto(chatId, [msg]); emit(`new:${chatId}`, msg); }
  } else {
    state.byId.set(msg.id, msg);
  }
  const chat = state.chats.get(chatId);
  if (!chat) { refreshChatsSoon(); return; }
  if (msg.waTimestamp >= chat.lastMessageAt) {
    chat.lastMessageAt = msg.waTimestamp;
    chat.preview = previewOf(msg);
  }
  if (isNew(msg)) chat.unreadCount += 1;
  emit('chats');
}

export function onMessageUpdated(u: MessageUpdate): void {
  const m = state.byId.get(u.messageId);
  if (!m) { refreshChatsSoon(); return; }
  const wasNew = isNew(m);
  if (u.seenAt !== undefined) m.seenAt = u.seenAt;
  if (u.playedAt !== undefined) m.playedAt = u.playedAt;
  if (u.deleted) m.deleted = true;
  if (u.deletedAt !== undefined) m.deletedAt = u.deletedAt;
  if (u.edited) m.edited = true;
  if (u.editedAt !== undefined) m.editedAt = u.editedAt;
  if (u.editCount !== undefined) m.editCount = u.editCount;
  if (u.protectedAt !== undefined) m.protectedAt = u.protectedAt;
  // A new text arrives with an edit. A deleted message keeps its text unless the server hides it (text null).
  if (u.text !== undefined && m.type !== 'audio') {
    const isCaption = m.type === 'image' || m.type === 'video' || m.type === 'document' || m.type === 'sticker';
    if (isCaption) {
      if (u.text === null) delete m.caption; else m.caption = u.text;
    } else if (u.text === null) delete m.text;
    else m.text = u.text;
  }
  const chat = state.chats.get(m.chatId);
  if (chat && wasNew && !isNew(m)) {
    chat.unreadCount = Math.max(0, chat.unreadCount - 1);
    emit('chats');
  }
  if (u.text !== undefined && chat && chat.lastMessageAt <= m.waTimestamp) {
    chat.preview = previewOf(m);
    emit('chats');
  }
  emit(`msg:${m.id}`, m);
}

export function onMediaReady(u: { messageId: string; status?: MediaInfo['status']; thumbnailPath?: string; skipReason?: string | null; loadable?: boolean }): void {
  const m = state.byId.get(u.messageId);
  if (!m) return;
  // The event also reports failed / expired; a missing status is treated as ready.
  const media: MediaInfo = {
    ...(m.media ?? {}),
    status: u.status ?? 'ready',
    ...(u.thumbnailPath ? { hasThumbnail: true } : {}),
  };
  if (u.skipReason === null || media.status === 'ready') delete media.skipReason;
  else if (typeof u.skipReason === 'string') media.skipReason = u.skipReason;
  if (u.loadable === true) media.loadable = true;
  else if (u.loadable === false || media.status === 'ready') delete media.loadable;
  m.media = media;
  emit(`msg:${m.id}`, m);
}

// ---------------------------------------------------------------------------
// Shield ("Schild"), load media, mute. All of these only touch the waread server.
// ---------------------------------------------------------------------------

/** Sets or removes the shield. Returns false (with a toast) if the server call failed. */
export async function setProtected(m: Message, on: boolean): Promise<boolean> {
  try {
    const res = await api.protect(m.id, on);
    m.protectedAt = res.protectedAt;
    if (res.loading && m.media) m.media = { ...m.media, status: 'pending' };
    emit(`msg:${m.id}`, m);
    toast(on
      ? (res.loading ? 'Geschützt. Die Datei wird jetzt geladen.' : 'Geschützt: wird nicht automatisch gelöscht.')
      : 'Schutz aufgehoben. Die Nachricht wird nach der Aufbewahrungszeit gelöscht.');
    return true;
  } catch {
    toast('Schild konnte nicht gesetzt werden.');
    return false;
  }
}

/** "Medium jetzt laden". The file arrives later via the media_ready event. */
export async function loadMedia(m: Message): Promise<void> {
  try {
    await api.loadMedia(m.id);
    if (m.media) m.media = { ...m.media, status: 'pending', loadable: false };
    emit(`msg:${m.id}`, m);
  } catch (err) {
    toast(err instanceof Error && err.message === 'not_loadable'
      ? 'Dieses Medium lässt sich nicht mehr laden.'
      : 'Laden konnte nicht angefordert werden.');
  }
}

export async function setMuted(chatId: string, muted: boolean): Promise<void> {
  const chat = state.chats.get(chatId);
  try {
    await api.muteChat(chatId, muted);
    if (chat) chat.muted = muted;
    emit('chats');
    toast(muted ? 'Chat stumm: zählt nicht mehr bei „Neu“.' : 'Chat nicht mehr stumm.');
  } catch {
    toast('Stumm-Einstellung konnte nicht gespeichert werden.');
  }
}

// ---------------------------------------------------------------------------
// Local "seen" / "played" markers. These only touch the waread database; the
// API calls have no effect on WhatsApp.
// ---------------------------------------------------------------------------

function applySeenLocally(chatId: string, upTo: Message | null): number {
  const list = state.messages.get(chatId) ?? [];
  const now = Date.now();
  let changed = 0;
  for (const m of list) {
    if (!isNew(m)) continue;
    if (upTo && m.waTimestamp > upTo.waTimestamp) continue;
    m.seenAt = now;
    changed++;
    emit(`msg:${m.id}`, m);
  }
  const chat = state.chats.get(chatId);
  if (chat) {
    chat.unreadCount = upTo === null && changed === 0 ? 0 : Math.max(0, chat.unreadCount - changed);
    emit('chats');
  }
  return changed;
}

/** Marks everything up to and including `upTo` as seen (the server reads `upTo` as a message id). */
export async function markSeenUpTo(chatId: string, upTo: Message): Promise<void> {
  applySeenLocally(chatId, upTo);
  try {
    await api.markSeen(chatId, { upTo: upTo.id });
  } catch {
    toast('Gesehen-Status konnte nicht gespeichert werden.');
  }
  refreshChatsSoon();
}

export async function markAllSeen(chatId: string): Promise<void> {
  applySeenLocally(chatId, null);
  const chat = state.chats.get(chatId);
  if (chat) { chat.unreadCount = 0; emit('chats'); }
  try {
    await api.markSeen(chatId, { all: true });
  } catch {
    toast('Gesehen-Status konnte nicht gespeichert werden.');
  }
  refreshChatsSoon();
}

export async function markPlayed(m: Message): Promise<void> {
  if (m.playedAt) return;
  m.playedAt = Date.now();
  emit(`msg:${m.id}`, m);
  try {
    await api.markPlayed(m.id);
  } catch {
    // Played is a cosmetic local marker; a failed call is not worth a toast.
  }
}

/** Drops every loaded message (after clearing storage or a server-side cleanup). */
export function resetMessageCache(): void {
  state.messages.clear();
  state.byId.clear();
  state.hasMore.clear();
}

/**
 * Call after stored data changed on the server (clear storage, cleanup run).
 * Drops loaded messages and tells open views ('reset') to reload.
 */
export function dataChanged(): void {
  resetMessageCache();
  emit('reset');
}

/** Drops all client state (logout, expired session). */
export function resetAll(): void {
  resetMessageCache();
  state.chats.clear();
  state.settings = null;
  state.openChatId = null;
  state.status = { state: 'connecting' };
}

export async function refreshAll(): Promise<void> {
  await Promise.allSettled([loadStatus(), loadChats(), syncOpenChat()]);
}
