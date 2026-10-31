-- Stem the keyword leg, and keep an unstemmed copy for picking entity seeds.
--
-- page_chunks_fts used FTS5's default unicode61 tokenizer, which does not stem,
-- so a query that paraphrases a page missed the word the page actually uses:
-- on the live index "retiring" matched 0 chunks of macbrain-gbrain-retirement
-- and "retirement" matched 12. The relational query set paraphrases its answer
-- pages on purpose, so this was structural there.
--
-- Stemming alone was benchmarked 2026-09-24 and failed one check: under
-- intent=entity, "boxes" matching every "box" moved the graph expansion's seed
-- pages, and "which of my two boxes handles mail" fell 0.793 -> 0.169. The fix
-- is the second table: page_chunks_fts_exact keeps the unstemmed tokens, and
-- searchUnified picks entity seeds from exact-keyword + vector fusion. The
-- ranking leg itself reads only the stemmed table. A dual-leg variant (both
-- tables fused as separate keyword legs) was measured and rejected: two keyword
-- votes against one vector vote doubled keyword noise. Evidence:
-- docs/evidence/2026-09-24-stemmed-fts.md.
--
-- FTS5 has no ALTER, so the table is recreated (the 004/009 pattern) and both
-- are backfilled from page_chunks joined to pages. Nothing is re-embedded:
-- neither hash is touched, CHUNK_SCHEME is unchanged, vectors stay as they are.
DROP TABLE IF EXISTS page_chunks_fts;
CREATE VIRTUAL TABLE page_chunks_fts USING fts5(
  chunk_id UNINDEXED, slug UNINDEXED, title, aliases, heading, text,
  tokenize = 'porter unicode61'
);
DROP TABLE IF EXISTS page_chunks_fts_exact;
CREATE VIRTUAL TABLE page_chunks_fts_exact USING fts5(
  chunk_id UNINDEXED, slug UNINDEXED, title, aliases, heading, text
);

-- Same backfill as 009, including its json_valid() guard.
INSERT INTO page_chunks_fts (chunk_id, slug, title, aliases, heading, text)
  SELECT c.chunk_id, c.slug, p.title,
         CASE WHEN json_valid(p.frontmatter)
              THEN COALESCE((SELECT group_concat(je.value, ' ')
                             FROM json_each(p.frontmatter, '$.aliases') je), '')
              ELSE '' END,
         c.heading, c.text
  FROM page_chunks c JOIN pages p ON p.slug = c.slug;
INSERT INTO page_chunks_fts_exact (chunk_id, slug, title, aliases, heading, text)
  SELECT chunk_id, slug, title, aliases, heading, text FROM page_chunks_fts;
