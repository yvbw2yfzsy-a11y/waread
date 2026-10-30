// Hash router. Hash URLs need no server-side rewrite rules in Nginx.
//   #/chats                  chat list
//   #/chats/<id>[?msg=<id>]  chat, optionally jumping to a message
//   #/search  #/settings  #/connection

export type Tab = 'chats' | 'search' | 'settings';

export type Route =
  | { name: 'chats' }
  | { name: 'chat'; chatId: string; msgId?: string }
  | { name: 'search' }
  | { name: 'settings' }
  | { name: 'connection' };

const listeners = new Set<(r: Route) => void>();
let lastTab: Tab = 'chats';

export function parseHash(hash: string = location.hash): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case 'chats': {
      const id = parts[1];
      if (!id) return { name: 'chats' };
      const msg = q.get('msg');
      return msg ? { name: 'chat', chatId: id, msgId: msg } : { name: 'chat', chatId: id };
    }
    case 'search': return { name: 'search' };
    case 'settings': return { name: 'settings' };
    case 'connection': return { name: 'connection' };
    default: return { name: 'chats' };
  }
}

export function hrefChat(chatId: string, msgId?: string): string {
  const base = `#/chats/${encodeURIComponent(chatId)}`;
  return msgId ? `${base}?msg=${encodeURIComponent(msgId)}` : base;
}

export function tabOf(route: Route): Tab {
  switch (route.name) {
    case 'search': lastTab = 'search'; return 'search';
    case 'settings': case 'connection': lastTab = 'settings'; return 'settings';
    case 'chats': lastTab = 'chats'; return 'chats';
    case 'chat': return lastTab;
  }
}

export function tabHash(tab: Tab): string {
  return `#/${tab}`;
}

function depth(): number {
  const s = history.state as { depth?: number } | null;
  return s?.depth ?? 0;
}

function notify(): void {
  const r = parseHash();
  listeners.forEach((fn) => fn(r));
}

export function navigate(hash: string): void {
  if (location.hash === hash) { notify(); return; }
  history.pushState({ depth: depth() + 1 }, '', hash);
  notify();
}

/** Back inside the app if there is an app entry to return to, otherwise go to the tab root. */
export function goBack(): void {
  if (depth() > 0) { history.back(); return; }
  history.replaceState({ depth: 0 }, '', tabHash(lastTab));
  notify();
}

export function onRoute(fn: (r: Route) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let started = false;

/** Idempotent: safe to call again after a re-login. */
export function startRouter(): void {
  if (!started) {
    started = true;
    history.replaceState({ depth: depth() }, '', location.hash || '#/chats');
    window.addEventListener('popstate', notify);
  }
  notify();
}
