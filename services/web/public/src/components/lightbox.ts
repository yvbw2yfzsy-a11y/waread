// Full-screen image viewer: pinch zoom, double-tap zoom, pan, swipe left/right
// to change image, swipe down to close, wheel zoom on desktop, save and shield buttons.
// Built on Pointer Events so touch, pen and mouse share one code path.

import { api } from '../api';
import { setProtected } from '../store';
import type { Message } from '../types';
import { clamp, el, formatDateTime } from '../util';
import { icon } from './icons';
import { saveMedia } from './saveMedia';

const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

let active: { close: () => void } | null = null;

export function openLightbox(images: Message[], startId: string): void {
  active?.close();
  const start = images.findIndex((m) => m.id === startId);
  if (start < 0) return;

  let index = start;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let chromeVisible = true;
  let lastTap = { t: 0, x: 0, y: 0 };
  const restoreFocus = document.activeElement as HTMLElement | null;

  const img = el('img', { class: 'lb-img', alt: '', draggable: 'false' });
  const stage = el('div', { class: 'lb-stage' }, img);
  const counter = el('span', { class: 'lb-count' });
  const caption = el('div', { class: 'lb-caption' });
  const closeBtn = el('button', { class: 'lb-btn', type: 'button', 'aria-label': 'Schließen' }, icon('close', 24));
  const saveBtn = el('button', { class: 'lb-btn', type: 'button', 'aria-label': 'Auf dem Gerät sichern', title: 'Auf dem Gerät sichern' }, icon('share', 24));
  const shieldBtn = el('button', { class: 'lb-btn', type: 'button' });
  const prevBtn = el('button', { class: 'lb-nav lb-prev', type: 'button', 'aria-label': 'Vorheriges Bild' }, icon('back', 28));
  const nextBtn = el('button', { class: 'lb-nav lb-next', type: 'button', 'aria-label': 'Nächstes Bild' }, icon('next', 28));
  const top = el('div', { class: 'lb-top' }, closeBtn, counter, el('div', { class: 'lb-actions' }, shieldBtn, saveBtn));
  const root = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bildansicht' }, stage, top, prevBtn, nextBtn, caption);

  const apply = (animateMs = 0): void => {
    img.style.transition = animateMs ? `transform ${animateMs}ms ease-out` : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const bounds = (): { x: number; y: number } => ({
    x: Math.max(0, (img.clientWidth * scale - stage.clientWidth) / 2),
    y: Math.max(0, (img.clientHeight * scale - stage.clientHeight) / 2),
  });

  const clampPan = (): void => {
    const b = bounds();
    tx = clamp(tx, -b.x, b.x);
    ty = clamp(ty, -b.y, b.y);
  };

  const reset = (): void => { scale = 1; tx = 0; ty = 0; apply(); };

  const zoomAt = (px: number, py: number, next: number, animate = false): void => {
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const ns = clamp(next, 1, MAX_SCALE);
    const ox = (px - cx - tx) / scale;
    const oy = (py - cy - ty) / scale;
    scale = ns;
    tx = px - cx - ox * ns;
    ty = py - cy - oy * ns;
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    apply(animate ? 180 : 0);
  };

  /** Shield button: shows the state of the current image and toggles it. The file name for saving comes from saveName(). */
  const paintShield = (m: Message): void => {
    const on = m.protectedAt !== null && m.protectedAt !== undefined;
    shieldBtn.replaceChildren(icon(on ? 'shieldCheck' : 'shield', 24));
    shieldBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = on ? 'Schutz aufheben' : 'Mit Schild schützen';
    shieldBtn.setAttribute('aria-label', label);
    shieldBtn.title = label;
    shieldBtn.classList.toggle('on', on);
  };

  const show = (i: number): void => {
    index = clamp(i, 0, images.length - 1);
    const m = images[index];
    if (!m) return;
    img.src = api.mediaUrl(m.id);
    reset();
    counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : '';
    paintShield(m);
    caption.textContent = '';
    if (m.caption) caption.append(el('p', null, m.caption));
    const label = m.viewOnce ? 'Einmal-Foto · ' : '';
    caption.append(el('span', null, `${label}${m.fromMe ? 'Du' : m.senderName ?? ''}${m.fromMe || m.senderName ? ' · ' : ''}${formatDateTime(m.waTimestamp)}`));
    prevBtn.hidden = index === 0;
    nextBtn.hidden = index === images.length - 1;
    const neighbour = images[index + 1] ?? images[index - 1];
    if (neighbour) new Image().src = api.mediaUrl(neighbour.id);
  };

  const step = (dir: 1 | -1): void => {
    const target = index + dir;
    if (target < 0 || target >= images.length) { tx = 0; apply(180); return; }
    const w = stage.clientWidth;
    img.style.transition = 'transform 120ms ease-in';
    img.style.transform = `translate(${-dir * w}px, 0) scale(1)`;
    window.setTimeout(() => {
      show(target);
      tx = dir * w * 0.4;
      apply();
      requestAnimationFrame(() => { tx = 0; apply(160); });
    }, 120);
  };

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('lb-open');
    root.remove();
    active = null;
    restoreFocus?.focus?.();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };

  // --- pointer gestures ---------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; scale: number; mid: { x: number; y: number }; tx: number; ty: number } | null = null;
  let drag: { x: number; y: number; tx: number; ty: number; t: number; axis: '' | 'x' | 'y'; moved: boolean } | null = null;

  const mid = (): { x: number; y: number } => {
    const [a, b] = [...pointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  };
  const dist = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 1;
  };

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      pinch = { dist: dist(), scale, mid: mid(), tx, ty };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, tx, ty, t: performance.now(), axis: '', moved: false };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const m = mid();
      const ns = clamp((pinch.scale * dist()) / pinch.dist, 0.8, MAX_SCALE);
      const ox = (pinch.mid.x - cx - pinch.tx) / pinch.scale;
      const oy = (pinch.mid.y - cy - pinch.ty) / pinch.scale;
      scale = ns;
      tx = m.x - cx - ox * ns;
      ty = m.y - cy - oy * ns;
      apply();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true;
    if (scale > 1.02) {
      tx = drag.tx + dx;
      ty = drag.ty + dy;
      clampPan();
      apply();
    } else if (drag.moved) {
      if (!drag.axis) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') {
        const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1);
        tx = atEdge ? dx * 0.3 : dx;
        ty = 0;
      } else {
        tx = 0;
        ty = dy;
        root.style.setProperty('--lb-fade', String(clamp(1 - Math.abs(dy) / 400, 0.3, 1)));
      }
      apply();
    }
  });

  const endPointer = (e: PointerEvent): void => {
    if (!pointers.delete(e.pointerId)) return;
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        if (scale < 1.05) { scale = 1; tx = 0; ty = 0; apply(160); } else { clampPan(); apply(160); }
        const rest = [...pointers.values()][0];
        drag = rest ? { x: rest.x, y: rest.y, tx, ty, t: performance.now(), axis: '', moved: true } : null;
      }
      return;
    }
    const d = drag;
    drag = null;
    if (!d) return;
    root.style.removeProperty('--lb-fade');
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const elapsed = performance.now() - d.t;

    if (!d.moved) {
      // Tap: double tap toggles zoom, single tap toggles the controls.
      const now = performance.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = { t: 0, x: 0, y: 0 };
        zoomAt(e.clientX, e.clientY, scale > 1.1 ? 1 : 2.5, true);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
        window.setTimeout(() => {
          if (lastTap.t === now) { chromeVisible = !chromeVisible; root.classList.toggle('chrome-hidden', !chromeVisible); }
        }, DOUBLE_TAP_MS + 20);
      }
      return;
    }
    if (scale > 1.02) { clampPan(); apply(120); return; }
    const w = stage.clientWidth;
    const fast = Math.abs(dx) / Math.max(elapsed, 1) > 0.5;
    if (d.axis === 'x' && (Math.abs(dx) > w * 0.22 || fast)) step(dx < 0 ? 1 : -1);
    else if (d.axis === 'y' && Math.abs(dy) > 110) close();
    else { tx = 0; ty = 0; apply(180); }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY * 0.0025));
  }, { passive: false });

  closeBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', () => { const m = images[index]; if (m) void saveMedia(m); });
  shieldBtn.addEventListener('click', () => {
    const m = images[index];
    if (!m) return;
    void setProtected(m, !(m.protectedAt !== null && m.protectedAt !== undefined)).then(() => { if (images[index] === m) paintShield(m); });
  });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  document.addEventListener('keydown', onKey);

  document.documentElement.classList.add('lb-open');
  document.body.append(root);
  show(index);
  closeBtn.focus();
  active = { close };
}
