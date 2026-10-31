# Record Format

The durable contract MacBrain owns. Append-mostly with explicit supersession
(no CRDT). Adopted from the v0 design spec (`2026-07-12-macbrain-design.md`, §5).

```jsonc
{
  "id": "01JXYZ...",                 // ULID, assigned on create
  "type": "decision",                // see record types below
  "created_at": "2026-07-12T15:22:00-04:00",
  "updated_at": "2026-07-12T15:22:00-04:00",
  "source": { "kind": "conversation", "application": "claude" },
  "subject": "MacBrain storage architecture",
  "content": "Prose the embedder indexes and a human can read.",
  "entities":      [ { "type": "project", "id": "project:macbrain" } ],
  "tags":          [ "architecture", "mcp" ],
  "relationships": [ { "predicate": "belongs_to", "object": "project:macbrain" } ],
  "provenance":    { "author": "user", "confidence": 1.0 },
  "version": 1,
  "supersedes": null,                // id of the record this replaces, or null
  "content_hash": "sha256:..."       // hash of canonical content; for dedup/sync
}
```

## Record types

`fact`, `note`, `document`, `event`, `person`, `project`, `decision`,
`preference`, `task`, `conversation`, `source`.

## Storage model

- **`records`** — typed columns for the queryable/indexable fields (`id`, `type`,
  `subject`, `content`, `created_at`, `updated_at`, `version`, `supersedes`,
  `content_hash`, `tombstoned`) plus `doc`, a JSON column holding the full
  document for round-tripping the flexible fields (`source`, `entities`,
  `provenance`, `relationships`, `tags`).
- **`records_fts`** — FTS5 virtual table over `subject`, `content`, `tags`, plus
  an `id UNINDEXED` column. The `tags` text comes from `doc`; there is no
  `records.tags` column.
- **`vec_records`** — `sqlite-vec` virtual table, 768-d vectors keyed by record id.
- **`embeddings`** — derived metadata: `record_id`, `embedding_model`, `dim`,
  `content_hash`, `generated_at`. Vectors are **never** stored inline in the
  canonical record; they are a derived artifact tied to the model that produced
  them, so canonical data outlives any embedding model.
- **`relationships`** — normalized `subject_id`, `predicate`, `object` rows,
  captured for later graph traversal.
- **`findings`** — the finding ledger: `key` (`<kind>:<subject>`, content-derived),
  `kind`, `subject`, `detail`, `source`, `first_seen`, `last_seen`,
  `times_reported`, `state`, `state_changed_at`, `note`, and a nullable `due`
  (migration 011) carried by the appendable kinds alone — the mechanical
  detectors have no deadlines, since an orphan page is equally orphaned tomorrow.
  It is a column rather than prose inside `detail` because ordering by it is the
  point: an ask that expires ranks above one that merely waits. **Not a derived
  index.**
  `state`, `note`, `first_seen` and `times_reported` are operator verdicts or
  accumulated across runs, so no rebuild regenerates them — `macbrain backup` is
  the only thing protecting them.
- **`_migrations`** — `name`, `applied_at`: one row per applied migration file,
  the DB's schema-version record. The runner applies each file's SQL and its row
  in one transaction. It tracks by **filename, not content**, so editing an
  already-applied file never re-runs it — a DB that migrated between two commits
  to the same file keeps whichever version it saw.

## Supersession & forget

- **Update** writes a **new version row** (`version` incremented) whose
  `supersedes` points at the prior record id. The `current_records` SQL view
  exposes only non-superseded, non-tombstoned records. Search operates over
  `current_records`.
- **`forget`** tombstones by default (sets `tombstoned`, auditable, recoverable),
  with a hard-delete escape hatch — `forget_record(id, hard)` over MCP as well as
  the CLI. Memory is not silently overwritten.
