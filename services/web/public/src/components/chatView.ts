// One open chat: header (back, avatar, name, mute), a slim bar with "N neue Nachrichten / Alle als gesehen" (only while
// something is unseen, so it never covers messages), message list with date separators, yellow "N neue Nachrichten"
// divider, seen tracking, paging of older messages, jump-to-message with highlight, and the read-only footer bar.

import { api } from '../api';
import { goBack } from '../router';
import {
  isNew, loadInitial, loadOlder, markAllSeen, markSeenUpTo, on, setMuted, state, unreadElsewhere,
} from '../store';
import type { Chat, Message } from '../types';
import { clear, coalesce, dayKey, dayLabel, el, loadPref } from '../util';
import { avatar } from './avatar';
import { buildBubble } from './bubble';
import { icon } from './icons';
import { openLightbox } from './lightbox';
import { openMessageSheet } from './messageSheet';
import { createSeenTracker } from './seenTracker';
import { toast } from './toast';
import { openVersions } from './versionsDialog';

const MAX_UNSEEN_PAGES = 6;
const MAX_JUMP_PAGES = 40;
const BOTTOM_SLACK = 80;

export function mountChatView(host: HTMLElement, chatId: string, jumpMsgId?: string): () => void {
  let destroyed = false;
  let loadingOlder = false;
  let pendingNew = 0;
  let dividerBeforeId: string | null = null;
  let dividerCount = 0;
  let userScrolled = false;
  let stickyUntil = 0;
  let reposition: (() => void) | null = null;

  const rows = new Map<string, HTMLElement>();
  const sigs = new Map<string, string>();
  const cleanups = new Map<string, (() => void)[]>();
  const globalOffs: (() => void)[] = [];

  // --- skeleton -----------------------------------------------------------
  const head = el('header', { class: 'chat-head' });
  const content = el('div', { class: 'msg-content' });
  const sentinel = el('div', { class: 'older' });
  const scroller = el('div', { class: 'messages', tabindex: '-1' }, sentinel, content);
  const toBottom = el('button', { class: 'to-bottom', type: 'button', 'aria-label': 'Zu den neuesten Nachrichten' }, icon('down', 22));
  const footer = el('footer', { class: 'readonly-bar' });
  // A slim bar under the header instead of a floating pill: it takes a little height only while something is unseen
  // and never covers message text. "Gesehen" is a purely local marker.
  const newBarText = el('span', { class: 'new-bar-text' });
  const seenBtn = el('button', {
    class: 'btn small-btn', type: 'button',
    title: 'Alle Nachrichten dieses Chats lokal als gesehen markieren',
    onclick: () => { void markAllSeen(chatId); },
  }, icon('checkAll', 16), 'Alle als gesehen');
  const newBar = el('div', { class: 'new-bar', role: 'status', hidden: true }, newBarText, seenBtn);
  // The connection hint of the chat list, repeated here: on a phone you are mostly inside a chat.
  const offlineBar = el('div', { class: 'banner chat-banner', role: 'status', hidden: true });
  const body = el('div', { class: 'messages-wrap' }, scroller, toBottom);
  const pane = el('section', { class: 'chat-pane' }, head, offlineBar, newBar, body, footer);
  host.append(pane);

  const tracker = createSeenTracker(scroller, (newest) => { void markSeenUpTo(chatId, newest); });

  // --- helpers ------------------------------------------------------------
  const chat = (): Chat | undefined => state.chats.get(chatId);
  const list = (): Message[] => state.messages.get(chatId) ?? [];
  const distanceFromBottom = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const atBottom = (): boolean => distanceFromBottom() < BOTTOM_SLACK;
  const scrollToBottom = (smooth = false): void => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  // A bubble is rebuilt when something it shows changes (not for seen/played, which only toggle a class or a dot).
  const sigOf = (m: Message): string =>
    JSON.stringify([m.deleted ? 1 : 0, m.media?.status ?? '', m.media?.loadable ? 1 : 0, m.media?.skipReason ?? '', m.protectedAt ? 1 : 0, m.edited ? 1 : 0, m.editCount ?? 0, m.text ?? '', m.caption ?? '']);

  const runCleanups = (id: string): void => {
    cleanups.get(id)?.forEach((fn) => fn());
    cleanups.delete(id);
  };

  const makeRow = (m: Message): HTMLElement => {
    const row = buildBubble(m, {
      openSheet: openMessageSheet,
      showVersions: openVersions,
      isGroup: chat()?.isGroup ?? false,
      openImage: (msg) => {
        const images = list().filter((x) => x.type === 'image' && !x.deleted && (!x.media?.status || x.media.status === 'ready'));
        openLightbox(images, msg.id);
      },
      jumpTo: (id) => { void jumpTo(id); },
      track: (fn) => { const arr = cleanups.get(m.id) ?? []; arr.push(fn); cleanups.set(m.id, arr); },
    });
    rows.set(m.id, row);
    sigs.set(m.id, sigOf(m));
    tracker.observe(row, m);
    const off = on(`msg:${m.id}`, () => onMessageChanged(m.id));
    const arr = cleanups.get(m.id) ?? [];
    arr.push(off);
    cleanups.set(m.id, arr);
    return row;
  };

  const onMessageChanged = (id: string): void => {
    const m = state.byId.get(id);
    const row = rows.get(id);
    if (!m || !row) return;
    row.classList.toggle('is-new', isNew(m));
    if (!isNew(m)) tracker.unobserve(row);
    if (sigs.get(id) !== sigOf(m)) {
      runCleanups(id);
      tracker.unobserve(row);
      row.replaceWith(makeRow(m));
    }
  };

  const daySep = (ts: number, key: string): HTMLElement =>
    el('div', { class: 'day-sep', 'data-day': key }, el('span', null, dayLabel(ts)));

  const dividerEl = (): HTMLElement =>
    el('div', { class: 'new-divider', role: 'separator' },
      el('span', null, `${dividerCount} ${dividerCount === 1 ? 'neue Nachricht' : 'neue Nachrichten'}`));

  const buildRows = (msgs: Message[], prevKey: string | null): { frag: DocumentFragment; lastKey: string | null } => {
    const frag = document.createDocumentFragment();
    let key = prevKey;
    for (const m of msgs) {
      const k = dayKey(m.waTimestamp);
      if (k !== key) { frag.append(daySep(m.waTimestamp, k)); key = k; }
      if (m.id === dividerBeforeId) frag.append(dividerEl());
      frag.append(makeRow(m));
    }
    return { frag, lastKey: key };
  };

  const clearRows = (): void => {
    for (const id of [...cleanups.keys()]) runCleanups(id);
    rows.forEach((row) => tracker.unobserve(row));
    rows.clear();
    sigs.clear();
    clear(content);
  };

  const renderAll = (): void => {
    clearRows();
    content.append(buildRows(list(), null).frag);
    renderOlderState();
  };

  const renderOlderState = (): void => {
    clear(sentinel);
    if (loadingOlder) sentinel.append(el('span', { class: 'spinner' }), 'Lade ältere Nachrichten …');
    else if (list().length > 0 && state.hasMore.get(chatId) === false) sentinel.append('Beginn des gespeicherten Verlaufs');
  };

  // --- header / footer ----------------------------------------------------
  const renderHead = (): void => {
    const c = chat();
    clear(head);
    const others = unreadElsewhere(chatId);
    const back = el('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Zurück zur Chatliste', onclick: goBack },
      icon('back', 26), others > 0 ? el('span', { class: 'back-count' }, String(others)) : null);
    const subtitle = c?.isGroup ? 'Gruppe' : c?.phone ? `+${c.phone}` : '';
    const unseen = Math.max(c?.unreadCount ?? 0, list().filter(isNew).length);
    newBar.hidden = unseen === 0;
    newBarText.textContent = `${unseen} ${unseen === 1 ? 'neue Nachricht' : 'neue Nachrichten'}`;
    const muted = c?.muted === true;
    const mute = el('button', {
      class: 'icon-btn mute', type: 'button', 'aria-pressed': muted ? 'true' : 'false',
      'aria-label': muted ? 'Stumm aufheben' : 'Chat stumm schalten',
      title: muted ? 'Stumm: zählt nicht bei „Neu“. Tippen hebt auf.' : 'Stumm schalten: zählt nicht mehr bei „Neu“',
    }, icon(muted ? 'bellOff' : 'bell', 22));
    mute.addEventListener('click', () => { void setMuted(chatId, !muted); });
    head.append(
      back,
      c ? avatar(c, 'sm') : el('div', { class: 'avatar avatar-sm' }),
      el('div', { class: 'chat-title' }, el('span', { class: 'name' }, c?.name ?? 'Chat'), subtitle ? el('span', { class: 'sub' }, subtitle) : null),
      ...(c ? [mute] : []),
    );
  };

  const renderOffline = (): void => {
    clear(offlineBar);
    offlineBar.hidden = state.online;
    if (!state.online) offlineBar.append(icon('wifiOff', 16), 'Keine Verbindung zum waread-Server. Neuer Versuch läuft …');
  };

  const renderFooter = (): void => {
    const c = chat();
    clear(footer);
    footer.append(el('span', { class: 'ro-text' }, icon('eye', 16), 'Nur lesen. Antworten in WhatsApp.'));
    if (c && !c.isGroup && c.phone) {
      footer.append(el('a', { class: 'btn', href: `https://wa.me/${c.phone}`, target: '_blank', rel: 'noopener noreferrer' }, 'In WhatsApp öffnen', icon('external', 16)));
    } else if (c?.isGroup) {
      footer.append(el('span', { class: 'ro-hint' }, 'Gruppen lassen sich nicht direkt öffnen. Bitte WhatsApp selbst starten.'));
    } else if (c) {
      footer.append(el('span', { class: 'ro-hint' }, 'Keine Rufnummer bekannt. Bitte WhatsApp selbst öffnen.'));
    }
  };

  // --- scrolling ----------------------------------------------------------
  const markSticky = (fn: () => void): void => {
    reposition = fn;
    stickyUntil = Date.now() + 2500;
    userScrolled = false;
  };

  scroller.addEventListener('load', () => {
    if (reposition && !userScrolled && Date.now() < stickyUntil) reposition();
  }, true);
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) {
    scroller.addEventListener(ev, () => { userScrolled = true; }, { passive: true });
  }

  const updateToBottom = coalesce(() => {
    const far = distanceFromBottom() > 320;
    toBottom.classList.toggle('show', far);
    if (!far) pendingNew = 0;
    toBottom.dataset.count = pendingNew > 0 ? String(pendingNew) : '';
  });
  scroller.addEventListener('scroll', updateToBottom, { passive: true });
  toBottom.addEventListener('click', () => { scrollToBottom(true); pendingNew = 0; updateToBottom(); });

  const scrollToRow = (row: HTMLElement, smooth: boolean): void => {
    row.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  };

  // --- older pages --------------------------------------------------------
  const prepend = (added: Message[]): void => {
    if (added.length === 0) return;
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    const { frag, lastKey } = buildRows(added, null);
    const first = content.firstElementChild;
    if (first instanceof HTMLElement && first.classList.contains('day-sep') && first.dataset.day === lastKey) first.remove();
    content.prepend(frag);
    scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  };

  const fetchOlder = async (): Promise<Message[]> => {
    if (loadingOlder || destroyed || state.hasMore.get(chatId) === false) return [];
    loadingOlder = true;
    renderOlderState();
    try {
      return await loadOlder(chatId);
    } catch {
      toast('Ältere Nachrichten konnten nicht geladen werden.');
      return [];
    } finally {
      loadingOlder = false;
      renderOlderState();
    }
  };

  const olderObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !loadingOlder) {
      void fetchOlder().then((added) => { if (!destroyed) prepend(added); });
    }
  }, { root: scroller, rootMargin: '400px 0px 0px 0px' });

  // --- jump to a message (search hit, quote tap) ---------------------------
  // The API has no "around this message" query, so older pages are loaded
  // until the target is found (bounded by MAX_JUMP_PAGES).
  const jumpTo = async (id: string | undefined, instant = false): Promise<void> => {
    if (!id) return;
    let pages = 0;
    while (!rows.has(id) && !list().some((m) => m.id === id) && state.hasMore.get(chatId) !== false && pages < MAX_JUMP_PAGES && !destroyed) {
      const added = await fetchOlder();
      if (added.length === 0) break;
      prepend(added);
      pages++;
    }
    const row = rows.get(id);
    if (!row) { toast('Diese Nachricht ist im geladenen Verlauf nicht mehr vorhanden.'); return; }
    scrollToRow(row, !instant);
    if (instant) markSticky(() => scrollToRow(row, false));
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    window.setTimeout(() => row.classList.remove('flash'), 2400);
  };

  // --- live updates ---------------------------------------------------------
  globalOffs.push(on(`new:${chatId}`, (payload) => {
    const m = payload as Message;
    const wasAtBottom = atBottom();
    const seps = content.querySelectorAll<HTMLElement>('.day-sep');
    const lastDay = seps[seps.length - 1]?.dataset.day ?? null;
    content.append(buildRows([m], lastDay).frag);
    if (wasAtBottom) scrollToBottom(true);
    else if (!m.fromMe) { pendingNew++; updateToBottom(); }
  }));
  globalOffs.push(on(`sync:${chatId}`, () => {
    const wasAtBottom = atBottom();
    renderAll();
    if (wasAtBottom) scrollToBottom();
  }));
  globalOffs.push(on('chats', coalesce(() => { renderHead(); renderFooter(); })));
  globalOffs.push(on('online', renderOffline));

  // --- initial load -----------------------------------------------------------
  const showError = (message: string): void => {
    clear(content);
    content.append(el('div', { class: 'empty' },
      el('p', null, message),
      el('button', { class: 'btn', type: 'button', onclick: () => { void init(); } }, 'Erneut versuchen')));
  };

  const countNew = (): number => list().filter(isNew).length;

  async function init(): Promise<void> {
    clear(content);
    content.append(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), 'Lade Nachrichten …'));
    try {
      await loadInitial(chatId);
      const unreadAtOpen = chat()?.unreadCount ?? 0;
      let pages = 0;
      while (countNew() < unreadAtOpen && state.hasMore.get(chatId) && pages < MAX_UNSEEN_PAGES && !destroyed) {
        const added = await loadOlder(chatId);
        if (added.length === 0) break;
        pages++;
      }
      if (destroyed) return;

      const firstNew = list().find(isNew);
      dividerBeforeId = firstNew && !jumpMsgId ? firstNew.id : null;
      dividerCount = Math.max(unreadAtOpen, countNew());
      state.openChatId = chatId;
      renderAll();

      requestAnimationFrame(() => {
        if (destroyed) return;
        const divider = content.querySelector<HTMLElement>('.new-divider');
        if (jumpMsgId) { void jumpTo(jumpMsgId, true); return; }
        const place = (): void => {
          if (divider) scroller.scrollTop = Math.max(0, divider.offsetTop - 70);
          else scrollToBottom();
        };
        place();
        markSticky(place);
        updateToBottom();
      });

      if (loadPref<boolean>('markAllOnOpen', false)) void markAllSeen(chatId);
    } catch {
      if (!destroyed) showError('Nachrichten konnten nicht geladen werden.');
    }
  }

  renderHead();
  renderFooter();
  renderOffline();
  olderObserver.observe(sentinel);
  void init();
  // Like WhatsApp: opening a chat refreshes its profile picture if it is due (decided by the ingest service).
  api.refreshAvatar(chatId).catch(() => undefined);

  return () => {
    destroyed = true;
    olderObserver.disconnect();
    tracker.destroy();
    globalOffs.forEach((off) => off());
    for (const id of [...cleanups.keys()]) runCleanups(id);
    if (state.openChatId === chatId) state.openChatId = null;
    pane.remove();
  };
}
