import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";

let db: Database;
let store: Store;
let search: SearchService;

beforeEach(async () => {
  db = openDb(":memory:");
  store = new Store(db);
  search = new SearchService(db, store, new FakeEmbedder());
});

function ftsCount(id: string): number {
  return (db.prepare(`SELECT count(*) AS c FROM records_fts WHERE id = ?`).get(id) as { c: number }).c;
}
function vecCount(id: string): number {
  return (db.prepare(`SELECT count(*) AS c FROM vec_records WHERE record_id = ?`).get(id) as { c: number }).c;
}
function relCount(id: string): number {
  return (db.prepare(`SELECT count(*) AS c FROM relationships WHERE subject_id = ?`).get(id) as { c: number }).c;
}

async function add(subject: string, content: string, tags: string[] = []) {
  const rec = store.add({ type: "note", subject, content, tags });
  await search.index(rec);
  return rec;
}

test("full-text leg finds an exact term", async () => {
  await add("Payments", "The Base24 switch handled authorization.");
  await add("Weather", "It rained in Springfield.");
  const hits = await search.search("Base24");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].record.subject).toBe("Payments");
  expect(hits[0].fts).toBe(true);
});

test("vector leg matches identical text (FakeEmbedder is deterministic, not semantic)", async () => {
  const rec = await add("Note", "unique lexical token zzqqx");
  // FakeEmbedder is a deterministic hash-based embedder: identical text maps to
  // an identical vector, so the vector leg matches here. This does NOT
  // demonstrate semantic/paraphrase retrieval, which FakeEmbedder cannot do.
  const hits = await search.search("unique lexical token zzqqx");
  expect(hits.some((h) => h.record.id === rec.id && h.vector)).toBe(true);
});

test("a record matching both legs outranks one matching a single leg", async () => {
  const both = await add("Fusion", "reciprocal rank fusion blends results");
  await add("Single", "reciprocal only appears here lexically");
  const hits = await search.search("reciprocal rank fusion blends results");
  expect(hits[0].record.id).toBe(both.id);
});

test("type filter narrows results", async () => {
  const rec = store.add({ type: "decision", subject: "D", content: "pick sqlite" });
  await search.index(rec);
  await add("N", "pick sqlite");
  const hits = await search.search("sqlite", { type: "decision" });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.record.type === "decision")).toBe(true);
});

test("superseded and tombstoned records are excluded from search", async () => {
  // Supersession: once v2 exists, v1 (the prior version) must not surface.
  const v1 = await add("Switch", "the base24 switch runs on nonstop hardware");
  const v2 = store.update(v1.id, { content: "the base24 switch runs on updated hardware" });
  await search.index(v2);

  const hits = await search.search("base24 switch hardware");
  expect(hits.some((h) => h.record.id === v2.id)).toBe(true);
  expect(hits.some((h) => h.record.id === v1.id)).toBe(false);

  // Tombstoning: a record with no successor must not surface once forgotten.
  // (Tombstoning v2 here instead would un-supersede v1 per current_records'
  // view semantics — v1 has no other live record pointing `supersedes` at it,
  // so it would legitimately resurface as current. That's a property of the
  // Store/schema, out of scope for this task, so this test avoids that
  // interaction by exercising tombstone-exclusion on a standalone record.)
  const rec3 = await add("Weather", "unrelated standalone content about clouds");
  store.forget(rec3.id);

  const hits2 = await search.search("unrelated standalone content about clouds");
  expect(hits2.some((h) => h.record.id === rec3.id)).toBe(false);
});

test("punctuation in a query does not cause an FTS5 error", async () => {
  await add("Payments", "The Base24 switch handled authorization.");
  const hits = await search.search("Base24: the switch!");
  expect(hits.some((h) => h.record.subject === "Payments")).toBe(true);
});

test("a query with no alphanumeric terms does not throw", async () => {
  await expect(search.search("!!! ???")).resolves.toBeDefined();
});

test("indexing a superseding version prunes the prior version from the search indexes", async () => {
  const v1 = await add("Ports", "eero forwards port 3133");
  expect(ftsCount(v1.id)).toBe(1);
  expect(vecCount(v1.id)).toBe(1);

  const v2 = store.update(v1.id, { content: "eero forwards port 3134 now" });
  await search.index(v2);

  // The superseded version is gone from BOTH derived indexes (no stale-row bloat).
  expect(ftsCount(v1.id)).toBe(0);
  expect(vecCount(v1.id)).toBe(0);
  // The current version is indexed.
  expect(ftsCount(v2.id)).toBe(1);
  expect(vecCount(v2.id)).toBe(1);
});

test("indexing a superseding version prunes the prior version's relationship rows", async () => {
  const v1 = store.add({
    type: "note", subject: "Linked", content: "edge holder",
    relationships: [{ predicate: "belongs_to", object: "project:x" }],
  });
  await search.index(v1);
  expect(relCount(v1.id)).toBe(1);

  const v2 = store.update(v1.id, { content: "edge holder v2" });
  await search.index(v2);

  expect(relCount(v1.id)).toBe(0); // prior version's edges pruned from the derived index
  expect(relCount(v2.id)).toBe(1); // current version carries the inherited edge
});

test("forget prunes the record from the search indexes while get() still returns it", async () => {
  const rec = await add("Secret", "confidential token zzqqx about clouds");
  expect(ftsCount(rec.id)).toBe(1);
  expect(vecCount(rec.id)).toBe(1);

  store.forget(rec.id); // soft (tombstone)

  // Removed from the derived search indexes...
  expect(ftsCount(rec.id)).toBe(0);
  expect(vecCount(rec.id)).toBe(0);
  // ...but the canonical record is still retrievable by id (auditable)...
  expect(store.get(rec.id)).toBeDefined();
  // ...and never surfaces in search.
  const hits = await search.search("confidential token zzqqx about clouds");
  expect(hits.some((h) => h.record.id === rec.id)).toBe(false);
});

// Deterministic polar embedder: everything embeds on one axis, with decisions
// (marked) at the opposite pole from the query — guaranteed outside any KNN
// pool that notes can fill.
class PolarEmbedder {
  readonly model = "polar-test";
  readonly dim = 768;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    v[0] = text.includes("DECISION-MARKER") ? -1 : 1;
    return v;
  }
}

test("type filter finds matches even when the candidate pool is dominated by another type", async () => {
  const svc = new SearchService(db, store, new PolarEmbedder());
  for (let i = 0; i < 40; i++) {
    const rec = store.add({ type: "note", subject: `gadget gadget gadget ${i}`, content: "gadget gadget", tags: [] });
    await svc.index(rec);
  }
  const filler = "long unrelated filler text about many other topics entirely ".repeat(5);
  const d1 = store.add({ type: "decision", subject: "DECISION-MARKER one", content: `${filler} gadget`, tags: [] });
  const d2 = store.add({ type: "decision", subject: "DECISION-MARKER two", content: `${filler} gadget`, tags: [] });
  await svc.index(d1);
  await svc.index(d2);

  const hits = await svc.search("gadget", { type: "decision", limit: 5 });
  expect(hits.map((h) => h.record.id).sort()).toEqual([d1.id, d2.id].sort());
});

test("embedder failure degrades record search to FTS-only instead of failing", async () => {
  const rec = await add("Payments", "the base24 switch handled authorization");
  const broken = { model: "broken", dim: 768, embed: async () => { throw new Error("onnx down"); } };
  const degraded = new SearchService(db, store, broken as never);
  const hits = await degraded.search("base24");
  expect(hits.some((h) => h.record.id === rec.id)).toBe(true);
  expect(hits.every((h) => h.vector === false)).toBe(true);
});

test("embedder failure degrades unified search to FTS-only instead of failing", async () => {
  const rec = await add("Payments", "the base24 switch handled authorization");
  const broken = { model: "broken", dim: 768, embed: async () => { throw new Error("onnx down"); } };
  const degraded = new SearchService(db, store, broken as never);
  const hits = await degraded.searchUnified("base24");
  expect(hits.some((h) => h.kind === "record" && h.record.id === rec.id)).toBe(true);
  expect(hits.every((h) => h.vector === false)).toBe(true);
});
