import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { FakeEmbedder } from "../src/embed/fake.js";
import { SearchService } from "../src/search/index.js";

let db: Database;
let store: Store;
let search: SearchService;

beforeEach(() => {
  db = openDb(":memory:");
  store = new Store(db);
  search = new SearchService(db, store, new FakeEmbedder());
});

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;

async function seed() {
  const a = store.add({
    type: "note", subject: "A", content: "alpha",
    relationships: [{ predicate: "belongs_to", object: "project:x" }],
  });
  await search.index(a);
  const b = store.add({ type: "fact", subject: "B", content: "bravo" });
  await search.index(b);
  return { a, b };
}

test("reindex rebuilds all derived indexes from the canonical current records", async () => {
  await seed();
  store.clearDerivedIndexes(); // simulate corrupted/empty indexes
  expect(count(`SELECT count(*) c FROM records_fts`)).toBe(0);
  expect(count(`SELECT count(*) c FROM vec_records`)).toBe(0);

  const { records } = await search.reindexAll();
  expect(records).toBe(2);
  expect(count(`SELECT count(*) c FROM records_fts`)).toBe(2);
  expect(count(`SELECT count(*) c FROM vec_records`)).toBe(2);
  expect(count(`SELECT count(*) c FROM embeddings`)).toBe(2);
  expect(count(`SELECT count(*) c FROM relationships`)).toBe(1); // only A carried an edge

  const hits = await search.search("alpha");
  expect(hits.some((h) => h.record.subject === "A")).toBe(true); // searchable again
});

test("reindex only rebuilds current (non-superseded) records", async () => {
  const v1 = store.add({ type: "note", subject: "V", content: "one" });
  await search.index(v1);
  const v2 = store.update(v1.id, { content: "two" });
  await search.index(v2);

  await search.reindexAll();
  expect(count(`SELECT count(*) c FROM records_fts WHERE id = ?`, v1.id)).toBe(0);
  expect(count(`SELECT count(*) c FROM records_fts WHERE id = ?`, v2.id)).toBe(1);
});

test("doctor reports healthy after indexing, flags a missing vector, and reindex heals it", async () => {
  const { a } = await seed();
  const healthy = search.doctor();
  expect(healthy.currentRecords).toBe(2);
  expect(healthy.missingVector).toEqual([]);
  expect(healthy.orphanVector).toBe(0);
  expect(healthy.orphanRelationships).toBe(0);
  expect(healthy.staleModel).toBe(0);

  // Simulate a partial-index state (add succeeded, vector missing).
  db.prepare(`DELETE FROM vec_records WHERE record_id = ?`).run(a.id);
  expect(search.doctor().missingVector).toEqual([a.id]);

  await search.reindexAll();
  expect(search.doctor().missingVector).toEqual([]);
});

// An embedder whose calls fail on demand: `failing` flips the outage on/off.
class FlakyEmbedder extends FakeEmbedder {
  failing = false;
  override async embed(text: string, kind: "document" | "query"): Promise<Float32Array> {
    if (this.failing) throw new Error("embedder down");
    return super.embed(text, kind);
  }
}

test("reindex during an embedder outage keeps full keyword coverage and existing vectors", async () => {
  const flaky = new FlakyEmbedder();
  search = new SearchService(db, store, flaky);
  const recs = [];
  for (const s of ["alpha", "bravo", "charlie"]) {
    const r = store.add({ type: "note", subject: s, content: `${s} body` });
    await search.index(r);
    recs.push(r);
  }
  const before = search.doctor();
  expect(before.missingFts).toEqual([]);
  expect(before.missingVector).toEqual([]);

  flaky.failing = true;
  const result = await search.reindexAll();
  expect(result.records).toBe(3);
  expect(result.failed.sort()).toEqual(recs.map((r) => r.id).sort()); // every failure reported, none abandoned

  const after = search.doctor();
  expect(after.missingFts).toEqual([]);       // keyword coverage intact
  expect(after.missingVector).toEqual([]);    // prior vectors survive a failed re-embed
  for (const s of ["alpha", "bravo", "charlie"]) {
    const hits = await search.search(s);      // FTS-only path while the embedder is down
    expect(hits.some((h) => h.record.subject === s)).toBe(true);
  }
});

test("reindex still embeds the records it can when some embeddings fail", async () => {
  const { a } = await seed();
  store.clearDerivedIndexes();
  let calls = 0;
  const partial = new FakeEmbedder();
  const realEmbed = partial.embed.bind(partial);
  partial.embed = async (t, k) => { if (calls++ === 0) throw new Error("first fails"); return realEmbed(t, k); };
  search = new SearchService(db, store, partial);
  const result = await search.reindexAll();
  expect(result.failed).toHaveLength(1);
  expect(search.doctor().missingVector).toHaveLength(1); // only the failed one lacks a vector
  expect(search.doctor().missingFts).toEqual([]);
  expect(count(`SELECT count(*) c FROM relationships WHERE subject_id = ?`, a.id)).toBe(1);
});

// A controllable embedding: index() awaits it while the test mutates the store.
function gatedEmbedder() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const inner = new FakeEmbedder();
  const emb = new FakeEmbedder();
  emb.embed = async (t, k) => { await gate; return inner.embed(t, k); };
  return { emb, release };
}

for (const hard of [true, false]) {
  test(`an embedding that completes after a ${hard ? "hard" : "soft"} forget writes no derived rows`, async () => {
    const { emb, release } = gatedEmbedder();
    search = new SearchService(db, store, emb);
    const r = store.add({ type: "note", subject: "gone", content: "to be forgotten" });
    const pending = search.index(r);
    store.forget(r.id, hard);
    release();
    await pending;
    expect(count(`SELECT count(*) c FROM vec_records WHERE record_id = ?`, r.id)).toBe(0);
    expect(count(`SELECT count(*) c FROM embeddings WHERE record_id = ?`, r.id)).toBe(0);
    expect(search.doctor().orphanVector).toBe(0);
  });
}

test("an embedding that completes after its record is superseded writes no derived rows", async () => {
  const v1 = store.add({ type: "note", subject: "V", content: "one" });
  const { emb, release } = gatedEmbedder();
  search = new SearchService(db, store, emb);
  const pending = search.index(v1);
  const v2 = store.update(v1.id, { content: "two" });
  await new SearchService(db, store, new FakeEmbedder()).index(v2); // v2 lands first...
  release();
  await pending;                                                     // ...then v1's late embedding
  expect(count(`SELECT count(*) c FROM vec_records WHERE record_id = ?`, v1.id)).toBe(0);
  expect(count(`SELECT count(*) c FROM embeddings WHERE record_id = ?`, v1.id)).toBe(0);
  expect(count(`SELECT count(*) c FROM vec_records WHERE record_id = ?`, v2.id)).toBe(1);
});
