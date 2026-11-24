import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { runDetection, DAEMON_KINDS } from "../../src/findings/index.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let findings: FindingsStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  findings = new FindingsStore(db);
});

test("records every MacBrain-side kind in one pass", async () => {
  await svc.ingest("wiki/concepts/lonely.md", "---\ntitle: L\n---\n# L\n[[Nowhere]]\n");
  const r = runDetection(store, findings, new Date("2026-08-11T00:00:00Z"));
  expect(r.added).toBe(2); // orphan:lonely + unresolved:Nowhere
  expect(findings.list({ state: "open" }).map((f) => f.key).sort())
    .toEqual(["orphan:lonely", "unresolved:Nowhere"]);
});

// runDetection must never touch gardener-owned kinds, or the nightly would
// resolve every contradiction the weekly probe found.
test("leaves gardener-owned kinds untouched", async () => {
  findings.upsertDetected({ kind: "contradiction", subject: "x|y", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  findings.upsertDetected({ kind: "red-link", subject: "z", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  runDetection(store, findings, new Date("2026-08-11T00:00:00Z"));
  expect(findings.get("contradiction:x|y")!.state).toBe("open");
  expect(findings.get("red-link:z")!.state).toBe("open");
});

// Measured against the real vault on 2026-08-11: rot-future-date returned 4
// findings and 0 true positives (book titles containing "Will"/"Next" sitting
// beside purchase dates), and rot-stale-todo has no input at all (zero
// unchecked checkboxes across 137 files). Pinned here so a future edit can't
// silently re-list them without a deliberate, reviewed change.
// In DAEMON_KINDS, so fixing the field resolves the finding on the next sweep.
test("records an unknown link type and resolves it once the field is fixed", async () => {
  await svc.ingest("wiki/concepts/hub.md", "---\ntitle: hub\n---\n# hub\n[[svc]]\n");
  await svc.ingest("wiki/concepts/svc.md", "---\ntitle: svc\n---\n# svc\nhosted-on:: [[hub]]\n");
  runDetection(store, findings, new Date("2026-10-22T00:00:00Z"));
  expect(findings.get("unknown-link-type:svc:hosted-on")!.state).toBe("open");
  await svc.ingest("wiki/concepts/svc.md", "---\ntitle: svc\n---\n# svc\nruns-on:: [[hub]]\n");
  runDetection(store, findings, new Date("2026-10-23T00:00:00Z"));
  expect(findings.get("unknown-link-type:svc:hosted-on")!.state).toBe("resolved");
});

// Measured against the real vault on 2026-10-31 before registering: 3 findings
// across 195 files, one a real SIP password and two truncated token fragments.
test("records a credential-shaped line, without the value, and resolves it once removed", async () => {
  const token = "a1".repeat(32);
  await svc.ingest("raw/2026-10-31-x-session.md", "---\ntitle: x\n---\n# x\nGATE_MCP_BEAR" + "ER=" + token + "\n");
  runDetection(store, findings, new Date("2026-10-31T00:00:00Z"));
  const f = findings.get("secret:2026-10-31-x-session")!;
  expect(f.state).toBe("open");
  expect(f.detail).toContain("secret-assignment body line 2");
  expect(f.detail).not.toContain(token);
  await svc.ingest("raw/2026-10-31-x-session.md", "---\ntitle: x\n---\n# x\nGATE_MCP_BEARER is in the store\n");
  runDetection(store, findings, new Date("2026-11-01T00:00:00Z"));
  expect(findings.get("secret:2026-10-31-x-session")!.state).toBe("resolved");
});

test("DAEMON_KINDS excludes the unfit rot detectors", () => {
  expect(DAEMON_KINDS).not.toContain("rot-future-date");
  expect(DAEMON_KINDS).not.toContain("rot-stale-todo");
});

test("runDetection raises and resolves stale pages, with the limit from STALE_DAYS", async () => {
  await svc.ingest("wiki/concepts/p.md", "---\ntitle: P\nverified: { by: human:owner, at: 2026-01-01 }\n---\n# P\n[[Q]]\n");
  await svc.ingest("wiki/concepts/q.md", "---\ntitle: Q\n---\n# Q\n[[P]]\n");
  const now = new Date("2026-10-31T00:00:00Z");
  process.env.ENSCRIBE_STALE_DAYS = "400";
  try {
    runDetection(store, findings, now);
    expect(findings.get("stale:p")).toBeUndefined();
  } finally {
    delete process.env.ENSCRIBE_STALE_DAYS;
  }
  runDetection(store, findings, now); // default 180
  expect(findings.get("stale:p")!.state).toBe("open");
  await svc.ingest("wiki/concepts/p.md", "---\ntitle: P\nverified: { by: human:owner, at: 2026-10-30 }\n---\n# P\n[[Q]]\n");
  runDetection(store, findings, now);
  expect(findings.get("stale:p")!.state).toBe("resolved");
});
