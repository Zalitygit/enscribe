import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { FakeEmbedder } from "../../src/embed/fake.js";

const PROV = { model: "fake-embed-v0", scheme: "test-scheme" };

let db: Database;
let store: PagesStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
});

test("upsertPage inserts and getPage round-trips frontmatter as an object", () => {
  const { changed } = store.upsertPage({
    slug: "full-title", title: "Full Title",
    frontmatter: { tags: ["infra"] }, body: "# Full Title\nbody",
    source_path: "full-title.md",
  });
  expect(changed).toBe(true);
  const row = store.getPage("full-title");
  expect(row?.title).toBe("Full Title");
  expect(row?.frontmatter).toEqual({ tags: ["infra"] });
  expect(row?.source_path).toBe("full-title.md");
  expect(row?.deleted_at).toBeNull();
});

test("re-upserting identical content reports changed=false", () => {
  const input = { slug: "p", title: "P", frontmatter: {}, body: "same" };
  expect(store.upsertPage(input).changed).toBe(true);
  expect(store.upsertPage(input).changed).toBe(false);
});

test("upserting changed body updates the row and bumps content_hash", () => {
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "v1" });
  const h1 = store.getPage("p")!.content_hash;
  const { changed } = store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "v2" });
  expect(changed).toBe(true);
  expect(store.getPage("p")!.body).toBe("v2");
  expect(store.getPage("p")!.content_hash).not.toBe(h1);
});

test("listPages returns non-deleted pages", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "x" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "y" });
  expect(store.listPages().map((p) => p.slug).sort()).toEqual(["a", "b"]);
});

test("resolve matches exact slug, title alias, and normalized alias to one slug", () => {
  store.upsertPage({ slug: "full-title", title: "Full Title", frontmatter: {}, body: "x" });
  store.rebuildAliases("full-title", ["Full Title", "an-alias"]);
  expect(store.resolve("full-title")).toBe("full-title");   // exact slug
  expect(store.resolve("Full Title")).toBe("full-title");   // title via alias table
  expect(store.resolve("an-alias")).toBe("full-title");     // frontmatter alias
  expect(store.resolve("An Alias")).toBe("full-title");     // normalized alias variant
});

test("resolve returns null for an unknown target", () => {
  expect(store.resolve("Nonexistent Page")).toBeNull();
});

test("rebuildAliases replaces prior aliases for the slug", () => {
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "x" });
  store.rebuildAliases("p", ["old-name"]);
  expect(store.resolve("old-name")).toBe("p");
  store.rebuildAliases("p", ["new-name"]);
  expect(store.resolve("old-name")).toBeNull();
  expect(store.resolve("new-name")).toBe("p");
});

test("addLink and clearLinksFrom manage the link graph", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "x" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "y" });
  store.addLink("a", "b", "wikilink", null, "wikilink");
  const links = db.prepare(`SELECT to_slug FROM page_links WHERE from_slug = 'a'`).all() as { to_slug: string }[];
  expect(links.map((l) => l.to_slug)).toEqual(["b"]);
  store.clearLinksFrom("a");
  expect(db.prepare(`SELECT count(*) AS c FROM page_links WHERE from_slug = 'a'`).get()).toEqual({ c: 0 });
});

test("addUnresolved is idempotent on (from_slug, raw_text)", () => {
  store.addUnresolved("a", "Ghost", "2026-07-24T00:00:00Z");
  store.addUnresolved("a", "Ghost", "2026-07-24T01:00:00Z");
  expect(db.prepare(`SELECT count(*) AS c FROM unresolved_links`).get()).toEqual({ c: 1 });
});

test("neighbors walks links in both directions, ranks by seed count, excludes seeds", () => {
  for (const s of ["a", "b", "c", "d", "gone"]) {
    store.upsertPage({ slug: s, title: s.toUpperCase(), frontmatter: {}, body: "x" });
  }
  store.addLink("a", "c", "wikilink", null, "wikilink");   // c is downstream of a
  store.addLink("b", "c", "wikilink", null, "wikilink");   // and of b — two seeds
  store.addLink("d", "a", "wikilink", null, "wikilink");   // d points AT a
  store.addLink("a", "gone", "wikilink", null, "wikilink");
  store.softDelete("gone");

  const n = store.neighbors(["a", "b"], 10);
  expect(n[0]).toBe("c");            // touched by both seeds, so ranked first
  expect(n).toContain("d");          // reached by an inbound edge
  expect(n).not.toContain("a");      // seeds excluded
  expect(n).not.toContain("b");
  expect(n).not.toContain("gone");   // tombstoned pages are not neighbours
});

// A page linked twice from one seed (a body wikilink plus a frontmatter
// `sources:` edge) is still one seed's worth of evidence, or a single
// densely-linked page would outrank one genuinely cited by several.
test("neighbors counts distinct seeds, not distinct edges", () => {
  for (const s of ["a", "b", "one", "two"]) {
    store.upsertPage({ slug: s, title: s, frontmatter: {}, body: "x" });
  }
  store.addLink("a", "one", "wikilink", null, "wikilink");
  store.addLink("a", "one", "source", null, "frontmatter-source"); // same pair, 2nd edge
  store.addLink("a", "two", "wikilink", null, "wikilink");
  store.addLink("b", "two", "wikilink", null, "wikilink");

  expect(store.neighbors(["a", "b"], 10)[0]).toBe("two");
});

test("byRecency orders the given slugs newest-first and adds none", () => {
  store.upsertPage({ slug: "old", title: "Old", frontmatter: {}, body: "x", source_path: "old.md" });
  store.upsertPage({ slug: "new", title: "New", frontmatter: {}, body: "x", source_path: "new.md" });
  store.upsertPage({ slug: "absent", title: "Absent", frontmatter: {}, body: "x", source_path: "absent.md" });
  store.stampAuthoredDates(new Map([
    ["old.md", "2020-01-01T00:00:00.000Z"],
    ["new.md", "2026-01-01T00:00:00.000Z"],
    ["absent.md", "2027-01-01T00:00:00.000Z"],
  ]));

  // `absent` is the newest page of the three and is still not returned, because
  // it was not among the candidates handed in.
  expect(store.byRecency(["old", "new"])).toEqual(["new", "old"]);
});

test("replaceChunks writes chunk, fts, and vec rows and getChunk reads back", async () => {
  const emb = new FakeEmbedder();
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "x" });
  const vec = await emb.embed("hello world", "document");
  store.replaceChunks("p", "P", [], [{ ordinal: 0, heading: "Intro", text: "hello world", embedding: vec }], PROV);
  expect(db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='p'`).get()).toEqual({ c: 1 });
  expect(db.prepare(`SELECT count(*) AS c FROM page_chunks_fts WHERE slug='p'`).get()).toEqual({ c: 1 });
  expect(db.prepare(`SELECT count(*) AS c FROM vec_page_chunks WHERE chunk_id='p#0'`).get()).toEqual({ c: 1 });
  expect(store.getChunk("p#0")).toEqual({ ordinal: 0, heading: "Intro", text: "hello world" });
});

// Migration 014: page_chunks_fts stems (porter) and page_chunks_fts_exact keeps
// the unstemmed tokens for picking entity seeds. Every write path must keep the
// two in step, or seeds and ranking are drawn from different corpora.
async function onePage(aliases: string[] = ["old name"]) {
  const emb = new FakeEmbedder();
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "x" });
  const vec = await emb.embed("the retirement plan", "document");
  store.replaceChunks("p", "P", aliases, [{ ordinal: 0, heading: "Intro", text: "the retirement plan", embedding: vec }], PROV);
}
const ftsCount = (table: string, where = "slug='p'") =>
  (db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number }).c;

test("the main keyword index stems and the exact copy does not", async () => {
  await onePage();
  expect(ftsCount("page_chunks_fts", `page_chunks_fts MATCH '"retiring"'`)).toBe(1);
  expect(ftsCount("page_chunks_fts_exact", `page_chunks_fts_exact MATCH '"retiring"'`)).toBe(0);
  expect(ftsCount("page_chunks_fts_exact", `page_chunks_fts_exact MATCH '"retirement"'`)).toBe(1);
});

test("replaceChunks, updateChunkAliases, softDelete and purge keep the exact copy in step", async () => {
  await onePage();
  expect([ftsCount("page_chunks_fts"), ftsCount("page_chunks_fts_exact")]).toEqual([1, 1]);
  await onePage(); // a rewrite replaces, never duplicates
  expect([ftsCount("page_chunks_fts"), ftsCount("page_chunks_fts_exact")]).toEqual([1, 1]);
  store.updateChunkAliases("p", ["zzqq nickname"]);
  expect(ftsCount("page_chunks_fts_exact", `page_chunks_fts_exact MATCH '"zzqq"'`)).toBe(1);
  expect(ftsCount("page_chunks_fts", `page_chunks_fts MATCH '"zzqq"'`)).toBe(1);
  store.softDelete("p");
  expect([ftsCount("page_chunks_fts"), ftsCount("page_chunks_fts_exact")]).toEqual([0, 0]);
  await onePage();
  db.prepare(`UPDATE pages SET deleted_at = 'x' WHERE slug = 'p'`).run(); // tombstone without softDelete's prune
  store.purgeTombstoned();
  expect([ftsCount("page_chunks_fts"), ftsCount("page_chunks_fts_exact")]).toEqual([0, 0]);
});

test("replaceChunks clears prior chunks for the slug", async () => {
  const emb = new FakeEmbedder();
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "x" });
  const v = await emb.embed("a", "document");
  store.replaceChunks("p", "P", [], [
    { ordinal: 0, heading: null, text: "a", embedding: v },
    { ordinal: 1, heading: null, text: "b", embedding: v },
  ], PROV);
  store.replaceChunks("p", "P", [], [{ ordinal: 0, heading: null, text: "only", embedding: v }], PROV);
  expect(db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='p'`).get()).toEqual({ c: 1 });
  expect(db.prepare(`SELECT count(*) AS c FROM vec_page_chunks`).get()).toEqual({ c: 1 });
});

test("softDelete tombstones the page, prunes search rows + outbound edges, keeps page row and aliases", async () => {
  const emb = new FakeEmbedder();
  store.upsertPage({ slug: "gone", title: "Gone Page", frontmatter: {}, body: "x", source_path: "gone.md" });
  store.rebuildAliases("gone", ["Gone Page", "gp"]);
  const v = await emb.embed("x", "document");
  store.replaceChunks("gone", "Gone", [], [{ ordinal: 0, heading: null, text: "x", embedding: v }], PROV);
  store.addLink("gone", "other", "wikilink", null, "wikilink");
  store.addUnresolved("gone", "Nope", "2026-07-24T00:00:00Z");

  store.softDelete("gone");

  const row = store.getPage("gone");
  expect(row?.deleted_at).not.toBeNull();
  expect(row?.body).toBe("x");
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  expect(c(`SELECT count(*) AS c FROM page_chunks WHERE slug='gone'`)).toBe(0);
  expect(c(`SELECT count(*) AS c FROM vec_page_chunks WHERE chunk_id='gone#0'`)).toBe(0);
  expect(c(`SELECT count(*) AS c FROM page_links WHERE from_slug='gone'`)).toBe(0);
  expect(c(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='gone'`)).toBe(0);
  expect(c(`SELECT count(*) AS c FROM page_aliases WHERE slug='gone'`)).toBe(2);
});

test("a soft-deleted page no longer resolves by slug or alias (the must-fix)", () => {
  store.upsertPage({ slug: "gone", title: "Gone Page", frontmatter: {}, body: "x", source_path: "gone.md" });
  store.rebuildAliases("gone", ["Gone Page", "gp"]);
  expect(store.resolve("gone")).toBe("gone");
  expect(store.resolve("Gone Page")).toBe("gone");
  store.softDelete("gone");
  expect(store.resolve("gone")).toBeNull();
  expect(store.resolve("Gone Page")).toBeNull();
  expect(store.resolve("gp")).toBeNull();
});

test("getBySourcePath finds the live page by path; undefined when deleted or absent", () => {
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "x", source_path: "dir/p.md" });
  expect(store.getBySourcePath("dir/p.md")?.slug).toBe("p");
  expect(store.getBySourcePath("nope.md")).toBeUndefined();
  store.softDelete("p");
  expect(store.getBySourcePath("dir/p.md")).toBeUndefined();
});

test("re-ingesting a soft-deleted slug un-deletes it and it resolves again", () => {
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "v1", source_path: "p.md" });
  store.rebuildAliases("p", ["P"]);
  store.softDelete("p");
  expect(store.resolve("p")).toBeNull();
  store.upsertPage({ slug: "p", title: "P", frontmatter: {}, body: "v2", source_path: "p.md" });
  expect(store.getPage("p")?.deleted_at).toBeNull();
  expect(store.resolve("p")).toBe("p");
});

test("unresolvedCount totals the unresolved_links table", () => {
  store.addUnresolved("a", "X", "t");
  store.addUnresolved("a", "Y", "t");
  store.addUnresolved("b", "X", "t");
  expect(store.unresolvedCount()).toBe(3);
});

test("getLinks returns outbound links and unresolved for a page", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "x" });
  store.addLink("a", "b", "wikilink", "ctx", "wikilink");
  store.addUnresolved("a", "Ghost", "2026-07-24T00:00:00Z");
  const r = store.getLinks("a");
  expect(r.links).toEqual([{ to_slug: "b", link_type: "wikilink", context: "ctx" }]);
  expect(r.unresolved).toEqual([{ raw_text: "Ghost" }]);
});

test("getBacklinks returns inbound links to a page", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "x" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "y" });
  store.addLink("a", "target", "wikilink", null, "wikilink");
  store.addLink("b", "target", "wikilink", null, "wikilink");
  expect(store.getBacklinks("target").map((l) => l.from_slug).sort()).toEqual(["a", "b"]);
});

test("upsertPage rewrites when only generator/source_path changes (ownership handoff, identical content)", () => {
  store.upsertPage({ slug: "s", title: "T", frontmatter: {}, body: "same", generator: "gen-a" });
  const r = store.upsertPage({ slug: "s", title: "T", frontmatter: {}, body: "same", source_path: "s.md" });
  expect(r.changed).toBe(true);
  const p = store.getPage("s");
  expect(p?.generator).toBeNull();
  expect(p?.source_path).toBe("s.md");
});

test("pageHealth reports counts, orphans, and unresolved samples", () => {
  store.upsertPage({ slug: "linked-a", title: "LA", frontmatter: {}, body: "x" });
  store.upsertPage({ slug: "linked-b", title: "LB", frontmatter: {}, body: "y" });
  store.upsertPage({ slug: "lonely", title: "Lonely", frontmatter: {}, body: "z" });
  store.addLink("linked-a", "linked-b", "wikilink", null, "wikilink");
  store.addUnresolved("linked-a", "Ghost", "2026-07-24T00:00:00Z");
  const h = store.pageHealth();
  expect(h.pages).toBe(3);
  expect(h.unresolved).toBe(1);
  expect(h.unresolvedSample).toEqual([{ from_slug: "linked-a", raw_text: "Ghost" }]);
  // linked-a links out to linked-b but has no inbound link itself, so under the
  // no-inbound predicate it is now an orphan alongside lonely; linked-b has an
  // inbound link from linked-a and is not.
  expect(h.orphans).toBe(2);
  expect(h.orphanSample).toEqual(["linked-a", "lonely"]);
});

test("listGeneratedBy returns live pages for a generator", () => {
  store.upsertPage({ slug: "g1", title: "G1", frontmatter: {}, body: "x", generator: "gen-a" });
  store.upsertPage({ slug: "g2", title: "G2", frontmatter: {}, body: "y", generator: "gen-a" });
  store.upsertPage({ slug: "auth", title: "Auth", frontmatter: {}, body: "z", source_path: "auth.md" });
  expect(store.listGeneratedBy("gen-a").sort()).toEqual(["g1", "g2"]);
  store.softDelete("g1");
  expect(store.listGeneratedBy("gen-a")).toEqual(["g2"]);
});

test("generatedUnresolvedLinks returns unresolved links from generated pages only", () => {
  store.upsertPage({ slug: "gen", title: "Gen", frontmatter: {}, body: "x", generator: "g" });
  store.upsertPage({ slug: "auth", title: "Auth", frontmatter: {}, body: "y", source_path: "auth.md" });
  store.addUnresolved("gen", "Bogus", "t");
  store.addUnresolved("auth", "AlsoBogus", "t");
  expect(store.generatedUnresolvedLinks()).toEqual([{ slug: "gen", raw_text: "Bogus" }]);
});

test("orphans excludes generator-owned pages", () => {
  store.upsertPage({ slug: "lonely", title: "L", frontmatter: {}, body: "x" });
  store.upsertPage({ slug: "gen-lonely", title: "GL", frontmatter: {}, body: "y", generator: "g" });
  expect(store.orphans()).toEqual(["lonely"]);
});

// gbrain's find_orphans flags no-inbound. Requiring no-outbound as well hides
// the most interesting case: a page that cites others but nothing cites back,
// i.e. active work that has fallen out of the graph. This is what hid the
// a duplicate host stub from the gardener on 2026-08-02.
test("orphans flags a page with outbound links but no inbound links", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "see [[B]]" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "x" });
  store.addLink("a", "b", "wikilink", null, "wikilink");

  // A links out to B; nothing links to A. A is unreachable and must be flagged.
  expect(store.orphans()).toContain("a");
  // B has an inbound link, so it is not an orphan.
  expect(store.orphans()).not.toContain("b");
});

test("pageHealth uses the same orphan predicate as orphans()", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "see [[B]]" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "x" });
  store.addLink("a", "b", "wikilink", null, "wikilink");

  expect(store.pageHealth().orphans).toBe(store.orphans().length);
  expect(store.pageHealth().orphanSample).toEqual(store.orphans().slice(0, 10));
});

test("recentPages filters by updated_at within the window", () => {
  store.upsertPage({ slug: "r", title: "R", frontmatter: {}, body: "x" });
  expect(store.recentPages(7).some((p) => p.slug === "r")).toBe(true);
  expect(store.recentPages(-1).length).toBe(0); // cutoff in the future -> nothing qualifies
});

test("recentPages uses authored_at over ingest updated_at as the recency signal", () => {
  // Freshly ingested (updated_at ~ now) but authored long ago: an old commit time
  // must push it OUT of the window, proving COALESCE(authored_at, updated_at) drives it.
  store.upsertPage({ slug: "old", title: "Old", frontmatter: {}, body: "x", source_path: "old.md" });
  expect(store.stampAuthoredDates(new Map([["old.md", "2000-01-01T00:00:00.000Z"]]))).toBe(1);
  expect(store.recentPages(7).some((p) => p.slug === "old")).toBe(false);
  store.upsertPage({ slug: "new", title: "New", frontmatter: {}, body: "y", source_path: "new.md" });
  const recent = store.recentPages(7);
  expect(recent.some((p) => p.slug === "new")).toBe(true);
  expect(recent.find((p) => p.slug === "new")!.recency).toBe(recent.find((p) => p.slug === "new")!.updated_at);
});

// A generator-owned page has no authored_at, so it falls back to updated_at —
// which a nightly generator run bumps every night. Without an exclusion it
// would sit permanently at the top of "what moved lately".
test("recentPages excludes generator-owned pages even when freshly updated", () => {
  store.upsertPage({ slug: "gen", title: "Gen", frontmatter: {}, body: "z", generator: "g" });
  expect(store.recentPages(7).some((p) => p.slug === "gen")).toBe(false);
});

test("stampAuthoredDates stamps only live source-backed pages present in the map", () => {
  store.upsertPage({ slug: "a", title: "A", frontmatter: {}, body: "x", source_path: "a.md" });
  store.upsertPage({ slug: "b", title: "B", frontmatter: {}, body: "y", source_path: "b.md" });
  store.upsertPage({ slug: "gen", title: "G", frontmatter: {}, body: "z", generator: "g" }); // no source
  const n = store.stampAuthoredDates(new Map([["a.md", "2026-07-01T00:00:00.000Z"], ["missing.md", "2026-07-02T00:00:00.000Z"]]));
  expect(n).toBe(1); // only a.md matched a live source-backed page
});

// kindsOf backs the search layer's kind weight: a page's class is decided by
// where it came from, not by anything in its text. `daily/` counts as raw for
// the same reason detectOrphans skips it — dated notes, not synthesis.
test("kindsOf classes pages as authored, raw or generated in one lookup", () => {
  store.upsertPage({ slug: "concept", title: "C", frontmatter: {}, body: "x", source_path: "wiki/concepts/concept.md" });
  store.upsertPage({ slug: "2026-01-01-x-session", title: "S", frontmatter: {}, body: "x", source_path: "raw/2026-01-01-x-session.md" });
  store.upsertPage({ slug: "2026-01-02", title: "D", frontmatter: {}, body: "x", source_path: "daily/2026-01-02.md" });
  store.upsertPage({ slug: "recent-git-activity", title: "G", frontmatter: {}, body: "x", source_path: null, generator: "activity-digest" });
  const kinds = store.kindsOf(["concept", "2026-01-01-x-session", "2026-01-02", "recent-git-activity", "nope"]);
  expect([...kinds.entries()].sort()).toEqual([
    ["2026-01-01-x-session", "raw"], ["2026-01-02", "raw"], ["concept", "authored"], ["recent-git-activity", "generated"],
  ]);
  expect(store.kindsOf([]).size).toBe(0);
});

// slugTitles is the light scan behind get_page's "did you mean" suggestions:
// slug and title for every live page, no frontmatter hydration.
test("slugTitles lists live pages only, as slug and title", () => {
  store.upsertPage({ slug: "alpha", title: "Alpha", frontmatter: {}, body: "x", source_path: "alpha.md" });
  store.upsertPage({ slug: "gone", title: "Gone", frontmatter: {}, body: "x", source_path: "gone.md" });
  store.softDelete("gone");
  expect(store.slugTitles()).toEqual([{ slug: "alpha", title: "Alpha" }]);
});
