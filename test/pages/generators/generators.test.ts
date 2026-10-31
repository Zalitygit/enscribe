import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { PageService } from "../../../src/pages/service.js";
import { FakeEmbedder } from "../../../src/embed/fake.js";
import { runGenerators } from "../../../src/pages/generators/runner.js";
import { repoInventory } from "../../../src/pages/generators/repo-inventory.js";
import { activityDigest } from "../../../src/pages/generators/activity-digest.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import type { GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;

const fakeRepos: RepoSource = {
  listRepos: () => [
    { name: "claude", slug: "repo-claude", branch: "main", commits: 42, lastDate: "2026-07-20" },
    { name: "auction", slug: "repo-auction", branch: "main", commits: 10, lastDate: "2026-07-18" },
  ],
  recentCommits: (name) => (name === "claude" ? [{ date: "2026-07-20", subject: "updated" }] : []),
};

const noVault: VaultSource = { list: () => ({ sourcePaths: [], failedDirs: [] }) };
const noGit: GitHistorySource = { history: () => new Map() };
const ctx = (repos: RepoSource): GeneratorContext => ({
  repos, store, git: noGit, vault: noVault, findings, now: () => new Date("2026-08-03T04:00:00Z"),
});

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("repo-inventory produces a hub linking every repo + a stub per repo", async () => {
  const pages = await repoInventory.run(ctx(fakeRepos));
  const hub = pages.find((p) => p.slug === "git-repo-inventory")!;
  expect(hub.body).toContain("[[repo-claude]]");
  expect(hub.body).toContain("[[repo-auction]]");
  expect(pages.some((p) => p.slug === "repo-claude")).toBe(true);
  expect(pages.some((p) => p.slug === "repo-auction")).toBe(true);
});

test("repo-inventory skips a repo that already has an authored page", async () => {
  store.upsertPage({ slug: "repo-claude", title: "Claude (curated)", frontmatter: {}, body: "hand-written", source_path: "wiki/concepts/repo-claude.md" });
  const pages = await repoInventory.run(ctx(fakeRepos));
  expect(pages.some((p) => p.slug === "repo-claude")).toBe(false); // authored wins
  expect(pages.some((p) => p.slug === "repo-auction")).toBe(true);
  expect(pages.find((p) => p.slug === "git-repo-inventory")!.body).toContain("[[repo-claude]]"); // still in hub
});

test("activity-digest emits a section only for repos with recent commits", async () => {
  const pages = await activityDigest.run(ctx(fakeRepos));
  expect(pages[0].slug).toBe("recent-git-activity");
  expect(pages[0].body).toContain("## claude");
  expect(pages[0].body).not.toContain("## auction");
});

test("runGenerators with both generators: hub->repo backlink exists and no lint errors", async () => {
  const r = await runGenerators(svc, store, ctx(fakeRepos), [repoInventory, activityDigest]);
  expect(r.lintErrors).toEqual([]); // [[recent-git-activity]] resolves after both run + resolveAll
  const back = store.getBacklinks("repo-claude");
  expect(back.some((l) => l.from_slug === "git-repo-inventory")).toBe(true);
});

test("repo-inventory revives a stub for a soft-deleted authored repo page (no permanent lint)", async () => {
  store.upsertPage({ slug: "repo-claude", title: "Claude", frontmatter: {}, body: "x", source_path: "wiki/concepts/repo-claude.md" });
  store.softDelete("repo-claude");
  const pages = await repoInventory.run(ctx(fakeRepos));
  expect(pages.some((p) => p.slug === "repo-claude")).toBe(true); // tombstoned authored page must NOT block the stub
});

test("full generate cycle has no lint error when an authored repo page was soft-deleted", async () => {
  store.upsertPage({ slug: "repo-claude", title: "Claude", frontmatter: {}, body: "x", source_path: "wiki/concepts/repo-claude.md" });
  store.softDelete("repo-claude");
  const r = await runGenerators(svc, store, ctx(fakeRepos), [repoInventory, activityDigest]);
  expect(r.lintErrors).toEqual([]);
  expect(store.getPage("repo-claude")?.deleted_at).toBeNull(); // revived
  expect(store.getPage("repo-claude")?.generator).toBe("repo-inventory");
});

const sensitiveRepos: RepoSource = {
  listRepos: () => [{ name: "workspace", slug: "repo-workspace", branch: "main", commits: 5, lastDate: "2026-07-28" }],
  recentCommits: () => [
    { date: "2026-07-21", subject: "health: add 23andMe raw genotype export (Jane Doe, 1970-01-01)" },
    { date: "2026-07-28", subject: "etc/health: import 2019 chest X-ray study from patient CD" },
    { date: "2026-07-27", subject: "auction: blocklist + damage guards" },
    { date: "2026-07-24", subject: "feat(mcp): doctor tool (pages index health)" },
    { date: "2026-07-27", subject: "docs: fix a stale tax factor" },
  ],
};

test("activity-digest withholds commit subjects naming sensitive material", async () => {
  const body = (await activityDigest.run(ctx(sensitiveRepos)))[0].body;
  expect(body).not.toContain("23andMe");
  expect(body).not.toContain("genotype");
  expect(body).not.toContain("chest X-ray");
  expect(body).not.toContain("etc/health");
});

test("activity-digest keeps ordinary commits that merely mention a sensitive word", async () => {
  const body = (await activityDigest.run(ctx(sensitiveRepos)))[0].body;
  expect(body).toContain("auction: blocklist + damage guards");
  expect(body).toContain("doctor tool (pages index health)"); // 'health' alone is not sensitive
  expect(body).toContain("stale tax factor"); // 'tax' alone is not sensitive
});

test("activity-digest states how many commits it withheld rather than dropping them silently", async () => {
  const body = (await activityDigest.run(ctx(sensitiveRepos)))[0].body;
  expect(body).toContain("2 commit(s) withheld");
});

test("activity-digest reduces a fully-sensitive repo to a bare withheld count", async () => {
  const allSensitive: RepoSource = {
    listRepos: () => [{ name: "workspace", slug: "repo-workspace", branch: "main", commits: 1, lastDate: "2026-07-21" }],
    recentCommits: () => [{ date: "2026-07-21", subject: "health: add genome probe writeup" }],
  };
  const body = (await activityDigest.run(ctx(allSensitive)))[0].body;
  expect(body).not.toContain("genome");
  expect(body).toContain("1 commit(s) withheld");
});
