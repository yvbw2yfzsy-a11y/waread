/**
 * waread – Cleanup-Dienst
 *
 * Erzwingt die Aufbewahrungsregeln: löscht abgelaufene Nachrichten samt Medien
 * (Datei + Thumbnail, DB-Zeilen; der Suchindex folgt über den Trigger trg_messages_ad),
 * räumt verwaiste Dateien unter dem Media-Root auf und hält die SQLite-Datei klein
 * (WAL-Checkpoint, wöchentlich VACUUM).
 *
 * Aufruf (siehe README.md; gebaut nach dist/cleanup.js):
 *   node dist/cleanup.js            # stündlicher Lauf (systemd-Timer)
 *   node dist/cleanup.js --vacuum   # wie oben, danach VACUUM (wöchentlicher Timer)
 *   node dist/cleanup.js --dry-run  # nur zählen, nichts ändern, kein Event
 *
 * Datenbankzugriff: openDb/getSetting/pushEvent kommen aus dem gemeinsamen Modul @waread/db.
 * Die Löschläufe selbst sind eigenes SQL gegen die Vertragstabellen (db/client.ts deleteExpired
 * löscht die DB-Zeilen VOR den Dateien; hier ist die Reihenfolge absichtlich umgekehrt, siehe unten).
 *
 * Reihenfolge pro Stapel (crash-sicher, jeder Schritt ist wiederholbar):
 *   1. Dateien löschen (ENOENT = schon weg = gut)
 *   2. DB-Zeilen (media, messages; Suchindex per Trigger) in EINER Transaktion löschen
 * Bricht ein Lauf zwischen 1 und 2 ab, findet der nächste Lauf dieselben DB-Zeilen
 * wieder und holt Schritt 2 nach. Bleiben Dateien ohne DB-Zeile übrig, entfernt sie
 * der Orphan-Sweep nach einer Schonfrist.
 *
 * Der Dienst spricht nie mit WhatsApp und braucht keinen Ingest-Prozess.
 * Er liest/schreibt nur die SQLite-Datei und löscht nur unter dem Media-Root.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getSetting, openDb as openSharedDb, pushEvent, type Database as Db } from '@waread/db';
import { parse as parseToml } from 'smol-toml';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------
const DEFAULT_DB_PATH = '/var/lib/waread/db/waread.db';
const DEFAULT_MEDIA_ROOT = '/var/lib/waread/media';
const DEFAULT_CONFIG_FILE = '/etc/waread/config.toml';
const DAY_S = 86_400;
const DEFAULT_RETENTION_DAYS = 3;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_BATCH_SIZE = 500;
/** Dateien/Ordner jünger als das gelten nie als verwaist (Ingest schreibt Datei vor DB-Zeile). */
const DEFAULT_ORPHAN_GRACE_S = 3_600;
/** Ab so vielen gelöschten Zeilen (Nachrichten + Medien) folgt ein WAL-Checkpoint. */
const CHECKPOINT_MIN_ROWS = 100;
/** Unix-Sekunden liegen um 1,8e9, Millisekunden um 1,8e12. Darüber: falsche Einheit. */
const MS_TIMESTAMP_THRESHOLD = 1e11;
/** Orphan-Sweep-Notbremse: so viele 'ready'-Medien fehlen und mehr als dieser Anteil. */
const MISMATCH_MIN_MISSING = 5;
const MISMATCH_MAX_RATIO = 0.5;
/** Profilbild-Cache: gehört nicht zur Retention, der Sweep fasst ihn nicht an. */
const AVATARS_DIR = 'avatars';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface CleanupOptions {
  dbPath: string;
  mediaRoot: string;
  vacuum?: boolean;
  dryRun?: boolean;
  /** Aktuelle Zeit in Unix-Sekunden (für Tests). */
  now?: number;
  batchSize?: number;
  orphanGraceSeconds?: number;
  log?: Logger;
}

export interface CleanupResult {
  dryRun: boolean;
  retentionDays: number;
  retentionMediaDays: number;
  /** Gelöschte Nachrichten (im Dry-Run: Kandidaten). */
  deletedMessages: number;
  /** Medien-Einträge, deren Datei/Thumbnail entfernt wurde (gelöschte Nachricht oder abgelaufenes Medium). */
  deletedMedia: number;
  filesRemoved: number;
  filesAlreadyGone: number;
  fileErrors: number;
  orphansRemoved: number;
  emptyDirsRemoved: number;
  /** 'ready'-Medien, deren Datei auf der Platte fehlt (nur Information). */
  danglingReady: number;
  sweepSkipped: boolean;
  checkpointed: boolean;
  vacuumed: boolean;
  /** Nicht-fatale Fehler; main() liefert dann Exit-Code 1. */
  errors: string[];
}

interface Ctx {
  db: Db;
  log: Logger;
  res: CleanupResult;
  /** Media-Root wie konfiguriert (absolut). */
  root: string;
  /** realpath des Media-Roots: kanonische Basis für alle Pfadvergleiche. */
  realRoot: string;
  now: number;
  batch: number;
  grace: number;
}

interface MsgRow { rid: number; id: string }
interface MediaRow { rid: number; id: string; f: string | null; t: string | null }

// ---------------------------------------------------------------------------
// Datenbank öffnen
//
// Der Cleanup-Dienst legt nie eine Datenbank an (openDb aus @waread/db würde eine leere Datei
// erzeugen), führt keine Migrationen aus (das tun Ingest und Web beim Start) und wartet bei
// Sperren länger als der Standard (Ingest und Web schreiben parallel; VACUUM braucht Geduld).
// ---------------------------------------------------------------------------
const BUSY_TIMEOUT_MS = 15_000;

export function openExistingDb(dbPath: string): Db {
  if (!fs.existsSync(dbPath)) throw new Error(`Datenbank nicht vorhanden: ${dbPath} (der Cleanup-Dienst legt keine an)`);
  const db = openSharedDb(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

const consoleLogger: Logger = {
  info: (m) => console.log(`[cleanup] ${m}`),
  warn: (m) => console.error(`[cleanup] WARN ${m}`),
};

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * F17: Fuers Journal nie Klartext-Pfade und nie Fehlertexte. Im Pfad stecken die Chat-Kennung (bei WhatsApp eine
 * Telefonnummer oder Gruppen-Kennung) und der Dateiname; Node-Fehlertexte wiederholen den ganzen Pfad. Stattdessen:
 * der Fehlercode (z. B. EACCES) und eine Kurzkennung `pfad#xxxxxxxx`. Sie ist mit einem Salz pro Lauf gebildet:
 * Zeilen desselben Laufs lassen sich einander zuordnen, aus dem Journal laesst sich aber weder der Pfad
 * zurueckrechnen noch mit Kandidaten (Telefonnummern) abgleichen. Welche Datei gemeint ist, zeigt das Journal damit
 * bewusst nicht; der Lauf zaehlt die Fehler (file_errors).
 */
const RUN_SALT = randomBytes(8);

function pathTag(ctx: Pick<Ctx, 'root' | 'realRoot'>, p: string): string {
  const rel = relInside(ctx.realRoot, p) ?? relInside(ctx.root, p) ?? p;
  return 'pfad#' + createHash('sha256').update(RUN_SALT).update(rel).digest('hex').slice(0, 8);
}

function errTag(e: unknown): string {
  const code = errCode(e);
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'UNBEKANNT';
}

/** Relativer Pfad von base nach target, oder null wenn target nicht in base liegt. '' = gleich. */
function relInside(base: string, target: string): string | null {
  const rel = path.relative(base, target);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Bringt einen DB-Pfad (absolut oder relativ zum Media-Root) auf die kanonische Form
 * unter realRoot. null = liegt nicht unter dem Media-Root (oder ist der Root selbst).
 */
function canonPath(ctx: Pick<Ctx, 'root' | 'realRoot'>, p: string): string | null {
  const abs = path.resolve(ctx.root, p);
  for (const base of [ctx.root, ctx.realRoot]) {
    const rel = relInside(base, abs);
    if (rel !== null && rel !== '') return path.join(ctx.realRoot, rel);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
/** null = Einstellung fehlt (dann gilt der Default). Vorhanden, aber ungültig = Fehler, nichts wird gelöscht. */
function readRetentionDays(db: Db, key: string): number | null {
  const raw = getSetting(db, key);
  if (raw === null) return null;
  const v = raw.trim();
  const n = /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_DAYS) {
    throw new Error(`Einstellung ${key}="${raw}" ist ungültig (erwartet: ganze Zahl 1–${MAX_RETENTION_DAYS}). Abbruch, es wurde nichts gelöscht.`);
  }
  return n;
}

/** wa_timestamp muss in Unix-SEKUNDEN vorliegen. Bei Millisekunden würde man falsch rechnen. */
function assertSecondsTimestamps(db: Db): void {
  const row = db.prepare('SELECT max(wa_timestamp) AS m FROM messages').get() as { m: number | null };
  if (row.m !== null && row.m > MS_TIMESTAMP_THRESHOLD) {
    throw new Error(`wa_timestamp ${row.m} sieht nach Millisekunden aus; Cleanup erwartet Unix-Sekunden. Abbruch, es wurde nichts gelöscht.`);
  }
}

// ---------------------------------------------------------------------------
// Dateien löschen
// ---------------------------------------------------------------------------
type Outcome = 'removed' | 'gone' | 'refused' | 'error';

function removeTrackedFile(ctx: Ctx, p: string): Outcome {
  const abs = canonPath(ctx, p);
  if (abs === null) {
    ctx.log.warn(`Pfad liegt nicht unter dem Media-Root, wird nicht angefasst (${pathTag(ctx, p)})`);
    return 'refused';
  }
  try {
    // Symlink-Ausbruch verhindern: das echte Elternverzeichnis muss unter dem Root liegen.
    const realDir = fs.realpathSync(path.dirname(abs));
    if (relInside(ctx.realRoot, realDir) === null) {
      ctx.log.warn(`Elternverzeichnis zeigt aus dem Media-Root heraus, wird nicht angefasst (${pathTag(ctx, abs)})`);
      return 'refused';
    }
    fs.unlinkSync(abs);
    return 'removed';
  } catch (e) {
    if (errCode(e) === 'ENOENT') return 'gone';
    ctx.log.warn(`Löschen fehlgeschlagen (${pathTag(ctx, abs)}): ${errTag(e)}`);
    return 'error';
  }
}

/** ok=false, wenn mindestens eine Datei nicht gelöscht werden konnte (ENOENT zählt als gelöscht). */
function removeFiles(ctx: Ctx, paths: (string | null)[]): { ok: boolean; hadPath: boolean } {
  let ok = true;
  let hadPath = false;
  for (const p of paths) {
    if (!p) continue;
    hadPath = true;
    const o = removeTrackedFile(ctx, p);
    if (o === 'removed') ctx.res.filesRemoved++;
    else if (o === 'gone') ctx.res.filesAlreadyGone++;
    else {
      ok = false;
      ctx.res.fileErrors++;
    }
  }
  return { ok, hadPath };
}

// ---------------------------------------------------------------------------
// Phase D: abgelaufene Nachrichten (wa_timestamp < messagesBefore)
// ---------------------------------------------------------------------------
function purgeExpiredMessages(ctx: Ctx, before: number): void {
  const { db } = ctx;
  const selMsgs = db.prepare('SELECT rowid AS rid, id FROM messages WHERE wa_timestamp < ? ORDER BY rowid LIMIT ?');
  const selMedia = db.prepare('SELECT file_path AS f, thumbnail_path AS t FROM media WHERE message_id = ?');
  const delMedia = db.prepare('DELETE FROM media WHERE message_id = ?');
  const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
  const purge = db.transaction((rows: MsgRow[]): number => {
    let n = 0;
    for (const r of rows) {
      delMedia.run(r.id); // media vor messages wegen Fremdschlüssel
      // Suchindex (messages_fts, messages_fts_map): räumt der Trigger trg_messages_ad auf.
      n += delMsg.run(r.id).changes;
    }
    return n;
  });

  for (;;) {
    const rows = selMsgs.all(before, ctx.batch) as MsgRow[];
    if (rows.length === 0) return;
    for (const r of rows) {
      const m = selMedia.get(r.id) as { f: string | null; t: string | null } | undefined;
      if (!m) continue;
      // Datenschutz zuerst: DB-Zeilen werden auch gelöscht, wenn eine Datei klemmt.
      // Die Datei bleibt dann verwaist und wird vom Sweep erneut versucht.
      if (removeFiles(ctx, [m.f, m.t]).hadPath) ctx.res.deletedMedia++;
    }
    const n = purge.immediate(rows);
    ctx.res.deletedMessages += n;
    if (n === 0) return;
  }
}

// ---------------------------------------------------------------------------
// Phase M: Medien früher ablaufen lassen als Nachrichten (retentionMediaDays < retentionDays)
// Betrifft Nachrichten mit from <= wa_timestamp < to. Nachricht und FTS bleiben.
// ---------------------------------------------------------------------------
function expireMediaOnly(ctx: Ctx, from: number, to: number): void {
  const { db } = ctx;
  const sel = db.prepare(
    `SELECT m.rowid AS rid, m.message_id AS id, m.file_path AS f, m.thumbnail_path AS t
       FROM media m JOIN messages s ON s.id = m.message_id
      WHERE s.wa_timestamp >= ? AND s.wa_timestamp < ?
        AND (m.status IN ('pending','downloading','ready') OR m.file_path IS NOT NULL OR m.thumbnail_path IS NOT NULL)
        AND m.rowid > ?
      ORDER BY m.rowid LIMIT ?`,
  );
  const upd = db.prepare("UPDATE media SET status = 'expired', file_path = NULL, thumbnail_path = NULL WHERE message_id = ?");
  const apply = db.transaction((ids: string[]) => {
    for (const id of ids) upd.run(id);
  });

  // Keyset über rowid: Zeilen, deren Datei klemmt, bleiben stehen und blockieren die Schleife nicht.
  let after = 0;
  for (;;) {
    const rows = sel.all(from, to, after, ctx.batch) as MediaRow[];
    if (rows.length === 0) return;
    after = rows[rows.length - 1].rid;
    const done: string[] = [];
    for (const r of rows) {
      const { ok, hadPath } = removeFiles(ctx, [r.f, r.t]);
      if (!ok) continue; // Pfad bleibt in der DB, nächster Lauf versucht es erneut
      done.push(r.id);
      if (hadPath) ctx.res.deletedMedia++;
    }
    if (done.length > 0) apply.immediate(done);
  }
}

// ---------------------------------------------------------------------------
// Dry-Run: nur zählen
// ---------------------------------------------------------------------------
function countCandidates(ctx: Ctx, messagesBefore: number, mediaBefore: number): void {
  const count = (sql: string, ...p: number[]): number => (ctx.db.prepare(sql).get(...p) as { c: number }).c;
  const withPaths = '(m.file_path IS NOT NULL OR m.thumbnail_path IS NOT NULL)';
  ctx.res.deletedMessages = count('SELECT count(*) AS c FROM messages WHERE wa_timestamp < ?', messagesBefore);
  ctx.res.deletedMedia = count(
    `SELECT count(*) AS c FROM media m JOIN messages s ON s.id = m.message_id WHERE s.wa_timestamp < ? AND ${withPaths}`,
    messagesBefore,
  );
  if (mediaBefore > messagesBefore) {
    ctx.res.deletedMedia += count(
      `SELECT count(*) AS c FROM media m JOIN messages s ON s.id = m.message_id
        WHERE s.wa_timestamp >= ? AND s.wa_timestamp < ? AND ${withPaths}`,
      messagesBefore,
      mediaBefore,
    );
  }
}

// ---------------------------------------------------------------------------
// Orphan-Sweep: Dateien unter dem Media-Root ohne DB-Verweis
// ---------------------------------------------------------------------------
function sweepOrphans(ctx: Ctx, remove: boolean): void {
  const { db, res } = ctx;

  // Alles, was die DB noch kennt (kanonische Pfade).
  const referenced = new Set<string>();
  const addRef = (p: string | null): void => {
    if (!p) return;
    const c = canonPath(ctx, p);
    if (c !== null) referenced.add(c);
  };
  for (const r of db
    .prepare('SELECT file_path AS f, thumbnail_path AS t FROM media WHERE file_path IS NOT NULL OR thumbnail_path IS NOT NULL')
    .iterate() as Iterable<{ f: string | null; t: string | null }>) {
    addRef(r.f);
    addRef(r.t);
  }
  for (const r of db.prepare('SELECT avatar_path AS a FROM chats WHERE avatar_path IS NOT NULL').iterate() as Iterable<{ a: string }>) {
    addRef(r.a);
  }

  // Notbremse: Stimmt die Pfad-Konvention (oder der Speicher) nicht, würde ein Sweep
  // lebende Medien für verwaist halten. Dann fehlen die meisten 'ready'-Dateien.
  const ready = db.prepare("SELECT file_path AS f FROM media WHERE status = 'ready' AND file_path IS NOT NULL").all() as { f: string }[];
  let missing = 0;
  for (const r of ready) {
    const c = canonPath(ctx, r.f);
    if (c === null || !fs.existsSync(c)) missing++;
  }
  res.danglingReady = missing;
  if (missing >= MISMATCH_MIN_MISSING && missing / ready.length > MISMATCH_MAX_RATIO) {
    res.sweepSkipped = true;
    res.errors.push(
      `Orphan-Sweep übersprungen: ${missing} von ${ready.length} 'ready'-Medien fehlen auf der Platte ` +
        '(falscher Media-Root, andere Pfad-Konvention oder Speicher nicht eingehängt?)',
    );
    return;
  }

  const graceCut = ctx.now - ctx.grace;
  // Gibt true zurück, wenn das Verzeichnis entfernt wurde (im Dry-Run: würde).
  const walk = (dir: string, top: boolean): boolean => {
    let dirMtime: number;
    let entries: fs.Dirent[];
    try {
      dirMtime = fs.lstatSync(dir).mtimeMs / 1000; // vor dem Löschen der Kinder messen
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      ctx.log.warn(`Verzeichnis nicht lesbar (${pathTag(ctx, dir)}): ${errTag(e)}`);
      res.fileErrors++;
      return false;
    }
    let remaining = 0;
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (top && e.name === AVATARS_DIR) { remaining++; continue; }
      if (e.isDirectory()) {
        if (!walk(full, false)) remaining++;
        continue;
      }
      // Symlinks und Sonderdateien werden nie angefasst.
      if (!e.isFile() || referenced.has(full)) { remaining++; continue; }
      let mtime: number;
      try {
        mtime = fs.lstatSync(full).mtimeMs / 1000;
      } catch {
        continue; // zwischenzeitlich verschwunden
      }
      if (mtime > graceCut) { remaining++; continue; } // könnte gerade vom Ingest geschrieben werden
      if (remove) {
        try {
          fs.unlinkSync(full);
        } catch (err) {
          if (errCode(err) !== 'ENOENT') {
            ctx.log.warn(`Verwaiste Datei nicht löschbar (${pathTag(ctx, full)}): ${errTag(err)}`);
            res.fileErrors++;
            remaining++;
            continue;
          }
        }
      }
      res.orphansRemoved++;
    }
    if (!top && remaining === 0 && dirMtime <= graceCut) {
      if (remove) {
        try {
          fs.rmdirSync(dir);
        } catch (err) {
          if (errCode(err) !== 'ENOENT') {
            ctx.log.warn(`Leeres Verzeichnis nicht löschbar (${pathTag(ctx, dir)}): ${errTag(err)}`);
            return false;
          }
        }
      }
      res.emptyDirsRemoved++;
      return true;
    }
    return false;
  };
  walk(ctx.realRoot, true);
}

// ---------------------------------------------------------------------------
// Checkpoint / VACUUM
// ---------------------------------------------------------------------------
function checkpoint(ctx: Ctx): void {
  const rows = ctx.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
  if (rows[0]?.busy) ctx.log.warn('WAL-Checkpoint unvollständig (Leser aktiv); ein späterer Lauf holt das nach.');
  else ctx.res.checkpointed = true;
}

// ---------------------------------------------------------------------------
// Schutz der Wurzel (F09)
// ---------------------------------------------------------------------------
/**
 * Der Waisen-Sweep loescht jede Datei unter der Medien-Wurzel, die keine Zeile in der Datenbank hat. Zeigt media_dir
 * versehentlich auf das Datenverzeichnis (z. B. /var/lib/waread), waeren auth.db, waread.db und session.key "Waisen".
 * Deshalb verweigert der Lauf, wenn die Wurzel die Datenbank oder eines dieser Betriebsdaten-Elemente (obere Ebene) enthaelt.
 * Echte Medienordner enthalten nur Chat-Unterordner (bereinigte Chat-IDs), nie diese Namen.
 */
const PROTECTED_TOP_LEVEL_NAMES = ['auth', 'session.key', 'passkeys.json', 'ingest-state.db', 'ingest.lock', 'config.toml'];

function assertMediaRootIsSafe(realRoot: string, dbPath: string): void {
  let realDb: string;
  try {
    realDb = fs.realpathSync(dbPath);
  } catch {
    realDb = path.resolve(dbPath); // fehlende Datei meldet openExistingDb gleich selbst
  }
  if (realDb === realRoot || realDb.startsWith(realRoot + path.sep)) {
    throw new Error(`Media-Root enthält die Datenbank und ist kein Medienordner: ${realRoot}`);
  }
  for (const name of PROTECTED_TOP_LEVEL_NAMES) {
    if (fs.existsSync(path.join(realRoot, name))) {
      throw new Error(`Media-Root enthält "${name}" und ist kein Medienordner (Datenverzeichnis?): ${realRoot}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hauptablauf
// ---------------------------------------------------------------------------
export function runCleanup(opts: CleanupOptions): CleanupResult {
  const log = opts.log ?? consoleLogger;
  const started = Date.now();

  const root = path.resolve(opts.mediaRoot);
  if (path.parse(root).root === root) throw new Error('Media-Root darf nicht das Wurzelverzeichnis sein.');
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('kein Verzeichnis');
  } catch {
    throw new Error(`Media-Root nicht vorhanden oder kein Verzeichnis: ${root}`);
  }
  assertMediaRootIsSafe(realRoot, opts.dbPath);

  const db = openExistingDb(opts.dbPath);
  try {
    const days = readRetentionDays(db, 'retentionDays') ?? DEFAULT_RETENTION_DAYS;
    const mediaDays = readRetentionDays(db, 'retentionMediaDays') ?? days;
    assertSecondsTimestamps(db);

    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const messagesBefore = now - days * DAY_S;
    const mediaBefore = now - mediaDays * DAY_S;
    const dryRun = opts.dryRun ?? false;

    const res: CleanupResult = {
      dryRun,
      retentionDays: days,
      retentionMediaDays: mediaDays,
      deletedMessages: 0,
      deletedMedia: 0,
      filesRemoved: 0,
      filesAlreadyGone: 0,
      fileErrors: 0,
      orphansRemoved: 0,
      emptyDirsRemoved: 0,
      danglingReady: 0,
      sweepSkipped: false,
      checkpointed: false,
      vacuumed: false,
      errors: [],
    };
    const ctx: Ctx = {
      db,
      log,
      res,
      root,
      realRoot,
      now,
      batch: opts.batchSize ?? DEFAULT_BATCH_SIZE,
      grace: opts.orphanGraceSeconds ?? DEFAULT_ORPHAN_GRACE_S,
    };

    log.info(
      `Aufbewahrung: Nachrichten ${days} d (älter als ${new Date(messagesBefore * 1000).toISOString()}), ` +
        `Medien ${mediaDays} d${dryRun ? ' [DRY-RUN]' : ''}`,
    );

    if (dryRun) {
      countCandidates(ctx, messagesBefore, mediaBefore);
      sweepOrphans(ctx, false);
    } else {
      purgeExpiredMessages(ctx, messagesBefore);
      if (mediaBefore > messagesBefore) expireMediaOnly(ctx, messagesBefore, mediaBefore);
      sweepOrphans(ctx, true);
      if (res.deletedMessages + res.deletedMedia >= CHECKPOINT_MIN_ROWS) checkpoint(ctx);
      if (opts.vacuum) {
        db.exec('VACUUM');
        res.vacuumed = true;
        checkpoint(ctx); // VACUUM läuft über das WAL und bläht es auf
      }
      pushEvent(db, 'cleanup_done', {
        deletedMessages: res.deletedMessages,
        deletedMedia: res.deletedMedia,
        orphansRemoved: res.orphansRemoved,
        vacuumed: res.vacuumed,
        fileErrors: res.fileErrors,
        at: now,
      });
    }

    if (res.fileErrors > 0) res.errors.push(`${res.fileErrors} Datei(en)/Verzeichnis(se) konnten nicht gelöscht werden (Details oben als WARN).`);
    log.info(
      `Lauf beendet: messages=${res.deletedMessages} media=${res.deletedMedia} files_removed=${res.filesRemoved} ` +
        `files_already_gone=${res.filesAlreadyGone} orphans=${res.orphansRemoved} empty_dirs=${res.emptyDirsRemoved} ` +
        `file_errors=${res.fileErrors} dangling_ready=${res.danglingReady} vacuum=${res.vacuumed ? 'ja' : 'nein'} ` +
        `dry_run=${dryRun ? 'ja' : 'nein'} dauer_ms=${Date.now() - started} rss_mb=${Math.round(process.memoryUsage().rss / 1048576)}`,
    );
    return res;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USAGE = `Aufruf: node dist/cleanup.js [--vacuum] [--dry-run] [--db PFAD] [--media-root PFAD]

  --vacuum           nach dem normalen Lauf VACUUM ausführen (wöchentlich)
  --dry-run          nur zählen und melden, nichts ändern, kein Event
  --db PFAD          SQLite-Datei   (sonst $WAREAD_DB, sonst [paths] db aus der Konfiguration, sonst ${DEFAULT_DB_PATH})
  --media-root PFAD  Medienordner   (sonst $WAREAD_MEDIA_ROOT, sonst [paths] media_dir, sonst ${DEFAULT_MEDIA_ROOT})

Konfigurationsdatei: $WAREAD_CONFIG oder ${DEFAULT_CONFIG_FILE}. Fehlt sie, gelten die Standardpfade;
ist sie vorhanden, aber kein gültiges TOML, bricht der Lauf mit Exit 1 ab.

Exit-Codes: 0 ok, 1 Fehler (auch nicht-fatale wie nicht löschbare Dateien), 2 falsche Argumente.`;

/**
 * Liest [paths] db und media_dir aus der gemeinsamen config.toml (dieselben Schlüssel wie Ingest und Web).
 * Fehlende Datei = keine Angaben. Eine vorhandene, aber kaputte Datei ist ein Fehler: Still auf Standardpfade
 * zurückzufallen könnte eine andere Datenbank aufräumen, als die Dienste benutzen.
 */
export function readPathsFromConfig(env: NodeJS.ProcessEnv): { db?: string; mediaRoot?: string } {
  const file = env.WAREAD_CONFIG ?? DEFAULT_CONFIG_FILE;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return {};
    throw new Error(`Konfiguration nicht lesbar: ${file}: ${errMsg(e)}`);
  }
  let root: Record<string, unknown>;
  try {
    root = parseToml(text) as Record<string, unknown>;
  } catch {
    // Parser-Fehlertexte können Dateiinhalt zitieren (Passwort-Hash): bewusst nicht weitergereicht.
    throw new Error(`Konfiguration ist kein gültiges TOML: ${file}`);
  }
  const paths = root.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return {};
  const p = paths as Record<string, unknown>;
  const out: { db?: string; mediaRoot?: string } = {};
  if (typeof p.db === 'string' && p.db !== '') out.db = p.db;
  if (typeof p.media_dir === 'string' && p.media_dir !== '') out.mediaRoot = p.media_dir;
  return out;
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let values: { vacuum?: boolean; 'dry-run'?: boolean; db?: string; 'media-root'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        vacuum: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        db: { type: 'string' },
        'media-root': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`${errMsg(e)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    // Reihenfolge: Kommandozeile, Umgebung, Konfigurationsdatei, Standard. Die Datei wird nur gelesen, wenn nötig.
    const needsConfig = !(values.db ?? env.WAREAD_DB) || !(values['media-root'] ?? env.WAREAD_MEDIA_ROOT);
    const cfg = needsConfig ? readPathsFromConfig(env) : {};
    const res = runCleanup({
      dbPath: values.db ?? env.WAREAD_DB ?? cfg.db ?? DEFAULT_DB_PATH,
      mediaRoot: values['media-root'] ?? env.WAREAD_MEDIA_ROOT ?? cfg.mediaRoot ?? DEFAULT_MEDIA_ROOT,
      vacuum: values.vacuum ?? false,
      dryRun: values['dry-run'] ?? false,
    });
    for (const e of res.errors) console.error(`[cleanup] FEHLER ${e}`);
    return res.errors.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`[cleanup] FEHLER ${errMsg(e)}`);
    return 1;
  }
}

/** True, wenn die Datei direkt gestartet wurde (auch über den Symlink /opt/waread/current). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
