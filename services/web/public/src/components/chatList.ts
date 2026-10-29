// Chat overview: avatar, name, preview line with type icon, time, yellow "new"
// counter and filter chips. "New" is yellow on purpose so it cannot be mistaken
// for WhatsApp's own green unread badge.

import { navigate, hrefChat, onRoute, parseHash } from '../router';
import { on, sortedChats, state } from '../store';
import type { Chat } from '../types';
import { append, clear, coalesce, el, formatDuration, listTime, loadPref, savePref, statusLabel } from '../util';
import { avatar } from './avatar';
import { icon, typeIcon } from './icons';

type FilterId = 'all' | 'new' | 'groups' | 'photos' | 'voice';

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'new', label: 'Neu' },
  { id: 'groups', label: 'Gruppen' },
  { id: 'photos', label: 'Fotos' },
  { id: 'voice', label: 'Sprachnachrichten' },
];

let filter: FilterId = loadPref<FilterId>('chatFilter', 'all');

// "Fotos" and "Sprachnachrichten" match on the type of each chat's LAST message,
// because the chat list payload only carries that. See README, known limits.
function matches(c: Chat, f: FilterId): boolean {
  switch (f) {
    case 'all': return true;
    case 'new': return c.unreadCount > 0;
    case 'groups': return c.isGroup;
    case 'photos': return c.preview.type === 'image';
    case 'voice': return c.preview.type === 'audio';
  }
}

function previewNode(chat: Chat): DocumentFragment {
  const p = chat.preview;
  const frag = document.createDocumentFragment();
  if (p.fromMe) frag.append('Du: ');
  else if (chat.isGroup && p.sender) frag.append(`${p.sender}: `);

  const ic = typeIcon(p.type);
  if (ic) frag.append(icon(ic, 15));

  let label = p.text;
  switch (p.type) {
    case 'audio': label = formatDuration(p.durationSec); break;
    case 'document': {
      const name = p.text || 'Dokument';
      label = p.pages ? `${name} · ${p.pages} ${p.pages === 1 ? 'Seite' : 'Seiten'}` : name;
      break;
    }
    case 'image': label = p.text || 'Foto'; break;
    case 'video': label = p.text || 'Video'; break;
    case 'sticker': label = 'Sticker'; break;
    case 'other': label = p.text || 'Nachricht'; break;
    case 'text': break;
  }
  frag.append(el('span', { class: 'preview-text' }, label));
  return frag;
}

function chatItem(chat: Chat, activeId: string | null): HTMLElement {
  const hasNew = chat.unreadCount > 0;
  const link = el(
    'a',
    {
      class: `chat-item${hasNew ? ' has-new' : ''}${chat.id === activeId ? ' active' : ''}`,
      href: hrefChat(chat.id),
      'data-chat-id': chat.id,
      'aria-current': chat.id === activeId ? 'true' : null,
    },
    avatar(chat),
    el(
      'div',
      { class: 'chat-body' },
      el('div', { class: 'chat-row' },
        el('span', { class: 'chat-name' }, chat.name),
        el('span', { class: 'chat-time' }, listTime(chat.lastMessageAt))),
      el('div', { class: 'chat-row' },
        el('span', { class: 'chat-preview' }, previewNode(chat)),
        hasNew ? el('span', { class: 'badge-new', 'aria-label': `${chat.unreadCount} neue Nachrichten` }, chat.unreadCount > 99 ? '99+' : String(chat.unreadCount)) : null),
    ),
  );
  link.addEventListener('click', (e) => {
    // Keep history clean: route through the router instead of a raw hash jump.
    e.preventDefault();
    navigate(hrefChat(chat.id));
  });
  return el('li', null, link);
}

export function mountChatList(host: HTMLElement): () => void {
  const head = el('header', { class: 'pane-head' });
  const banner = el('div', { class: 'banner', role: 'status' });
  const chips = el('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filter' });
  const list = el('ul', { class: 'chat-list' });
  const empty = el('div', { class: 'empty' });
  const scroller = el('div', { class: 'scroll' }, chips, list, empty);
  host.append(head, banner, scroller);

  const renderHead = (): void => {
    const s = state.status.state;
    const chip = el('button', { class: `status-chip st-${s}`, type: 'button', title: 'Verbindungsstatus' },
      el('span', { class: 'dot' }), statusLabel(s));
    chip.addEventListener('click', () => navigate('#/connection'));
    clear(head);
    head.append(el('h1', null, 'Chats'), chip);
  };

  const renderBanner = (): void => {
    clear(banner);
    banner.hidden = state.online;
    if (!state.online) banner.append(icon('wifiOff', 16), 'Keine Verbindung zum waread-Server. Neuer Versuch läuft …');
  };

  const renderChips = (): void => {
    clear(chips);
    const chatsWithNew = [...state.chats.values()].filter((c) => c.unreadCount > 0).length;
    for (const f of FILTERS) {
      const b = el('button', { class: `chip${f.id === filter ? ' on' : ''}`, type: 'button', 'aria-pressed': f.id === filter ? 'true' : 'false' }, f.label);
      if (f.id === 'new' && chatsWithNew > 0) b.append(el('span', { class: 'chip-count' }, String(chatsWithNew)));
      b.addEventListener('click', () => { filter = f.id; savePref('chatFilter', f.id); renderAll(); });
      chips.append(b);
    }
  };

  const renderList = (): void => {
    const route = parseHash();
    const activeId = route.name === 'chat' ? route.chatId : null;
    const items = sortedChats().filter((c) => matches(c, filter));
    clear(list);
    for (const c of items) list.append(chatItem(c, activeId));

    clear(empty);
    empty.hidden = items.length > 0;
    if (items.length === 0) {
      if (state.chats.size === 0) {
        const connected = state.status.state === 'connected';
        append(empty, [
          el('p', null, connected ? 'Keine Nachrichten im Aufbewahrungszeitraum.' : 'Noch keine Chats. WhatsApp ist nicht verbunden.'),
          connected ? null : el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/connection') }, 'Verbindung öffnen'),
        ]);
      } else {
        empty.append(el('p', null, 'Keine Chats für diesen Filter.'));
      }
    }
  };

  const renderAll = (): void => { renderHead(); renderBanner(); renderChips(); renderList(); };
  const schedule = coalesce(renderAll);
  renderAll();

  const offs = [on('chats', schedule), on('status', schedule), on('online', schedule), onRoute(schedule)];
  return () => offs.forEach((off) => off());
}
