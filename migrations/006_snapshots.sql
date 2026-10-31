-- Per-run fingerprint of the authored graph, so the change digest can report
-- what actually changed state rather than restating current state.
--
-- `run_at` is a DATE (YYYY-MM-DD), not a timestamp, on purpose: a same-day
-- re-run replaces its own rows instead of creating a second baseline, so
-- recovering from a failed generator run needs no manual cleanup.
--
-- Generator-owned pages are excluded by the writer, not by this schema. A
-- digest that snapshotted generated pages would report its own body changing
-- every night, forever.
CREATE TABLE IF NOT EXISTS page_snapshots (
  run_at       TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  inbound      INTEGER NOT NULL,
  outbound     INTEGER NOT NULL,
  unresolved   INTEGER NOT NULL,
  content_hash TEXT,
  deleted      INTEGER NOT NULL,
  PRIMARY KEY (run_at, slug)
);

-- The unresolved set by name, so the digest can say WHICH wikilink resolved
-- rather than only how many. The live set is small (tens of rows), so keeping
-- it per run is cheap.
CREATE TABLE IF NOT EXISTS unresolved_snapshots (
  run_at    TEXT NOT NULL,
  from_slug TEXT NOT NULL,
  raw_text  TEXT NOT NULL,
  PRIMARY KEY (run_at, from_slug, raw_text)
);

CREATE INDEX IF NOT EXISTS idx_page_snapshots_run ON page_snapshots(run_at);
