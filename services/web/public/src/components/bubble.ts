// Renders one message as a chat bubble. Everything is built with DOM APIs and
// textContent; message text never reaches innerHTML.
//
// Marks are labels, not colours: "Vom Absender gelöscht", "Einmal-Foto", "bearbeitet" and the shield all carry a
// text or an accessible name. Tapping the bubble (outside links, buttons, players and the quote) opens the action sheet.

import { api } from '../api';
import { isNew, loadMedia } from '../store';
import type { Message, MessageType, QuotedRef } from '../types';
import { colorFor, el, formatBytes, formatTime, richNodes } from '../util';
import { audioPlayer } from './audioPlayer';
import { icon, typeIcon } from './icons';

export interface BubbleCtx {
  isGroup: boolean;
  openImage(m: Message): void;
  jumpTo(id: string | undefined): void;
  /** Registers a cleanup that runs when this bubble is replaced or the chat closes. */
  track(cleanup: () => void): void;
  /** Opens the action sheet (shield, save, load now, edit history). */
  openSheet(m: Message): void;
  showVersions(m: Message): void;
}

/** Name of the thing a message carries, for placeholders and labels. */
function noun(type: MessageType | undefined): string {
  switch (type) {
    case 'image': case 'sticker': return 'Foto';
    case 'audio': return 'Sprachnachricht';
    case 'video': return 'Video';
    case 'document': return 'Dokument';
    default: return 'Nachricht';
  }
}

/**
 * The API stores stickers as images. WhatsApp sends them as WebP without a caption, ordinary photos as JPEG, so a
 * captionless WebP image is shown as a sticker (small, transparent). A heuristic: a WebP photo would look like a sticker.
 */
export function isSticker(m: Message): boolean {
  return m.type === 'sticker' || (m.type === 'image' && m.media?.mimeType === 'image/webp' && !m.caption && !m.text);
}

/** Why there is no file, in words. null = the file is there (or nothing is known to be missing). */
function mediaNote(m: Message): { text: string; busy: boolean } | null {
  const media = m.media;
  if (!media) return m.deleted && m.type !== 'text' && m.type !== 'other' ? { text: 'Inhalt wird nicht angezeigt', busy: false } : null;
  switch (media.status) {
    case 'pending': return { text: 'Wird geladen …', busy: true };
    case 'failed':
      return { text: media.skipReason === 'too_large' ? 'Zu groß, nicht geladen' : 'Konnte nicht geladen werden', busy: false };
    case 'skipped': return { text: 'Nicht geladen (Download-Regel)', busy: false };
    case 'expired':
      switch (media.skipReason) {
        case 'rule_off': return { text: 'Nicht geladen (Download-Regel „Aus“)', busy: false };
        case 'history': return { text: 'Nicht geladen (Verlauf von vor der Kopplung)', busy: false };
        case 'retention': return { text: 'Nach Ablauf der Aufbewahrung gelöscht', busy: false };
        case 'link_expired': return { text: 'Bei WhatsApp nicht mehr verfügbar', busy: false };
        default: return { text: 'Datei nicht (mehr) gespeichert', busy: false };
      }
    default: return null;
  }
}

function loadButton(m: Message): HTMLElement {
  const b = el('button', { class: 'btn small-btn', type: 'button' }, icon('cloudDown', 16), 'Jetzt laden');
  b.addEventListener('click', () => { b.disabled = true; void loadMedia(m); });
  return b;
}

function placeholder(m: Message, note: { text: string; busy: boolean }): HTMLElement {
  const size = m.media?.size !== undefined ? ` · ${formatBytes(m.media.size)}` : '';
  const lead = note.busy ? el('span', { class: 'spinner' }) : icon(typeIcon(m.type) ?? 'info', 22);
  const box = el('div', { class: 'media-missing' }, lead,
    el('div', { class: 'media-missing-text' }, el('strong', null, `${noun(m.type)}${size}`), el('span', null, note.text)));
  if (m.media?.loadable && !note.busy) box.append(loadButton(m));
  if (m.media?.width && m.media.height) box.style.aspectRatio = `${m.media.width} / ${m.media.height}`;
  return box;
}

function failedPlaceholder(m: Message, text: string): HTMLElement {
  return placeholder(m, { text, busy: false });
}

function quoteBlock(q: QuotedRef, ctx: BubbleCtx): HTMLElement {
  const known = !!(q.senderName || q.text || q.type || q.fromMe);
  const color = colorFor(q.senderName ?? (q.fromMe ? 'me' : 'quote'));
  const ic = q.type ? typeIcon(q.type) : null;
  const typeLabel = q.type && q.type !== 'text' ? noun(q.type) : '';
  const label = q.deleted
    ? 'Gelöschte Nachricht'
    : q.text || typeLabel || (known ? 'Nachricht' : 'Ursprüngliche Nachricht nicht mehr gespeichert');
  const name = q.fromMe ? 'Du' : q.senderName ?? (q.available || known ? 'Unbekannt' : '');
  const linkable = !!q.id && q.available !== false;
  const node = el('div', { class: `quote${linkable ? ' quote-link' : ''}`, role: linkable ? 'button' : null, tabindex: linkable ? '0' : null },
    name ? el('span', { class: 'quote-name' }, name) : null,
    el('span', { class: `quote-text${known ? '' : ' muted'}` }, ic && !q.deleted ? icon(ic, 14) : null, label));
  node.style.setProperty('--q', color);
  if (linkable) {
    const go = (): void => ctx.jumpTo(q.id);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  return node;
}

function textNodes(text: string): HTMLElement {
  return el('p', { class: 'text' }, ...richNodes(text));
}

function imageBlock(m: Message, ctx: BubbleCtx): HTMLElement {
  const note = mediaNote(m);
  if (note) return placeholder(m, note);
  const w = m.media?.width;
  const h = m.media?.height;
  const sticker = isSticker(m);
  const box = el('button', { class: `photo${sticker ? ' sticker' : ''}`, type: 'button', 'aria-label': sticker ? 'Sticker öffnen' : 'Bild öffnen' });
  if (w && h) box.style.aspectRatio = `${w} / ${h}`;
  // The small thumbnail is enough in the chat; the lightbox loads the full image.
  const src = m.media?.hasThumbnail && !sticker ? api.thumbUrl(m.id) : api.mediaUrl(m.id);
  const img = el('img', { src, alt: m.caption ?? '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => box.replaceWith(failedPlaceholder(m, 'Bild nicht verfügbar')), { once: true });
  box.append(img);
  box.addEventListener('click', () => ctx.openImage(m));
  return box;
}

function videoBlock(m: Message): HTMLElement {
  const note = mediaNote(m);
  if (note) return placeholder(m, note);
  const v = el('video', { class: 'video', controls: true, playsinline: true, preload: 'metadata', src: api.mediaUrl(m.id) });
  if (m.media?.width && m.media.height) v.style.aspectRatio = `${m.media.width} / ${m.media.height}`;
  v.addEventListener('error', () => v.replaceWith(failedPlaceholder(m, 'Video nicht verfügbar')), { once: true });
  return v;
}

function documentTile(m: Message): HTMLElement {
  const media = m.media;
  // The file name comes from the server (the part after "<id>__" of the stored file); "Dokument" only if it is unknown.
  const name = media?.fileName ?? 'Dokument';
  const parts: string[] = [];
  if (media?.pages) parts.push(`${media.pages} ${media.pages === 1 ? 'Seite' : 'Seiten'}`);
  if (media?.size !== undefined) parts.push(formatBytes(media.size));
  const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
  if (ext) parts.push(ext.toUpperCase());
  const note = mediaNote(m);
  const tile = el('div', { class: 'doc' },
    el('div', { class: 'doc-icon' }, icon('doc', 26)),
    el('div', { class: 'doc-info' },
      el('span', { class: 'doc-name' }, name),
      el('span', { class: 'doc-sub' }, note ? note.text : parts.join(' · '))));
  if (!note) {
    tile.append(el('a', { class: 'doc-dl', href: api.mediaUrl(m.id), download: name, 'aria-label': `${name} herunterladen` }, icon('download', 20)));
  } else if (media?.loadable && !note.busy) {
    tile.append(loadButton(m));
  }
  return tile;
}

function tag(ic: Parameters<typeof icon>[0], text: string, cls = ''): HTMLElement {
  return el('div', { class: `tag${cls ? ` ${cls}` : ''}` }, icon(ic, 14), el('span', null, text));
}

export function buildBubble(m: Message, ctx: BubbleCtx): HTMLElement {
  const incoming = !m.fromMe;
  const edited = m.edited === true || (m.editCount ?? 0) > 0;
  const row = el('div', {
    class: `msg-row ${incoming ? 'in' : 'out'}${isNew(m) ? ' is-new' : ''}${m.deleted ? ' is-deleted' : ''}${m.protectedAt ? ' is-protected' : ''}`,
    'data-id': m.id,
  });
  const bubble = el('div', { class: 'bubble', tabindex: '0' });

  // Time, shield and "bearbeitet" sit bottom right. The edit mark is a real button (opens the version list).
  const meta = el('span', { class: 'meta' });
  if (m.protectedAt) meta.append(el('span', { class: 'meta-shield', role: 'img', 'aria-label': 'Mit Schild geschützt', title: 'Mit Schild geschützt' }, icon('shieldCheck', 13)));
  if (edited) {
    const eb = el('button', { class: 'meta-edit', type: 'button', 'aria-label': 'Bearbeitungsverlauf anzeigen' }, 'bearbeitet');
    eb.addEventListener('click', () => ctx.showVersions(m));
    meta.append(eb);
  }
  meta.append(formatTime(m.waTimestamp));

  if (ctx.isGroup && incoming && m.senderName) {
    const s = el('span', { class: 'sender' }, m.senderName);
    s.style.color = colorFor(m.senderName);
    bubble.append(s);
  }
  if (m.deleted) bubble.append(tag('trash', m.deletedAt ? `Vom Absender gelöscht · ${formatTime(m.deletedAt)}` : 'Vom Absender gelöscht', 'tag-deleted'));
  if (m.viewOnce && m.type !== 'other') bubble.append(tag('once', `Einmal-${noun(m.type)}`, 'tag-once'));
  if (m.quoted) bubble.append(quoteBlock(m.quoted, ctx));

  const caption = m.caption ?? m.text;
  switch (m.type) {
    case 'image':
    case 'sticker':
    case 'video': {
      bubble.classList.add('has-media');
      const block = m.type === 'video' ? videoBlock(m) : imageBlock(m, ctx);
      bubble.append(block);
      if (isSticker(m) && !caption) bubble.classList.add('is-sticker');
      if (caption) bubble.append(el('p', { class: 'text caption' }, ...richNodes(caption), meta));
      else { bubble.classList.add('meta-overlay'); bubble.append(meta); }
      break;
    }
    case 'audio': {
      bubble.classList.add('has-voice');
      const note = mediaNote(m);
      bubble.append(note ? placeholder(m, note) : audioPlayer(m, ctx.track), meta);
      break;
    }
    case 'document': {
      bubble.classList.add('has-doc');
      bubble.append(documentTile(m));
      if (m.caption) bubble.append(el('p', { class: 'text caption' }, ...richNodes(m.caption)));
      bubble.append(meta);
      break;
    }
    case 'text':
    case 'other': {
      const body = m.text ?? '';
      if (body) { const p = textNodes(body); p.append(meta); bubble.append(p); }
      else if (m.deleted) bubble.append(el('p', { class: 'text deleted-body' }, el('em', { class: 'muted' }, 'Der Text wird nicht angezeigt.'), meta));
      else bubble.append(el('p', { class: 'text deleted' }, icon('info', 14), 'Nicht unterstützter Nachrichtentyp', meta));
      break;
    }
  }

  // A tap on the bubble opens the action sheet, unless it hit something interactive or the user is selecting text.
  const interactive = 'a, button, video, audio, input, select, .wave, .quote-link';
  bubble.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target?.closest(interactive)) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    ctx.openSheet(m);
  });
  bubble.addEventListener('keydown', (e) => {
    if (e.target === bubble && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.openSheet(m); }
  });

  row.append(bubble);
  return row;
}

