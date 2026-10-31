-- Canonical records. Typed columns are the queryable/indexable fields;
-- `doc` holds the full JSON document for round-tripping the flexible fields
-- (source, entities, provenance, relationships).
CREATE TABLE IF NOT EXISTS records (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  subject       TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes    TEXT,
  content_hash  TEXT NOT NULL,
  tombstoned    INTEGER NOT NULL DEFAULT 0,
  doc           TEXT NOT NULL
);

-- A record is "superseded" if another live record points at it via supersedes.
CREATE INDEX IF NOT EXISTS idx_records_supersedes ON records(supersedes);
CREATE INDEX IF NOT EXISTS idx_records_type       ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_created     ON records(created_at);

-- Full-text index over the human-readable fields.
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  id UNINDEXED,
  subject,
  content,
  tags
);

-- Vector index (sqlite-vec). 768-d float embeddings keyed by record id.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_records USING vec0(
  record_id TEXT PRIMARY KEY,
  embedding float[768]
);

-- Derived embedding metadata: which model produced each vector.
CREATE TABLE IF NOT EXISTS embeddings (
  record_id       TEXT PRIMARY KEY,
  embedding_model TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  generated_at    TEXT NOT NULL
);

-- Normalized relationships for future graph traversal.
CREATE TABLE IF NOT EXISTS relationships (
  subject_id TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  object     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_subject ON relationships(subject_id);
CREATE INDEX IF NOT EXISTS idx_rel_object  ON relationships(object);

-- Live records: not tombstoned and not superseded by any other row.
CREATE VIEW IF NOT EXISTS current_records AS
SELECT r.*
FROM records r
WHERE r.tombstoned = 0
  AND NOT EXISTS (
    SELECT 1 FROM records s
    WHERE s.supersedes = r.id AND s.tombstoned = 0
  );
