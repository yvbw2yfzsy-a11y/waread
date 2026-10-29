import fs from 'node:fs';
import path from 'node:path';
import type { App } from '../context.js';
import { deleteExpired, pushEvent, setSetting } from '../db.js';
import { resolveInside } from '../files.js';
import { asObject, HttpError, readJson, type Router, sendJson } from '../http.js';
import { errFields } from '../log.js';
import { chatExists, dbFileBytes, deleteChatData, storageUsage } from '../queries.js';
import { readSettings } from './settings.js';

/**
 * Dateien aus einer Loeschliste entfernen. Nur Pfade unterhalb von media_dir (nach Symlink-Aufloesung),
 * nie der Avatar-Cache. Leer gewordene <chat>/<datum>-Ordner werden (zwei Ebenen) mit entfernt.
 */
async function removeFiles(mediaDir: string, paths: string[]): Promise<{ deleted: number; freedBytes: number }> {
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(mediaDir);
  } catch {
    return { deleted: 0, freedBytes: 0 };
  }
  let deleted = 0;
  let freedBytes = 0;
  for (const p of new Set(paths)) {
    const real = await resolveInside(mediaDir, p);
    if (!real) continue;
    const rel = path.relative(rootReal, real);
    if (rel === '' || rel.split(path.sep)[0] === 'avatars') continue;
    try {
      const st = await fs.promises.stat(real);
      if (!st.isFile()) continue;
      await fs.promises.unlink(real);
      deleted++;
      freedBytes += st.size;
    } catch {
      continue;
    }
    let dir = path.dirname(real);
    for (let i = 0; i < 2 && dir !== rootReal && dir.startsWith(rootReal + path.sep); i++) {
      try {
        await fs.promises.rmdir(dir); // schlaegt bei nicht leerem Ordner fehl -> ignorieren
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
  return { deleted, freedBytes };
}

export function registerStorageRoutes(r: Router, app: App): void {
  let clearing = false;

  r.add('GET', '/api/storage/usage', async (c) => {
    const u = storageUsage(app.db);
    const dbBytes = dbFileBytes(app.cfg.paths.db);
    let diskFreeBytes: number | null = null;
    let diskTotalBytes: number | null = null;
    try {
      const s = await fs.promises.statfs(app.cfg.paths.mediaDir);
      diskFreeBytes = Number(s.bavail) * Number(s.bsize);
      diskTotalBytes = Number(s.blocks) * Number(s.bsize);
    } catch {
      /* Verzeichnis fehlt noch */
    }
    const limitMb = readSettings(app.db).storageLimitMb;
    sendJson(c.res, 200, {
      totalBytes: u.mediaBytes + dbBytes, // Mediendateien (Summe media.size_bytes, ohne Thumbnails) + DB inkl. WAL
      mediaBytes: u.mediaBytes,
      dbBytes,
      limitBytes: limitMb > 0 ? limitMb * 1024 * 1024 : null,
      diskFreeBytes,
      diskTotalBytes,
      perChat: u.perChat,
      perType: u.perType,
    });
  });

  // Loescht endgueltig. confirm muss exakt true sein.
  r.add('POST', '/api/storage/clear', async (c) => {
    const body = asObject(await readJson(c));
    if (body['confirm'] !== true) throw new HttpError(400, 'confirm_required');
    const scope = body['scope'];
    if (scope !== 'chat' && scope !== 'media' && scope !== 'all') throw new HttpError(400, 'invalid_scope');
    let chatId: string | null = null;
    if (scope === 'chat') {
      const v = body['chatId'];
      if (typeof v !== 'string' || v === '' || v.length > 512) throw new HttpError(400, 'chat_id_required');
      if (!chatExists(app.db, v)) throw new HttpError(404, 'chat_not_found');
      chatId = v;
    }
    if (clearing) throw new HttpError(409, 'clear_in_progress');
    clearing = true;
    try {
      let deletedMessages = 0;
      let paths: string[] = [];
      if (scope === 'chat') {
        const res = deleteChatData(app.db, chatId!);
        deletedMessages = res.deletedMessages;
        paths = res.mediaPaths;
      } else {
        // "Alles aelter als unendlich" ueber den Vertrag: FTS-Index und Medienstatus bleiben konsistent.
        const everything = Number.MAX_SAFE_INTEGER;
        const res =
          scope === 'media'
            ? deleteExpired(app.db, { messagesBefore: 0, mediaBefore: everything })
            : deleteExpired(app.db, { messagesBefore: everything, mediaBefore: everything });
        deletedMessages = res.deletedMessageIds.length;
        paths = res.mediaPathsToDelete;
      }
      const files = await removeFiles(app.cfg.paths.mediaDir, paths);
      try {
        pushEvent(app.db, 'cleanup_done', { deletedMessages, deletedMedia: files.deleted });
      } catch (err) {
        app.log.warn('cleanup_event_failed', errFields(err));
      }
      // F14: Namen und Nummernzuordnung liegen in der privaten Datei des Ingest. Das Web erreicht sie nicht selbst und
      // beauftragt den Ingest ueber die settings-Tabelle (der Befehl bleibt stehen, bis der Ingest laeuft).
      if (scope === 'all') {
        try {
          setSetting(app.db, 'ingest.state_command', 'clear_identity');
        } catch (err) {
          app.log.warn('identity_clear_command_failed', errFields(err));
        }
      }
      app.log.info('storage_cleared', { scope, deletedMessages, deletedMedia: files.deleted });
      sendJson(c.res, 200, { deletedMessages, deletedMedia: files.deleted, freedBytes: files.freedBytes });
    } finally {
      clearing = false;
    }
  });
}
