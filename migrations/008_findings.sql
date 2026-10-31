-- migrations/008_findings.sql
--
-- The finding ledger. brain-gardener recomputes every finding nightly and has
-- nowhere to record that one was already seen, acted on, or deliberately
-- declined, so it reports all of them every night forever. Measured across the
-- 23 archived digests (2026-07-20 -> 2026-08-11): uuid-primary-keys
-- reported 14 times, four broken-link targets 10 times each, and the digests of
-- 2026-08-10 and 2026-08-11 contained no new information at all. At 295 words
-- against a 400-word budget there is no prompt fix available -- a prompt cannot
-- remember across runs.
--
-- `key` is content-derived (<kind>:<subject>) so the same condition maps to the
-- same row on every run without a surrogate id to look up.
--
-- `source` records which side detected it. MacBrain's SQL detectors and the
-- gardener's vault scan / LLM probe both write here, and reconciliation is
-- scoped by kind so neither resolves the other's findings.
--
-- There is no `new` state on purpose: "new" is derived (first_seen == this run)
-- and therefore cannot get stuck.
CREATE TABLE IF NOT EXISTS findings (
  key              TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  subject          TEXT NOT NULL,
  detail           TEXT NOT NULL,
  source           TEXT NOT NULL,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  times_reported   INTEGER NOT NULL DEFAULT 1,
  state            TEXT NOT NULL DEFAULT 'open',
  state_changed_at TEXT NOT NULL,
  note             TEXT
);

CREATE INDEX IF NOT EXISTS findings_state ON findings(state);
CREATE INDEX IF NOT EXISTS findings_kind  ON findings(kind);
