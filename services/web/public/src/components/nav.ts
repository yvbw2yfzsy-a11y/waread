// Floating "glass" pill navigation with three tabs: Chats, Suche, Einstellungen.

import { navigate, onRoute, parseHash, tabHash, tabOf, type Tab } from '../router';
import { on, totalUnread } from '../store';
import { clear, coalesce, el } from '../util';
import { icon, type IconName } from './icons';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'search', label: 'Suche', icon: 'search' },
  { id: 'settings', label: 'Einstellungen', icon: 'settings' },
];

export function mountNav(host: HTMLElement): () => void {
  const nav = el('nav', { class: 'glass-nav', 'aria-label': 'Hauptnavigation' });
  host.append(nav);

  const render = (): void => {
    const active = tabOf(parseHash());
    const unread = totalUnread();
    clear(nav);
    for (const t of TABS) {
      const link = el('a', {
        class: `tab${t.id === active ? ' on' : ''}`,
        href: tabHash(t.id),
        'aria-current': t.id === active ? 'page' : null,
      }, icon(t.icon, 24), el('span', { class: 'tab-label' }, t.label));
      if (t.id === 'chats' && unread > 0) {
        link.append(el('span', { class: 'badge-new tab-badge', 'aria-label': `${unread} neue Nachrichten` }, unread > 99 ? '99+' : String(unread)));
      }
      link.addEventListener('click', (e) => { e.preventDefault(); navigate(tabHash(t.id)); });
      nav.append(link);
    }
  };

  const schedule = coalesce(render);
  render();
  const offs = [onRoute(schedule), on('chats', schedule)];
  return () => { offs.forEach((off) => off()); nav.remove(); };
}
