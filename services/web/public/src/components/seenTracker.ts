// "Seen" tracking for incoming messages via IntersectionObserver.
//
// A message counts as seen only after it has been visibly on screen for
// DWELL_MS without interruption: opening a chat alone marks nothing, and
// scrolling past quickly marks nothing. The timer pauses while the tab is
// hidden. Seen is a purely local marker in the waread database.

import { isNew } from '../store';
import type { Message } from '../types';

const DWELL_MS = 1000;
const FLUSH_MS = 400;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

export interface SeenTracker {
  observe(row: HTMLElement, m: Message): void;
  unobserve(row: HTMLElement): void;
  destroy(): void;
}

export function createSeenTracker(scroller: HTMLElement, onSeen: (newest: Message) => void): SeenTracker {
  const messages = new Map<Element, Message>();
  const visible = new Set<Element>();
  const timers = new Map<Element, number>();
  let batch: Message[] = [];
  let flushTimer: number | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    if (batch.length === 0) return;
    const newest = batch.reduce((a, b) => (b.waTimestamp >= a.waTimestamp ? b : a));
    batch = [];
    onSeen(newest);
  };

  const fire = (row: Element): void => {
    timers.delete(row);
    const m = messages.get(row);
    if (!m || !isNew(m) || !visible.has(row)) return;
    io.unobserve(row);
    visible.delete(row);
    messages.delete(row);
    batch.push(m);
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, FLUSH_MS);
  };

  const startTimer = (row: Element): void => {
    if (timers.has(row) || document.hidden) return;
    timers.set(row, window.setTimeout(() => fire(row), DWELL_MS));
  };

  const stopTimer = (row: Element): void => {
    const t = timers.get(row);
    if (t !== undefined) { window.clearTimeout(t); timers.delete(row); }
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      // Tall bubbles may never reach 60 % of their own height, so half of the
      // scroll viewport also counts as "visible enough".
      const enough = e.isIntersecting && (
        e.intersectionRatio >= 0.6 ||
        (e.rootBounds !== null && e.intersectionRect.height >= e.rootBounds.height * 0.5)
      );
      if (enough) { visible.add(e.target); startTimer(e.target); }
      else { visible.delete(e.target); stopTimer(e.target); }
    }
  }, { root: scroller, threshold: THRESHOLDS });

  const onVisibility = (): void => {
    if (document.hidden) { [...timers.keys()].forEach(stopTimer); return; }
    visible.forEach(startTimer);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    observe(row, m) {
      if (!isNew(m)) return;
      messages.set(row, m);
      io.observe(row);
    },
    unobserve(row) {
      stopTimer(row);
      visible.delete(row);
      messages.delete(row);
      io.unobserve(row);
    },
    destroy() {
      document.removeEventListener('visibilitychange', onVisibility);
      [...timers.keys()].forEach(stopTimer);
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      io.disconnect();
      messages.clear();
      visible.clear();
    },
  };
}
