// Inline SVG icons. All markup below is static; no data ever flows into innerHTML.

import type { MessageType } from '../types';

const PATHS = {
  chats: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  // Gear (iOS convention for Settings). One path with the hub as a second subpath, so it can be filled (evenodd) when selected.
  settings: '<path d="M10.3 4.9L10.6 2.6A9.5 9.5 0 0 1 13.4 2.6L13.7 4.9A7.3 7.3 0 0 1 15.81 5.78L17.65 4.36A9.5 9.5 0 0 1 19.64 6.35L18.22 8.19A7.3 7.3 0 0 1 19.1 10.3L21.4 10.6A9.5 9.5 0 0 1 21.4 13.4L19.1 13.7A7.3 7.3 0 0 1 18.22 15.81L19.64 17.65A9.5 9.5 0 0 1 17.65 19.64L15.81 18.22A7.3 7.3 0 0 1 13.7 19.1L13.4 21.4A9.5 9.5 0 0 1 10.6 21.4L10.3 19.1A7.3 7.3 0 0 1 8.19 18.22L6.35 19.64A9.5 9.5 0 0 1 4.36 17.65L5.78 15.81A7.3 7.3 0 0 1 4.9 13.7L2.6 13.4A9.5 9.5 0 0 1 2.6 10.6L4.9 10.3A7.3 7.3 0 0 1 5.78 8.19L4.36 6.35A9.5 9.5 0 0 1 6.35 4.36L8.19 5.78A7.3 7.3 0 0 1 10.3 4.9ZM15.1 12A3.1 3.1 0 1 0 8.9 12A3.1 3.1 0 1 0 15.1 12Z"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  doc: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  video: '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3z"/>',
  sticker: '<path d="M5 4h14v10l-6 6H5z"/><path d="M19 14h-6v6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  checkAll: '<path d="m2.5 12.5 4 4L14 9M10 15.5l1 1L20 8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  group: '<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.5 14.6c2.4 0 4 1.2 4.5 3.9"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  wifiOff: '<path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-5.5-3M2 9a15 15 0 0 1 4.5-2.8M22 9a15 15 0 0 0-8-3.8"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  refresh: '<path d="M20 5v5h-5M4 19v-5h5M18.5 10A7 7 0 0 0 6 7.5M5.5 14A7 7 0 0 0 18 16.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  shield: '<path d="M12 3.5 19 6.5v5c0 4.4-2.9 8-7 9.5-4.1-1.5-7-5.1-7-9.5v-5z"/>',
  shieldCheck: '<path d="M12 3.5 19 6.5v5c0 4.4-2.9 8-7 9.5-4.1-1.5-7-5.1-7-9.5v-5z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M6 16.5V11a6 6 0 0 1 9.6-4.8M18 11v5.5l1.5 2H8M10 20.5a2 2 0 0 0 4 0M3 3l18 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  once: '<circle cx="12" cy="12" r="8.5"/><path d="m10.3 9.6 1.9-1.2V16"/>',
  cloudDown: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.2 3.9 3.9 0 0 1 17.6 18"/><path d="M12 11v8M9 16.2l3 3 3-3"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 12v7.5h14V12"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 20): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${PATHS[name]}</svg>`;
  return span;
}

export function typeIcon(type: MessageType): IconName | null {
  switch (type) {
    case 'audio': return 'mic';
    case 'document': return 'doc';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'sticker': return 'sticker';
    case 'other': return 'info';
    case 'text': return null;
  }
}
