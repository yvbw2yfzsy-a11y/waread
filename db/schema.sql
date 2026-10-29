-- waread: Datenbank-Schema, Version 1 (PRAGMA user_version = 1)
--
-- Kern laut verbindlichem Vertrag (Tabellen/Spalten unveraendert) plus:
--   * zusaetzliche Indizes
--   * messages_fts_map: stabile Zuordnung message_id <-> FTS-Rowid
--   * Trigger, die messages_fts bei INSERT/UPDATE/DELETE synchron halten
--
-- Warum messages_fts_map (Vorsichtsmassnahme): messages hat einen TEXT-Primaerschluessel
-- und damit nur eine implizite rowid. Laut SQLite-Dokumentation darf VACUUM die rowids
-- von Tabellen ohne expliziten INTEGER PRIMARY KEY aendern. In einem Versuch mit
-- SQLite 3.53.4 ist das nicht aufgetreten, es ist also eine Garantie der Doku, kein
-- beobachtetes Verhalten. Haengte die FTS-Rowid an messages.rowid, liefe der Suchindex
-- im Ernstfall still auseinander; die Map-Tabelle schliesst das aus.
--
-- Pragmas (WAL, foreign_keys) setzt openDb() pro Verbindung, nicht dieses Skript.

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  avatar_path TEXT,
  last_activity_at INTEGER
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender TEXT NOT NULL,
  wa_timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  type TEXT NOT NULL CHECK(type IN ('text','image','voice','video','document','system')),
  text TEXT,
  reply_to TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER,
  played_at INTEGER
);
CREATE INDEX idx_messages_chat_ts ON messages(chat_id, wa_timestamp);
-- Aufraeumen und chatuebergreifende Zeitfenster-Suche
CREATE INDEX idx_messages_ts ON messages(wa_timestamp);
-- "Neu"-Zaehler pro Chat (nur eingehende, ungesehene Nachrichten)
CREATE INDEX idx_messages_new ON messages(chat_id) WHERE direction = 'in' AND seen_at IS NULL;

CREATE TABLE media (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  file_path TEXT,
  thumbnail_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  duration_seconds REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','downloading','ready','failed','expired'))
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, caption, filename, chat_name, sender_name,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE messages_fts_map (
  fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Cross-Prozess-Benachrichtigung fuer Server-Sent Events:
-- Ingest/Cleanup schreiben hinein, der Web-Dienst pollt sie und leert alte Zeilen periodisch.
CREATE TABLE events_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- FTS-Synchronisation
--
-- Spaltenbelegung in messages_fts:
--   text        messages.text bei type text/voice/system
--   caption     messages.text bei type image/video/document (dort ist text die Bildunterschrift)
--   filename    Dateiname (Basename) aus media.file_path
--   chat_name   chats.name
--   sender_name messages.sender (ob JID oder Anzeigename darin steht, bestimmt der Ingest)
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts_map(message_id) VALUES (new.id);
  INSERT INTO messages_fts(rowid, text, caption, filename, chat_name, sender_name)
  VALUES (
    (SELECT fts_rowid FROM messages_fts_map WHERE message_id = new.id),
    CASE WHEN new.type IN ('image','video','document') THEN NULL ELSE new.text END,
    CASE WHEN new.type IN ('image','video','document') THEN new.text END,
    NULL,
    (SELECT name FROM chats WHERE id = new.chat_id),
    new.sender
  );
END;

CREATE TRIGGER trg_messages_au AFTER UPDATE OF text, type, sender ON messages BEGIN
  UPDATE messages_fts SET
    text = CASE WHEN new.type IN ('image','video','document') THEN NULL ELSE new.text END,
    caption = CASE WHEN new.type IN ('image','video','document') THEN new.text END,
    sender_name = new.sender
  WHERE rowid = (SELECT fts_rowid FROM messages_fts_map WHERE message_id = new.id);
END;

CREATE TRIGGER trg_messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts
  WHERE rowid = (SELECT fts_rowid FROM messages_fts_map WHERE message_id = old.id);
  DELETE FROM messages_fts_map WHERE message_id = old.id;
END;

-- Dateiname aus media.file_path: Basename = Pfad ohne alles bis zum letzten '/'.
-- rtrim(p, replace(p,'/','')) schneidet von rechts alle Zeichen ab, die im Pfad
-- ausser '/' vorkommen, stoppt also exakt am letzten '/'.
CREATE TRIGGER trg_media_ai AFTER INSERT ON media BEGIN
  UPDATE messages_fts SET filename = CASE
    WHEN new.file_path IS NULL THEN NULL
    ELSE replace(new.file_path, rtrim(new.file_path, replace(new.file_path, '/', '')), '')
  END
  WHERE rowid = (SELECT fts_rowid FROM messages_fts_map WHERE message_id = new.message_id);
END;

CREATE TRIGGER trg_media_au AFTER UPDATE OF file_path ON media BEGIN
  UPDATE messages_fts SET filename = CASE
    WHEN new.file_path IS NULL THEN NULL
    ELSE replace(new.file_path, rtrim(new.file_path, replace(new.file_path, '/', '')), '')
  END
  WHERE rowid = (SELECT fts_rowid FROM messages_fts_map WHERE message_id = new.message_id);
END;

-- Chat-Umbenennung: chat_name aller Nachrichten dieses Chats nachziehen.
-- WHEN-Klausel, weil UPDATE OF auch bei unveraendertem Wert feuert (z. B. Upsert).
CREATE TRIGGER trg_chats_au_name AFTER UPDATE OF name ON chats
WHEN old.name IS NOT new.name BEGIN
  UPDATE messages_fts SET chat_name = new.name
  WHERE rowid IN (
    SELECT map.fts_rowid
    FROM messages m JOIN messages_fts_map map ON map.message_id = m.id
    WHERE m.chat_id = new.id
  );
END;
