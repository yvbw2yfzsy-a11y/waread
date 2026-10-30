// Voice-note player: bar waveform, seek by tap/drag, speed 1x / 1.5x / 2x.
//
// Layout (phone width): [mic] [play] [waveform, time below] [speed]. The speed button sits right of the waveform with a
// small gap, so the waveform is shorter (BARS) and the button is at least 44 px wide.
//
// The audio element is created lazily on first interaction (preload "none"
// semantics) so a chat full of voice notes does not make the Pi serve every
// file on open. Safari requires Range support on /api/media/:id; that is a
// backend duty.
//
// Waveform: uses media.waveform (0..100) when the API provides it. Without it
// the bars are a DECORATIVE pattern derived from the message id, not audio
// data. The README states this.

import { api } from '../api';
import { markPlayed, on } from '../store';
import type { Message } from '../types';
import { clamp, el, formatDuration, hashString, loadPref, savePref } from '../util';
import { icon } from './icons';

const SPEEDS = [1, 1.5, 2] as const;
type Speed = (typeof SPEEDS)[number];
const BARS = 30;

let current: HTMLAudioElement | null = null;

function speedLabel(s: Speed): string {
  return s === 1 ? '1×' : s === 1.5 ? '1,5×' : '2×';
}

function barHeights(m: Message): { values: number[]; real: boolean } {
  const wf = m.media?.waveform;
  if (wf && wf.length >= 8) {
    const max = Math.max(...wf, 1);
    const values: number[] = [];
    for (let i = 0; i < BARS; i++) {
      const a = Math.floor((i * wf.length) / BARS);
      const b = Math.max(a + 1, Math.floor(((i + 1) * wf.length) / BARS));
      let sum = 0;
      for (let j = a; j < b; j++) sum += wf[j] ?? 0;
      values.push(clamp(sum / (b - a) / max, 0.12, 1));
    }
    return { values, real: true };
  }
  let seed = hashString(m.id) || 1;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const values: number[] = [];
  let prev = 0.5;
  for (let i = 0; i < BARS; i++) {
    prev = clamp(prev * 0.45 + rnd() * 0.65, 0.15, 1);
    values.push(prev);
  }
  return { values, real: false };
}

export function audioPlayer(m: Message, track: (cleanup: () => void) => void): HTMLElement {
  const total = m.media?.durationSec;
  const stored = loadPref<number>('voiceSpeed', 1);
  let speed: Speed = (SPEEDS as readonly number[]).includes(stored) ? (stored as Speed) : 1;
  let audio: HTMLAudioElement | null = null;
  let dragging = false;
  let broken = false;

  const { values, real } = barHeights(m);
  const bars = values.map((v) => {
    const b = el('i');
    b.style.height = `${Math.round(v * 100)}%`;
    return b;
  });
  const wave = el('div', {
    class: `wave${real ? '' : ' wave-decor'}`,
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Wiedergabeposition',
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.round(total ?? 0)),
    'aria-valuenow': '0',
  }, ...bars);

  const playBtn = el('button', { class: 'play', type: 'button', 'aria-label': 'Abspielen' }, icon('play', 22));
  const timeLbl = el('span', { class: 'voice-time' }, formatDuration(total));
  const speedBtn = el('button', { class: 'speed', type: 'button', 'aria-label': 'Wiedergabegeschwindigkeit' }, speedLabel(speed));
  const dot = el('span', { class: 'voice-dot', title: 'Noch nicht angehört' });
  const root = el('div', { class: 'voice' },
    el('div', { class: 'voice-lead' }, icon('mic', 18), dot),
    playBtn,
    el('div', { class: 'voice-main' }, wave, el('div', { class: 'voice-foot' }, timeLbl)),
    speedBtn);

  const durationOf = (a: HTMLAudioElement | null): number =>
    a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : total ?? 0;

  const paint = (ratio: number): void => {
    const r = clamp(ratio, 0, 1);
    const upTo = Math.round(r * BARS);
    bars.forEach((b, i) => b.classList.toggle('on', i < upTo));
    const dur = durationOf(audio);
    wave.setAttribute('aria-valuenow', String(Math.round(r * dur)));
    if (!broken) timeLbl.textContent = formatDuration(r > 0 ? r * dur : dur);
  };

  const setPlaying = (playing: boolean): void => {
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 22));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
    root.classList.toggle('playing', playing);
  };

  const fail = (): void => {
    broken = true;
    root.classList.add('broken');
    timeLbl.textContent = 'Nicht abspielbar';
    setPlaying(false);
  };

  const ensureAudio = (): HTMLAudioElement => {
    if (audio) return audio;
    const a = new Audio();
    a.preload = 'metadata';
    a.src = api.mediaUrl(m.id);
    a.playbackRate = speed;
    a.addEventListener('timeupdate', () => { if (!dragging) paint(a.currentTime / durationOf(a)); });
    a.addEventListener('play', () => setPlaying(true));
    a.addEventListener('pause', () => setPlaying(false));
    a.addEventListener('ended', () => { setPlaying(false); paint(0); });
    a.addEventListener('error', fail);
    audio = a;
    return a;
  };

  const toggle = async (): Promise<void> => {
    const a = ensureAudio();
    if (!a.paused) { a.pause(); return; }
    if (current && current !== a) current.pause();
    current = a;
    try {
      await a.play();
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') fail();
      return;
    }
    if (!m.fromMe) void markPlayed(m);
  };

  const seekTo = (ratio: number): void => {
    const a = ensureAudio();
    const apply = (): void => { a.currentTime = clamp(ratio, 0, 1) * durationOf(a); };
    if (a.readyState >= 1) apply();
    else a.addEventListener('loadedmetadata', apply, { once: true });
    paint(ratio);
  };

  const ratioAt = (ev: PointerEvent): number => {
    const r = wave.getBoundingClientRect();
    return r.width > 0 ? clamp((ev.clientX - r.left) / r.width, 0, 1) : 0;
  };

  playBtn.addEventListener('click', () => { void toggle(); });

  speedBtn.addEventListener('click', () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
    speedBtn.textContent = speedLabel(speed);
    savePref('voiceSpeed', speed);
    if (audio) audio.playbackRate = speed;
  });

  wave.addEventListener('pointerdown', (ev) => {
    dragging = true;
    wave.setPointerCapture(ev.pointerId);
    paint(ratioAt(ev));
  });
  wave.addEventListener('pointermove', (ev) => { if (dragging) paint(ratioAt(ev)); });
  wave.addEventListener('pointerup', (ev) => { if (!dragging) return; dragging = false; seekTo(ratioAt(ev)); });
  wave.addEventListener('pointercancel', () => { dragging = false; });
  wave.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const a = ensureAudio();
    const dur = durationOf(a);
    if (dur <= 0) return;
    seekTo((a.currentTime + (ev.key === 'ArrowRight' ? 5 : -5)) / dur);
  });

  const updateDot = (): void => { dot.hidden = m.fromMe || !!m.playedAt; };
  updateDot();
  track(on(`msg:${m.id}`, updateDot));
  track(() => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (current === audio) current = null;
    audio = null;
  });

  return root;
}
