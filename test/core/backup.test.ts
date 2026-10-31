import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/core/db.js";
import { backupDb } from "../../src/core/backup.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "mb-bak-")); dirs.push(d); return d; }

test("backupDb writes a dated, openable copy of the db", async () => {
  const dir = tmp();
  const dbPath = join(dir, "src.db");
  openDb(dbPath).close();
  const backupDir = join(dir, "backups");
  const { file } = await backupDb(dbPath, backupDir, 30, new Date("2026-07-24T00:00:00Z"));
  expect(file).toContain("enscribe-2026-07-24.db");
  expect(existsSync(file)).toBe(true);
  const restored = openDb(file);
  expect(restored.prepare("SELECT count(*) AS c FROM pages").get()).toBeDefined();
  restored.close();
});

// A backup is a full copy of the brain, so it must not be more readable than
// the live DB (0600). Without an explicit mode it inherits the process umask,
// which on this box produced world-readable 0644 snapshots.
test("backupDb writes an owner-only file into an owner-only dir", async () => {
  const dir = tmp();
  const dbPath = join(dir, "src.db");
  openDb(dbPath).close();
  const backupDir = join(dir, "backups");
  const { file } = await backupDb(dbPath, backupDir, 30, new Date("2026-07-24T00:00:00Z"));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(backupDir).mode & 0o777).toBe(0o700);
});

// A pre-existing dir created with looser permissions must be tightened too --
// mkdir's mode argument is a no-op when the directory already exists.
test("backupDb tightens a pre-existing world-readable backup dir", async () => {
  const dir = tmp();
  const dbPath = join(dir, "src.db");
  openDb(dbPath).close();
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o755 });
  chmodSync(backupDir, 0o755); // defeat umask so the dir really is 0755
  await backupDb(dbPath, backupDir, 30, new Date("2026-07-24T00:00:00Z"));
  expect(statSync(backupDir).mode & 0o777).toBe(0o700);
});

test("backupDb prunes backups older than the retention window", async () => {
  const dir = tmp();
  const dbPath = join(dir, "src.db");
  openDb(dbPath).close();
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  // Both prefixes age out: macbrain-* snapshots predate the 2026-10-31 rename.
  const old = join(backupDir, "macbrain-2020-01-01.db");
  const oldNew = join(backupDir, "enscribe-2020-01-02.db");
  for (const f of [old, oldNew]) {
    writeFileSync(f, "x");
    utimesSync(f, new Date("2020-01-01"), new Date("2020-01-01"));
  }
  const { pruned } = await backupDb(dbPath, backupDir, 30, new Date("2026-07-24T00:00:00Z"));
  expect(pruned).toBe(2);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(oldNew)).toBe(false);
});
