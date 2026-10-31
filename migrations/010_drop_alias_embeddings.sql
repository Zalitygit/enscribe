-- Heal any database that applied the FIRST draft of 009, which fed a page's
-- aliases to the embedder as well as to the FTS column.
--
-- That draft was benchmarked and reverted: alias-prefixed chunk vectors cost
-- relational nDCG@5 0.746 -> 0.699 and recall@5 0.640 -> 0.582, because a
-- handful of short alternate names pulls every chunk vector on the page toward
-- them and away from what the chunk actually says. 009 now writes aliases to the
-- keyword index only, and CHUNK_SCHEME is back to the 004 convention.
--
-- A DB that ran the old draft therefore holds vectors embedded under a
-- convention no code produces any more, stamped with a chunk_scheme string that
-- no longer exists in the source. Clearing both hashes makes the next
-- `vault sync` / `generate` re-ingest every page through the normal path and
-- re-embed it without the alias prefix. embed_hash matters as much as
-- content_hash: PageService.writePage reuses existing chunks whenever embed_hash
-- matches, so clearing content_hash alone would rewrite each page and keep its
-- stale vectors.
--
-- On a database that never ran the old draft this is a no-op in the only case
-- that matters — a fresh install has no page rows yet. On an existing DB that
-- went straight to the current 009 it forces one redundant re-embed, which is
-- wasteful but correct, and is the cheaper side of the trade against leaving a
-- mixed vector space in place.
UPDATE pages
   SET content_hash = '', embed_hash = NULL
 WHERE deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM page_chunks
                WHERE chunk_scheme = 'heading-window-title-alias-prefixed-v1');
