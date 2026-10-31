import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../../src/core/db.js";
import { PagesStore } from "../../../src/pages/store.js";
import { PageService } from "../../../src/pages/service.js";
import { FakeEmbedder } from "../../../src/embed/fake.js";
import { healthReport } from "../../../src/pages/generators/health-report.js";
import { FindingsStore } from "../../../src/findings/ledger.js";
import type { GeneratorContext, GitHistorySource, RepoSource, VaultSource } from "../../../src/pages/generators/types.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;
const noRepos: RepoSource = { listRepos: () => [], recentCommits: () => [] };

const noGit: GitHistorySource = { history: () => new Map() };
const ctx = (vault: VaultSource): GeneratorContext => ({
  repos: noRepos, store, git: noGit, vault, findings, now: () => new Date("2026-08-03T04:00:00Z"),
});
const vaultOf = (sourcePaths: string[], failedDirs: string[] = []): VaultSource => ({
  list: () => ({ sourcePaths, failedDirs }),
});

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("produces one page at the slug the wiki links to", async () => {
  const pages = await healthReport.run(ctx(vaultOf([])));
  expect(pages).toHaveLength(1);
  expect(pages[0].slug).toBe("brain-health-report");
});

test("reports a vault file that has no page in the index", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const [page] = await healthReport.run(ctx(vaultOf(["wiki/concepts/a.md", "wiki/concepts/b.md"])));
  expect(page.body).toContain("wiki/concepts/b.md");
  expect(page.body).not.toContain("wiki/concepts/a.md");
});

test("reports unresolved links", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  const [page] = await healthReport.run(ctx(vaultOf(["wiki/concepts/a.md"])));
  expect(page.body).toContain("Nowhere");
});

// The lint in runGenerators fails the whole nightly run on one unresolved link
// in a generated page. A report that names pages as wikilinks would fail every
// time it reported an unresolved link — it would cite the missing target.
test("never emits a wikilink", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  const [page] = await healthReport.run(ctx(vaultOf(["wiki/concepts/a.md", "wiki/concepts/gone.md"])));
  expect(page.body).not.toMatch(/\[\[/);
});

// An incomplete walk cannot justify a "missing page" claim — same reasoning as
// vault sync's prune guard. Reporting phantom missing files on an unmounted
// vault would be worse than reporting nothing.
test("suppresses the missing-file section when an include dir failed", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  // gone.md IS absent from the index, so without the guard it would be listed.
  // The guard must win: an incomplete walk cannot say what is missing.
  const [page] = await healthReport.run(ctx(vaultOf(["wiki/concepts/gone.md"], ["raw"])));
  expect(page.body).toContain("incomplete");
  expect(page.body).toContain("raw");
  expect(page.body).not.toContain("gone.md");
});

// Nightly determinism: an unchanged brain must produce a byte-identical body,
// or pageContentHash changes and the page re-chunks and re-embeds every night.
test("is byte-identical across runs when nothing changed", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  const v = vaultOf(["wiki/concepts/a.md"]);
  const [first] = await healthReport.run(ctx(v));
  const [second] = await healthReport.run(ctx(v));
  expect(second.body).toBe(first.body);
});

// LIST_LIMIT truncation must be indicated in all sections. The "Vault vs index"
// section appends "…and N more" when there are more files than shown; unresolved
// links and orphans must do the same or the reader cannot tell a 60-item list
// was truncated to 50.
test("shows truncation indicator for unresolved links when exceeding LIST_LIMIT", async () => {
  // Create 60 unresolved links by ingesting pages with many different unresolved references.
  // Each page gets 6 unresolved links (60 total).
  for (let i = 0; i < 10; i++) {
    const body = `---\ntitle: Page${i}\n---\n# Page ${i}\n` +
      Array.from({ length: 6 }, (_, j) => `[[Nowhere${i}-${j}]]`).join("\n");
    await svc.ingest(`wiki/p${i}.md`, body);
  }
  const [page] = await healthReport.run(ctx(vaultOf([])));
  // Should show 50 unresolved links + "…and 10 more" indicator.
  expect(page.body).toContain("- _…and 10 more_");
  // Verify the count in the Counts section is still accurate.
  expect(page.body).toContain("- Unresolved links: 60");
});
