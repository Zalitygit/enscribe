-- In-flight ingests, one row each, so a newer ingest of a source path wins.
--
-- PageService.writePage embeds before its transaction, so an older ingest of a
-- file could commit after a newer one: the tables stayed consistent with each
-- other, but held the older revision, and since slug retirement the stale write
-- also tombstoned the newer slug. An ingest inserts its row when it starts and
-- deletes every older row for the same path; it commits only if its own row is
-- still there. A row is transient (removed when its ingest ends), and the table
-- lives in the DB so separate processes (vault sync, serve) honour it too.
CREATE TABLE IF NOT EXISTS page_ingests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_ingests_path ON page_ingests(source_path);
