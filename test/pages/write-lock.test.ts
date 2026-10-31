import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";

// Two connections on one WAL file, the shape of the 2026-10-22 field failure:
// an edit_page caller's ingest raced `vault sync` (a separate process writing
// the same DB). A DEFERRED transaction that reads before it writes takes a read
// snapshot first; when another writer holds or commits the write lock, the
// read->write upgrade fails at once with SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT
// ("database is locked"), and busy_timeout never applies. IMMEDIATE takes the
// write lock at BEGIN, where busy_timeout does apply, so the write waits.

const HOLD_MS = 400;
// The other writer runs on its own thread (a stand-in for the other process):
// it takes the write lock, says so, holds it HOLD_MS, then commits.
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const D = require(workerData.sqlite);
const db = new D(workerData.path);
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO meta (key, value) VALUES ('other-writer', 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
parentPort.postMessage("locked");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.hold);
db.exec("COMMIT");
db.close();
parentPort.postMessage("committed");
`;

let dir: string;
let db: Database;
let store: PagesStore;
let svc: PageService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mb-lock-"));
  db = openDb(join(dir, "brain.db"));
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Start the other writer and resolve once it holds the write lock; the
// returned `done` settles when it has committed and exited (wrapped in an
// object: an async function returning a bare promise would await it too).
async function otherWriterHoldsLock(): Promise<{ done: Promise<void> }> {
  const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
  const w = new Worker(WORKER, { eval: true, workerData: { path: join(dir, "brain.db"), sqlite, hold: HOLD_MS } });
  const done = new Promise<void>((res, rej) => { w.on("exit", () => res()); w.on("error", rej); });
  await new Promise<void>((res, rej) => {
    w.on("message", (m) => { if (m === "locked") res(); });
    w.on("error", rej);
  });
  return { done };
}

test("ingest waits for a concurrent writer instead of failing with 'database is locked'", async () => {
  await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nfirst\n");
  const { done } = await otherWriterHoldsLock();
  const t0 = Date.now();
  const r = await svc.ingest("wiki/concepts/a.md", "---\ntitle: A\n---\n# A\nsecond\n");
  const waited = Date.now() - t0;
  await done;
  expect(r.changed).toBe(true);
  expect(store.getPage("a")?.body).toContain("second");
  expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2);
});

test("resolvePending waits for a concurrent writer instead of failing", async () => {
  // A page with a pending link makes resolvePending's transaction read first.
  await svc.ingest("wiki/concepts/p.md", "---\ntitle: P\n---\n# P\nsee [[Q]]\n");
  const { done } = await otherWriterHoldsLock();
  await expect(svc.resolvePending()).resolves.toBeUndefined();
  await done;
  expect(store.getLinks("p").unresolved.map((u) => u.raw_text)).toEqual(["Q"]);
});
