-- Index a page's frontmatter aliases alongside each chunk, on the KEYWORD leg only.
--
-- Migration 004 fixed the same shape of hole for the title: a page whose body
-- never repeated its own name was unfindable by that name. The aliases are the
-- OTHER names for the same thing and had the same hole. Measured on the live
-- vault 2026-08-16: 94 of 201 declared aliases appear nowhere in their page's
-- title or body, so searching one was a recall zero, not a ranking tilt.
-- `concert-os` declares "libct" and "ct library"; neither string existed
-- anywhere in the index.
--
-- FTS5 has no ALTER, so the table is recreated. `aliases` is an indexed column
-- and an unqualified FTS5 MATCH searches every indexed column, so the search SQL
-- needs no change to start matching on it.
DROP TABLE IF EXISTS page_chunks_fts;
CREATE VIRTUAL TABLE page_chunks_fts USING fts5(
  chunk_id UNINDEXED, slug UNINDEXED, title, aliases, heading, text
);

-- Backfill from page_chunks (the durable copy of the chunk text) joined to
-- pages. json_valid() guards the extraction: json_each() raises "malformed JSON"
-- and aborts the WHOLE migration on a single bad row, and CASE short-circuits so
-- the subquery never runs for one. Values written by upsertPage are always valid
-- JSON, so this is belt-and-braces against a hand-edited row.
INSERT INTO page_chunks_fts (chunk_id, slug, title, aliases, heading, text)
  SELECT c.chunk_id, c.slug, p.title,
         CASE WHEN json_valid(p.frontmatter)
              THEN COALESCE((SELECT group_concat(je.value, ' ')
                             FROM json_each(p.frontmatter, '$.aliases') je), '')
              ELSE '' END,
         c.heading, c.text
  FROM page_chunks c JOIN pages p ON p.slug = c.slug;

-- NOTE what this migration deliberately does NOT do: it does not clear
-- content_hash or embed_hash, because nothing needs re-embedding. The aliases go
-- to the FTS column and never into the chunk-embedding input, so every existing
-- vector is still correct under the current convention and CHUNK_SCHEME is
-- unchanged. This is the whole keyword-leg fix, and it costs one table rebuild.
--
-- An earlier draft of this migration also fed the aliases to the embedder, on
-- the theory that what worked for the title in 004 would work for the other
-- names. It was benchmarked and it was wrong: relational nDCG@5 0.746 -> 0.699
-- and recall@5 0.640 -> 0.582, because a few short alternate names drag every
-- chunk vector on the page toward them and away from what the chunk says.
-- Aliases are short exact strings, which is what FTS is for.
