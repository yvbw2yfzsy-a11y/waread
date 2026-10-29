// Login screen. The session cookie is set by the server (HttpOnly), so the page never
// sees or stores the session itself.
//
// Two modes, chosen by the server (GET /api/auth/state):
// - normal: password form (plus a passkey button once a passkey exists)
// - passkey lock: no password field at all; sign-in only with the passkey (Face ID / Touch ID)

import { api, ApiError } from '../api';
import type { AuthState } from '../types';
import { clear, el } from '../util';
import { describeWebAuthnError, getCredential, passkeySupported } from '../webauthnClient';
import { icon } from './icons';

export function showLogin(root: HTMLElement, onSuccess: () => void): void {
  clear(root);
  const card = el('div', { class: 'login-card' });
  root.append(el('div', { class: 'login-wrap' }, card));

  const header = (): Node[] => [
    el('div', { class: 'login-logo' }, icon('lock', 28)),
    el('h1', null, 'waread'),
  ];

  function passkeyButton(label: string, error: HTMLElement, primary: boolean): HTMLButtonElement {
    const btn = el('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button' }, icon('lock', 18), label);
    btn.addEventListener('click', () => {
      btn.disabled = true;
      error.hidden = true;
      const fail = (msg: string): void => { btn.disabled = false; error.textContent = msg; error.hidden = false; };
      void (async () => {
        try {
          const { challengeId, options } = await api.passkeyLoginOptions();
          const credential = await getCredential(options);
          await api.passkeyLoginVerify(challengeId, credential);
          onSuccess();
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 429) fail('Zu viele Versuche. Bitte kurz warten.');
            else if (err.status === 401) fail('Passkey nicht akzeptiert.');
            else if (err.status === 409) fail('Es ist kein Passkey eingerichtet.');
            else if (err.message === 'challenge_expired') fail('Zeit abgelaufen. Bitte noch einmal versuchen.');
            else fail('Anmeldung nicht möglich. Server erreichbar?');
          } else {
            fail(describeWebAuthnError(err));
          }
        }
      })();
    });
    return btn;
  }

  function renderLocked(st: AuthState): void {
    clear(card);
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    card.append(...header());
    if (!st.passkey) {
      card.append(
        el('p', { class: 'muted' }, 'Gesperrt: Anmeldung nur mit Passkey, aber auf dem Server ist kein Passkey verfügbar.'),
        el('p', { class: 'muted small' }, 'Notausstieg am Server: „passkey-admin unlock“ (siehe Anleitung).'));
      return;
    }
    if (!passkeySupported()) {
      card.append(
        el('p', { class: 'muted' }, 'Gesperrt: Anmeldung nur mit Passkey.'),
        el('p', { class: 'form-error' }, 'Dieser Zugang unterstützt keine Passkeys. Passkeys brauchen eine HTTPS-Adresse mit Host-Namen.'));
      return;
    }
    card.append(
      el('p', { class: 'muted' }, 'Gesperrt. Anmeldung nur mit Passkey (Face ID / Touch ID).'),
      error,
      passkeyButton('Mit Passkey anmelden', error, true));
  }

  function renderPassword(st: AuthState | null): void {
    clear(card);
    const input = el('input', {
      class: 'field', type: 'password', name: 'password', autocomplete: 'current-password',
      placeholder: 'Passwort', required: true, 'aria-label': 'Passwort',
    });
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Anmelden');
    const form = el('form', { class: 'login-card-form' }, input, error, submit);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value) return;
      submit.disabled = true;
      error.hidden = true;
      api.login(input.value).then(
        () => { input.value = ''; onSuccess(); },
        (err: unknown) => {
          submit.disabled = false;
          if (err instanceof ApiError && err.status === 403 && err.message === 'passkey_required') {
            // The lock was switched on in the meantime: show the passkey screen instead.
            input.value = '';
            void api.authState().then(renderLocked, () => renderLocked({ lock: true, passkey: true }));
            return;
          }
          error.hidden = false;
          if (err instanceof ApiError && err.status === 401) error.textContent = 'Passwort falsch.';
          else if (err instanceof ApiError && err.status === 429) error.textContent = 'Zu viele Versuche. Bitte kurz warten.';
          else error.textContent = 'Anmeldung nicht möglich. Server erreichbar?';
          input.select();
        },
      );
    });

    card.append(...header(), el('p', { class: 'muted' }, 'Nur lesen. Nichts wird an WhatsApp zurückgesendet.'), form);
    if (st?.passkey && passkeySupported()) {
      const pkError = el('p', { class: 'form-error', role: 'alert', hidden: true });
      card.append(pkError, passkeyButton('Mit Passkey anmelden', pkError, false));
    }
    input.focus();
  }

  api.authState().then(
    (st) => (st.lock ? renderLocked(st) : renderPassword(st)),
    // State unknown (e.g. server just restarting): show the password form; the server enforces the lock anyway.
    () => renderPassword(null),
  );
}
