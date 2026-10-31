import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { PageService } from "../../../src/pages/service.js";
import { FakeEmbedder } from "../../../src/embed/fake.js";
import { pageHistory } from "../../../src/pages/generators/page-history.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import type { GeneratedPage, GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";
import type { VaultCommit } from "../../../src/pages/vault-git.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;
const noRepos: RepoSource = { listRepos: () => [], recentCommits: () => [] };
const noVault: VaultSource = { list: () => ({ sourcePaths: [], failedDirs: [] }) };

const gitOf = (h: Record<string, VaultCommit[]>): GitHistorySource => ({
  history: () => new Map(Object.entries(h)),
});
const ctx = (git: GitHistorySource): GeneratorContext => ({
  repos: noRepos, store, vault: noVault, git, findings,
  now: () => new Date("2026-09-13T04:00:00Z"),
});
const c = (iso: string, subject: string): VaultCommit => ({ iso, subject });
const bySlug = (pages: GeneratedPage[], slug: string) => pages.find((p) => p.slug === slug);

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("writes one history page per live source-backed page, plus the timeline", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [c("2026-09-04T00:00:00Z", "wiki: a")],
    "wiki/concepts/b.md": [c("2026-09-05T00:00:00Z", "wiki: b")],
  })));
  expect(pages.map((p) => p.slug).sort()).toEqual(["history-a", "history-b", "vault-commit-timeline"]);
});

test("reports first-added, last-changed and the commit count", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [
      c("2026-09-04T11:00:00Z", "wiki: third"),
      c("2026-08-01T11:00:00Z", "wiki: second"),
      c("2026-06-22T11:00:00Z", "wiki: first"),
    ],
  })));
  const body = bySlug(pages, "history-a")!.body;
  expect(body).toContain("First added to the vault: **2026-06-22**");
  expect(body).toContain("Last changed: **2026-09-04**");
  expect(body).toContain("Total commits touching this page: **3**");
  expect(body).toContain("- 2026-08-01 wiki: second");
});

// The lint in runGenerators fails the whole nightly run on one unresolved link in
// a generated page, and commit subjects are free text that can contain brackets.
// But the stronger reason is the orphan predicate: a history page per authored
// page, each linking its subject, would hand every page in the vault an inbound
// link and silently zero out orphan detection for all four of its consumers.
test("never emits a wikilink, even when a commit subject contains one", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [c("2026-09-04T00:00:00Z", "wiki: link [[[Nowhere]]] and [[Gone]]")],
  })));
  for (const p of pages) expect(p.body).not.toMatch(/\[\[/);
});

// Same hazard activity-digest guards, and worse here: that page shows 21 days,
// this one shows the whole history of the vault.
test("withholds a sensitive commit subject and says how many", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [
      c("2026-09-04T00:00:00Z", "add 23andMe raw genotype export"),
      c("2026-09-03T00:00:00Z", "wiki: ordinary work"),
    ],
  })));
  const body = bySlug(pages, "history-a")!.body;
  expect(body).not.toContain("genotype");
  expect(body).toContain("wiki: ordinary work");
  expect(body).toContain("1 commit(s) withheld");
  // The dates are still counts, not disclosures: the page is still two commits.
  expect(body).toContain("Total commits touching this page: **2**");
});

test("skips a page git has no history for", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const pages = await pageHistory.run(ctx(gitOf({})));
  expect(bySlug(pages, "history-a")).toBeUndefined();
});

test("gives a generated page no history page", async () => {
  await svc.putGenerated({ slug: "gen", title: "Gen", body: "# Gen\n" }, "some-generator");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [c("2026-09-04T00:00:00Z", "wiki: a")],
  })));
  expect(bySlug(pages, "history-gen")).toBeUndefined();
});

test("the timeline counts distinct commits and ranks the most-revised paths", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  const shared = c("2026-09-04T00:00:00Z", "wiki: touches both");
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/concepts/a.md": [shared, c("2026-08-01T00:00:00Z", "wiki: only a")],
    "wiki/concepts/b.md": [shared],
  })));
  const body = bySlug(pages, "vault-commit-timeline")!.body;
  // Three change events, two commits.
  expect(body).toContain("Total commits touching the vault: **2**");
  expect(body).toContain("- **2** commits: `wiki/concepts/a.md`");
  expect(body).toContain("- **1** commits: `wiki/concepts/b.md`");
  // Each commit listed once, newest first.
  expect(body.match(/wiki: touches both/g)).toHaveLength(1);
  expect(body.indexOf("wiki: touches both")).toBeLessThan(body.indexOf("wiki: only a"));
});

// The timeline is the only page here whose body moves on every vault commit; the
// per-page pages must be byte-stable so an unchanged page is not re-embedded
// nightly. Purity is what guarantees that, so it is asserted directly.
test("is byte-stable across runs on identical input", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const git = gitOf({ "wiki/concepts/a.md": [c("2026-09-04T00:00:00Z", "wiki: a")] });
  const first = await pageHistory.run(ctx(git));
  const second = await pageHistory.run(ctx(git));
  expect(second.map((p) => p.body)).toEqual(first.map((p) => p.body));
});

// A denied file is never ingested, so it has no page — and the timeline names
// paths, on a page any pages.read client can read. The index is therefore the
// allow-list for path disclosure, which makes the deny-list authoritative here
// by construction rather than by a second copy of it. The commit itself still
// counts and its subject still shows, subject to the same redaction as above.
test("never names a path that has no live page in the index", async () => {
  const pages = await pageHistory.run(ctx(gitOf({
    "wiki/entities/private/records.md": [c("2026-09-04T00:00:00Z", "wiki: a denied file")],
  })));
  expect(pages.map((p) => p.slug)).toEqual(["vault-commit-timeline"]);
  const body = pages[0].body;
  expect(body).not.toContain("wiki/entities/private/records.md");
  expect(body).toContain("Total commits touching the vault: **1**");
  expect(body).toContain("wiki: a denied file");
});
