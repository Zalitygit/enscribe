import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { PageService } from "../../../src/pages/service.js";
import { FakeEmbedder } from "../../../src/embed/fake.js";
import { LAST_VAULT_SYNC } from "../../../src/pages/store.js";
import { changeDigest } from "../../../src/pages/generators/change-digest.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import type { GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;

const noRepos: RepoSource = { listRepos: () => [], recentCommits: () => [] };
const noVault: VaultSource = { list: () => ({ sourcePaths: [], failedDirs: [] }) };
const noGit: GitHistorySource = { history: () => new Map() };
const ctx = (iso: string): GeneratorContext => ({
  repos: noRepos, store, git: noGit, vault: noVault, findings, now: () => new Date(iso),
});

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("produces one page at the expected slug", async () => {
  const pages = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(pages).toHaveLength(1);
  expect(pages[0].slug).toBe("brain-change-digest");
});

// Without this the very first run reports the entire vault as newly created.
test("the first run reports a baseline, not a vault full of new pages", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).toContain("Baseline");
  expect(page.body).not.toContain("- `a`");
});

test("reports a page added between two runs", async () => {
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).toContain("## Added");
  expect(page.body).toContain("`a`");
});

// A run captured nothing (the store was empty), but it still happened. The
// next run must diff against it rather than re-declaring itself the baseline.
test("a run against an empty store is not forgotten by the next run", async () => {
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).not.toContain("Baseline");
  expect(page.body).toContain("Previous snapshot: 2026-08-02");
});

// A same-day rerun must not compare today's snapshot against itself.
test("a same-day rerun does not self-compare", async () => {
  await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).not.toContain("Previous snapshot: 2026-08-03");
  expect(page.body).toContain("Baseline");
});

test("reports a page that became orphaned", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[B]]\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  await svc.resolveAll();
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));

  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  await svc.resolveAll();
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));

  expect(page.body).toContain("## Became orphaned");
  expect(page.body).toContain("`b`");
});

test("names an unresolved link that appeared", async () => {
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).toContain("Nowhere");
});

// The generator lint fails the entire nightly run on one unresolved link in a
// generated page, and this page's job includes naming pages that were just
// tombstoned.
test("never emits a wikilink", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));
  store.softDelete("a");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).not.toMatch(/\[\[/);
});

// Determinism given fixed inputs. The page legitimately changes daily in
// production, which is why the clock is injected rather than read.
test("is byte-identical for the same day and an unchanged brain", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  await changeDigest.run(ctx("2026-08-02T04:00:00Z"));
  const [first] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  const [second] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(second.body).toBe(first.body);
});

// A dead macbrain-vault-ingest.path must not read as a calm "nothing changed".
test("flags a stale vault sync", async () => {
  store.setMeta(LAST_VAULT_SYNC, "2026-07-01T00:00:00Z");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).toContain("stale");
});

test("does not flag a fresh vault sync", async () => {
  store.setMeta(LAST_VAULT_SYNC, "2026-08-03T03:00:00Z");
  const [page] = await changeDigest.run(ctx("2026-08-03T04:00:00Z"));
  expect(page.body).not.toContain("stale");
});

test("prunes snapshots beyond retention", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  // 31 runs against a RETAIN of 30, so exactly the oldest date is dropped.
  // Stay within a real month: `new Date("2026-08-32")` is Invalid Date and
  // toISOString() throws on it.
  for (let d = 1; d <= 31; d++) {
    const day = String(d).padStart(2, "0");
    await changeDigest.run(ctx(`2026-08-${day}T04:00:00Z`));
  }
  expect(store.getSnapshot("2026-08-01")).toHaveLength(0);
  expect(store.getSnapshot("2026-08-31").length).toBeGreaterThan(0);
});
