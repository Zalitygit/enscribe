-- Split the page hash in two, and record what produced each chunk.
--
-- `embed_hash` covers only title+body (the chunk-embedding input), so a
-- frontmatter-only edit updates the page without re-embedding it. Left NULL on
-- existing rows on purpose: a NULL never matches, so every page re-embeds once
-- the next time its content actually changes, and no bulk re-embed is forced
-- here. The column fills in lazily.
ALTER TABLE pages ADD COLUMN embed_hash TEXT;

-- Chunk provenance. Which model encoded this chunk, and under which chunking
-- convention. NULL on existing rows means "written before this migration",
-- which is itself the useful signal — those are the chunks predating the
-- current scheme.
ALTER TABLE page_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE page_chunks ADD COLUMN chunk_scheme TEXT;

-- Small key/value side table for operational facts that are not knowledge:
-- currently just the last completed vault sync, which `doctor` reports so a
-- dead sync trigger stops looking like a quiet vault.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
