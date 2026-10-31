import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/index.js";
import { openDb } from "../../src/core/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.MACBRAIN_DB;
  delete process.env.MACBRAIN_EMBED_BACKEND;
  delete process.env.MACBRAIN_VAULT_CONFIG;
});

test("vault sync ingests the configured vault into the DB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-cli-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/a.md"), "---\ntitle: A\n---\n# A\nbody\n");
  const cfgPath = join(dir, "vault.json");
  writeFileSync(cfgPath, JSON.stringify({ root, include: ["wiki/concepts"], deny: ["Vaulted"] }));
  const dbPath = join(dir, "mb.db");
  process.env.MACBRAIN_DB = dbPath;
  process.env.MACBRAIN_EMBED_BACKEND = "fake";
  process.env.MACBRAIN_VAULT_CONFIG = cfgPath;

  const code = await run(["vault", "sync"]);
  expect(code).toBe(0);

  const db = openDb(dbPath);
  const n = (db.prepare(`SELECT count(*) AS c FROM pages WHERE deleted_at IS NULL`).get() as { c: number }).c;
  expect(n).toBe(1);
  db.close();
});

test("vault with no subcommand prints usage and exits 1", async () => {
  const code = await run(["vault"]);
  expect(code).toBe(1);
});
