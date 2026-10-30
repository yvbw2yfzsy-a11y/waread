// App shell: login gate, two-pane layout, routing and live-update wiring.
//
// Mobile shows one pane at a time (list OR chat). From the CSS breakpoint on
// (see styles.css) both panes are visible: list/search/settings left, chat right.

import { api, setUnauthorizedHandler } from './api';
import { mountChatList } from './components/chatList';
import { mountChatView } from './components/chatView';
import { mountConnectionView } from './components/connectionView';
import { icon } from './components/icons';
import { showLogin } from './components/loginView';
import { mountNav } from './components/nav';
import { mountSearchView } from './components/searchView';
import { mountSettingsView } from './components/settingsView';
import { onRoute, parseHash, startRouter, tabOf, type Route } from './router';
import { startEvents } from './sse';
import {
  dataChanged, loadChats, loadSettings, loadStatus, on, onMediaReady, onMessageUpdated, onNewMessage, refreshChatsSoon,
  refreshAll, resetAll, setOnline, setStatus, totalUnread,
} from './store';
import { clear, el } from './util';

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('#app fehlt in index.html');
const root: HTMLElement = rootEl;

let session: { teardown: () => void } | null = null;
let loginShown = false;

function teardown(): void {
  session?.teardown();
  session = null;
}

function showLoginScreen(): void {
  if (loginShown) return;
  loginShown = true;
  teardown();
  resetAll();
  showLogin(root, () => { loginShown = false; void boot(); });
}

function showBootError(): void {
  clear(root);
  root.append(el('div', { class: 'login-wrap' }, el('div', { class: 'login-card' },
    el('h1', null, 'waread'),
    el('p', { class: 'muted' }, 'Der Server ist nicht erreichbar.'),
    el('button', { class: 'btn primary', type: 'button', onclick: () => { void boot(); } }, 'Erneut versuchen'))));
}

function mountLeft(key: string, host: HTMLElement): () => void {
  switch (key) {
    case 'search': return mountSearchView(host);
    case 'settings': return mountSettingsView(host, showLoginScreen);
    case 'connection': return mountConnectionView(host);
    default: return mountChatList(host);
  }
}

function placeholder(): HTMLElement {
  return el('div', { class: 'placeholder' },
    icon('chats', 56),
    el('p', null, 'Chat auswählen'),
    el('p', { class: 'muted small' }, 'Nur lesen. Antworten in WhatsApp.'));
}

function startApp(): void {
  clear(root);
  const left = el('aside', { class: 'pane-left' });
  const leftHost = el('div', { class: 'left-host' });
  const right = el('main', { class: 'pane-right' });
  const shell = el('div', { class: 'shell' }, left, right);
  left.append(leftHost);
  root.append(shell);
  const unmountNav = mountNav(left);

  let leftKey = '';
  let leftCleanup: (() => void) | null = null;
  // Sentinel, so the very first render mounts the placeholder even on a non-chat route.
  let rightKey = '\u0001';
  let rightCleanup: (() => void) | null = null;

  const render = (route: Route): void => {
    const tab = tabOf(route);
    const nextLeft = route.name === 'connection' ? 'connection' : tab;
    if (nextLeft !== leftKey) {
      leftCleanup?.();
      leftHost.replaceChildren();
      leftKey = nextLeft;
      leftCleanup = mountLeft(nextLeft, leftHost);
    }
    const nextRight = route.name === 'chat' ? `${route.chatId}|${route.msgId ?? ''}` : '';
    if (nextRight !== rightKey) {
      rightCleanup?.();
      rightCleanup = null;
      right.replaceChildren();
      rightKey = nextRight;
      if (route.name === 'chat') rightCleanup = mountChatView(right, route.chatId, route.msgId);
      else right.append(placeholder());
    }
    shell.classList.toggle('chat-open', route.name === 'chat');
  };

  const stopEvents = startEvents({
    onNewMessage,
    onMessageUpdated,
    onMediaReady,
    onConnectionStatus: setStatus,
    onCleanupDone: (u) => {
      if (u.deletedMessages > 0 || u.deletedMedia > 0) { dataChanged(); void loadChats(); }
    },
    onHistorySynced: () => refreshChatsSoon(),
    onOpen: () => { setOnline(true); void refreshAll(); },
    onDown: () => {
      setOnline(false);
      // Also surfaces an expired session: a 401 here triggers the login screen.
      void api.status().then(setStatus, () => undefined);
    },
  });

  const offs = [
    onRoute(render),
    on('reset', () => { rightKey = '\u0000'; render(parseHash()); }),
    on('chats', () => { const n = totalUnread(); document.title = n > 0 ? `(${n}) waread` : 'waread'; }),
  ];

  session = {
    teardown: () => {
      stopEvents();
      offs.forEach((off) => off());
      leftCleanup?.();
      rightCleanup?.();
      unmountNav();
    },
  };

  startRouter();
}

async function boot(): Promise<void> {
  clear(root);
  root.append(el('div', { class: 'boot' }, el('span', { class: 'spinner' }), 'Lade …'));
  const [status, chats] = await Promise.allSettled([loadStatus(), loadChats(), loadSettings()]);
  // A 401 during these calls already switched to the login screen.
  if (loginShown) return;
  if (status.status === 'rejected' && chats.status === 'rejected') { showBootError(); return; }
  startApp();
}

setUnauthorizedHandler(showLoginScreen);
void boot();
