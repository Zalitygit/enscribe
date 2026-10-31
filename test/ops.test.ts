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
