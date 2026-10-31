import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { detectOrphans, detectUnresolved } from "../../src/findings/detectors.js";
import { detectRot } from "../../src/findings/detectors.js";
import { detectUnknownLinkTypes } from "../../src/findings/detectors.js";

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
