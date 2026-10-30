// Action sheet for one message: shield on/off, save, "load now", edit history. Opens when a bubble is tapped.
// Everything here only touches the waread server and this device; nothing is sent to WhatsApp.

import { loadMedia, setProtected } from '../store';
import type { Message } from '../types';
import { el, formatBytes, formatDateTime } from '../util';
import { modalHeader, openModal } from './dialog';
import { icon, type IconName } from './icons';
import { saveMedia } from './saveMedia';
import { openVersions } from './versionsDialog';

function kindLabel(m: Message): string {
  switch (m.type) {
    case 'image': return m.viewOnce ? 'Einmal-Foto' : 'Foto';
    case 'video': return m.viewOnce ? 'Einmal-Video' : 'Video';
    case 'audio': return m.viewOnce ? 'Einmal-Sprachnachricht' : 'Sprachnachricht';
    case 'document': return 'Dokument';
    default: return 'Nachricht';
  }
}

export function openMessageSheet(m: Message): void {
  const ready = !!m.media && (!m.media.status || m.media.status === 'ready');
  const hasFile = m.type === 'image' || m.type === 'audio' || m.type === 'video' || m.type === 'document';

  const handle = openModal(el('div', null), { label: 'Nachricht', sheet: true });
  const item = (ic: IconName, title: string, hint: string, run: () => void, cls = ''): HTMLElement => {
    const b = el('button', { class: `sheet-item${cls ? ` ${cls}` : ''}`, type: 'button' },
      icon(ic, 22), el('span', { class: 'sheet-text' }, el('strong', null, title), el('small', null, hint)));
    b.addEventListener('click', () => { handle.close(); run(); });
    return b;
  };

  const items: HTMLElement[] = [];
  const isProtected = m.protectedAt !== null && m.protectedAt !== undefined;
  items.push(isProtected
    ? item('shield', 'Schutz aufheben', 'Die Nachricht wird nach der Aufbewahrungszeit wieder automatisch gelöscht.', () => { void setProtected(m, false); })
    : item('shieldCheck', 'Mit Schild schützen', 'Wird nicht automatisch gelöscht, auch nicht nach der Aufbewahrungszeit.', () => { void setProtected(m, true); }, 'sheet-protect'));
  if (hasFile && ready) items.push(item('share', 'Auf dem Gerät sichern', 'Foto, Datei oder Sprachnachricht auf dieses Gerät kopieren.', () => { void saveMedia(m); }));
  if (hasFile && m.media?.loadable) {
    const size = m.media.size !== undefined ? ` (${formatBytes(m.media.size)})` : '';
    items.push(item('cloudDown', `${kindLabel(m)} jetzt laden${size}`, 'Holt die Datei einmalig vom WhatsApp-Medienserver (ein Abruf, es wird keine Nachricht gesendet).', () => { void loadMedia(m); }));
  }
  if (m.edited || (m.editCount ?? 0) > 0) {
    items.push(item('history', 'Bearbeitungen ansehen', m.editCount ? `${m.editCount} frühere ${m.editCount === 1 ? 'Fassung' : 'Fassungen'}` : 'Frühere Fassungen anzeigen', () => openVersions(m)));
  }

  const when = formatDateTime(m.waTimestamp);
  const who = m.fromMe ? 'Du' : m.senderName ?? 'Unbekannt';
  const notes: HTMLElement[] = [];
  if (m.deleted) notes.push(el('p', { class: 'muted small' }, `Vom Absender gelöscht${m.deletedAt ? ` (${formatDateTime(m.deletedAt)})` : ''}. waread zeigt die Nachricht weiter an.`));
  if (m.viewOnce) notes.push(el('p', { class: 'muted small' }, 'Einmal-Nachricht: Der Absender wollte, dass sie nur einmal angesehen wird. Hier bleibt sie ansehbar, solange sie gespeichert ist.'));
  if (isProtected && m.protectedAt) notes.push(el('p', { class: 'muted small' }, `Geschützt seit ${formatDateTime(m.protectedAt)}.`));

  handle.panel.replaceChildren(
    modalHeader(kindLabel(m), () => handle.close(), `${who} · ${when}`),
    el('div', { class: 'modal-body' }, ...notes, el('div', { class: 'sheet-list' }, ...items)),
  );
  (handle.panel.querySelector('.sheet-item') as HTMLElement | null)?.focus();
}
