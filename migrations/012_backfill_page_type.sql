-- Backfill `pages.type` from frontmatter for rows written before ingest() lifted it.
--
-- The column has existed since 002 but only `putGenerated` ever populated it, so
-- every authored page carried NULL while its frontmatter held the answer. The
-- vault started declaring `type` on all 119 authored pages on 2026-08-19 (the OKF
-- adoption), which is what made the gap worth closing.
--
-- A resync cannot do this, and that is the whole reason this file exists.
-- `content_hash` covers title + frontmatter + body, and `type` is DERIVED from
-- frontmatter rather than added to it, so an existing row's hash still matches its
-- file byte for byte. ingest()'s idempotence pre-check returns early, writePage is
-- never reached, and the column stays NULL through any number of `vault sync` runs.
-- Pinned by the test "re-ingesting unchanged content does NOT backfill a null type".
--
-- Shape-validated the same way `frontmatterType()` validates it in TS: a non-empty
-- JSON string only. `json_type(...) = 'text'` rejects `type: [a, b]` and `type: 3`,
-- which YAML happily parses and which would land a stringified array in a TEXT
-- column that nothing could route on. The value itself is never checked — OKF types
-- are not registered anywhere and consumers must tolerate an unknown one.
--
-- Touches no hash, so nothing re-chunks and nothing re-embeds.
UPDATE pages
   SET type = json_extract(frontmatter, '$.type')
 WHERE type IS NULL
   AND json_valid(frontmatter)
   AND json_type(frontmatter, '$.type') = 'text'
   AND json_extract(frontmatter, '$.type') <> '';
