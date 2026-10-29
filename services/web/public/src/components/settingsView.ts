// Settings: retention, storage limit, download rules, storage overview and the
// two-step "clear storage" flow (two ways: without and including protected messages), plus local display preferences.
//
// Retention changes are saved with an explicit button and a visible warning,
// because shortening them lets the next cleanup run delete older messages.

import { api, ApiError } from '../api';
import { navigate } from '../router';
import { dataChanged, loadChats, loadSettings, on, saveSettings, sortedChats, state } from '../store';
import type { ClearScope, DownloadKind, DownloadMode, Settings, StorageUsage } from '../types';
import { append, clear, el, formatBytes, loadPref, savePref, statusLabel } from '../util';
import { icon } from './icons';
import { createPasskeyCard } from './passkeyCard';
import { toast } from './toast';

const DAY_CHOICES = [1, 3, 7, 14, 30];
const LIMIT_CHOICES_MB = [0, 250, 500, 1000, 2000, 5000, 10000];
const FILE_MAX_CHOICES_MB = [5, 10, 20, 50, 100, 200, 500];
const KINDS: { id: DownloadKind; label: string }[] = [
  { id: 'image', label: 'Fotos' },
  { id: 'audio', label: 'Sprachnachrichten' },
  { id: 'video', label: 'Videos' },
  { id: 'document', label: 'Dokumente' },
];
const TYPE_LABELS: Record<string, string> = {
  image: 'Fotos', voice: 'Sprachnachrichten', audio: 'Sprachnachrichten', video: 'Videos', document: 'Dokumente', text: 'Text', system: 'System', sticker: 'Sticker', other: 'Sonstiges',
};

const dayLabel = (n: number): string => (n === 1 ? '1 Tag' : `${n} Tage`);
const mbLabel = (mb: number): string => (mb === 0 ? 'Kein Limit' : mb >= 1000 && mb % 1000 === 0 ? `${mb / 1000} GB` : `${mb} MB`);

function select<T extends string | number>(
  choices: T[], current: T, label: (v: T) => string, onChange: (v: string) => void, ariaLabel: string,
): HTMLSelectElement {
  const all = choices.includes(current) ? choices : [...choices, current].sort((a, b) => Number(a) - Number(b));
  const sel = el('select', { class: 'field', 'aria-label': ariaLabel },
    ...all.map((v) => el('option', { value: String(v), selected: v === current }, label(v) + (choices.includes(v) ? '' : ' (Serverwert)'))));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/** `stack`: label above the controls (needed where two selects share a row, so neither is cut off on a phone). */
function row(label: string, control: Node, hint?: string, stack = false): HTMLElement {
  return el('div', { class: `form-row${stack ? ' stack' : ''}` },
    el('div', { class: 'form-label' }, el('span', null, label), hint ? el('small', null, hint) : null), control);
}

export function mountSettingsView(host: HTMLElement, onLogout: () => void): () => void {
  let destroyed = false;
  let draft: Settings | null = state.settings ? structuredClone(state.settings) : null;
  let usage: StorageUsage | null = null;
  let clearScope: ClearScope = 'media';
  let clearChatId = '';
  /** null = nothing started; 'normal' = without protected messages; 'extreme' = including them. */
  let confirming: 'normal' | 'extreme' | null = null;

  const passkeyCard = createPasskeyCard(); // keeps its own state; the node is re-attached on every render()
  const body = el('div', { class: 'scroll pad' });
  host.append(el('header', { class: 'pane-head' }, el('h1', null, 'Einstellungen')), body);

  const dirty = (): boolean => {
    const s = state.settings;
    if (!s || !draft) return false;
    return JSON.stringify(s) !== JSON.stringify(draft);
  };

  // --- sections -------------------------------------------------------------
  const connectionCard = (): HTMLElement => {
    const s = state.status.state;
    return el('section', { class: 'card' },
      el('h2', null, 'WhatsApp-Verbindung'),
      el('div', { class: `status-line st-${s}` }, el('span', { class: 'dot big' }), el('strong', null, statusLabel(s))),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => navigate('#/connection') }, 'Verbindung anzeigen')));
  };

  const displayCard = (): HTMLElement => {
    const box = el('input', { type: 'checkbox', checked: loadPref<boolean>('markAllOnOpen', false) });
    box.addEventListener('change', () => savePref('markAllOnOpen', box.checked));
    return el('section', { class: 'card' },
      el('h2', null, 'Anzeige'),
      el('label', { class: 'switch-row' }, box, el('span', null, 'Beim Öffnen eines Chats alles als gesehen markieren')),
      el('p', { class: 'muted small' }, 'Ohne diese Option gilt eine Nachricht erst nach etwa einer Sekunde im sichtbaren Bereich als gesehen. Gesehen ist nur eine lokale Markierung und ändert nichts in WhatsApp.'),
      el('p', { class: 'muted small' }, 'Tipp: Auf eine Nachricht tippen öffnet ihr Menü: mit Schild schützen, auf dem Gerät sichern, Medium jetzt laden, Bearbeitungen ansehen.'));
  };

  const retentionCard = (): HTMLElement => {
    const d = draft;
    if (!d) return el('section', { class: 'card' }, el('h2', null, 'Aufbewahrung'), el('p', { class: 'muted' }, 'Einstellungen werden geladen …'));
    const saved = state.settings;
    const shortened = !!saved && (d.retentionDays < saved.retentionDays || d.retentionMediaDays < saved.retentionMediaDays);
    const save = el('button', { class: 'btn primary', type: 'button', disabled: !dirty() }, 'Speichern');
    save.addEventListener('click', () => {
      save.disabled = true;
      saveSettings(d).then(
        () => { draft = state.settings ? structuredClone(state.settings) : null; toast('Gespeichert.'); render(); },
        (err: unknown) => {
          toast(err instanceof ApiError && err.message === 'media_retention_exceeds_message_retention'
            ? 'Medien dürfen nicht länger aufbewahrt werden als Nachrichten.'
            : 'Speichern fehlgeschlagen.');
          save.disabled = false;
        },
      );
    });

    const ruleRows = KINDS.map((k) => {
      const cur: DownloadMode = d.downloadRules[k.id];
      const opts: [DownloadMode, string][] = [['auto', 'Laden'], ['off', 'Aus']];
      const sel = el('select', { class: 'field', 'aria-label': `Download-Regel ${k.label}` },
        ...opts.map(([v, l]) => el('option', { value: v, selected: v === cur }, l)));
      sel.addEventListener('change', () => { d.downloadRules[k.id] = sel.value as DownloadMode; render(); });
      const max = select(FILE_MAX_CHOICES_MB, d.downloadMaxMb[k.id], (v) => `≤ ${mbLabel(v)}`, (v) => { d.downloadMaxMb[k.id] = Number(v); render(); }, `Größenlimit ${k.label}`);
      max.disabled = cur === 'off';
      return row(k.label, el('div', { class: 'inline-controls' }, sel, max), undefined, true);
    });

    return el('section', { class: 'card' },
      el('h2', null, 'Aufbewahrung'),
      row('Nachrichten', select(DAY_CHOICES, d.retentionDays, dayLabel, (v) => { d.retentionDays = Number(v); render(); }, 'Aufbewahrung Nachrichten'), 'gemessen am WhatsApp-Zeitstempel'),
      row('Medien', select(DAY_CHOICES, d.retentionMediaDays, dayLabel, (v) => { d.retentionMediaDays = Number(v); render(); }, 'Aufbewahrung Medien')),
      row('Speicherlimit', select(LIMIT_CHOICES_MB, d.storageLimitMb, mbLabel, (v) => { d.storageLimitMb = Number(v); render(); }, 'Speicherlimit'), 'Nur Anzeige: Die Grenze wird nicht durchgesetzt, deswegen wird nichts gelöscht.'),
      shortened ? el('p', { class: 'warn' }, icon('info', 16), 'Kürzere Aufbewahrung: ältere Nachrichten bzw. Medien werden beim nächsten Aufräumen gelöscht.') : null,
      el('h3', null, 'Download-Regeln'),
      el('p', { class: 'muted small' }, '„Aus“ speichert nur die Nachricht, nicht die Datei. „≤“ ist die größte Datei, die noch geladen wird. Die Regeln gelten für neu eintreffende Nachrichten.'),
      ...ruleRows,
      el('div', { class: 'actions' }, save));
  };

  /** `warn` (orange from 90 %) is only meaningful against the storage limit, not for relative bars. */
  const meter = (ratio: number, warn = false): HTMLElement => {
    const fill = el('i');
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    return el('div', { class: `meter${warn && ratio >= 0.9 ? ' high' : ''}` }, fill);
  };

  const usageCard = (): HTMLElement => {
    const refresh = el('button', { class: 'btn', type: 'button' }, icon('refresh', 16), 'Aktualisieren');
    refresh.addEventListener('click', () => { void loadUsage(); });
    const card = el('section', { class: 'card' }, el('h2', null, 'Speicher'));
    if (!usage) { card.append(el('p', { class: 'muted' }, 'Wird berechnet …'), el('div', { class: 'actions' }, refresh)); return card; }
    const limitMb = state.settings?.storageLimitMb ?? 0;
    const limitBytes = limitMb * 1024 * 1024;
    append(card, [
      el('p', null, el('strong', null, formatBytes(usage.totalBytes)), limitMb ? ` von ${mbLabel(limitMb)}` : ''),
      limitBytes ? meter(usage.totalBytes / limitBytes, true) : null,
      usage.protectedMessages > 0
        ? el('p', { class: 'muted small protected-line' }, icon('shieldCheck', 14),
          `Mit Schild geschützt: ${usage.protectedMessages} ${usage.protectedMessages === 1 ? 'Nachricht' : 'Nachrichten'}, Dateien ${formatBytes(usage.protectedMediaBytes)}. Das Schild ist kein Backup: Fällt die Speicherkarte aus, sind auch geschützte Nachrichten weg.`)
        : null,
    ]);
    const maxType = Math.max(1, ...usage.perType.map((t) => t.bytes));
    if (usage.perType.length) {
      card.append(el('h3', null, 'Nach Typ'));
      for (const t of usage.perType) card.append(el('div', { class: 'usage-row' }, el('span', null, TYPE_LABELS[t.type] ?? t.type), el('span', { class: 'muted' }, formatBytes(t.bytes)), meter(t.bytes / maxType)));
    }
    const top = [...usage.perChat].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    const maxChat = Math.max(1, ...top.map((c) => c.bytes));
    if (top.length) {
      card.append(el('h3', null, 'Größte Chats'));
      for (const c of top) card.append(el('div', { class: 'usage-row' }, el('span', null, c.name), el('span', { class: 'muted' }, formatBytes(c.bytes)), meter(c.bytes / maxChat)));
    }
    card.append(el('div', { class: 'actions' }, refresh));
    return card;
  };

  /** What the chosen scope deletes, in words; `extreme` adds the protected messages. */
  const scopeText = (extreme: boolean): string => {
    const prot = usage ? `${usage.protectedMessages} ${usage.protectedMessages === 1 ? 'geschützte Nachricht' : 'geschützte Nachrichten'}` : 'geschützte Nachrichten';
    if (clearScope === 'media') {
      return extreme
        ? `alle gespeicherten Medien (Fotos, Sprachnachrichten, Videos, Dokumente), auch die Dateien von ${prot}`
        : 'alle gespeicherten Medien (Fotos, Sprachnachrichten, Videos, Dokumente) außer denen geschützter Nachrichten';
    }
    if (clearScope === 'all') {
      return extreme
        ? `ALLE gespeicherten Nachrichten und Medien, auch ${prot}, sowie die gemerkten Namen und Nummernzuordnungen`
        : 'alle gespeicherten Nachrichten und Medien außer den geschützten, sowie die gemerkten Namen und Nummernzuordnungen';
    }
    const name = state.chats.get(clearChatId)?.name ?? 'den gewählten Chat';
    return extreme
      ? `alle gespeicherten Nachrichten und Medien von „${name}“, auch die mit Schild`
      : `alle gespeicherten Nachrichten und Medien von „${name}“ außer den geschützten`;
  };

  const keptText = (): string => {
    if (!usage || usage.protectedMessages === 0) return '';
    const n = usage.protectedMessages;
    return clearScope === 'chat'
      ? 'Geschützte Nachrichten dieses Chats bleiben erhalten.'
      : `${n} ${n === 1 ? 'geschützte Nachricht bleibt' : 'geschützte Nachrichten bleiben'} erhalten.`;
  };

  const clearCard = (): HTMLElement => {
    const scopeSel = el('select', { class: 'field', 'aria-label': 'Was soll geleert werden' },
      el('option', { value: 'media', selected: clearScope === 'media' }, 'Nur Medien'),
      el('option', { value: 'chat', selected: clearScope === 'chat' }, 'Einen Chat'),
      el('option', { value: 'all', selected: clearScope === 'all' }, 'Alles'));
    scopeSel.addEventListener('change', () => { clearScope = scopeSel.value as ClearScope; confirming = null; render(); });

    const card = el('section', { class: 'card danger-zone' }, el('h2', null, 'Speicher leeren'), row('Umfang', scopeSel));

    if (clearScope === 'chat') {
      const chats = sortedChats();
      if (!clearChatId && chats[0]) clearChatId = chats[0].id;
      const chatSel = el('select', { class: 'field', 'aria-label': 'Chat wählen' },
        ...chats.map((c) => el('option', { value: c.id, selected: c.id === clearChatId }, c.name)));
      chatSel.addEventListener('change', () => { clearChatId = chatSel.value; confirming = null; render(); });
      card.append(row('Chat', chatSel));
    }

    if (confirming === null) {
      const disabled = clearScope === 'chat' && !clearChatId;
      const normal = el('button', { class: 'btn danger', type: 'button', disabled }, icon('trash', 16), 'Speicher leeren (ohne geschützte)');
      normal.addEventListener('click', () => { confirming = 'normal'; render(); });
      const extreme = el('button', { class: 'btn danger extreme', type: 'button', disabled }, icon('trash', 16), 'Speicher leeren (auch geschützte)');
      extreme.addEventListener('click', () => { confirming = 'extreme'; render(); });
      card.append(
        el('p', { class: 'muted small' }, 'Geschützte Nachrichten (mit Schild) löscht weder die automatische Aufbewahrung noch die erste Variante. Nur die zweite entfernt auch sie.'),
        el('div', { class: 'actions vertical' }, normal, extreme));
      return card;
    }

    const extreme = confirming === 'extreme';
    // Step 2: explicit confirmation by typing a word. The extreme way needs a different word, so it cannot be
    // confirmed by habit.
    const WORD = extreme ? 'GESCHÜTZTE LÖSCHEN' : 'LÖSCHEN';
    const word = el('input', { class: 'field', type: 'text', placeholder: `${WORD} eingeben`, autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Bestätigung' });
    const go = el('button', { class: `btn danger${extreme ? ' extreme' : ''}`, type: 'button', disabled: true }, extreme ? 'Endgültig löschen, auch geschützte' : 'Endgültig löschen');
    const cancel = el('button', { class: 'btn', type: 'button' }, 'Abbrechen');
    const normalize = (v: string): string => v.trim().replace(/\s+/g, ' ').toLocaleUpperCase('de-DE');
    word.addEventListener('input', () => { go.disabled = normalize(word.value) !== WORD; });
    cancel.addEventListener('click', () => { confirming = null; render(); });
    go.addEventListener('click', () => {
      go.disabled = true;
      const chatId = clearScope === 'chat' ? clearChatId : undefined;
      api.storageClear(clearScope, chatId, extreme).then(
        async (res) => {
          confirming = null;
          toast(res.keptProtected > 0
            ? `Speicher geleert. ${res.keptProtected} geschützte ${res.keptProtected === 1 ? 'Nachricht bleibt' : 'Nachrichten bleiben'} erhalten.`
            : 'Speicher geleert.');
          dataChanged();
          await Promise.allSettled([loadChats(), loadUsage()]);
          if (!destroyed) render();
        },
        () => { toast('Leeren fehlgeschlagen.'); go.disabled = false; },
      );
    });
    card.append(el('div', { class: `confirm-panel${extreme ? ' confirm-extreme' : ''}` },
      extreme ? el('p', { class: 'extreme-label' }, icon('info', 16), el('strong', null, 'Extremer Schritt: löscht auch Nachrichten mit Schild')) : null,
      el('p', null, `Das löscht ${scopeText(extreme)} endgültig aus dem waread-Speicher. Es lässt sich nicht rückgängig machen${extreme ? ', und es gibt kein Backup' : ''}. WhatsApp selbst ist nicht betroffen.`),
      !extreme && keptText() ? el('p', { class: 'muted small' }, keptText()) : null,
      el('p', { class: 'small' }, 'Zum Bestätigen eingeben: ', el('strong', null, WORD)),
      extreme && usage ? el('p', { class: 'muted small' }, `Geschützt sind zurzeit ${usage.protectedMessages} ${usage.protectedMessages === 1 ? 'Nachricht' : 'Nachrichten'} (Dateien: ${formatBytes(usage.protectedMediaBytes)}).`) : null,
      word, el('div', { class: 'actions' }, cancel, go)));
    return card;
  };

  const aboutCard = (): HTMLElement => {
    const out = el('button', { class: 'btn', type: 'button' }, 'Abmelden');
    out.addEventListener('click', () => { api.logout().catch(() => undefined).then(onLogout); });
    return el('section', { class: 'card' },
      el('h2', null, 'Über waread'),
      el('p', { class: 'muted small' }, 'Diese Oberfläche sendet nichts an WhatsApp. „Neu“ und „angehört“ sind lokale Markierungen in der eigenen Datenbank.'),
      el('div', { class: 'actions' }, out));
  };

  function render(): void {
    if (destroyed) return;
    const top = body.scrollTop;
    clear(body);
    body.append(connectionCard(), displayCard(), retentionCard(), usageCard(), clearCard(), passkeyCard.node, aboutCard());
    body.scrollTop = top;
  }

  async function loadUsage(): Promise<void> {
    try { usage = await api.storageUsage(); } catch { usage = { totalBytes: 0, protectedMessages: 0, protectedMediaBytes: 0, perChat: [], perType: [] }; toast('Speicherübersicht konnte nicht geladen werden.'); }
    render();
  }

  render();
  void loadUsage();
  if (!state.settings) {
    loadSettings().then(
      () => { draft = state.settings ? structuredClone(state.settings) : null; render(); },
      () => { toast('Einstellungen konnten nicht geladen werden.'); },
    );
  }
  const off = [on('status', render)];
  return () => { destroyed = true; passkeyCard.destroy(); off.forEach((f) => f()); };
}
