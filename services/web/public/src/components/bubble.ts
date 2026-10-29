// Renders one message as a chat bubble. Everything is built with DOM APIs and
// textContent; message text never reaches innerHTML.

import { api } from '../api';
import { isNew } from '../store';
import type { MediaInfo, Message, QuotedRef } from '../types';
import { colorFor, el, formatBytes, formatTime, linkify } from '../util';
import { audioPlayer } from './audioPlayer';
import { icon, typeIcon } from './icons';

export interface BubbleCtx {
  isGroup: boolean;
  openImage(m: Message): void;
  jumpTo(id: string | undefined): void;
  /** Registers a cleanup that runs when this bubble is replaced or the chat closes. */
  track(cleanup: () => void): void;
}

function mediaStateText(media: MediaInfo | undefined): string | null {
  switch (media?.status) {
    case 'pending': return 'Medium wird geladen …';
    case 'failed': return 'Medium konnte nicht geladen werden';
    case 'skipped': return 'Medium wurde nicht geladen (Download-Regel)';
    case 'expired': return 'Medium nach Ablauf der Aufbewahrung gelöscht';
    default: return null;
  }
}

function placeholder(text: string, m: Message): HTMLElement {
  const box = el('div', { class: 'media-missing' }, icon(typeIcon(m.type) ?? 'info', 22), el('span', null, text));
  if (m.media?.width && m.media.height) box.style.aspectRatio = `${m.media.width} / ${m.media.height}`;
  return box;
}

function quoteBlock(q: QuotedRef, ctx: BubbleCtx): HTMLElement {
  const color = colorFor(q.senderName ?? (q.fromMe ? 'me' : 'quote'));
  const ic = q.type ? typeIcon(q.type) : null;
  const label = q.text || (q.type === 'audio' ? 'Sprachnachricht' : q.type === 'image' ? 'Foto' : q.type === 'video' ? 'Video' : q.type === 'document' ? 'Dokument' : 'Nachricht');
  const node = el('div', { class: `quote${q.id ? ' quote-link' : ''}`, role: q.id ? 'button' : null, tabindex: q.id ? '0' : null },
    el('span', { class: 'quote-name' }, q.fromMe ? 'Du' : q.senderName ?? 'Unbekannt'),
    el('span', { class: 'quote-text' }, ic ? icon(ic, 14) : null, label));
  node.style.setProperty('--q', color);
  if (q.id) {
    const go = (): void => ctx.jumpTo(q.id);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  return node;
}

function textNodes(text: string): HTMLElement {
  return el('p', { class: 'text' }, ...linkify(text));
}

function imageBlock(m: Message, ctx: BubbleCtx): HTMLElement {
  const state = mediaStateText(m.media);
  if (state) return placeholder(state, m);
  const w = m.media?.width;
  const h = m.media?.height;
  const box = el('button', { class: `photo${m.type === 'sticker' ? ' sticker' : ''}`, type: 'button', 'aria-label': 'Bild öffnen' });
  if (w && h) box.style.aspectRatio = `${w} / ${h}`;
  // The small thumbnail is enough in the chat; the lightbox loads the full image.
  const src = m.media?.hasThumbnail ? api.thumbUrl(m.id) : api.mediaUrl(m.id);
  const img = el('img', { src, alt: m.caption ?? '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => box.replaceWith(placeholder('Bild nicht verfügbar', m)), { once: true });
  box.append(img);
  if (m.type === 'image') box.addEventListener('click', () => ctx.openImage(m));
  return box;
}

function videoBlock(m: Message): HTMLElement {
  const state = mediaStateText(m.media);
  if (state) return placeholder(state, m);
  const v = el('video', { class: 'video', controls: true, playsinline: true, preload: 'metadata', src: api.mediaUrl(m.id) });
  if (m.media?.width && m.media.height) v.style.aspectRatio = `${m.media.width} / ${m.media.height}`;
  v.addEventListener('error', () => v.replaceWith(placeholder('Video nicht verfügbar', m)), { once: true });
  return v;
}

function documentTile(m: Message): HTMLElement {
  const media = m.media;
  // The API does not deliver the original file name; the caption is shown below the tile.
  const name = media?.fileName ?? 'Dokument';
  const parts: string[] = [];
  if (media?.pages) parts.push(`${media.pages} ${media.pages === 1 ? 'Seite' : 'Seiten'}`);
  if (media?.size !== undefined) parts.push(formatBytes(media.size));
  const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
  if (ext) parts.push(ext.toUpperCase());
  const state = mediaStateText(media);
  const tile = el('div', { class: 'doc' },
    el('div', { class: 'doc-icon' }, icon('doc', 26)),
    el('div', { class: 'doc-info' },
      el('span', { class: 'doc-name' }, name),
      el('span', { class: 'doc-sub' }, state ?? parts.join(' · '))));
  if (!state) {
    tile.append(el('a', { class: 'doc-dl', href: api.mediaUrl(m.id), download: name, 'aria-label': `${name} herunterladen` }, icon('download', 20)));
  }
  return tile;
}

export function buildBubble(m: Message, ctx: BubbleCtx): HTMLElement {
  const incoming = !m.fromMe;
  const row = el('div', { class: `msg-row ${incoming ? 'in' : 'out'}${isNew(m) ? ' is-new' : ''}`, 'data-id': m.id });
  const bubble = el('div', { class: 'bubble' });
  const meta = el('span', { class: 'meta' }, formatTime(m.waTimestamp));

  if (ctx.isGroup && incoming && m.senderName) {
    const s = el('span', { class: 'sender' }, m.senderName);
    s.style.color = colorFor(m.senderName);
    bubble.append(s);
  }
  if (m.quoted && !m.deleted) bubble.append(quoteBlock(m.quoted, ctx));

  const caption = m.caption ?? m.text;
  if (m.deleted) {
    bubble.append(el('p', { class: 'text deleted' }, icon('info', 14), 'Diese Nachricht wurde gelöscht', meta));
  } else {
    switch (m.type) {
      case 'image':
      case 'sticker':
      case 'video': {
        bubble.classList.add('has-media');
        bubble.append(m.type === 'video' ? videoBlock(m) : imageBlock(m, ctx));
        if (caption && m.type !== 'sticker') bubble.append(el('p', { class: 'text caption' }, ...linkify(caption), meta));
        else { bubble.classList.add('meta-overlay'); bubble.append(meta); }
        break;
      }
      case 'audio': {
        bubble.classList.add('has-voice');
        const state = mediaStateText(m.media);
        bubble.append(state ? placeholder(state, m) : audioPlayer(m, ctx.track), meta);
        break;
      }
      case 'document': {
        bubble.classList.add('has-doc');
        bubble.append(documentTile(m));
        if (m.caption) bubble.append(el('p', { class: 'text caption' }, ...linkify(m.caption)));
        bubble.append(meta);
        break;
      }
      case 'text':
      case 'other': {
        const body = m.text ?? '';
        if (body) { const p = textNodes(body); p.append(meta); bubble.append(p); }
        else bubble.append(el('p', { class: 'text deleted' }, icon('info', 14), 'Nicht unterstützter Nachrichtentyp', meta));
        break;
      }
    }
  }

  row.append(bubble);
  return row;
}
