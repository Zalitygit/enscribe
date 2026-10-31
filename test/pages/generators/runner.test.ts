import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { PageService } from "../../../src/pages/service.js";
import { FakeEmbedder } from "../../../src/embed/fake.js";
import { runGenerators } from "../../../src/pages/generators/runner.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import type { Generator, GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;
const noRepos: RepoSource = { listRepos: () => [], recentCommits: () => [] };
const noVault: VaultSource = { list: () => ({ sourcePaths: [], failedDirs: [] }) };
const noGit: GitHistorySource = { history: () => new Map() };
const ctx = (): GeneratorContext => ({
  repos: noRepos, store, git: noGit, vault: noVault, findings, now: () => new Date("2026-08-03T04:00:00Z"),
});

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("runGenerators produces pages and prunes ones no longer generated", async () => {
  let items = ["a", "b"];
  const gen: Generator = { name: "g", run: async () => items.map((s) => ({ slug: `gp-${s}`, title: s, body: `# ${s}\n` })) };
  const r1 = await runGenerators(svc, store, ctx(), [gen]);
  expect(r1.generated).toBe(2);
  expect(store.listGeneratedBy("g").sort()).toEqual(["gp-a", "gp-b"]);

  items = ["a"];
  const r2 = await runGenerators(svc, store, ctx(), [gen]);
  expect(r2.pruned).toBe(1);
  expect(store.getPage("gp-b")?.deleted_at).not.toBeNull();
  expect(store.listGeneratedBy("g")).toEqual(["gp-a"]);
});

test("pruning a generated page frees the alias it stole from a live page", async () => {
  await svc.ingest("wiki/real.md", "---\ntitle: Shared Name\n---\n# Shared Name\n");
  expect(store.resolve("Shared Name")).toBe("real");

  // The generated page's title claims the same alias. Two live claimants means
  // the alias resolves to neither, rather than the generated page silently
  // stealing it (per-page rebuildAliases alone is last-writer-wins).
  let items = ["a"];
  const gen: Generator = { name: "g", run: async () => items.map((s) => ({ slug: `gp-${s}`, title: "Shared Name", body: `# ${s}\n` })) };
  await runGenerators(svc, store, ctx(), [gen]);
  expect(store.resolve("Shared Name")).toBeNull();

  // Once the generator stops producing it, the tombstoned page must not keep
  // shadowing the live claimant.
  items = [];
  await runGenerators(svc, store, ctx(), [gen]);
  expect(store.resolve("Shared Name")).toBe("real");
});

test("runGenerators lints: a generated page with an unresolved link is reported", async () => {
  const gen: Generator = { name: "g", run: async () => [{ slug: "gp", title: "GP", body: "# GP\nsee [[Nonexistent]]\n" }] };
  const r = await runGenerators(svc, store, ctx(), [gen]);
  expect(r.lintErrors).toEqual([{ slug: "gp", raw_text: "Nonexistent" }]);
});

// Authored-wins. Markdown-in-git is canonical (locked decision 6) and a
// generated page is DB-native and disposable, so when both claim one slug the
// generator must yield. Without this, `vault sync` and `runGenerators`
// overwrite each other nightly — re-chunking and re-embedding every run, both
// reporting success — and the page ping-pongs between authored and generated.
test("putGenerated yields to a live authored page instead of flip-flopping", async () => {
  const raw = "---\ntitle: Repo Foo\n---\n# Repo Foo\nauthored\n";
  await svc.ingest("wiki/concepts/repo-foo.md", raw);
  const gen: Generator = { name: "g", run: async () => [{ slug: "repo-foo", title: "Repo Foo", body: "# generated stub\n" }] };

  const r1 = await runGenerators(svc, store, ctx(), [gen]);
  expect(r1.generated).toBe(0);
  expect(r1.skipped).toEqual([{ slug: "repo-foo", generator: "g", sourcePath: "wiki/concepts/repo-foo.md" }]);
  const page = store.getPage("repo-foo")!;
  expect(page.body).toContain("authored");
  expect(page.generator).toBeNull();
  expect(page.source_path).toBe("wiki/concepts/repo-foo.md");

  // The next sync must be a genuine no-op: unchanged content, no re-embed.
  expect((await svc.ingest("wiki/concepts/repo-foo.md", raw)).changed).toBe(false);
  const r2 = await runGenerators(svc, store, ctx(), [gen]);
  expect(r2.generated).toBe(0);
  expect(r2.pruned).toBe(0);
  expect(store.getPage("repo-foo")?.source_path).toBe("wiki/concepts/repo-foo.md");
});

// A tombstoned authored page must not block the generator forever.
test("putGenerated reclaims a slug whose authored page was pruned", async () => {
  await svc.ingest("wiki/concepts/repo-bar.md", "---\ntitle: Repo Bar\n---\n# Repo Bar\nauthored\n");
  store.softDelete("repo-bar");
  const gen: Generator = { name: "g", run: async () => [{ slug: "repo-bar", title: "Repo Bar", body: "# stub\n" }] };

  const r = await runGenerators(svc, store, ctx(), [gen]);
  expect(r.skipped).toEqual([]);
  expect(r.generated).toBe(1);
  expect(store.getPage("repo-bar")?.generator).toBe("g");
});
