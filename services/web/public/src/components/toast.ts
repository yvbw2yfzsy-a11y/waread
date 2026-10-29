// Minimal toast notifications (non-blocking, auto-hide).

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

export function toast(message: string, ms = 3500): void {
  const h = ensureHost();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  h.appendChild(t);
  window.setTimeout(() => {
    t.classList.add('out');
    window.setTimeout(() => t.remove(), 250);
  }, ms);
}
