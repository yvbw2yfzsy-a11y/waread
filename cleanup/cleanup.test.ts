/**
 * Tests für cleanup.ts. Laufen gegen eine echte SQLite-Datei (mit FTS5, WAL, Fremdschlüsseln)
 * in einem Temp-Verzeichnis. Das Schema kommt aus db/schema.sql (über runMigrations aus @waread/db),
 * also samt Triggern und messages_fts_map: Der Suchindex wird nicht von Hand gepflegt.
 *   npm test -w waread-cleanup     (node --import tsx --test cleanup.test.ts)
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations, type Database } from '@waread/db';
import { readPathsFromConfig, runCleanup, type CleanupOptions, type CleanupResult } from './cleanup.ts';

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const D = 86400;
const silent = { info() {}, warn() {} };
const CLEANUP_TS = fileURLToPath(new URL('./cleanup.ts', import.meta.url));

interface Env { dir: string; dbPath: string; root: string; db: Database; destroy(): void }

function makeEnv(): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waread-cleanup-'));
  const dbPath = path.join(dir, 'waread.db');
  const root = path.join(dir, 'media');
  fs.mkdirSync(root);
  const db = openDb(dbPath); // WAL + foreign_keys wie im Betrieb
  runMigrations(db);
  db.prepare("INSERT INTO chats (id, name, is_group, last_activity_at) VALUES ('c1', 'Alice', 0, ?)").run(NOW);
  return {
    dir, dbPath, root, db,
    destroy() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withEnv(fn: (env: Env) => void | Promise<void>) {
  return async () => {
    const env = makeEnv();
    try {
      await fn(env);
    } finally {
      env.destroy();
    }
  };
}

interface MsgOpts {
  text?: string;
  receivedAt?: number;
  /** Datei relativ zum Media-Root; wird angelegt. */
  file?: string;
  thumb?: string;
  status?: string;
  /** Pfade relativ in die DB schreiben statt absolut. */
  storeRelative?: boolean;
  /** Beliebiger file_path ohne Datei (für Pfad-Sicherheitstests). */
  rawPath?: string;
}

/** Legt Nachricht + optional Media-Zeile samt Dateien an. Der Suchindex entsteht über die Trigger des Schemas. */
function addMsg(env: Env, id: string, waTs: number, o: MsgOpts = {}): void {
  const text = o.text ?? `text ${id}`;
  const hasMedia = Boolean(o.file || o.rawPath);
  env.db
    .prepare(
      `INSERT INTO messages (id, chat_id, sender, wa_timestamp, received_at, direction, type, text)
       VALUES (?, 'c1', 'bob', ?, ?, 'in', ?, ?)`,
    )
    .run(id, waTs, o.receivedAt ?? NOW, hasMedia ? 'image' : 'text', text);
  if (!hasMedia) return;
  const mk = (rel: string): string => {
    const abs = path.join(env.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x'.repeat(10));
    return o.storeRelative ? rel : abs;
  };
  const filePath = o.rawPath ?? mk(o.file as string);
  const thumbPath = o.thumb ? mk(o.thumb) : null;
  env.db
    .prepare("INSERT INTO media (message_id, file_path, thumbnail_path, mime_type, size_bytes, status) VALUES (?, ?, ?, 'image/jpeg', 10, ?)")
    .run(id, filePath, thumbPath, o.status ?? 'ready');
}

function bulk(env: Env, fn: () => void): void {
  env.db.exec('BEGIN');
  try {
    fn();
    env.db.exec('COMMIT');
  } catch (e) {
    env.db.exec('ROLLBACK');
    throw e;
  }
}

const abs = (env: Env, rel: string): string => path.join(env.root, rel);
const exists = (env: Env, rel: string): boolean => fs.existsSync(abs(env, rel));
const num = (env: Env, sql: string, ...p: unknown[]): number => (env.db.prepare(sql).get(...p) as { c: number }).c;
const setSetting = (env: Env, k: string, v: string): void => {
  env.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
};
const run = (env: Env, extra: Partial<CleanupOptions> = {}): CleanupResult =>
  runCleanup({ dbPath: env.dbPath, mediaRoot: env.root, now: NOW, log: silent, ...extra });
/** Datei/Ordner künstlich altern lassen. */
const age = (p: string, ageS: number): void => fs.utimesSync(p, NOW - ageS, NOW - ageS);

// ---------------------------------------------------------------------------
// Kernverhalten
// ---------------------------------------------------------------------------
test(
  'löscht nach wa_timestamp (nicht received_at): Zeile, FTS-Eintrag, Datei, Thumbnail; zweiter Lauf ist ein No-Op',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { text: 'altehallo', file: 'c1/d1/old.jpg', thumb: 'c1/d1/old.thumb.jpg', receivedAt: NOW });
    addMsg(env, 'young', NOW - 1 * D, { text: 'neuehallo', file: 'c1/d2/young.jpg', receivedAt: NOW - 10 * D });

    const res = run(env); // Default: 3 Tage
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'old'"), 0);
    assert.equal(num(env, "SELECT count(*) AS c FROM media WHERE message_id = 'old'"), 0);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'altehallo'"), 0);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts'), 1);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts_map'), 1); // auch die Zuordnung ist aufgeräumt
    assert.equal(exists(env, 'c1/d1/old.jpg'), false);
    assert.equal(exists(env, 'c1/d1/old.thumb.jpg'), false);
    // junge Nachricht (alter Empfangszeitpunkt!) bleibt komplett erhalten
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'young'"), 1);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'neuehallo'"), 1);
    assert.equal(exists(env, 'c1/d2/young.jpg'), true);

    assert.equal(res.deletedMessages, 1);
    assert.equal(res.deletedMedia, 1);
    assert.equal(res.filesRemoved, 2);
    assert.deepEqual(res.errors, []);

    const ev = env.db.prepare('SELECT type, payload_json FROM events_outbox').all() as { type: string; payload_json: string }[];
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'cleanup_done');
    const payload = JSON.parse(ev[0].payload_json);
    assert.equal(payload.deletedMessages, 1);
    assert.equal(payload.deletedMedia, 1);

    const again = run(env);
    assert.equal(again.deletedMessages, 0);
    assert.deepEqual(again.errors, []);
  }),
);

test(
  'Einstellung retentionDays steuert die Grenze',
  withEnv((env) => {
    addMsg(env, 'five', NOW - 5 * D);
    setSetting(env, 'retentionDays', '7');
    run(env);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 1);
    setSetting(env, 'retentionDays', '3');
    run(env);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);
  }),
);

test(
  'retentionMediaDays kürzer: Datei weg, Medium "expired", Nachricht und FTS bleiben',
  withEnv((env) => {
    setSetting(env, 'retentionDays', '7');
    setSetting(env, 'retentionMediaDays', '1');
    addMsg(env, 'a', NOW - 2 * D, { text: 'alphatext', file: 'c1/a.jpg', thumb: 'c1/a.thumb.jpg' });
    addMsg(env, 'b', NOW - 12 * H, { file: 'c1/b.jpg' });

    const res = run(env);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 2);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'alphatext'"), 1);
    const a = env.db.prepare("SELECT status, file_path, thumbnail_path FROM media WHERE message_id = 'a'").get() as Record<string, unknown>;
    assert.deepEqual({ ...a }, { status: 'expired', file_path: null, thumbnail_path: null });
    assert.equal(exists(env, 'c1/a.jpg'), false);
    assert.equal(exists(env, 'c1/a.thumb.jpg'), false);
    assert.equal(num(env, "SELECT count(*) AS c FROM media WHERE message_id = 'b' AND status = 'ready'"), 1);
    assert.equal(exists(env, 'c1/b.jpg'), true);
    assert.equal(res.deletedMedia, 1);
    assert.equal(res.deletedMessages, 0);
  }),
);

test(
  'retentionMediaDays länger als retentionDays: Medium überlebt die Nachricht nicht',
  withEnv((env) => {
    setSetting(env, 'retentionDays', '1');
    setSetting(env, 'retentionMediaDays', '30');
    addMsg(env, 'old', NOW - 2 * D, { file: 'c1/old.jpg' });
    run(env);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);
    assert.equal(num(env, 'SELECT count(*) AS c FROM media'), 0);
    assert.equal(exists(env, 'c1/old.jpg'), false);
  }),
);

test(
  'viele Nachrichten werden über mehrere Stapel gelöscht',
  withEnv((env) => {
    for (let i = 0; i < 10; i++) addMsg(env, `m${i}`, NOW - 4 * D - i, { file: `c1/m${i}.jpg` });
    const res = run(env, { batchSize: 3 });
    assert.equal(res.deletedMessages, 10);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts'), 0);
    for (let i = 0; i < 10; i++) assert.equal(exists(env, `c1/m${i}.jpg`), false);
  }),
);

test(
  'relative Pfade in der DB werden gegen den Media-Root aufgelöst',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { file: 'c1/rel-old.jpg', storeRelative: true });
    addMsg(env, 'young', NOW - 1 * H, { file: 'c1/rel-young.jpg', storeRelative: true });
    age(abs(env, 'c1/rel-young.jpg'), 5 * H); // alt genug für den Sweep: nur der DB-Verweis schützt sie
    run(env);
    assert.equal(exists(env, 'c1/rel-old.jpg'), false);
    assert.equal(exists(env, 'c1/rel-young.jpg'), true);
  }),
);

// ---------------------------------------------------------------------------
// Crash-Sicherheit (Resume)
// ---------------------------------------------------------------------------
test(
  'Resume A: Dateien schon weg, DB-Zeilen noch da -> nächster Lauf räumt die DB auf',
  withEnv((env) => {
    setSetting(env, 'retentionMediaDays', '1'); // zusätzlich Fall "abgelaufenes Medium, Nachricht bleibt"
    addMsg(env, 'old', NOW - 4 * D, { file: 'c1/o.jpg', thumb: 'c1/o.thumb.jpg' });
    addMsg(env, 'mid', NOW - 2 * D, { file: 'c1/m.jpg' });
    for (const f of ['c1/o.jpg', 'c1/o.thumb.jpg', 'c1/m.jpg']) fs.rmSync(abs(env, f)); // Absturz nach Schritt 1

    const res = run(env);
    assert.deepEqual(res.errors, []);
    assert.equal(res.fileErrors, 0);
    assert.equal(res.filesAlreadyGone, 3);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'old'"), 0);
    assert.equal(num(env, "SELECT count(*) AS c FROM media WHERE message_id = 'old'"), 0);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts'), 1);
    const mid = env.db.prepare("SELECT status, file_path FROM media WHERE message_id = 'mid'").get() as Record<string, unknown>;
    assert.deepEqual({ ...mid }, { status: 'expired', file_path: null });
  }),
);

test(
  'Resume B: DB-Zeilen weg, Dateien übrig -> Sweep entfernt sie erst nach der Schonfrist',
  withEnv((env) => {
    fs.mkdirSync(abs(env, 'c1/d1'), { recursive: true });
    fs.writeFileSync(abs(env, 'c1/d1/old-orphan.jpg'), 'x');
    fs.writeFileSync(abs(env, 'c1/d1/fresh-orphan.jpg'), 'x');
    age(abs(env, 'c1/d1/old-orphan.jpg'), 2 * H);
    age(abs(env, 'c1/d1/fresh-orphan.jpg'), 30 * 60); // innerhalb der Schonfrist (60 min)

    const first = run(env);
    assert.equal(first.orphansRemoved, 1);
    assert.equal(exists(env, 'c1/d1/old-orphan.jpg'), false);
    assert.equal(exists(env, 'c1/d1/fresh-orphan.jpg'), true); // könnte der Ingest gerade schreiben

    const later = run(env, { now: NOW + 2 * H });
    assert.equal(later.orphansRemoved, 1);
    assert.equal(exists(env, 'c1/d1/fresh-orphan.jpg'), false);
  }),
);

// ---------------------------------------------------------------------------
// Orphan-Sweep und Sicherheitsnetze
// ---------------------------------------------------------------------------
test(
  'Sweep: referenzierte Dateien, avatars/ und Symlinks bleiben; alte leere Ordner gehen, frische bleiben',
  withEnv((env) => {
    addMsg(env, 'young', NOW - 1 * H, { file: 'c1/keep/young.jpg' });
    age(abs(env, 'c1/keep/young.jpg'), 5 * H);
    fs.mkdirSync(abs(env, 'avatars'));
    fs.writeFileSync(abs(env, 'avatars/x.jpg'), 'x');
    age(abs(env, 'avatars/x.jpg'), 5 * H);
    const outsideFile = path.join(env.dir, 'outside.txt');
    fs.writeFileSync(outsideFile, 'geheim');
    fs.symlinkSync(outsideFile, abs(env, 'c1/link.jpg'));
    fs.mkdirSync(abs(env, 'c1/olddir'));
    fs.writeFileSync(abs(env, 'c1/olddir/o.jpg'), 'x');
    age(abs(env, 'c1/olddir/o.jpg'), 5 * H);
    age(abs(env, 'c1/olddir'), 5 * H);
    fs.mkdirSync(abs(env, 'c1/freshdir'));
    age(abs(env, 'c1/freshdir'), 30 * 60); // leer, aber innerhalb der Schonfrist

    const res = run(env);
    assert.equal(exists(env, 'c1/keep/young.jpg'), true);
    assert.equal(exists(env, 'avatars/x.jpg'), true);
    assert.equal(fs.lstatSync(abs(env, 'c1/link.jpg')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'geheim');
    assert.equal(exists(env, 'c1/olddir'), false);
    assert.equal(exists(env, 'c1/freshdir'), true);
    assert.equal(res.orphansRemoved, 1);
    assert.equal(res.emptyDirsRemoved, 1);
  }),
);

test(
  'Pfade außerhalb des Media-Roots (absolut oder per Symlink) werden nie gelöscht; Nachricht verschwindet trotzdem',
  withEnv((env) => {
    const outside = path.join(env.dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'a.txt'), 'a');
    fs.writeFileSync(path.join(outside, 'b.txt'), 'b');
    fs.symlinkSync(outside, abs(env, 'link')); // Ordner im Root zeigt nach draußen
    addMsg(env, 'o1', NOW - 4 * D, { rawPath: path.join(outside, 'a.txt') });
    addMsg(env, 'o2', NOW - 4 * D, { rawPath: abs(env, 'link/b.txt') });

    const res = run(env);
    assert.equal(fs.existsSync(path.join(outside, 'a.txt')), true);
    assert.equal(fs.existsSync(path.join(outside, 'b.txt')), true);
    assert.equal(res.fileErrors, 2);
    assert.ok(res.errors.length >= 1);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0); // Retention geht vor
  }),
);

test(
  'Notbremse: fehlen die meisten ready-Dateien (falsche Pfad-Konvention/Speicher), überspringt der Sweep alles',
  withEnv((env) => {
    for (let i = 0; i < 6; i++) addMsg(env, `r${i}`, NOW - 1 * H, { file: `c1/r${i}.jpg` });
    for (let i = 0; i < 6; i++) fs.rmSync(abs(env, `c1/r${i}.jpg`));
    fs.writeFileSync(abs(env, 'c1/stray.jpg'), 'x');
    age(abs(env, 'c1/stray.jpg'), 5 * H);

    const res = run(env);
    assert.equal(res.sweepSkipped, true);
    assert.equal(res.danglingReady, 6);
    assert.match(res.errors[0], /Sweep übersprungen/);
    assert.equal(exists(env, 'c1/stray.jpg'), true);
  }),
);

test(
  'Millisekunden-Zeitstempel: Abbruch, nichts gelöscht',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D);
    addMsg(env, 'ms', NOW * 1000);
    assert.throws(() => run(env), /Millisekunden/);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 2);
  }),
);

test(
  'ungültige Einstellung: Abbruch, nichts gelöscht',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 40 * D);
    for (const v of ['abc', '0', '-1', '99999', '3 Tage', '']) {
      setSetting(env, 'retentionDays', v);
      assert.throws(() => run(env), /ungültig/, `retentionDays=${JSON.stringify(v)}`);
    }
    setSetting(env, 'retentionDays', '3');
    setSetting(env, 'retentionMediaDays', 'x');
    assert.throws(() => run(env), /retentionMediaDays/);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 1);
  }),
);

test(
  'Dry-Run meldet Kandidaten, ändert nichts und schreibt kein Event',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { file: 'c1/old.jpg' });
    fs.writeFileSync(abs(env, 'c1/orphan.jpg'), 'x');
    age(abs(env, 'c1/orphan.jpg'), 5 * H);

    const res = run(env, { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.deletedMessages, 1);
    assert.equal(res.deletedMedia, 1);
    assert.equal(res.orphansRemoved, 1);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 1);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts'), 1);
    assert.equal(exists(env, 'c1/old.jpg'), true);
    assert.equal(exists(env, 'c1/orphan.jpg'), true);
    assert.equal(num(env, 'SELECT count(*) AS c FROM events_outbox'), 0);
  }),
);

// ---------------------------------------------------------------------------
// VACUUM
// ---------------------------------------------------------------------------
test(
  'VACUUM nur mit vacuum:true: normaler Lauf lässt freie Seiten stehen, Vacuum-Lauf räumt sie weg',
  withEnv((env) => {
    bulk(env, () => {
      for (let i = 0; i < 300; i++) addMsg(env, `m${i}`, NOW - 5 * D, { text: 'x'.repeat(2000) });
    });
    const hourly = run(env);
    assert.equal(hourly.deletedMessages, 300);
    assert.equal(hourly.vacuumed, false);
    assert.ok((env.db.pragma('freelist_count', { simple: true }) as number) > 0);

    const weekly = run(env, { vacuum: true });
    assert.equal(weekly.vacuumed, true);
    assert.equal(env.db.pragma('freelist_count', { simple: true }), 0);
  }),
);

// ---------------------------------------------------------------------------
// CLI (über einen Symlink gestartet, wie /opt/waread/current es tun würde)
// ---------------------------------------------------------------------------
/** Die CLI-Tests starten cleanup.ts direkt; tsx übersetzt (im Betrieb läuft das gebaute dist/cleanup.js). */
const TSX = ['--import', 'tsx'];

function cliLink(env: Env): string {
  const link = path.join(env.dir, 'current-cleanup.ts');
  fs.symlinkSync(CLEANUP_TS, link);
  return link;
}

test(
  'CLI: Flags, Exit-Code 0, Zusammenfassung auf stdout; Start über Symlink',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { file: 'c1/old.jpg' });
    const r = spawnSync(process.execPath, [...TSX, cliLink(env), '--db', env.dbPath, '--media-root', env.root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Lauf beendet: messages=1 /);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);
    assert.equal(exists(env, 'c1/old.jpg'), false);
  }),
);

test(
  'CLI: Umgebungsvariablen als Fallback; Exit 1 bei fehlender DB, Exit 2 bei unbekanntem Flag',
  withEnv((env) => {
    const link = cliLink(env);
    addMsg(env, 'old', NOW - 4 * D);
    const viaEnv = spawnSync(process.execPath, [...TSX, link], {
      encoding: 'utf8',
      env: { ...process.env, WAREAD_DB: env.dbPath, WAREAD_MEDIA_ROOT: env.root },
    });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);

    const noDb = spawnSync(process.execPath, [...TSX, link, '--db', path.join(env.dir, 'gibt-es-nicht.db'), '--media-root', env.root], { encoding: 'utf8' });
    assert.equal(noDb.status, 1);
    assert.match(noDb.stderr, /FEHLER/);
    assert.equal(fs.existsSync(path.join(env.dir, 'gibt-es-nicht.db')), false); // legt keine leere DB an

    const badFlag = spawnSync(process.execPath, [...TSX, link, '--quatsch'], { encoding: 'utf8' });
    assert.equal(badFlag.status, 2);
  }),
);

test(
  'CLI: zwei gleichzeitig gestartete Läufe enden beide mit Exit 0 und konsistentem Ergebnis',
  withEnv(async (env) => {
    const link = cliLink(env);
    bulk(env, () => {
      for (let i = 0; i < 4000; i++) addMsg(env, `m${i}`, NOW - 5 * D);
    });
    const start = (): Promise<number | null> =>
      new Promise((resolve) => {
        spawn(process.execPath, [...TSX, link, '--db', env.dbPath, '--media-root', env.root], { stdio: 'ignore' }).on('close', resolve);
      });
    const codes = await Promise.all([start(), start()]);
    assert.deepEqual(codes, [0, 0]);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages_fts'), 0);
    assert.ok(num(env, "SELECT count(*) AS c FROM events_outbox WHERE type = 'cleanup_done'") >= 2);
  }),
);

// ---------------------------------------------------------------------------
// Pfade aus der gemeinsamen config.toml
// ---------------------------------------------------------------------------
test(
  'Konfiguration: [paths] db/media_dir werden gelesen; fehlende Datei = keine Angaben; kaputtes TOML = Fehler ohne Inhalt',
  withEnv((env) => {
    const cfg = path.join(env.dir, 'config.toml');
    assert.deepEqual(readPathsFromConfig({ WAREAD_CONFIG: path.join(env.dir, 'gibt-es-nicht.toml') }), {});
    fs.writeFileSync(cfg, '[paths]\ndb = "/a/b.db"\nmedia_dir = "/a/media"\n[web]\npassword_hash = "$argon2id$GEHEIM"\n');
    assert.deepEqual(readPathsFromConfig({ WAREAD_CONFIG: cfg }), { db: '/a/b.db', mediaRoot: '/a/media' });
    fs.writeFileSync(cfg, '[web]\nport = 1\n');
    assert.deepEqual(readPathsFromConfig({ WAREAD_CONFIG: cfg }), {});
    fs.writeFileSync(cfg, '[paths\npassword_hash = "$argon2id$GEHEIM"\n');
    assert.throws(() => readPathsFromConfig({ WAREAD_CONFIG: cfg }), (e: Error) => /kein gültiges TOML/.test(e.message) && !e.message.includes('GEHEIM'));
  }),
);

test(
  'CLI: ohne --db/--media-root/Umgebung gelten die Pfade aus der Konfigurationsdatei; Kommandozeile und Umgebung haben Vorrang',
  withEnv((env) => {
    const link = cliLink(env);
    const cfg = path.join(env.dir, 'config.toml');
    fs.writeFileSync(cfg, `[paths]\ndb = ${JSON.stringify(env.dbPath)}\nmedia_dir = ${JSON.stringify(env.root)}\n`);
    addMsg(env, 'old', NOW - 4 * D);
    const base: NodeJS.ProcessEnv = { ...process.env, WAREAD_CONFIG: cfg };
    delete base.WAREAD_DB;
    delete base.WAREAD_MEDIA_ROOT;
    const viaCfg = spawnSync(process.execPath, [...TSX, link], { encoding: 'utf8', env: base });
    assert.equal(viaCfg.status, 0, viaCfg.stderr);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 0);

    // Umgebung schlägt Konfiguration: falsche Umgebungs-DB -> Fehler (die Konfig-DB bleibt unberührt)
    addMsg(env, 'old2', NOW - 4 * D);
    const wrong = spawnSync(process.execPath, [...TSX, link], { encoding: 'utf8', env: { ...base, WAREAD_DB: path.join(env.dir, 'nein.db') } });
    assert.equal(wrong.status, 1);
    assert.equal(num(env, 'SELECT count(*) AS c FROM messages'), 1);
  }),
);

// ---------------------------------------------------------------------------
// F09: media_dir darf nie das Datenverzeichnis (mit Datenbank und Sitzung) sein
// ---------------------------------------------------------------------------
/** Datenverzeichnis wie im Betrieb: auth/auth.db, db/waread.db, media/..., session.key. Alles alt genug fuer den Waisen-Sweep. */
function dataLayout(env: Env): { data: string; files: string[] } {
  const data = path.join(env.dir, 'data');
  const files = ['auth/auth.db', 'db/waread.db', 'media/c1/foto.jpg', 'session.key'];
  for (const f of files) {
    const p = path.join(data, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(10));
    age(p, 3 * D);
  }
  return { data, files };
}

test(
  'F09: media_dir = Datenverzeichnis (enthaelt auth/, session.key und die Datenbank) -> Lauf verweigert, nichts geloescht',
  withEnv((env) => {
    const { data, files } = dataLayout(env);
    assert.throws(
      () => runCleanup({ dbPath: path.join(data, 'db', 'waread.db'), mediaRoot: data, log: silent }),
      (e: Error) => /Media-Root/.test(e.message),
    );
    for (const f of files) assert.ok(fs.existsSync(path.join(data, f)), `${f} muss erhalten bleiben`);
  }),
);

test(
  'F09: media_dir enthaelt die Datenbank (auch ohne auth/) -> verweigert',
  withEnv((env) => {
    // env.dir enthaelt waread.db und media/
    fs.writeFileSync(path.join(env.root, 'alt.jpg'), 'x');
    age(path.join(env.root, 'alt.jpg'), 3 * D);
    assert.throws(() => runCleanup({ dbPath: env.dbPath, mediaRoot: env.dir, log: silent }), (e: Error) => /Media-Root/.test(e.message));
    assert.ok(fs.existsSync(path.join(env.root, 'alt.jpg')));
  }),
);

test(
  'F09: media_dir mit session.key, auth oder passkeys.json obendrauf (Datenbank liegt woanders) -> verweigert',
  withEnv((env) => {
    for (const marker of ['session.key', 'auth', 'passkeys.json', 'ingest-state.db']) {
      const root = path.join(env.dir, `root-${marker}`);
      fs.mkdirSync(root);
      const m = path.join(root, marker);
      if (marker === 'auth') fs.mkdirSync(m);
      else fs.writeFileSync(m, 'x');
      assert.throws(() => runCleanup({ dbPath: env.dbPath, mediaRoot: root, log: silent }), (e: Error) => /Media-Root/.test(e.message), marker);
      assert.ok(fs.existsSync(m), `${marker} muss erhalten bleiben`);
    }
  }),
);

test(
  'F09: auch ueber einen Symlink auf das Datenverzeichnis wird verweigert',
  withEnv((env) => {
    const { data, files } = dataLayout(env);
    const link = path.join(env.dir, 'medien-link');
    fs.symlinkSync(data, link);
    assert.throws(() => runCleanup({ dbPath: path.join(data, 'db', 'waread.db'), mediaRoot: link, log: silent }), (e: Error) => /Media-Root/.test(e.message));
    for (const f of files) assert.ok(fs.existsSync(path.join(data, f)));
  }),
);

test(
  'F09: der normale Aufbau (media/ als Unterordner neben auth/) laeuft weiter: Waise im Medienordner wird entfernt, auth/ bleibt',
  withEnv((env) => {
    const { data } = dataLayout(env);
    const res = runCleanup({ dbPath: env.dbPath, mediaRoot: path.join(data, 'media'), log: silent, now: NOW });
    assert.equal(res.orphansRemoved, 1);
    assert.equal(fs.existsSync(path.join(data, 'media', 'c1', 'foto.jpg')), false);
    for (const f of ['auth/auth.db', 'session.key']) assert.ok(fs.existsSync(path.join(data, f)));
  }),
);

// ---------------------------------------------------------------------------
// F18/O4: Grenzfaelle der Aufbewahrung (Vergleich "wa_timestamp < Grenze": genau auf der Grenze bleibt die Nachricht)
// ---------------------------------------------------------------------------
test(
  'F18/O4: genau 3 Tage alt bleibt, eine Sekunde aelter wird geloescht',
  withEnv((env) => {
    addMsg(env, 'edge', NOW - 3 * D, { text: 'randhallo', file: 'c1/d1/edge.jpg' });
    addMsg(env, 'over', NOW - 3 * D - 1, { text: 'drueberhallo', file: 'c1/d1/over.jpg' });
    run(env);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'edge'"), 1);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'over'"), 0);
    assert.equal(exists(env, 'c1/d1/edge.jpg'), true);
    assert.equal(exists(env, 'c1/d1/over.jpg'), false);
  }),
);

test(
  'F18/O4: dieselbe Grenze bei 14 Tagen (Einstellung retentionDays), auch fuer Medien (retentionMediaDays)',
  withEnv((env) => {
    setSetting(env, 'retentionDays', '14');
    setSetting(env, 'retentionMediaDays', '7');
    addMsg(env, 'edge', NOW - 14 * D, { file: 'c1/d1/edge.jpg' });
    addMsg(env, 'over', NOW - 14 * D - 1, { file: 'c1/d1/over.jpg' });
    addMsg(env, 'medge', NOW - 7 * D, { file: 'c1/d2/medge.jpg' });
    addMsg(env, 'mover', NOW - 7 * D - 1, { file: 'c1/d2/mover.jpg' });
    run(env);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'edge'"), 1);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id = 'over'"), 0);
    // Medien: genau 7 Tage alt bleibt (Datei da), eine Sekunde aelter laeuft ab (Nachricht bleibt, Datei weg)
    assert.equal(exists(env, 'c1/d2/medge.jpg'), true);
    assert.equal(exists(env, 'c1/d2/mover.jpg'), false);
    assert.equal(num(env, "SELECT count(*) AS c FROM messages WHERE id IN ('medge','mover')"), 2);
  }),
);

// ---------------------------------------------------------------------------
// F17: Das Journal enthaelt keine Pfade (Chat-Kennung und Dateiname stecken im Pfad) und keine Fehlertexte
// ---------------------------------------------------------------------------
const CHAT_DIR = '4917012345678@s.whatsapp.net'; // Chat-Ordner traegt die Kennung (Telefonnummer)
const SECRET_FILE = 'GEHEIM-DATEI-4711.jpg';

function capture(): { log: { info(m: string): void; warn(m: string): void }; warns: string[]; all(): string } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) }, warns, all: () => [...infos, ...warns].join('\n') };
}

/** Pfad-/Fehlertext-Lecks: nichts davon darf im Journal erscheinen. */
function assertNoLeak(env: Env, text: string, extra: string[] = []): void {
  for (const secret of ['4917012345678', 'GEHEIM-DATEI', 'ORPHAN-4711', 'PRIVAT-NOTIZEN', 'linkdir-', env.dir, 'permission denied', 'unlink', ...extra]) {
    assert.ok(!text.includes(secret), `Journal enthaelt "${secret}":\n${text}`);
  }
}

const errnoError = (code: string, p: string): Error =>
  Object.assign(new Error(`${code}: operation failed, access '${p}'`), { code });

test(
  'F17: Datei laesst sich nicht loeschen -> Warnung nennt Fehlercode und Kurzkennung, nicht Pfad oder Fehlertext',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { file: `${CHAT_DIR}/2023-11-14/${SECRET_FILE}` });
    const orig = fs.unlinkSync.bind(fs);
    const m = mock.method(fs, 'unlinkSync', (p: fs.PathLike) => {
      if (String(p).includes('GEHEIM-DATEI')) throw errnoError('EACCES', String(p));
      return orig(p);
    });
    const cap = capture();
    try {
      const res = run(env, { log: cap.log });
      assert.equal(res.fileErrors, 1);
    } finally {
      m.mock.restore();
    }
    assert.ok(cap.warns.some((w) => w.includes('Löschen fehlgeschlagen') && w.includes('EACCES') && /pfad#[0-9a-f]{8}/.test(w)), cap.warns.join('\n'));
    assertNoLeak(env, cap.all());
    // Die Kurzkennung ist gesalzen: sie ist NICHT der einfache Hash des Pfads (sonst liesse sie sich mit Kandidaten abgleichen).
    const tag = /pfad#([0-9a-f]{8})/.exec(cap.warns.join('\n'))?.[1];
    const plain = createHash('sha256').update(`${CHAT_DIR}/2023-11-14/${SECRET_FILE}`).digest('hex').slice(0, 8);
    assert.ok(tag && tag !== plain, `Kurzkennung ${tag} gleicht dem ungesalzenen Hash`);
  }),
);

test(
  'F17: Pfad in der Datenbank liegt ausserhalb des Media-Roots -> Warnung ohne den Pfad',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { rawPath: '/srv/PRIVAT-NOTIZEN-4711.txt' });
    const cap = capture();
    run(env, { log: cap.log });
    assert.ok(cap.warns.some((w) => w.includes('nicht unter dem Media-Root') && /pfad#[0-9a-f]{8}/.test(w)), cap.warns.join('\n'));
    assertNoLeak(env, cap.all());
  }),
);

test(
  'F17: Elternverzeichnis ist ein Symlink aus dem Root heraus -> Warnung ohne Pfad',
  withEnv((env) => {
    const outside = path.join(env.dir, 'ausserhalb');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, SECRET_FILE), 'x');
    fs.symlinkSync(outside, path.join(env.root, `linkdir-${CHAT_DIR}`));
    addMsg(env, 'old', NOW - 4 * D, { rawPath: path.join(env.root, `linkdir-${CHAT_DIR}`, SECRET_FILE) });
    const cap = capture();
    run(env, { log: cap.log });
    assert.ok(cap.warns.some((w) => w.includes('zeigt aus dem Media-Root heraus') && /pfad#[0-9a-f]{8}/.test(w)), cap.warns.join('\n'));
    assert.ok(fs.existsSync(path.join(outside, SECRET_FILE)), 'Datei ausserhalb bleibt unberuehrt');
    assertNoLeak(env, cap.all(), ['ausserhalb']);
  }),
);

test(
  'F17: verwaiste Datei nicht loeschbar -> Warnung ohne Pfad und Fehlertext',
  withEnv((env) => {
    const f = path.join(env.root, CHAT_DIR, '2023-11-14', 'ORPHAN-4711.jpg');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    age(f, 2 * H);
    const orig = fs.unlinkSync.bind(fs);
    const m = mock.method(fs, 'unlinkSync', (p: fs.PathLike) => {
      if (String(p).includes('ORPHAN-4711')) throw errnoError('EACCES', String(p));
      return orig(p);
    });
    const cap = capture();
    try {
      run(env, { log: cap.log });
    } finally {
      m.mock.restore();
    }
    assert.ok(cap.warns.some((w) => w.includes('Verwaiste Datei nicht löschbar') && w.includes('EACCES')), cap.warns.join('\n'));
    assertNoLeak(env, cap.all());
  }),
);

test(
  'F17: Verzeichnis nicht lesbar -> Warnung ohne Pfad und Fehlertext',
  withEnv((env) => {
    fs.mkdirSync(path.join(env.root, CHAT_DIR), { recursive: true });
    const orig = fs.readdirSync as (...a: unknown[]) => unknown;
    const m = mock.method(fs, 'readdirSync', (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith(CHAT_DIR)) throw errnoError('EIO', String(p));
      return orig(p, ...rest);
    });
    const cap = capture();
    try {
      run(env, { log: cap.log });
    } finally {
      m.mock.restore();
    }
    assert.ok(cap.warns.some((w) => w.includes('Verzeichnis nicht lesbar') && w.includes('EIO')), cap.warns.join('\n'));
    assertNoLeak(env, cap.all());
  }),
);

test(
  'F17: leeres Verzeichnis nicht loeschbar -> Warnung ohne Pfad und Fehlertext',
  withEnv((env) => {
    const dir = path.join(env.root, CHAT_DIR, '2023-11-14');
    const f = path.join(dir, 'ORPHAN-4711.jpg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, 'x');
    age(f, 2 * H);
    age(dir, 2 * H);
    const orig = fs.rmdirSync.bind(fs);
    const m = mock.method(fs, 'rmdirSync', (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes(CHAT_DIR)) throw errnoError('EBUSY', String(p));
      return (orig as (...a: unknown[]) => unknown)(p, ...rest);
    });
    const cap = capture();
    try {
      run(env, { log: cap.log });
    } finally {
      m.mock.restore();
    }
    assert.ok(cap.warns.some((w) => w.includes('Leeres Verzeichnis nicht löschbar') && w.includes('EBUSY')), cap.warns.join('\n'));
    assertNoLeak(env, cap.all());
  }),
);

test(
  'F17: normaler Lauf schreibt keinen Nachrichtentext, Chat-Namen, Absender oder Pfad ins Journal (Schutz vor S12d)',
  withEnv((env) => {
    addMsg(env, 'old', NOW - 4 * D, { text: 'GEHEIMTEXT-4711', file: `${CHAT_DIR}/2023-11-14/${SECRET_FILE}` });
    addMsg(env, 'young', NOW - 1 * D, { text: 'GEHEIMTEXT-0815' });
    const cap = capture();
    const res = run(env, { log: cap.log });
    assert.equal(res.deletedMessages, 1);
    assert.ok(cap.all().includes('Lauf beendet'));
    assertNoLeak(env, cap.all(), ['GEHEIMTEXT', 'Alice', 'bob']);
  }),
);
