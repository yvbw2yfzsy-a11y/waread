// "Sichern": put a media file onto the device. On iPhone the share sheet (Web Share API with a file) is the way to reach
// "In Fotos sichern" / "In Dateien sichern"; it needs a secure context (HTTPS). Everywhere else, and for big files, a plain
// download link is used. Nothing here talks to WhatsApp: the file comes from the waread server.

import { api } from '../api';
import type { Message } from '../types';
import { el } from '../util';
import { toast } from './toast';

/** Above this size the file is not read into memory for sharing (phones run out of memory); a download link is used. */
const SHARE_MAX_BYTES = 60 * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

/** File name offered to the user: the original name for documents, otherwise waread-<id>.<ext>. */
export function saveName(m: Message): string {
  if (m.media?.fileName) return m.media.fileName;
  const mime = (m.media?.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = EXT[mime] ?? (m.type === 'image' ? 'jpg' : m.type === 'audio' ? 'm4a' : m.type === 'video' ? 'mp4' : 'bin');
  return `waread-${m.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}.${ext}`;
}

function downloadViaLink(m: Message, name: string): void {
  const a = el('a', { href: api.mediaUrl(m.id), download: name, rel: 'noopener' });
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}

export async function saveMedia(m: Message): Promise<void> {
  const name = saveName(m);
  const size = m.media?.size ?? 0;
  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && window.isSecureContext;
  if (canShare && size > 0 && size <= SHARE_MAX_BYTES) {
    try {
      const res = await fetch(api.mediaUrl(m.id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const file = new File([blob], name, { type: blob.type || m.media?.mimeType || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      // The user closing the share sheet is not an error. Anything else falls back to the download link.
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  downloadViaLink(m, name);
  toast('Download gestartet.');
}
