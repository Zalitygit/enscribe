-- Each chunk row records the rowids of its two keyword rows.
--
-- PagesStore.chunksIntact runs for every unchanged page on every vault sync.
-- It counted keyword rows `WHERE slug = ?`, but slug (like chunk_id) is
-- UNINDEXED in both FTS5 tables, so each count read the whole table: about
-- 1.1 s per sync on production at 212 pages, growing as pages times chunks.
-- rowid is the only indexed way into an FTS5 table, so replaceChunks now keeps
-- the rowids it gets back and chunksIntact looks each row up by them.
--
-- Backfilled from the existing keyword rows, one scan per table, so no page
-- re-embeds. A chunk with no keyword row is left NULL and reads as not intact,
-- which is the truth. Any later migration that rebuilds an FTS table must
-- refresh these columns the same way, or every page rebuilds on the next sync.
ALTER TABLE page_chunks ADD COLUMN fts_rowid INTEGER;
ALTER TABLE page_chunks ADD COLUMN exact_rowid INTEGER;

CREATE TEMP TABLE _fts_rowids (chunk_id TEXT PRIMARY KEY, fts INTEGER, exact INTEGER);
INSERT INTO _fts_rowids (chunk_id, fts)
  SELECT chunk_id, max(rowid) FROM page_chunks_fts GROUP BY chunk_id;
INSERT INTO _fts_rowids (chunk_id, exact)
  SELECT chunk_id, max(rowid) FROM page_chunks_fts_exact WHERE true GROUP BY chunk_id
  ON CONFLICT (chunk_id) DO UPDATE SET exact = excluded.exact;
UPDATE page_chunks SET
  fts_rowid = (SELECT fts FROM _fts_rowids r WHERE r.chunk_id = page_chunks.chunk_id),
  exact_rowid = (SELECT exact FROM _fts_rowids r WHERE r.chunk_id = page_chunks.chunk_id);
DROP TABLE _fts_rowids;
