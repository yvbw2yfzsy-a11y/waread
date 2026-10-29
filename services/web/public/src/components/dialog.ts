// Modal dialog / bottom sheet shell. No inline styles (CSP): everything is classes. Escape and a tap on the backdrop
// close it, focus moves into the dialog and returns to the previous element afterwards, the page behind does not scroll.

import { el } from '../util';

export interface ModalHandle {
  close(): void;
  /** The panel element, so callers can fill or replace its content later. */
  panel: HTMLElement;
}

let open: ModalHandle | null = null;

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.hidden);
}

/**
 * Opens `content` in a modal. `sheet` slides up from the bottom (phones); otherwise it is centered.
 * `label` is the accessible name. Only one modal is open at a time: opening another closes the first.
 */
export function openModal(content: HTMLElement, opts: { label: string; sheet?: boolean; onClose?: () => void }): ModalHandle {
  open?.close();
  const restore = document.activeElement as HTMLElement | null;
  const panel = el('div', { class: `modal-panel${opts.sheet ? ' sheet' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.label }, content);
  const backdrop = el('div', { class: `modal-backdrop${opts.sheet ? ' is-sheet' : ''}` }, panel);

  let closed = false;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); handle.close(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables(panel);
    if (list.length === 0) return;
    const first = list[0] as HTMLElement;
    const last = list[list.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !panel.contains(active))) { e.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) handle.close(); });

  const handle: ModalHandle = {
    panel,
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('modal-open');
      backdrop.remove();
      if (open === handle) open = null;
      opts.onClose?.();
      restore?.focus?.();
    },
  };

  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('modal-open');
  document.body.append(backdrop);
  open = handle;
  (focusables(panel)[0] ?? panel).focus?.();
  return handle;
}

/** Plain heading + close button row used by the dialogs. */
export function modalHeader(title: string, onClose: () => void, subtitle?: string): HTMLElement {
  const close = el('button', { class: 'icon-btn modal-close', type: 'button', 'aria-label': 'Schließen' }, '✕');
  close.addEventListener('click', onClose);
  return el('header', { class: 'modal-head' },
    el('div', { class: 'modal-titles' }, el('h2', null, title), subtitle ? el('p', { class: 'muted small' }, subtitle) : null),
    close);
}
