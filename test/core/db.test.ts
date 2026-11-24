import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createPrivateFile } from "../../src/core/db.js";

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

// The live DB holds every memory; a fresh one must not inherit a permissive
// umask (backup.ts already writes 0700/0600). Existing files are left alone.
test("openDb creates a fresh data dir 0700 and DB + WAL/SHM 0600 under umask 022", async () => {
  const { statSync, writeFileSync, chmodSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "mb-perm-"));
  const old = process.umask(0o022);
  try {
    const path = join(base, "data", "nested", "m.db");
    const db = openDb(path);
    db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);"); // forces -wal/-shm into existence
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(join(base, "data"))).toBe(0o700);
    expect(mode(join(base, "data", "nested"))).toBe(0o700);
    for (const p of [path, `${path}-wal`, `${path}-shm`]) expect(mode(p)).toBe(0o600);
    db.close();

    // An operator-supplied existing parent and an existing DB keep their modes.
    const shared = join(base, "shared");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(shared, { mode: 0o755 });
    const existing = join(shared, "e.db");
    writeFileSync(existing, "");
    chmodSync(existing, 0o640);
    openDb(existing).close();
    expect(mode(shared)).toBe(0o755);
    expect(mode(existing)).toBe(0o640);
  } finally {
    process.umask(old);
    rmSync(base, { recursive: true, force: true });
  }
});

// Two processes opening one missing path can both see it absent; the loser of
// the exclusive create must open the winner's file, not fail with EEXIST.
test("createPrivateFile tolerates a file that already exists and leaves its mode alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "macbrain-db-"));
  try {
    const p = join(dir, "x.db");
    writeFileSync(p, "");
    chmodSync(p, 0o640);
    expect(() => createPrivateFile(p)).not.toThrow();
    expect(statSync(p).mode & 0o777).toBe(0o640);
    expect(() => createPrivateFile(join(dir, "missing-dir", "y.db"))).toThrow(/ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
