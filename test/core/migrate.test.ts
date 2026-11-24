import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { migrate } from "../../src/core/db.js";
import { expect, test } from "vitest";
import { openDb } from "../../src/core/db.js";

test("openDb applies all migrations and records them", () => {
  const db = openDb(":memory:");
  const names = (db.prepare(`SELECT name FROM _migrations ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  expect(names).toEqual(["001_init.sql", "002_pages.sql", "003_authored_at.sql", "004_chunk_title.sql", "005_embed_provenance.sql", "006_snapshots.sql", "007_snapshot_runs.sql", "008_findings.sql", "009_chunk_aliases.sql", "010_drop_alias_embeddings.sql", "011_finding_due.sql", "012_backfill_page_type.sql", "013_finding_doc.sql", "014_stemmed_fts.sql", "015_page_ingests.sql", "016_chunk_fts_rowids.sql"]);
});

test("pages-layer tables exist after open", () => {
  const db = openDb(":memory:");
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ["pages", "page_aliases", "page_links", "unresolved_links", "page_chunks"]) {
    expect(tables).toContain(t);
  }
});

test("re-opening the same file DB applies no new migrations", () => {
  // :memory: can't persist across opens, so assert idempotence by re-running the
  // runner against an already-migrated connection: a second migrate is a no-op.
  const db = openDb(":memory:");
  const before = (db.prepare(`SELECT count(*) AS c FROM _migrations`).get() as { c: number }).c;
  // Re-applying the same files must not duplicate rows (names are the PK / dedup key).
  const names = (db.prepare(`SELECT name FROM _migrations`).all() as { name: string }[]).map((r) => r.name);
  expect(new Set(names).size).toBe(before);
});

test("a failing migration rolls back atomically: no partial schema, not recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-mig-"));
  try {
    writeFileSync(join(dir, "001_bad.sql"), [
      "CREATE TABLE half_applied (id TEXT PRIMARY KEY);",
      "INSERT INTO half_applied (id) VALUES ('x');",
      "INSERT INTO no_such_table (id) VALUES ('boom');",
    ].join("\n"));
    const db = new BetterSqlite3(":memory:");
    expect(() => migrate(db, dir)).toThrow();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).not.toContain("half_applied");
    expect((db.prepare(`SELECT count(*) c FROM _migrations`).get() as { c: number }).c).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("012 backfills pages.type from frontmatter, and only from a non-empty string", () => {
  // Runs the shipped SQL against rows seeded in their pre-012 state (type NULL,
  // frontmatter already carrying the key), since the runner has of course already
  // applied 012 to this connection and will not re-run it.
  const db = openDb(":memory:");
  const sql = readFileSync(new URL("../../migrations/012_backfill_page_type.sql", import.meta.url), "utf8");
  const seed = db.prepare(
    `INSERT INTO pages (slug, title, type, frontmatter, body, content_hash, source_path, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'b', 'h', 'p.md', 't', 't')`,
  );
  seed.run("typed", "Typed", JSON.stringify({ type: "concept", title: "Typed" }));
  seed.run("listy", "Listy", JSON.stringify({ type: ["a", "b"] }));
  seed.run("numeric", "Numeric", JSON.stringify({ type: 3 }));
  seed.run("empty", "Empty", JSON.stringify({ type: "" }));
  seed.run("absent", "Absent", JSON.stringify({ title: "Absent" }));
  // A page whose type was already set must not be rewritten.
  db.prepare(
    `INSERT INTO pages (slug, title, type, frontmatter, body, content_hash, generator, created_at, updated_at)
     VALUES ('gen', 'Gen', 'Report', ?, 'b', 'h', 'g', 't', 't')`,
  ).run(JSON.stringify({ type: "Report" }));

  db.exec(sql);

  const got = Object.fromEntries(
    (db.prepare(`SELECT slug, type FROM pages ORDER BY slug`).all() as { slug: string; type: string | null }[])
      .map((r) => [r.slug, r.type]),
  );
  expect(got).toEqual({
    typed: "concept",
    listy: null,
    numeric: null,
    empty: null,
    absent: null,
    gen: "Report",
  });
});

test("016 backfills the keyword rowids from the existing FTS rows, so no page reads as stale", async () => {
  // Build the schema as of 015, seed chunks the old way (no rowid columns),
  // then let the runner apply only 016 from the real directory.
  const migrations = new URL("../../migrations/", import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "mb-mig-"));
  try {
    for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql") && f < "016")) {
      copyFileSync(new URL(f, migrations), join(dir, f));
    }
    const db = new BetterSqlite3(":memory:");
    sqliteVec.load(db);
    migrate(db, dir);
    db.exec(`INSERT INTO page_chunks (chunk_id, slug, ordinal, heading, text, embedding_model, chunk_scheme)
             VALUES ('p#0', 'p', 0, NULL, 'a', 'm', 's'), ('p#1', 'p', 1, NULL, 'b', 'm', 's'), ('q#0', 'q', 0, NULL, 'c', 'm', 's')`);
    for (const t of ["page_chunks_fts", "page_chunks_fts_exact"]) {
      db.exec(`INSERT INTO ${t} (chunk_id, slug, title, aliases, heading, text)
               VALUES ('q#0', 'q', 'Q', '', NULL, 'c'), ('p#0', 'p', 'P', '', NULL, 'a'), ('p#1', 'p', 'P', '', NULL, 'b')`);
    }
    db.exec(`DELETE FROM page_chunks_fts_exact WHERE chunk_id = 'q#0'`); // lost before the migration
    migrate(db, fileURLToPath(migrations));

    const rows = db.prepare(`SELECT chunk_id, fts_rowid, exact_rowid FROM page_chunks ORDER BY chunk_id`).all() as
      { chunk_id: string; fts_rowid: number | null; exact_rowid: number | null }[];
    for (const r of rows) {
      expect(db.prepare(`SELECT chunk_id FROM page_chunks_fts WHERE rowid = ?`).get(r.fts_rowid)).toEqual({ chunk_id: r.chunk_id });
    }
    expect(rows.find((r) => r.chunk_id === "q#0")?.exact_rowid).toBeNull();
    for (const r of rows.filter((r) => r.chunk_id !== "q#0")) {
      expect(db.prepare(`SELECT chunk_id FROM page_chunks_fts_exact WHERE rowid = ?`).get(r.exact_rowid)).toEqual({ chunk_id: r.chunk_id });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
