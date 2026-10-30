// Edit history of a message: every earlier version with the time it was replaced, and the current one.

import { api } from '../api';
import type { Message, MessageVersions } from '../types';
import { clear, el, formatDateTime, richNodes } from '../util';
import { modalHeader, openModal } from './dialog';

export function openVersions(m: Message): void {
  const body = el('div', { class: 'modal-body' });
  const handle = openModal(el('div', null), { label: 'Bearbeitungsverlauf', sheet: true });
  const render = (data: MessageVersions | null, error: boolean): void => {
    clear(handle.panel);
    const content = el('div', null, modalHeader('Bearbeitungsverlauf', () => handle.close(), 'Alle Fassungen dieser Nachricht, die waread gespeichert hat.'), body);
    handle.panel.append(content);
    clear(body);
    if (error) {
      const retry = el('button', { class: 'btn', type: 'button' }, 'Erneut versuchen');
      retry.addEventListener('click', () => { void load(); });
      body.append(el('p', { class: 'muted' }, 'Der Verlauf konnte nicht geladen werden.'), el('div', { class: 'actions' }, retry));
      return;
    }
    if (!data) { body.append(el('p', { class: 'muted' }, el('span', { class: 'spinner' }), 'Lade …')); return; }
    const list = el('ol', { class: 'versions' });
    for (const v of data.versions) {
      list.append(el('li', { class: 'version' },
        el('div', { class: 'version-head' },
          el('strong', null, v.version === 1 ? 'Original' : `Fassung ${v.version}`),
          el('span', { class: 'muted small' }, `ersetzt ${formatDateTime(v.replacedAt)}`)),
        el('p', { class: 'version-text' }, ...(v.text ? richNodes(v.text) : [el('em', { class: 'muted' }, 'ohne Text')]))));
    }
    list.append(el('li', { class: 'version current' },
      el('div', { class: 'version-head' },
        el('strong', null, 'Aktuell'),
        el('span', { class: 'muted small' }, data.current.editedAt ? `bearbeitet ${formatDateTime(data.current.editedAt)}` : '')),
      el('p', { class: 'version-text' }, ...(data.current.text ? richNodes(data.current.text) : [el('em', { class: 'muted' }, 'ohne Text')]))));
    body.append(list);
  };
  const load = async (): Promise<void> => {
    render(null, false);
    try { render(await api.versions(m.id), false); } catch { render(null, true); }
  };
  void load();
}
