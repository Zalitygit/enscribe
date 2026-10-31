import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { CHUNK_SCHEME } from "../../src/pages/parse.js";

let db: Database;
let store: PagesStore;
let svc: PageService;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
});

const TARGET = `---\ntitle: Full Title\naliases:\n  - an-alias\n---\n# Full Title\n\nThe target page body.\n`;

test("ingest derives slug from filename and title from frontmatter", async () => {
  const { slug, changed } = await svc.ingest("full-title.md", TARGET);
  expect(slug).toBe("full-title");
  expect(changed).toBe(true);
  expect(store.getPage("full-title")?.title).toBe("Full Title");
});

test("ingest chunks and embeds the body", async () => {
  await svc.ingest("full-title.md", TARGET);
  expect((db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='full-title'`).get() as { c: number }).c).toBeGreaterThan(0);
  expect((db.prepare(`SELECT count(*) AS c FROM vec_page_chunks`).get() as { c: number }).c).toBeGreaterThan(0);
});

test("THE GATE: title, alias, and slug wikilinks all resolve to one page", async () => {
  await svc.ingest("full-title.md", TARGET);
  const linker = `---\ntitle: Linker\n---\nSee [[Full Title]], [[an-alias]], and [[full-title]].\n`;
  await svc.ingest("linker.md", linker);
  const targets = (db.prepare(`SELECT to_slug FROM page_links WHERE from_slug='linker'`).all() as { to_slug: string }[]).map((r) => r.to_slug);
  expect(targets).toEqual(["full-title", "full-title", "full-title"]);
  expect(db.prepare(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='linker'`).get()).toEqual({ c: 0 });
});

test("a bogus wikilink lands in unresolved_links", async () => {
  const linker = `---\ntitle: Linker\n---\nSee [[Nonexistent Ref]].\n`;
  await svc.ingest("linker.md", linker);
  const rows = db.prepare(`SELECT raw_text FROM unresolved_links WHERE from_slug='linker'`).all() as { raw_text: string }[];
  expect(rows.map((r) => r.raw_text)).toEqual(["Nonexistent Ref"]);
});

test("re-ingesting unchanged content is a no-op (changed=false)", async () => {
  await svc.ingest("full-title.md", TARGET);
  const second = await svc.ingest("full-title.md", TARGET);
  expect(second.changed).toBe(false);
});

test("resolveAll heals a forward reference authored before its target", async () => {
  // Linker ingested first: its link to Full Title is unresolvable at ingest time.
  const linker = `---\ntitle: Linker\n---\nSee [[Full Title]].\n`;
  await svc.ingest("linker.md", linker);
  expect((db.prepare(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='linker'`).get() as { c: number }).c).toBe(1);
  expect((db.prepare(`SELECT count(*) AS c FROM page_links WHERE from_slug='linker'`).get() as { c: number }).c).toBe(0);

  // Target ingested second, then a full re-resolve pass.
  await svc.ingest("full-title.md", TARGET);
  await svc.resolveAll();

  expect((db.prepare(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='linker'`).get() as { c: number }).c).toBe(0);
  const links = db.prepare(`SELECT to_slug FROM page_links WHERE from_slug='linker'`).all() as { to_slug: string }[];
  expect(links.map((l) => l.to_slug)).toEqual(["full-title"]);
});

test("a failed embed leaves no partial page (ingest is atomic)", async () => {
  const boom = {
    model: "boom",
    dim: 768,
    embed: async () => { throw new Error("embed failed"); },
  };
  const svc2 = new PageService(db, store, boom);
  await expect(
    svc2.ingest("boom.md", "---\ntitle: Boom\n---\n# Boom\n\nbody\n"),
  ).rejects.toThrow("embed failed");
  // Nothing was persisted: no page row, no chunks.
  expect(store.getPage("boom")).toBeUndefined();
  expect((db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='boom'`).get() as { c: number }).c).toBe(0);
});

test("putGenerated creates a DB-native generator-owned page that resolves", async () => {
  const { changed } = await svc.putGenerated(
    { slug: "gen-hub", title: "Gen Hub", body: "# Gen Hub\nself [[Gen Hub]]\n", type: "reference", tags: ["x"] },
    "test-gen",
  );
  expect(changed).toBe(true);
  const p = store.getPage("gen-hub");
  expect(p?.generator).toBe("test-gen");
  expect(p?.source_path).toBeNull();
  expect(store.resolve("Gen Hub")).toBe("gen-hub");
});

test("putGenerated is idempotent for unchanged content + same generator", async () => {
  const input = { slug: "g", title: "G", body: "same" };
  expect((await svc.putGenerated(input, "gen")).changed).toBe(true);
  expect((await svc.putGenerated(input, "gen")).changed).toBe(false);
});

test("ingest takes ownership of a generated page even with identical content", async () => {
  await svc.putGenerated({ slug: "t", title: "T", body: "# T\nsame body\n" }, "gen");
  expect(store.getPage("t")?.generator).toBe("gen");
  const { changed } = await svc.ingest("t.md", "---\ntitle: T\n---\n# T\nsame body\n");
  expect(changed).toBe(true);
  expect(store.getPage("t")?.generator).toBeNull();
  expect(store.getPage("t")?.source_path).toBe("t.md");
});

test("ingest materializes frontmatter sources: as resolved source edges (fixes the sourced-page orphan)", async () => {
  await svc.ingest("raw/sess.md", "# Session\nnotes\n"); // target page, slug "sess"
  await svc.ingest("wiki/concepts/topic.md", "---\ntitle: Topic\nsources: [sess.md]\n---\n# Topic\nbody with no wikilinks\n");
  const back = store.getBacklinks("sess");
  expect(back.some((l) => l.from_slug === "topic" && l.link_type === "source")).toBe(true);
  expect(store.orphans()).not.toContain("sess"); // the sourced page is no longer an orphan
});

test("ingest stores an inline-field link once, with its type, and leaves plain links as wikilink", async () => {
  await svc.ingest("hub.md", "# hub\nthe hub\n");
  await svc.ingest("svc.md", "# svc\nruns-on:: [[hub]]\nSee also [[hub]].\n");
  const rows = db.prepare(
    `SELECT link_type, link_source FROM page_links WHERE from_slug='svc' ORDER BY link_type`,
  ).all();
  expect(rows).toEqual([
    { link_type: "runs-on", link_source: "inline-field" },
    { link_type: "wikilink", link_source: "wikilink" },
  ]);
});

test("an unresolvable frontmatter source is ignored, not flagged as unresolved", async () => {
  await svc.ingest("wiki/concepts/t.md", "---\ntitle: T\nsources: [some-import-tag, 'https://example.com']\n---\n# T\nbody\n");
  expect((db.prepare(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='t'`).get() as { c: number }).c).toBe(0);
  expect((db.prepare(`SELECT count(*) AS c FROM page_links WHERE from_slug='t'`).get() as { c: number }).c).toBe(0);
});

test("a page's title is searchable even when the body never mentions it", async () => {
  await svc.ingest("wiki/x.md", "---\ntitle: Quixotic Ledger\n---\n# Overview\nnothing relevant here\n");
  const rows = db.prepare(
    `SELECT slug FROM page_chunks_fts WHERE page_chunks_fts MATCH 'Quixotic'`,
  ).all() as { slug: string }[];
  expect(rows.map((r) => r.slug)).toEqual(["x"]);
});

test("the title is part of every chunk's embedding input", async () => {
  const seen: string[] = [];
  const recorder = {
    model: "rec",
    dim: 768,
    embed: async (text: string) => {
      seen.push(text);
      return new Float32Array(768);
    },
  };
  const s = new PageService(db, store, recorder);
  await s.ingest("wiki/y.md", "---\ntitle: Quixotic Ledger\n---\n# Overview\nbody text\n");
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((t) => t.startsWith("Quixotic Ledger\n"))).toBe(true);
});

// A counting embedder so a test can assert that a write did NOT reach the model.
class CountingEmbedder extends FakeEmbedder {
  calls = 0;
  override async embed(text: string, kind: "document" | "query"): Promise<Float32Array> {
    this.calls++;
    return super.embed(text, kind);
  }
}

test("frontmatter churn outside the aliases updates the page without re-embedding", async () => {
  const emb = new CountingEmbedder();
  const s = new PageService(db, store, emb);
  await s.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nBody text.\n`);
  const afterFirst = emb.calls;
  expect(afterFirst).toBeGreaterThan(0);

  // Same title, same aliases, same body; only inert frontmatter moved, so the
  // chunk-embedding input is byte-identical and the vectors would be too.
  await s.ingest("note.md", `---\ntitle: Note\nupdated: 2026-08-02\ntags:\n  - x\n---\n# Note\n\nBody text.\n`);

  expect(emb.calls).toBe(afterFirst);
});

// Aliases reach the FTS column but never the embedding input, so adding one must
// NOT re-embed — and must still update the keyword index in place. Miss the
// second half and the page stays findable under a name it dropped and unfindable
// under the one it just gained, with nothing to signal the gap.
test("adding a frontmatter alias updates the keyword index without re-embedding", async () => {
  const emb = new CountingEmbedder();
  const s = new PageService(db, store, emb);
  await s.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nBody text.\n`);
  const afterFirst = emb.calls;

  await s.ingest("note.md", `---\ntitle: Note\naliases:\n  - nickname\n---\n# Note\n\nBody text.\n`);

  expect(emb.calls).toBe(afterFirst);
  expect(store.resolve("nickname")).toBe("note");
  const fts = db.prepare(
    `SELECT count(*) AS c FROM page_chunks_fts WHERE page_chunks_fts MATCH '"nickname"'`,
  ).get() as { c: number };
  expect(fts.c).toBeGreaterThan(0);
});

// The other direction: a dropped alias must leave the keyword index too.
test("removing a frontmatter alias clears it from the keyword index", async () => {
  const s = new PageService(db, store, new CountingEmbedder());
  await s.ingest("note.md", `---\ntitle: Note\naliases:\n  - nickname\n---\n# Note\n\nBody text.\n`);
  await s.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nBody text.\n`);
  const fts = db.prepare(
    `SELECT count(*) AS c FROM page_chunks_fts WHERE page_chunks_fts MATCH '"nickname"'`,
  ).get() as { c: number };
  expect(fts.c).toBe(0);
});

test("a body edit still re-embeds", async () => {
  const emb = new CountingEmbedder();
  const s = new PageService(db, store, emb);
  await s.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nBody text.\n`);
  const afterFirst = emb.calls;
  await s.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nDifferent body text.\n`);
  expect(emb.calls).toBeGreaterThan(afterFirst);
});

test("chunks record the embedding model and chunk scheme that produced them", async () => {
  await svc.ingest("note.md", `---\ntitle: Note\n---\n# Note\n\nBody text.\n`);
  const rows = db.prepare(`SELECT embedding_model, chunk_scheme FROM page_chunks WHERE slug='note'`).all() as
    { embedding_model: string; chunk_scheme: string }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.embedding_model).toBe("fake-embed-v0");
    expect(r.chunk_scheme).toBe(CHUNK_SCHEME);
  }
  expect(store.chunkProvenance()).toEqual([
    { embedding_model: "fake-embed-v0", chunk_scheme: CHUNK_SCHEME, chunks: rows.length },
  ]);
});

test("ingest lifts frontmatter type into the pages.type column", async () => {
  await svc.ingest("typed.md", `---\ntype: concept\ntitle: Typed\n---\n# Typed\n\nBody.\n`);
  expect(store.getPage("typed")?.type).toBe("concept");
});

test("a page with no frontmatter type gets a null type, not the string 'undefined'", async () => {
  await svc.ingest("untyped.md", `---\ntitle: Untyped\n---\n# Untyped\n\nBody.\n`);
  expect(store.getPage("untyped")?.type).toBeNull();
});

test("a non-string frontmatter type is ignored rather than stored", async () => {
  // Frontmatter is author-controlled YAML: `type: [a, b]` parses to an array and
  // `type: 3` to a number. The column is TEXT, so anything but a non-empty string
  // is dropped rather than coerced into a value no consumer could route on.
  await svc.ingest("listy.md", `---\ntype: [a, b]\ntitle: Listy\n---\n# Listy\n\nBody.\n`);
  expect(store.getPage("listy")?.type).toBeNull();
});

test("re-ingesting unchanged content does NOT backfill a null type — migration 012's reason for existing", async () => {
  // The content hash covers title + frontmatter + body, and `type` is derived
  // from frontmatter rather than stored in it, so a row written before the lift
  // has a hash that still matches its file. ingest()'s idempotence pre-check
  // therefore returns early and the column stays null forever. This is why the
  // 119 pages already in production needed a SQL backfill and not just a resync.
  await svc.ingest("typed.md", `---\ntype: concept\ntitle: Typed\n---\n# Typed\n\nBody.\n`);
  db.prepare(`UPDATE pages SET type = NULL WHERE slug = 'typed'`).run();
  const { changed } = await svc.ingest("typed.md", `---\ntype: concept\ntitle: Typed\n---\n# Typed\n\nBody.\n`);
  expect(changed).toBe(false);
  expect(store.getPage("typed")?.type).toBeNull();
});

// Markdown links resolve by PATH, relative to the linking page's source file,
// against the stored source_path of the target. Misses are dropped, not recorded
// as unresolved: plenty of docs link .md files outside the vault include list.

test("relative Markdown links become mdlink edges, resolved by source path", async () => {
  await svc.ingest("docs/meetings/m1-summary.md", "# M1\n\nbody\n");
  await svc.ingest("docs/arch.md", "# Arch\n\nbody\n");
  await svc.ingest("docs/00-index.md",
    "# Index\n\n[Arch](arch.md), [M1](meetings/m1-summary.md#top), [gone](nope.md), [self](00-index.md), [again](./arch.md)\n");
  const rows = db.prepare(`SELECT to_slug, link_type FROM page_links WHERE from_slug='00-index' ORDER BY to_slug`).all();
  expect(rows).toEqual([
    { to_slug: "arch", link_type: "mdlink" },
    { to_slug: "m1-summary", link_type: "mdlink" },
  ]);
  expect(db.prepare(`SELECT count(*) AS c FROM unresolved_links WHERE from_slug='00-index'`).get()).toEqual({ c: 0 });
});

test("an mdlink climbs out of a subdirectory", async () => {
  await svc.ingest("../other/bin/tool.md", "# Tool\n\nbody\n");
  await svc.ingest("../other/docs/guide.md", "# Guide\n\nSee [tool](../bin/tool.md).\n");
  expect(store.getBacklinks("tool").map((r) => r.from_slug)).toEqual(["guide"]);
});

test("resolveAll picks up an mdlink to a page ingested later", async () => {
  await svc.ingest("docs/index.md", "# Index\n\n[Later](later.md)\n");
  await svc.ingest("docs/later.md", "# Later\n\nbody\n");
  expect(store.getBacklinks("later")).toEqual([]);
  await svc.resolveAll();
  expect(store.getBacklinks("later").map((r) => r.from_slug)).toEqual(["index"]);
});
