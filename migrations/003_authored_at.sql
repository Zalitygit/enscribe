-- Recency change-event signal. `updated_at` is ingest time, so a bulk reseed
-- (e.g. the phase-5 migration) makes every page look "recently updated".
-- `authored_at` holds the source file's last git-commit time instead — stable
-- across reseed and covering every source-backed page (including the frontmatter-
-- less session logs). Null for generated pages (no source file); recency queries
-- COALESCE to `updated_at`, which for regenerated-nightly pages IS their change
-- time. Populated by the vault-sync post-pass (PagesStore.stampAuthoredDates);
-- preserved across re-ingest since upsertPage never writes this column.
ALTER TABLE pages ADD COLUMN authored_at TEXT;
