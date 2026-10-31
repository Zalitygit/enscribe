-- Pages layer: authored/generated markdown pages, alias-aware wikilink graph,
-- chunked+embedded bodies. Page `body` is canonical; all other tables derive
-- from it and are rebuildable.

CREATE TABLE IF NOT EXISTS pages (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  type          TEXT,
  frontmatter   TEXT NOT NULL,      -- JSON object
  body          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  source_path   TEXT,               -- null for generated pages
  generator     TEXT,               -- null for authored pages
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS page_aliases (
  alias TEXT PRIMARY KEY,           -- normalized key (title + frontmatter aliases)
  slug  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_aliases_slug ON page_aliases(slug);

CREATE TABLE IF NOT EXISTS page_links (
  from_slug   TEXT NOT NULL,
  to_slug     TEXT NOT NULL,
  link_type   TEXT,
  context     TEXT,
  link_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_links_from ON page_links(from_slug);
CREATE INDEX IF NOT EXISTS idx_page_links_to   ON page_links(to_slug);

CREATE TABLE IF NOT EXISTS unresolved_links (
  from_slug  TEXT NOT NULL,
  raw_text   TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (from_slug, raw_text)
);

CREATE TABLE IF NOT EXISTS page_chunks (
  chunk_id TEXT PRIMARY KEY,        -- `${slug}#${ordinal}`
  slug     TEXT NOT NULL,
  ordinal  INTEGER NOT NULL,
  heading  TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_chunks_slug ON page_chunks(slug);

CREATE VIRTUAL TABLE IF NOT EXISTS page_chunks_fts USING fts5(
  chunk_id UNINDEXED, slug UNINDEXED, heading, text
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_page_chunks USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding float[768]
);
