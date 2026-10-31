import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import type { RecordInput } from "../../src/core/types.js";

function sample(): RecordInput {
  return {
    type: "decision",
    subject: "MacBrain storage",
    content: "Use one SQLite file with derived indexes.",
    tags: ["architecture", "sqlite"],
    entities: [{ type: "project", id: "project:macbrain" }],
    provenance: { author: "user", confidence: 1 },
  };
}

let db: Database;
let store: Store;
beforeEach(() => { db = openDb(":memory:"); store = new Store(db); });

function relCount(subjectId: string): number {
  return (db.prepare(`SELECT count(*) AS c FROM relationships WHERE subject_id = ?`).get(subjectId) as { c: number }).c;
}

test("add then get round-trips a record with an assigned ULID and hash", () => {
  const rec = store.add(sample());
  expect(rec.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  expect(rec.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(rec.version).toBe(1);
  const got = store.get(rec.id);
  expect(got?.subject).toBe("MacBrain storage");
  expect(got?.tags).toEqual(["architecture", "sqlite"]);
});

test("update writes a new superseding version and current hides the old one", () => {
  const v1 = store.add(sample());
  const v2 = store.update(v1.id, { content: "Revised: SQLite + sqlite-vec." });
  expect(v2.supersedes).toBe(v1.id);
  expect(v2.version).toBe(2);
  const current = store.listCurrent();
  expect(current.map((r) => r.id)).toContain(v2.id);
  expect(current.map((r) => r.id)).not.toContain(v1.id);
});

test("forget tombstones by default and removes it from current", () => {
  const rec = store.add(sample());
  store.forget(rec.id);
  expect(store.listCurrent().map((r) => r.id)).not.toContain(rec.id);
  expect(store.get(rec.id)).toBeDefined(); // still retrievable by id (auditable)
});

test("forget erases the whole supersede lineage, not just the given id", () => {
  const v1 = store.add(sample());
  const v2 = store.update(v1.id, { content: "Revised: SQLite + sqlite-vec." });
  store.forget(v2.id);
  const currentIds = store.listCurrent().map((r) => r.id);
  expect(currentIds).not.toContain(v1.id);
  expect(currentIds).not.toContain(v2.id);
  // Soft tombstone: both versions remain retrievable by id (auditable).
  expect(store.get(v1.id)).toBeDefined();
  expect(store.get(v2.id)).toBeDefined();
});

test("update resolves to the current lineage head (no fork on a stale id)", () => {
  const v1 = store.add(sample());
  const v2 = store.update(v1.id, { content: "v2" });
  // Update again using the ORIGINAL (now stale) id — must supersede the head (v2),
  // not create a second live version off v1.
  const v3 = store.update(v1.id, { content: "v3" });
  expect(v3.supersedes).toBe(v2.id);
  expect(v3.version).toBe(3);
  const currentIds = store.listCurrent().map((r) => r.id);
  expect(currentIds.filter((id) => [v1.id, v2.id, v3.id].includes(id))).toEqual([v3.id]);
});

test("forget prunes relationship rows but the canonical doc retains them", () => {
  const rec = store.add({
    type: "note", subject: "linked", content: "c",
    relationships: [{ predicate: "belongs_to", object: "project:macbrain" }],
  });
  expect(relCount(rec.id)).toBe(1);
  store.forget(rec.id); // soft tombstone
  expect(relCount(rec.id)).toBe(0); // derived relationships index pruned
  expect(store.get(rec.id)?.relationships).toEqual([
    { predicate: "belongs_to", object: "project:macbrain" },
  ]); // canonical doc still carries the edge (auditable, rebuildable)
});

test("listCurrent tolerates bad limit values (NaN / negative)", () => {
  store.add(sample());
  store.add({ type: "note", subject: "n", content: "c" });
  expect(() => store.listCurrent({ limit: -5 })).not.toThrow();
  expect(() => store.listCurrent({ limit: NaN as unknown as number })).not.toThrow();
  expect(store.listCurrent({ limit: 1 }).length).toBe(1); // a sane limit still bounds
});

test("listCurrent filters by type", () => {
  store.add(sample());
  store.add({ type: "note", subject: "n", content: "a note" });
  expect(store.listCurrent({ type: "note" }).length).toBe(1);
});

test("listCurrent filters by project via an entity match, not a doc substring", () => {
  store.add({
    type: "note", subject: "has project entity", content: "n/a",
    entities: [{ type: "project", id: "project:x" }],
  });
  store.add({
    type: "note", subject: "mentions project:x in content only", content: "see project:x for details",
  });
  // Decoy that would false-positive under the old `doc LIKE '%"id":"<project>"%'`
  // substring check: a non-project entity whose id happens to equal the project id.
  // The doc's serialized JSON contains the substring `"id":"project:x"` even though
  // this entity's type is "person", not "project".
  store.add({
    type: "note", subject: "person entity sharing the project's id value", content: "n/a",
    entities: [{ type: "person", id: "project:x" }],
  });
  const results = store.listCurrent({ project: "project:x" });
  expect(results.length).toBe(1);
  expect(results[0].subject).toBe("has project entity");
});
