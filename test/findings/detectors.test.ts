import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { detectOrphans, detectUnresolved } from "../../src/findings/detectors.js";
import { detectRot } from "../../src/findings/detectors.js";
import { detectUnknownLinkTypes, detectStale } from "../../src/findings/detectors.js";

let db: Database;
let store: PagesStore;
let svc: PageService;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
});

test("reports a live authored page with no inbound links", async () => {
  await svc.ingest("wiki/entities/home-paint-colors.md", "---\ntitle: Paint\n---\n# Paint\n");
  const found = detectOrphans(store);
  expect(found).toEqual([
    { kind: "orphan", subject: "home-paint-colors", detail: "no inbound links" },
  ]);
});

// The gardener excludes these in prose today ("10 are dated raw/ session logs,
// not gaps"). Moving the exclusion into the detector is what stops ten permanent
// non-findings from occupying the ledger.
test("excludes raw/ session logs and daily/ notes", async () => {
  await svc.ingest("raw/2026-08-07-surf-session.md", "---\ntitle: S\n---\n# S\n");
  await svc.ingest("daily/2026-05-26.md", "---\ntitle: D\n---\n# D\n");
  await svc.ingest("wiki/concepts/real.md", "---\ntitle: R\n---\n# R\n");
  expect(detectOrphans(store).map((f) => f.subject)).toEqual(["real"]);
});

test("does not report a page that something links to", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[B]]\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  await svc.resolveAll();
  expect(detectOrphans(store).map((f) => f.subject)).not.toContain("b");
});

test("groups unresolved links by target and names the referrers", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n[[Nowhere]]\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n[[Nowhere]]\n");
  const found = detectUnresolved(store);
  expect(found).toEqual([
    { kind: "unresolved", subject: "Nowhere", detail: "linked from a, b" },
  ]);
});

const NOW = new Date("2026-08-11T00:00:00Z");
const page = (slug: string, body: string) =>
  svc.ingest(`wiki/concepts/${slug}.md`, `---\ntitle: ${slug}\n---\n# ${slug}\n${body}\n`);

test("R1 flags a future-tense claim whose date has passed", async () => {
  await page("a", "The cutover will happen on 2026-07-01.");
  const found = detectRot(store, NOW);
  expect(found).toHaveLength(1);
  expect(found[0].kind).toBe("rot-future-date");
  expect(found[0].subject).toMatch(/^a#\d+$/);
});

test("R1 ignores a future date that has not passed", async () => {
  await page("a", "The cutover will happen on 2026-12-01.");
  expect(detectRot(store, NOW)).toEqual([]);
});

// A past date alone is the normal way this vault records history. Without the
// marker requirement R1 would fire on every dated Key fact in the brain.
test("R1 ignores a past date with no future-tense marker", async () => {
  await page("a", "The cutover happened on 2026-07-01.");
  expect(detectRot(store, NOW)).toEqual([]);
});

test("R1 requires marker and date on the SAME line", async () => {
  await page("a", "The cutover will happen.\nUnrelated note from 2026-07-01.");
  expect(detectRot(store, NOW)).toEqual([]);
});

// Sample commands and config in fenced blocks are full of past dates and the
// word "next". Scanning them would make R1 useless on a technical vault.
test("R1 ignores fenced code blocks", async () => {
  await page("a", "```\nthis will run on 2026-07-01\n```");
  expect(detectRot(store, NOW)).toEqual([]);
});

test("R2 flags unchecked boxes on a page untouched for 90+ days", async () => {
  await page("old", "- [ ] wire up the thing\n- [ ] and the other");
  db.prepare(`UPDATE pages SET authored_at = ? WHERE slug = 'old'`).run("2026-01-01T00:00:00Z");
  const found = detectRot(store, NOW).filter((f) => f.kind === "rot-stale-todo");
  expect(found).toHaveLength(1);
  expect(found[0].subject).toBe("old");
  expect(found[0].detail).toContain("2 unchecked");
});

test("R2 ignores a recently touched page", async () => {
  await page("fresh", "- [ ] wire up the thing");
  db.prepare(`UPDATE pages SET authored_at = ? WHERE slug = 'fresh'`).run("2026-08-10T00:00:00Z");
  expect(detectRot(store, NOW).filter((f) => f.kind === "rot-stale-todo")).toEqual([]);
});

test("R2 ignores checked boxes", async () => {
  await page("old", "- [x] done already");
  db.prepare(`UPDATE pages SET authored_at = ? WHERE slug = 'old'`).run("2026-01-01T00:00:00Z");
  expect(detectRot(store, NOW).filter((f) => f.kind === "rot-stale-todo")).toEqual([]);
});

// Typed edges: an inline field outside LINK_TYPES degrades to a plain wikilink,
// and this is what keeps the degradation from being silent.
test("flags a link-bearing inline field outside the vocabulary", async () => {
  await page("svc", "intro\nhosted-on:: [[hub]]");
  expect(detectUnknownLinkTypes(store)).toEqual([{
    kind: "unknown-link-type",
    subject: "svc:hosted-on",
    detail: "`hosted-on::` is not a link type; stored as a plain wikilink: hosted-on:: [[hub]]",
  }]);
});

test("flags a wrong-case or underscored spelling of a real type", async () => {
  await page("svc", "Runs-On:: [[hub]]\n- runs_on:: [[nas]]");
  expect(detectUnknownLinkTypes(store).map((f) => f.subject)).toEqual(["svc:Runs-On", "svc:runs_on"]);
});

test("one finding per page and field, counting repeat lines", async () => {
  await page("svc", "hosted-on:: [[a]]\nhosted-on:: [[b]]");
  const found = detectUnknownLinkTypes(store);
  expect(found).toHaveLength(1);
  expect(found[0].detail).toBe("`hosted-on::` is not a link type; stored as a plain wikilink on 2 lines, first: hosted-on:: [[a]]");
});

test("does not flag known types, link-less fields, or fenced fields", async () => {
  await page("svc", "runs-on:: [[hub]]\nstatus:: done\n```\nhosted-on:: [[hub]]\n```");
  expect(detectUnknownLinkTypes(store)).toEqual([]);
});

// Staleness follows OKF v0.2 (spec/okf.md §5.2, §5.5), which the vault already
// uses: `stale_after: YYYY-MM-DD` is stale once today >= that date, and when it
// is absent, `verified` ({ by, at } or a list of them) is stale once its latest
// `at` is older than the limit. A page with neither is never stale.
const STALE_NOW = new Date("2026-10-31T12:00:00Z");
const trustPage = (slug: string, fm: string) =>
  svc.ingest(`wiki/concepts/${slug}.md`, `---\ntitle: ${slug}\n${fm}\n---\n# ${slug}\n`);
const stale = () => detectStale(store, STALE_NOW, 180).map((f) => [f.subject, f.detail]);

test("detectStale: stale_after is stale on and after its date", async () => {
  await trustPage("due-today", "stale_after: 2026-10-31");
  await trustPage("past", "stale_after: 2026-09-23");
  await trustPage("later", "stale_after: 2026-11-01");
  await svc.ingest("wiki/concepts/undeclared.md", "---\ntitle: U\n---\n# U\n");
  expect(stale()).toEqual([
    ["due-today", "stale_after 2026-10-31 has passed; re-check the page and move stale_after or verified forward"],
    ["past", "stale_after 2026-09-23 has passed; re-check the page and move stale_after or verified forward"],
  ]);
});

test("detectStale: verified is stale when its latest at is older than the limit", async () => {
  await trustPage("old", "verified:\n  - { by: human:owner, at: 2026-01-15T09:00:00Z }");
  await trustPage("rechecked", "verified:\n  - { by: human:owner, at: 2026-01-15T09:00:00Z }\n  - { by: process:nightly, at: 2026-10-01T02:00:00Z }");
  await trustPage("mapping", "verified: { by: human:owner, at: 2026-02-01 }");
  await trustPage("edge", "verified: { by: human:owner, at: 2026-05-04 }"); // exactly 180 days
  expect(stale()).toEqual([
    ["mapping", "last verified 2026-02-01, older than 180 days; re-check the page and add a verified entry"],
    ["old", "last verified 2026-01-15, older than 180 days; re-check the page and add a verified entry"],
  ]);
});

test("detectStale: a future stale_after decides alone, over an old verified", async () => {
  await trustPage("vouched", "stale_after: 2027-01-01\nverified: { by: human:owner, at: 2025-01-01 }");
  expect(stale()).toEqual([]);
});

test("detectStale reports malformed trust fields instead of skipping them", async () => {
  await trustPage("bad-date", "stale_after: soon");
  await trustPage("scalar", "verified: 2026-10-01");
  await trustPage("no-by", "verified: { at: 2026-10-01 }");
  await trustPage("bad-at", "verified: [{ by: human:owner, at: 2026-13-01 }]");
  expect(stale()).toEqual([
    ["bad-at", "`verified` entries need a by and a valid ISO 8601 at (spec/okf.md §5.2)"],
    ["bad-date", "`stale_after` is not a YYYY-MM-DD date: soon"],
    ["no-by", "`verified` entries need a by and a valid ISO 8601 at (spec/okf.md §5.2)"],
    ["scalar", "`verified` entries need a by and a valid ISO 8601 at (spec/okf.md §5.2)"],
  ]);
});

test("detectStale's details do not change from day to day", async () => {
  await trustPage("old", "verified: { by: human:owner, at: 2026-01-15 }");
  await trustPage("past", "stale_after: 2026-09-23");
  expect(detectStale(store, STALE_NOW, 180)).toEqual(detectStale(store, new Date("2026-12-25T00:00:00Z"), 180));
});

test("detectStale ignores generated pages", async () => {
  await svc.putGenerated({ slug: "gen", title: "Gen", body: "# Gen\n" }, "test");
  expect(stale()).toEqual([]);
});
