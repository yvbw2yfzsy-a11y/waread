// Round avatar. The ingest service stores no profile pictures, so the
// default is initials on a colour derived from the chat id. If a chat carries
// an avatarUrl it is used, with the initials as fallback on load errors.
// Styles are set through the CSSOM (not style="..." attributes) so a strict
// Content-Security-Policy without 'unsafe-inline' keeps working.

import { colorFor, el, initials } from '../util';
import { icon } from './icons';

export interface AvatarSubject {
  id: string;
  name: string;
  isGroup: boolean;
  avatarUrl?: string;
}

export function avatar(subject: AvatarSubject, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const node = el('div', { class: `avatar avatar-${size}`, 'aria-hidden': 'true' });
  node.style.background = colorFor(subject.id);

  const fallback = (): void => {
    node.textContent = '';
    if (subject.isGroup) node.appendChild(icon('group', size === 'lg' ? 28 : size === 'sm' ? 16 : 22));
    else node.appendChild(document.createTextNode(initials(subject.name)));
  };

  if (subject.avatarUrl) {
    const img = el('img', { src: subject.avatarUrl, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', fallback, { once: true });
    node.appendChild(img);
  } else {
    fallback();
  }
  return node;
}
