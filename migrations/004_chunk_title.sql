-- Index the page title alongside each chunk.
--
-- page_chunks_fts indexed only `heading` and `text`, and the chunk embedding
-- input was `heading\ntext`. A page whose body never repeats its frontmatter
-- title was therefore unfindable by its own title on BOTH legs: a recall zero,
-- not a ranking tilt.
--
-- FTS5 has no ALTER, so the table is recreated. The rows rebuild from
-- page_chunks (the durable copy of the chunk text) joined to pages for the
-- title, so no re-chunking is needed to heal the keyword leg.
DROP TABLE IF EXISTS page_chunks_fts;
CREATE VIRTUAL TABLE page_chunks_fts USING fts5(
  chunk_id UNINDEXED, slug UNINDEXED, title, heading, text
);
INSERT INTO page_chunks_fts (chunk_id, slug, title, heading, text)
  SELECT c.chunk_id, c.slug, p.title, c.heading, c.text
  FROM page_chunks c JOIN pages p ON p.slug = c.slug;

-- The vector leg cannot be rebuilt in SQL: existing chunk vectors were embedded
-- without the title prefix, and mixing two embedding conventions in one vec0
-- space is exactly the silent-corpus-drift failure to avoid. Clearing the
-- content hash makes the next `vault sync` / `generate` re-ingest every page
-- through the normal path, re-embedding it under the new convention.
UPDATE pages SET content_hash = '' WHERE deleted_at IS NULL;
