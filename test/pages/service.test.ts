import { beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { CHUNK_SCHEME, chunkBody } from "../../src/pages/parse.js";

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

// The same embedder reporting another model name, as a backend change would.
function renamed(model: string): CountingEmbedder {
  return Object.defineProperty(new CountingEmbedder(), "model", { value: model });
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

// Unchanged content is only a no-op when the derived chunk rows are still the
// ones this service would write. Otherwise vault sync, the documented recovery
// route, could never heal a model change, a scheme bump or a lost index.
const NOTE = `---\ntitle: Note\n---\n# Note\n\nBody text.\n`;
const chunkCount = (table: string) =>
  (db.prepare(`SELECT count(*) AS c FROM ${table} WHERE chunk_id LIKE 'note#%'`).get() as { c: number }).c;

test("an unchanged re-ingest under a different embedding model re-embeds", async () => {
  await svc.ingest("note.md", NOTE);
  const emb = renamed("replacement-model");
  const { changed } = await new PageService(db, store, emb).ingest("note.md", NOTE);
  expect(changed).toBe(true);
  expect(emb.calls).toBeGreaterThan(0);
  expect(store.chunkProvenance().map((r) => r.embedding_model)).toEqual(["replacement-model"]);
});

test("an unchanged re-ingest after a chunk-scheme change re-embeds", async () => {
  await svc.ingest("note.md", NOTE);
  db.prepare(`UPDATE page_chunks SET chunk_scheme = 'older-scheme'`).run();
  const emb = new CountingEmbedder();
  expect((await new PageService(db, store, emb).ingest("note.md", NOTE)).changed).toBe(true);
  expect(emb.calls).toBeGreaterThan(0);
  expect(store.chunkProvenance().map((r) => r.chunk_scheme)).toEqual([CHUNK_SCHEME]);
});

for (const table of ["page_chunks", "page_chunks_fts", "page_chunks_fts_exact", "vec_page_chunks"]) {
  test(`an unchanged re-ingest rebuilds a page whose ${table} rows are missing`, async () => {
    await svc.ingest("note.md", NOTE);
    const expected = chunkCount("page_chunks");
    db.prepare(`DELETE FROM ${table} WHERE chunk_id LIKE 'note#%'`).run();
    expect((await svc.ingest("note.md", NOTE)).changed).toBe(true);
    for (const t of ["page_chunks", "page_chunks_fts", "page_chunks_fts_exact", "vec_page_chunks"]) {
      expect(chunkCount(t)).toBe(expected);
    }
  });
}

test("a frontmatter-only edit re-embeds when the reused chunks are stale", async () => {
  await svc.ingest("note.md", NOTE);
  const emb = renamed("replacement-model");
  await new PageService(db, store, emb).ingest("note.md", `---\ntitle: Note\nupdated: 2026-10-31\n---\n# Note\n\nBody text.\n`);
  expect(emb.calls).toBeGreaterThan(0);
  expect(store.chunkProvenance().map((r) => r.embedding_model)).toEqual(["replacement-model"]);
});

test("putGenerated rebuilds unchanged content whose chunks are stale", async () => {
  await svc.putGenerated({ slug: "note", title: "Note", body: "Generated body." }, "gen");
  const emb = renamed("replacement-model");
  const res = await new PageService(db, store, emb).putGenerated({ slug: "note", title: "Note", body: "Generated body." }, "gen");
  expect(res.changed).toBe(true);
  expect(store.chunkProvenance().map((r) => r.embedding_model)).toEqual(["replacement-model"]);
});

test("a page whose body yields no chunks is still a no-op on re-ingest", async () => {
  await svc.ingest("empty.md", `---\ntitle: Empty\n---\n`);
  expect((await svc.ingest("empty.md", `---\ntitle: Empty\n---\n`)).changed).toBe(false);
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

// A file's slug can change in place (frontmatter `slug:` edited). The file is
// one page, so the former slug must be retired, not left live beside the new one.
const live = () => store.listPages().map((p) => p.slug).sort();

test("re-ingesting a file under a new slug retires the former slug", async () => {
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nalpha body\n`);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: new\n---\nalpha body\n`);
  expect(live()).toEqual(["new"]);
  expect(store.getPage("old")?.deleted_at).not.toBeNull();
  expect((db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='old'`).get() as { c: number }).c).toBe(0);
  expect(store.resolve("Alpha")).toBe("new");
});

test("deleting the file after a slug change leaves no live page for it", async () => {
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nalpha body\n`);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: new\n---\nalpha body\n`);
  const page = store.getBySourcePath("wiki/a.md"); // what the watcher does on unlink
  store.softDelete(page!.slug);
  expect(live()).toEqual([]);
});

test("inbound links follow a slug change: by title they re-resolve, by old slug they go unresolved", async () => {
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nalpha body\n`);
  await svc.ingest("wiki/b.md", `---\ntitle: Bee\n---\nSee [[Alpha]] and [[old]].\n`);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: new\n---\nalpha body\n`);
  const to = (db.prepare(`SELECT to_slug FROM page_links WHERE from_slug='b'`).all() as { to_slug: string }[]).map((r) => r.to_slug);
  expect(to).toEqual(["new"]);
  const unresolved = (db.prepare(`SELECT raw_text FROM unresolved_links WHERE from_slug='b'`).all() as { raw_text: string }[]).map((r) => r.raw_text);
  expect(unresolved).toEqual(["old"]);
});

// writePage embeds before its transaction, so an older ingest of a file can
// commit after a newer one. The newer ingest of a source path must win however
// the embeddings finish, including across processes (two connections, one DB).
function holdable() {
  const inner = new FakeEmbedder();
  const emb = new FakeEmbedder();
  let gate: Promise<void> | null = null;
  emb.embed = async (t, k) => { const g = gate; gate = null; if (g) await g; return inner.embed(t, k); };
  // Holds the NEXT embed call (the first chunk of the next ingest that embeds).
  const holdNext = () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return release; };
  return { emb, holdNext };
}

test("a delayed older ingest cannot retire the newer slug (reversed completion)", async () => {
  const { emb, holdNext } = holdable();
  svc = new PageService(db, store, emb);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nfirst\n`);
  const release = holdNext();
  const older = svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nsecond\n`);
  await svc.ingest("wiki/b.md", `---\ntitle: Bee\n---\nSee [[Alpha]].\n`);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: new\n---\nthird\n`);
  release();
  await older;
  expect(live()).toEqual(["b", "new"]);
  expect(store.getPage("new")?.body).toContain("third");
  expect((db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='new'`).get() as { c: number }).c).toBeGreaterThan(0);
  expect((db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug='old'`).get() as { c: number }).c).toBe(0);
  const to = (db.prepare(`SELECT to_slug FROM page_links WHERE from_slug='b'`).all() as { to_slug: string }[]).map((r) => r.to_slug);
  expect(to).toEqual(["new"]);
});

test("two edits of one file with reversed embedding completion keep the later body", async () => {
  const { emb, holdNext } = holdable();
  svc = new PageService(db, store, emb);
  const release = holdNext();
  const older = svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nolder\n`);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nnewer\n`);
  release();
  await older;
  expect(store.getPage("a")?.body).toContain("newer");
});

test("a newer ingest that finds the content unchanged still cancels an older in-flight one", async () => {
  const { emb, holdNext } = holdable();
  svc = new PageService(db, store, emb);
  await svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nv1\n`);
  const release = holdNext();
  const older = svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nv2\n`);
  expect(await svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nv1\n`)).toEqual({ slug: "a", changed: false }); // reverted
  release();
  await older;
  expect(store.getPage("a")?.body).toContain("v1");
});

// Authored-wins must hold at commit time, not only when putGenerated starts:
// an authored ingest can land while the generator is embedding.
test("a generator that was embedding when an authored page landed yields to it", async () => {
  const { emb, holdNext } = holdable();
  const gen = new PageService(db, store, emb);
  const release = holdNext();
  const pending = gen.putGenerated({ slug: "race", title: "Race", body: "Generated report" }, "gen");
  await svc.ingest("wiki/race.md", "# Race\nAuthored canonical note\n");
  release();
  expect(await pending).toEqual({ slug: "race", changed: false, skipped: "wiki/race.md" });
  const page = store.getPage("race");
  expect(page?.source_path).toBe("wiki/race.md");
  expect(page?.generator).toBeNull();
  expect(page?.body).toContain("Authored canonical note");
  expect((db.prepare(`SELECT text FROM page_chunks WHERE slug='race'`).all() as { text: string }[])
    .every((r) => r.text.includes("Authored"))).toBe(true);
});

test("retire() removes the live page and cancels an in-flight ingest of that path", async () => {
  const { emb, holdNext } = holdable();
  svc = new PageService(db, store, emb);
  const release = holdNext();
  const pending = svc.ingest("wiki/a.md", `---\ntitle: Alpha\n---\nbody\n`);
  svc.retire("wiki/a.md");
  release();
  await pending;
  expect(live()).toEqual([]);
});

test("the newer ingest wins across two connections to one database file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-ingest-"));
  try {
    const path = join(dir, "x.db");
    const db1 = openDb(path), db2 = openDb(path);
    const s1 = new PagesStore(db1), s2 = new PagesStore(db2);
    const { emb, holdNext } = holdable();
    const p1 = new PageService(db1, s1, emb), p2 = new PageService(db2, s2, new FakeEmbedder());
    const release = holdNext();
    const older = p1.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: old\n---\nolder\n`);
    await p2.ingest("wiki/a.md", `---\ntitle: Alpha\nslug: new\n---\nnewer\n`);
    release();
    await older;
    expect(s1.listPages().map((p) => p.slug)).toEqual(["new"]);
    db1.close(); db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Another process can commit between this process's last read and its write
// transaction (while BEGIN IMMEDIATE waits for the lock), or right after it.
// Runs `before`/`after` around the next transaction's body to stand in for it.
function aroundNextTransaction(d: Database, hooks: { before?: () => void; after?: () => void }) {
  const orig = d.transaction.bind(d);
  (d as any).transaction = (body: (...a: unknown[]) => unknown) => {
    (d as any).transaction = orig;
    const tx = orig(body);
    const run = (...a: unknown[]) => tx(...a);
    run.immediate = (...a: unknown[]) => {
      hooks.before?.();
      try { return tx.immediate(...a); } finally { hooks.after?.(); }
    };
    return run;
  };
}

test("a yielding generator reports the authored owner it saw at commit, even if it is purged just after", async () => {
  const { emb, holdNext } = holdable();
  const gen = new PageService(db, store, emb);
  const release = holdNext();
  const pending = gen.putGenerated({ slug: "race", title: "Race", body: "Generated report" }, "gen");
  await svc.ingest("wiki/race.md", "# Race\nAuthored canonical note\n");
  aroundNextTransaction(db, { after: () => { svc.retire("wiki/race.md"); store.purgeTombstoned(); } });
  release();
  expect(await pending).toEqual({ slug: "race", changed: false, skipped: "wiki/race.md" });
});

test("chunks lost after the reuse decision are rebuilt, not reused", async () => {
  const body = "# Report\n\nGenerated body.\n";
  await svc.putGenerated({ slug: "rep", title: "Report", body, type: "a" }, "gen");
  // Same title and body, so the chunks would be reused; another writer drops
  // the keyword rows before this write's transaction runs.
  aroundNextTransaction(db, { before: () => {
    db.prepare(`DELETE FROM page_chunks_fts WHERE chunk_id LIKE 'rep#%'`).run();
  } });
  expect((await svc.putGenerated({ slug: "rep", title: "Report", body, type: "b" }, "gen")).changed).toBe(true);
  expect(store.chunksIntact("rep", chunkBody(body).length, { model: new FakeEmbedder().model, scheme: CHUNK_SCHEME })).toBe(true);
});
