// WhatsApp connection status and QR pairing.
//
// GET api/status and GET api/qr show the state and the pairing code. "Neu verbinden"
// (POST api/connect) only stores a command for the waread ingest service, which then
// starts a new QR session if it has no active connection. Nothing is sent to WhatsApp
// by this page.

import { api } from '../api';
import { goBack } from '../router';
import { loadStatus, on, state } from '../store';
import { clear, coalesce, el, formatDateTime, statusLabel } from '../util';
import { icon } from './icons';
import { toast } from './toast';

const QR_POLL_MS = 4000;

function qrSrc(payload: string): string | null {
  const p = payload.trim();
  if (p.startsWith('data:image/')) return p;
  if (p.startsWith('<svg') || p.startsWith('<?xml')) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p)}`;
  return null;
}

export function mountConnectionView(host: HTMLElement): () => void {
  let destroyed = false;
  let qr: { state: 'none' | 'ok' | 'unknown' | 'error'; src?: string } = { state: 'none' };
  let pollTimer: number | undefined;

  const head = el('header', { class: 'pane-head with-back' },
    el('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Zurück', onclick: goBack }, icon('back', 26)),
    el('h1', null, 'Verbindung'));
  const bodyEl = el('div', { class: 'scroll pad' });
  host.append(head, bodyEl);

  const stopPoll = (): void => {
    if (pollTimer !== undefined) { window.clearTimeout(pollTimer); pollTimer = undefined; }
  };

  const fetchQr = async (): Promise<void> => {
    try {
      const payload = await api.qr();
      if (destroyed) return;
      if (payload === null) qr = { state: 'none' };
      else {
        const src = qrSrc(payload);
        qr = src ? { state: 'ok', src } : { state: 'unknown' };
      }
    } catch {
      qr = { state: 'error' };
    }
    if (!destroyed) render();
  };

  const poll = (): void => {
    stopPoll();
    if (destroyed || state.status.state !== 'needs_qr') return;
    void fetchQr().then(() => {
      if (!destroyed && state.status.state === 'needs_qr') pollTimer = window.setTimeout(poll, QR_POLL_MS);
    });
  };

  const explain = (s: typeof state.status.state): string => {
    switch (s) {
      case 'connected': return 'waread ist als verknüpftes Gerät mit WhatsApp verbunden und empfängt Nachrichten. Es sendet nichts zurück: keine Nachrichten, keine Lesebestätigungen.';
      case 'connecting': return 'Die Verbindung zu WhatsApp wird aufgebaut.';
      case 'needs_qr': return 'waread muss mit deinem WhatsApp-Konto gekoppelt werden. Scanne den QR-Code mit dem Telefon.';
      case 'disconnected': return 'Keine Verbindung zu WhatsApp. Wenn das nach einigen Minuten so bleibt, wurde die Verknüpfung vermutlich in WhatsApp entfernt. Mit „Neu verbinden“ bittet diese Seite den waread-Dienst, eine neue Kopplung zu beginnen; sobald er einen QR-Code bereitstellt, steht der Status auf „QR-Code scannen“ und der Code erscheint hier.';
    }
  };

  const render = (): void => {
    const s = state.status;
    clear(bodyEl);
    const card = el('div', { class: 'card' },
      el('div', { class: `status-line st-${s.state}` }, el('span', { class: 'dot big' }), el('strong', null, statusLabel(s.state))),
      s.since ? el('p', { class: 'muted small' }, `Seit ${formatDateTime(s.since)}`) : null,
      el('p', null, explain(s.state)));
    bodyEl.append(card);

    if (s.state === 'needs_qr') {
      const box = el('div', { class: 'qr-box' });
      if (qr.state === 'ok' && qr.src) box.append(el('img', { class: 'qr', src: qr.src, alt: 'QR-Code zum Koppeln mit WhatsApp' }));
      else if (qr.state === 'unknown') box.append(el('p', { class: 'muted' }, 'Der Server liefert den QR-Code in einem unbekannten Format (erwartet: SVG oder Daten-URL).'));
      else if (qr.state === 'error') box.append(el('p', { class: 'muted' }, 'QR-Code konnte nicht geladen werden.'));
      else box.append(el('span', { class: 'spinner' }), el('p', { class: 'muted' }, 'Noch kein QR-Code verfügbar. Erscheint nach einigen Sekunden keiner, unten „Neu verbinden“ wählen.'));
      bodyEl.append(
        box,
        el('ol', { class: 'steps' },
          el('li', null, 'WhatsApp auf dem Telefon öffnen.'),
          el('li', null, 'Einstellungen → Verknüpfte Geräte → Gerät hinzufügen.'),
          el('li', null, 'Den QR-Code oben scannen. Er erneuert sich automatisch.')),
      );
    }

    const reload = el('button', { class: 'btn', type: 'button' }, icon('refresh', 16), 'Status neu laden');
    reload.addEventListener('click', () => {
      reload.disabled = true;
      void loadStatus().catch(() => undefined).then(() => { reload.disabled = false; poll(); });
    });
    const actions = el('div', { class: 'actions' }, reload);
    // After a logout or an unscanned QR the ingest service idles in "needs_qr" without a code until it is asked to
    // connect. A command sent while it already has an active session is ignored by the service.
    if (s.state === 'disconnected' || (s.state === 'needs_qr' && qr.state !== 'ok')) {
      const reconnect = el('button', { class: 'btn primary', type: 'button' }, icon('refresh', 16), 'Neu verbinden');
      reconnect.addEventListener('click', () => {
        reconnect.disabled = true;
        api.connect().then(
          () => {
            toast('Anfrage gesendet. Der Dienst startet gleich eine neue Kopplung.');
            // The ingest service polls the command every few seconds; look again shortly after.
            window.setTimeout(() => { if (!destroyed) void loadStatus().catch(() => undefined); }, 4000);
          },
          () => toast('Anfrage konnte nicht gesendet werden.'),
        ).then(() => window.setTimeout(() => { reconnect.disabled = false; }, 5000));
      });
      actions.prepend(reconnect);
    }
    bodyEl.append(actions);
  };

  const onStatus = coalesce(() => {
    render();
    if (state.status.state === 'needs_qr') poll(); else { stopPoll(); qr = { state: 'none' }; }
  });

  render();
  poll();
  const off = on('status', onStatus);
  return () => { destroyed = true; stopPoll(); off(); head.remove(); bodyEl.remove(); };
}
