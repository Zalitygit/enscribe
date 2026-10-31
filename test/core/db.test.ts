import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/core/db.js";

test("openDb creates all tables and the current_records view", () => {
  const db = openDb(":memory:");
  const names = db
    .prepare("SELECT name FROM sqlite_master ORDER BY name")
    .all()
    .map((r: any) => r.name);
  for (const t of ["records", "records_fts", "vec_records", "embeddings", "relationships", "current_records"]) {
    expect(names).toContain(t);
  }
  db.close();
});

test("sqlite-vec extension is loaded (vec_version returns a string)", () => {
  const db = openDb(":memory:");
  const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
  expect(typeof row.v).toBe("string");
  db.close();
});

test("openDb creates a missing parent directory for a file-based DB", () => {
  const base = mkdtempSync(join(tmpdir(), "macbrain-db-"));
  const dbPath = join(base, "nested", "deeper", "macbrain.db");
  const db = openDb(dbPath); // must not throw even though nested/deeper/ does not exist
  expect(existsSync(dbPath)).toBe(true);
  db.close();
  rmSync(base, { recursive: true, force: true });
});
