import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";

let db: Database;
let store: PagesStore;
let svc: PageService;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
});

test("snapshots an authored page with its link counts", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[B]]\n");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  await svc.resolveAll();

  store.writeSnapshot("2026-08-03");
  const rows = store.getSnapshot("2026-08-03");

  const a = rows.find((r) => r.slug === "a");
  const b = rows.find((r) => r.slug === "b");
  expect(a?.outbound).toBe(1);
  expect(b?.inbound).toBe(1);
  expect(a?.deleted).toBe(0);
});

// A digest that snapshotted its own generated page would report that page
// changing every single night, forever.
test("excludes generator-owned pages", async () => {
  await svc.putGenerated({ slug: "gen", title: "Gen", body: "# Gen\n" }, "test-gen");
  store.writeSnapshot("2026-08-03");
  expect(store.getSnapshot("2026-08-03").map((r) => r.slug)).not.toContain("gen");
});

// Tombstoned pages MUST stay in the snapshot, flagged. Dropping them would make
// "page tombstoned" indistinguishable from "page never existed".
test("keeps a tombstoned page, flagged deleted", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  store.softDelete("a");
  store.writeSnapshot("2026-08-03");
  expect(store.getSnapshot("2026-08-03").find((r) => r.slug === "a")?.deleted).toBe(1);
});

test("captures unresolved links by name", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  store.writeSnapshot("2026-08-03");
  const un = store.getUnresolvedSnapshot("2026-08-03");
  expect(un).toEqual([{ from_slug: "a", raw_text: "Nowhere" }]);
});

// Date-granular run_at is what makes a failed run recoverable: re-running the
// same day must replace, never accumulate.
test("a same-day re-run replaces rather than duplicating", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  store.writeSnapshot("2026-08-03");
  await svc.ingest("wiki/concepts/b.md", "---\ntitle: B\n---\n# B\n");
  store.writeSnapshot("2026-08-03");

  const rows = store.getSnapshot("2026-08-03");
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.slug === "a")).toHaveLength(1);
});

// A page deleted between two same-day runs must not survive as a stale row.
test("a same-day re-run drops rows for pages that vanished", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsee [[Nowhere]]\n");
  store.writeSnapshot("2026-08-03");
  expect(store.getUnresolvedSnapshot("2026-08-03")).toHaveLength(1);

  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  store.writeSnapshot("2026-08-03");
  expect(store.getUnresolvedSnapshot("2026-08-03")).toHaveLength(0);
});

test("previousSnapshotDate finds the most recent earlier run", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  store.writeSnapshot("2026-08-01");
  store.writeSnapshot("2026-08-02");
  store.writeSnapshot("2026-08-03");
  expect(store.previousSnapshotDate("2026-08-03")).toBe("2026-08-02");
});

test("previousSnapshotDate returns null on the first run", () => {
  expect(store.previousSnapshotDate("2026-08-03")).toBeNull();
});

// writeSnapshot only inserts a page_snapshots row per LIVE page, so a run
// against an empty graph leaves that table with no trace of the date at all.
// previousSnapshotDate must not conflate "ran with nothing to snapshot" with
// "never ran" -- the run right after this one needs to find it.
test("previousSnapshotDate finds an earlier run that captured zero pages", () => {
  store.writeSnapshot("2026-08-02"); // no pages ingested yet -- empty snapshot
  expect(store.previousSnapshotDate("2026-08-03")).toBe("2026-08-02");
});

// A same-day rerun must never see itself as its own "previous" run.
test("previousSnapshotDate excludes a run recorded for the same date", () => {
  store.writeSnapshot("2026-08-03");
  expect(store.previousSnapshotDate("2026-08-03")).toBeNull();
});

test("pruneSnapshots keeps the newest N dates", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\n");
  for (const d of ["2026-08-01", "2026-08-02", "2026-08-03"]) store.writeSnapshot(d);

  store.pruneSnapshots(2);

  expect(store.getSnapshot("2026-08-01")).toHaveLength(0);
  expect(store.getSnapshot("2026-08-02")).toHaveLength(1);
  expect(store.getSnapshot("2026-08-03")).toHaveLength(1);
  // The run-date ledger must be pruned in step, or a dropped date would keep
  // answering previousSnapshotDate queries for history that no longer exists.
  expect(store.previousSnapshotDate("2026-08-02")).toBeNull();
});
