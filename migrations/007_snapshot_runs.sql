-- Ledger of dates a snapshot run occurred, independent of whether the graph
-- had any live pages to record. `page_snapshots` only gets a row per LIVE
-- page (see 006_snapshots.sql), so a run against an empty graph leaves it
-- with zero rows for that date -- indistinguishable, to a caller querying
-- distinct run_at there, from "no run has ever happened". That conflation
-- made the run immediately after an empty-graph run misreport itself as the
-- first-ever run instead of diffing against the (empty) one before it.
--
-- writeSnapshot records every run here unconditionally; previousSnapshotDate
-- and pruneSnapshots consult this table instead of page_snapshots for "which
-- dates have a run", while page_snapshots/unresolved_snapshots stay the
-- per-page derived data for a given date.
CREATE TABLE IF NOT EXISTS snapshot_runs (
  run_at TEXT PRIMARY KEY
);

-- Backfill: makes "every page_snapshots date has a snapshot_runs row" a
-- schema-enforced fact rather than an argument about deployment history --
-- pruneSnapshots iterates only snapshot_runs, so a page_snapshots date
-- missing from this ledger would be unprunable forever. NOT actually
-- guaranteed to run everywhere: this INSERT was added to an already-shipped
-- migration file in a later, separate commit (091cd21 created the table,
-- 551efcb added this line) rather than in a new migration of its own. The
-- runner tracks applied migrations by FILENAME, so any DB that had already
-- run 007_snapshot_runs.sql before that second commit landed recorded the
-- file as applied and will never run this INSERT. Harmless on the shared
-- server only by luck of timing (verified: 007 applied 2026-08-03T23:58:39Z,
-- this line landed 2026-08-04T00:59:12Z, and page_snapshots was still empty
-- in that window, so there was nothing to backfill). Do not rely on this
-- INSERT for a DB migrated in that gap -- a real backfill needs its own
-- migration file.
INSERT OR IGNORE INTO snapshot_runs(run_at) SELECT DISTINCT run_at FROM page_snapshots;
