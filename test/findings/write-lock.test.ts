import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { openDb, type Database } from "../../src/core/db.js";
import { FindingsStore } from "../../src/findings/ledger.js";

// Same race as test/pages/write-lock.test.ts, on the ledger: add_finding from
// MCP against a nightly report_findings reconcile in another process. add and
// reconcile read (get) before they write, so a DEFERRED transaction fails at
// once with SQLITE_BUSY while another connection holds the write lock;
// IMMEDIATE waits on busy_timeout.

const HOLD_MS = 400;
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
`;

let dir: string;
let db: Database;
let store: FindingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mb-ledger-lock-"));
  db = openDb(join(dir, "brain.db"));
  store = new FindingsStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Resolves once the other writer holds the lock; `done` settles when it has
// committed and exited (wrapped: an async function would await a bare promise).
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

test("add waits for a concurrent writer instead of failing with SQLITE_BUSY", async () => {
  const { done } = await otherWriterHoldsLock();
  const t0 = Date.now();
  const r = store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-10-22T00:00:00Z");
  const waited = Date.now() - t0;
  await done;
  expect(r.created).toBe(true);
  expect(store.get("needs-human:a")?.state).toBe("open");
  expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2);
});

test("reconcile waits for a concurrent writer instead of failing with SQLITE_BUSY", async () => {
  const { done } = await otherWriterHoldsLock();
  const t0 = Date.now();
  const r = store.reconcile(["orphan"], [{ kind: "orphan", subject: "a", detail: "d" }], "macbrain", "2026-10-22T00:00:00Z");
  const waited = Date.now() - t0;
  await done;
  expect(r.added).toBe(1);
  expect(store.get("orphan:a")?.state).toBe("open");
  expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2);
});
