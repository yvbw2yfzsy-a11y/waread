// Server-Sent Events client for events (relative URL, see apiUrl in api.ts).
//
// EventSource reconnects on its own only for some failures (it gives up when
// the server answers with a non-200 status). To get predictable behaviour the
// stream is closed on every error and reopened here with exponential backoff.
// iOS Safari also leaves streams half-dead after the page was in the background,
// so a long-hidden page is reconnected explicitly when it becomes visible again.

import { apiUrl, normMediaStatus, normMessage, normStatus } from './api';
import type { SseHandlers } from './types';
import { isObj } from './util';

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;
const STALE_AFTER_HIDDEN_MS = 20_000;

function parse(ev: Event): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse((ev as MessageEvent<string>).data);
    return isObj(data) ? data : null;
  } catch {
    return null;
  }
}

export function startEvents(h: SseHandlers): () => void {
  let es: EventSource | null = null;
  let timer: number | undefined;
  let backoff = MIN_BACKOFF;
  let everOpened = false;
  let stopped = false;
  let hiddenAt = 0;

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    const delay = backoff + Math.random() * 500;
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    timer = window.setTimeout(() => { timer = undefined; connect(); }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    es?.close();
    const source = new EventSource(apiUrl('/events'), { withCredentials: true });
    es = source;

    source.onopen = () => {
      const again = everOpened;
      everOpened = true;
      backoff = MIN_BACKOFF;
      h.onOpen(again);
    };
    source.onerror = () => {
      source.close();
      if (es === source) es = null;
      h.onDown();
      schedule();
    };

    source.addEventListener('new_message', (ev) => {
      const d = parse(ev);
      if (!d) return;
      const chatId = typeof d.chatId === 'string' ? d.chatId : '';
      const msg = normMessage(d.message, chatId);
      if (msg.id) h.onNewMessage(msg.chatId || chatId, msg);
    });
    source.addEventListener('message_updated', (ev) => {
      const d = parse(ev);
      if (!d || typeof d.messageId !== 'string') return;
      const u: Parameters<SseHandlers['onMessageUpdated']>[0] = { messageId: d.messageId };
      if (typeof d.seenAt === 'number' || d.seenAt === null) u.seenAt = d.seenAt;
      if (typeof d.playedAt === 'number' || d.playedAt === null) u.playedAt = d.playedAt;
      if (d.deleted === true) u.deleted = true;
      if (typeof d.deletedAt === 'number') u.deletedAt = d.deletedAt;
      if (d.edited === true) u.edited = true;
      if (typeof d.editedAt === 'number') u.editedAt = d.editedAt;
      if (typeof d.editCount === 'number') u.editCount = d.editCount;
      if (typeof d.protectedAt === 'number' || d.protectedAt === null) u.protectedAt = d.protectedAt;
      if (typeof d.text === 'string' || d.text === null) u.text = d.text;
      h.onMessageUpdated(u);
    });
    source.addEventListener('media_ready', (ev) => {
      const d = parse(ev);
      if (!d || typeof d.messageId !== 'string') return;
      const u: Parameters<SseHandlers['onMediaReady']>[0] = { messageId: d.messageId };
      const status = normMediaStatus(d.status);
      if (status) u.status = status;
      if (typeof d.thumbnailPath === 'string') u.thumbnailPath = d.thumbnailPath;
      if (typeof d.filePath === 'string') u.filePath = d.filePath;
      if (typeof d.skipReason === 'string' || d.skipReason === null) u.skipReason = d.skipReason;
      if (typeof d.loadable === 'boolean') u.loadable = d.loadable;
      h.onMediaReady(u);
    });
    source.addEventListener('connection_status', (ev) => {
      const d = parse(ev);
      if (d) h.onConnectionStatus(normStatus(d));
    });
    source.addEventListener('history_synced', (ev) => {
      const d = parse(ev);
      h.onHistorySynced({ stored: d && typeof d.stored === 'number' ? d.stored : 0 });
    });
    source.addEventListener('avatar_updated', (ev) => {
      const d = parse(ev);
      if (d && typeof d.chatId === 'string') h.onAvatarUpdated({ chatId: d.chatId });
    });
    source.addEventListener('cleanup_done', (ev) => {
      const d = parse(ev);
      if (!d) return;
      h.onCleanupDone({
        deletedMessages: typeof d.deletedMessages === 'number' ? d.deletedMessages : 0,
        deletedMedia: typeof d.deletedMedia === 'number' ? d.deletedMedia : 0,
      });
    });
  };

  const onVisibility = (): void => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const staleMs = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (stopped) return;
    if (!es || es.readyState === EventSource.CLOSED || staleMs > STALE_AFTER_HIDDEN_MS) {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      backoff = MIN_BACKOFF;
      connect();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onVisibility);
  window.addEventListener('online', onVisibility);
  connect();

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    es?.close();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onVisibility);
    window.removeEventListener('online', onVisibility);
  };
}
