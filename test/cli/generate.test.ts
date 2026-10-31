import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/index.js";
import { openDb } from "../../src/core/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.MACBRAIN_DB;
  delete process.env.MACBRAIN_EMBED_BACKEND;
  delete process.env.MACBRAIN_GIT_ROOT;
  delete process.env.MACBRAIN_BACKUP_DIR;
  delete process.env.MACBRAIN_VAULT_CONFIG;
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "mb-gen-")); dirs.push(d); return d; }

test("macbrain generate runs the generators (empty git server + empty vault -> hub + digest + health report, no lint)", async () => {
  const dir = tmp();
  process.env.MACBRAIN_DB = join(dir, "mb.db");
  process.env.MACBRAIN_EMBED_BACKEND = "fake";
  process.env.MACBRAIN_GIT_ROOT = join(dir, "no-such-root"); // absent -> 0 repos
  const vaultRoot = join(dir, "vault");
  mkdirSync(join(vaultRoot, "wiki/concepts"), { recursive: true }); // empty include dir -> 0 files, no failedDirs
  const cfgPath = join(dir, "vault.json");
  writeFileSync(cfgPath, JSON.stringify({ root: vaultRoot, include: ["wiki/concepts"], deny: ["Vaulted"] }));
  process.env.MACBRAIN_VAULT_CONFIG = cfgPath;
  const code = await run(["generate"]);
  expect(code).toBe(0);
  const db = openDb(join(dir, "mb.db"));
  const slugs = (db.prepare("SELECT slug FROM pages WHERE deleted_at IS NULL ORDER BY slug").all() as { slug: string }[]).map((r) => r.slug);
  db.close();
  expect(slugs).toEqual(["brain-change-digest", "brain-findings", "brain-health-report", "recent-git-activity", "git-repo-inventory"].sort());
});

test("macbrain backup writes a dated db copy", async () => {
  const dir = tmp();
  process.env.MACBRAIN_DB = join(dir, "mb.db");
  openDb(process.env.MACBRAIN_DB).close();
  process.env.MACBRAIN_EMBED_BACKEND = "fake";
  process.env.MACBRAIN_BACKUP_DIR = join(dir, "backups");
  const code = await run(["backup"]);
  expect(code).toBe(0);
  expect(readdirSync(join(dir, "backups")).some((f) => /^enscribe-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toBe(true);
});
