// Settings card "Passkey-Sperre": create a passkey for this device, switch the lock on/off, remove passkeys.
//
// The lock is switched on only after the passkey was confirmed once in this very session
// (Face ID / Touch ID prompt), so a passkey that does not work cannot lock you out.
// With the lock on, adding/removing a passkey and switching the lock off each ask for a fresh
// passkey confirmation.

import { api, ApiError } from '../api';
import type { PasskeyOverview, PasskeyStepPurpose } from '../types';
import { el } from '../util';
import { createCredential, describeWebAuthnError, getCredential, passkeySupported } from '../webauthnClient';
import { icon } from './icons';
import { toast } from './toast';

const date = (sec: number): string => new Date(sec * 1000).toLocaleDateString('de-DE');

function defaultLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  return 'Gerät';
}

function explain(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case 'invalid_credentials': return 'Passkey nicht akzeptiert.';
      case 'challenge_expired': return 'Zeit abgelaufen. Bitte noch einmal versuchen.';
      case 'too_many_passkeys': return 'Es sind schon zehn Passkeys eingerichtet.';
      case 'passkey_exists': return 'Dieser Passkey ist schon eingerichtet.';
      case 'last_passkey_while_locked': return 'Der letzte Passkey kann bei aktiver Sperre nicht entfernt werden. Erst die Sperre aufheben.';
      case 'passkey_not_configured': return 'Auf dem Server sind Passkeys nicht eingerichtet.';
      case 'too_many_attempts': return 'Zu viele Versuche. Bitte kurz warten.';
      case 'step_up_required': return 'Bestätigung mit Passkey nötig.';
      default: return 'Der Server hat die Anfrage abgelehnt.';
    }
  }
  return describeWebAuthnError(err);
}

export function createPasskeyCard(): { node: HTMLElement; destroy: () => void } {
  let destroyed = false;
  let info: PasskeyOverview | null = null;
  let loadFailed = false;
  let busy = false;
  let error = '';
  let label = defaultLabel();
  let confirmLock = false;
  let confirmRemove: string | null = null;

  const node = el('section', { class: 'card' });

  /** Fresh passkey confirmation for a sensitive action. Returns the one-time grant. */
  async function stepUp(purpose: PasskeyStepPurpose): Promise<string> {
    const { challengeId, options } = await api.passkeyStepOptions(purpose);
    const credential = await getCredential(options);
    return api.passkeyStepVerify(challengeId, credential);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    render();
    try {
      await action();
    } catch (err) {
      error = explain(err);
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  const create = (): Promise<void> => run(async () => {
    const wasLocked = info?.lock === true;
    const grant = wasLocked ? await stepUp('register') : undefined;
    const { challengeId, options } = await api.passkeyRegisterOptions(grant);
    const credential = await createCredential(options);
    const had = info?.passkeys.length ?? 0;
    info = await api.passkeyRegisterVerify(challengeId, credential, label.trim());
    toast('Passkey gespeichert.');
    if (had === 0 && !info.lock) confirmLock = true; // first passkey: offer the lock right away
  });

  const lockOn = (): Promise<void> => run(async () => {
    confirmLock = false;
    const grant = await stepUp('lock_on');
    info = await api.passkeyLock(true, grant);
    toast('Passkey-Sperre ist aktiv.');
  });

  const lockOff = (): Promise<void> => run(async () => {
    const grant = await stepUp('lock_off');
    info = await api.passkeyLock(false, grant);
    toast('Passkey-Sperre aufgehoben.');
  });

  const remove = (id: string): Promise<void> => run(async () => {
    confirmRemove = null;
    const grant = info?.lock ? await stepUp('delete') : undefined;
    info = await api.passkeyDelete(id, grant);
    toast('Passkey entfernt.');
  });

  function render(): void {
    if (destroyed) return;
    node.replaceChildren(el('h2', null, 'Passkey-Sperre'));

    if (loadFailed) {
      node.append(el('p', { class: 'muted' }, 'Passkey-Einstellungen konnten nicht geladen werden.'));
      return;
    }
    if (!info) {
      node.append(el('p', { class: 'muted' }, 'Wird geladen …'));
      return;
    }
    node.append(el('p', { class: 'muted small' },
      'Mit der Sperre öffnet sich waread nur noch per Passkey (Face ID / Touch ID). Das Passwort gilt dann nicht mehr.'));

    if (!info.configured) {
      node.append(el('p', { class: 'warn' }, icon('info', 16),
        'Auf dem Server nicht eingerichtet. Passkeys brauchen eine HTTPS-Adresse mit Host-Namen (keine IP-Adresse). web.passkey_rp_id und web.passkey_origin in der config.toml setzen (siehe Anleitung).'));
      return;
    }
    if (!passkeySupported()) {
      node.append(el('p', { class: 'warn' }, icon('info', 16),
        'Dieser Browser oder diese Adresse unterstützt keine Passkeys. Öffne waread über die HTTPS-Adresse mit Host-Namen.'));
      return;
    }

    node.append(el('div', { class: `status-line ${info.lock ? 'st-connected' : 'st-disconnected'}` },
      el('span', { class: 'dot big' }), el('strong', null, info.lock ? 'Sperre aktiv' : 'Sperre aus')));
    if (info.lock) {
      node.append(el('p', { class: 'muted small' }, `Nach der Anmeldung bleibt die Sitzung ${info.sessionHours} Stunden gültig.`));
    }

    if (info.passkeys.length > 0) {
      node.append(el('h3', null, 'Passkeys'));
      for (const p of info.passkeys) {
        const used = p.lastUsedAt ? `zuletzt benutzt ${date(p.lastUsedAt)}` : 'noch nicht benutzt';
        const askRemove = confirmRemove === p.id;
        const btn = el('button', { class: `btn${askRemove ? ' danger' : ''}`, type: 'button', disabled: busy }, askRemove ? 'Wirklich entfernen' : 'Entfernen');
        btn.addEventListener('click', () => {
          if (askRemove) void remove(p.id);
          else { confirmRemove = p.id; render(); }
        });
        node.append(el('div', { class: 'passkey-row' },
          el('div', null, el('strong', null, p.label), el('div', { class: 'muted small' }, `erstellt ${date(p.createdAt)} · ${used}${p.backupState ? ' · in iCloud/Cloud gesichert' : ''}`)),
          btn));
      }
    }

    if (confirmLock) {
      const go = el('button', { class: 'btn primary', type: 'button', disabled: busy }, 'Sperre aktivieren');
      const later = el('button', { class: 'btn', type: 'button', disabled: busy }, 'Später');
      go.addEventListener('click', () => { void lockOn(); });
      later.addEventListener('click', () => { confirmLock = false; render(); });
      node.append(el('div', { class: 'confirm-panel notice' },
        el('p', null, 'Passkey gespeichert. Sperre jetzt aktivieren? Du bestätigst dazu einmal mit dem Passkey.'),
        el('p', { class: 'muted small' },
          'Danach gilt nur noch der Passkey. Alle anderen angemeldeten Geräte werden abgemeldet. Notausstieg bei Verlust des Geräts: am Server „passkey-admin unlock“.'),
        el('div', { class: 'actions' }, later, go)));
    }

    // Add a passkey
    const input = el('input', { class: 'field', type: 'text', value: label, maxlength: 40, 'aria-label': 'Bezeichnung des Passkeys', autocomplete: 'off', disabled: busy });
    input.addEventListener('input', () => { label = input.value; });
    const add = el('button', { class: 'btn primary', type: 'button', disabled: busy || info.passkeys.length >= 10 },
      icon('lock', 16), info.passkeys.length === 0 ? 'Passkey auf diesem Gerät erstellen' : 'Weiteren Passkey erstellen');
    add.addEventListener('click', () => { void create(); });
    node.append(el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, el('span', null, 'Bezeichnung')), input),
      el('div', { class: 'actions' }, add));

    // Lock switch
    if (info.passkeys.length > 0 && !confirmLock) {
      if (info.lock) {
        const off = el('button', { class: 'btn', type: 'button', disabled: busy }, 'Sperre aufheben');
        off.addEventListener('click', () => { void lockOff(); });
        node.append(el('div', { class: 'actions' }, off));
      } else {
        const on = el('button', { class: 'btn', type: 'button', disabled: busy }, 'Sperre aktivieren');
        on.addEventListener('click', () => { confirmLock = true; render(); });
        node.append(el('div', { class: 'actions' }, on));
      }
    }

    if (error) node.append(el('p', { class: 'form-error', role: 'alert' }, error));
    if (busy) node.append(el('p', { class: 'muted small' }, 'Bitte am Gerät bestätigen …'));
  }

  render();
  api.passkeys().then(
    (o) => { info = o; render(); },
    () => { loadFailed = true; render(); },
  );

  return { node, destroy: () => { destroyed = true; } };
}
