import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Count every embedder construction that goes through the factory. The
// nightly pass used to build a fresh OnnxEmbedder (and load a fresh ~550 MB
// ONNX session) on every run, which grew `serve` to 1.85 GB RSS in 8 days.
const created = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/embed/index.js", async (orig) => {
  const real = await orig<typeof import("../../src/embed/index.js")>();
  return { ...real, createEmbedder: (...a: Parameters<typeof real.createEmbedder>) => { created.n++; return real.createEmbedder(...a); } };
});

import { nightlyTask } from "../../src/cli/index.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { startHttp } from "../../src/mcp/http.js";
import { openDb } from "../../src/core/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ["MACBRAIN_DB", "MACBRAIN_EMBED_BACKEND", "MACBRAIN_GIT_ROOT", "MACBRAIN_BACKUP_DIR", "MACBRAIN_VAULT_CONFIG"]) delete process.env[k];
  created.n = 0;
});

test("repeated nightly passes reuse the injected embedder and never construct one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-nightly-")); dirs.push(dir);
  process.env.MACBRAIN_DB = join(dir, "mb.db");
  process.env.MACBRAIN_EMBED_BACKEND = "fake";
  process.env.MACBRAIN_GIT_ROOT = join(dir, "no-such-root");
  process.env.MACBRAIN_BACKUP_DIR = join(dir, "backups");
  const vaultRoot = join(dir, "vault");
  mkdirSync(join(vaultRoot, "wiki/concepts"), { recursive: true });
  writeFileSync(join(dir, "vault.json"), JSON.stringify({ root: vaultRoot, include: ["wiki/concepts"], deny: [] }));
  process.env.MACBRAIN_VAULT_CONFIG = join(dir, "vault.json");

  const embedder = new FakeEmbedder();
  const spy = vi.spyOn(embedder, "embed");
  const task = nightlyTask(embedder);
  await task();
  await task();
  await task();
  expect(created.n).toBe(0);
  expect(spy).toHaveBeenCalled(); // the generators embedded through the shared instance

  const db = openDb(join(dir, "mb.db"));
  const n = (db.prepare("SELECT count(*) AS n FROM pages WHERE deleted_at IS NULL").get() as { n: number }).n;
  db.close();
  expect(n).toBe(5);
});

test("startHttp uses an injected embedder instance instead of building its own", async () => {
  const embedder = new FakeEmbedder();
  const server = await startHttp({ dbPath: ":memory:", port: 0, tokens: new Map(), embedderInstance: embedder });
  try {
    expect(created.n).toBe(0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
