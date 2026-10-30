// Search with filters (chat, type, date range, only new). A hit opens its chat
// at that message and highlights it (route #/chats/<id>?msg=<id>).

import { api } from '../api';
import { hrefChat, navigate } from '../router';
import { isNew, on, sortedChats, state } from '../store';
import type { Message, SearchFilters, SearchHit, SearchType } from '../types';
import { append, clear, debounce, el, formatDuration, highlight, listTime } from '../util';
import { avatar } from './avatar';
import { icon, typeIcon } from './icons';

const TYPES: { value: SearchType; label: string }[] = [
  { value: '', label: 'Alle Typen' },
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'Fotos' },
  { value: 'audio', label: 'Sprachnachrichten' },
  { value: 'video', label: 'Videos' },
  { value: 'document', label: 'Dokumente' },
];

// Kept at module level so the form and results survive tab switches.
let filters: SearchFilters = { q: '', chatId: '', type: '', from: '', to: '', onlyNew: false };
let lastHits: SearchHit[] | null = null;
let lastQuery = '';

const hasCriteria = (f: SearchFilters): boolean =>
  !!(f.q.trim() || f.chatId || f.type || f.from || f.to || f.onlyNew);

function snippetOf(m: Message, q: string): string {
  if (m.deleted) return 'Gelöschte Nachricht';
  const text = m.caption ?? m.text ?? '';
  if (!text) {
    switch (m.type) {
      case 'audio': return `Sprachnachricht ${formatDuration(m.media?.durationSec)}`;
      case 'document': return m.media?.fileName ?? 'Dokument';
      case 'image': return 'Foto';
      case 'video': return 'Video';
      default: return 'Nachricht';
    }
  }
  const needle = q.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  const start = at > 40 ? at - 30 : 0;
  const cut = text.slice(start, start + 160);
  return `${start > 0 ? '…' : ''}${cut}${start + 160 < text.length ? '…' : ''}`;
}

export function mountSearchView(host: HTMLElement): () => void {
  const head = el('header', { class: 'pane-head' }, el('h1', null, 'Suche'));

  const q = el('input', { class: 'field search-input', type: 'search', placeholder: 'Nachrichten durchsuchen', 'aria-label': 'Suchbegriff', enterkeyhint: 'search', autocomplete: 'off', value: filters.q });
  const chatSel = el('select', { class: 'field', 'aria-label': 'Chat' });
  const typeSel = el('select', { class: 'field', 'aria-label': 'Nachrichtentyp' },
    ...TYPES.map((t) => el('option', { value: t.value, selected: t.value === filters.type }, t.label)));
  const from = el('input', { class: 'field', type: 'date', 'aria-label': 'Von', value: filters.from });
  const to = el('input', { class: 'field', type: 'date', 'aria-label': 'Bis', value: filters.to });
  const onlyNew = el('input', { type: 'checkbox', checked: filters.onlyNew });
  const results = el('div', { class: 'results', 'aria-live': 'polite' });

  const form = el('form', { class: 'search-form', role: 'search' },
    el('div', { class: 'search-box' }, icon('search', 18), q),
    el('div', { class: 'filter-grid' },
      el('label', null, el('span', null, 'Chat'), chatSel),
      el('label', null, el('span', null, 'Typ'), typeSel),
      el('label', null, el('span', null, 'Von'), from),
      el('label', null, el('span', null, 'Bis'), to)),
    el('label', { class: 'switch-row' }, onlyNew, el('span', null, 'Nur neue (ungesehene) Nachrichten')));

  host.append(head, el('div', { class: 'scroll' }, form, results));

  const fillChats = (): void => {
    clear(chatSel);
    chatSel.append(el('option', { value: '' }, 'Alle Chats'));
    for (const c of sortedChats()) chatSel.append(el('option', { value: c.id, selected: c.id === filters.chatId }, c.name));
    chatSel.value = filters.chatId;
  };

  let requestNo = 0;

  const renderHits = (hits: SearchHit[], query: string): void => {
    clear(results);
    if (hits.length === 0) { results.append(el('p', { class: 'muted center' }, 'Keine Treffer.')); return; }
    results.append(el('p', { class: 'muted small count' }, `${hits.length} Treffer`));
    const list = el('ul', { class: 'chat-list' });
    for (const h of hits) {
      const m = h.message;
      const chat = state.chats.get(m.chatId);
      const name = h.chatName ?? chat?.name ?? m.chatId;
      const ic = typeIcon(m.type);
      const link = el('a', { class: 'chat-item hit', href: hrefChat(m.chatId, m.id) },
        avatar({ id: m.chatId, name, isGroup: chat?.isGroup ?? false, ...(chat?.avatarUrl ? { avatarUrl: chat.avatarUrl } : {}) }),
        el('div', { class: 'chat-body' },
          el('div', { class: 'chat-row' }, el('span', { class: 'chat-name' }, name), el('span', { class: 'chat-time' }, listTime(m.waTimestamp))),
          el('div', { class: 'chat-row' },
            el('span', { class: 'chat-preview wrap' },
              m.fromMe ? 'Du: ' : m.senderName ? `${m.senderName}: ` : '',
              ic ? icon(ic, 15) : null,
              ...highlight(snippetOf(m, query), query)),
            isNew(m) ? el('span', { class: 'dot-new', title: 'Neu' }) : null)));
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(hrefChat(m.chatId, m.id)); });
      list.append(el('li', null, link));
    }
    results.append(list);
  };

  const run = async (): Promise<void> => {
    if (!hasCriteria(filters)) { lastHits = null; clear(results); results.append(el('p', { class: 'muted center' }, 'Suchbegriff eingeben oder einen Filter setzen.')); return; }
    const no = ++requestNo;
    clear(results);
    results.append(el('p', { class: 'muted center' }, el('span', { class: 'spinner' }), 'Suche läuft …'));
    try {
      const hits = await api.search(filters);
      if (no !== requestNo) return;
      lastHits = hits;
      lastQuery = filters.q;
      renderHits(hits, filters.q);
    } catch {
      if (no !== requestNo) return;
      clear(results);
      append(results, [el('p', { class: 'muted center' }, 'Suche fehlgeschlagen.'), el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => { void run(); } }, 'Erneut versuchen'))]);
    }
  };

  const runSoon = debounce(() => { void run(); }, 350);

  const readForm = (): void => {
    filters = { q: q.value, chatId: chatSel.value, type: typeSel.value as SearchType, from: from.value, to: to.value, onlyNew: onlyNew.checked };
  };
  q.addEventListener('input', () => { readForm(); runSoon(); });
  for (const control of [chatSel, typeSel, from, to, onlyNew]) control.addEventListener('change', () => { readForm(); void run(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); readForm(); void run(); q.blur(); });

  fillChats();
  if (lastHits) renderHits(lastHits, lastQuery);
  else void run();

  const off = on('chats', () => { const keep = chatSel.value; fillChats(); chatSel.value = keep; });
  return () => { off(); requestNo++; host.replaceChildren(); };
}
