import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { FindingsStore } from "../../src/findings/ledger.js";

let db: Database;
let store: FindingsStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new FindingsStore(db);
});

test("inserts a detected finding as open, seen once", () => {
  store.upsertDetected({ kind: "orphan", subject: "home-paint-colors", detail: "no inbound links" },
    "macbrain", "2026-08-11T00:00:00Z");
  const f = store.get("orphan:home-paint-colors")!;
  expect(f.state).toBe("open");
  expect(f.times_reported).toBe(1);
  expect(f.first_seen).toBe("2026-08-11T00:00:00Z");
  expect(f.last_seen).toBe("2026-08-11T00:00:00Z");
});

test("re-detecting bumps last_seen and the count but never first_seen", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-02T00:00:00Z");
  const f = store.get("orphan:a")!;
  expect(f.first_seen).toBe("2026-08-01T00:00:00Z");
  expect(f.last_seen).toBe("2026-08-02T00:00:00Z");
  expect(f.times_reported).toBe(2);
});

// wont_fix is the entire point of the ledger: Group A red links are described as
// "expected, not rot" in every digest and reported in full every night anyway.
// If re-detection could clear this state, nothing would ever stay dismissed.
test("re-detecting does not disturb a wont_fix state", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.setState("orphan:a", "wont_fix", "deliberate placeholder", "2026-08-01T12:00:00Z");
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-02T00:00:00Z");
  const f = store.get("orphan:a")!;
  expect(f.state).toBe("wont_fix");
  expect(f.note).toBe("deliberate placeholder");
  expect(f.times_reported).toBe(2);
});

// The deployment's triage step is a human hand-typing keys (e.g.
// `red-link:reference_biography`). A typo or wrong kind-prefix must not
// report success and silently do nothing — that reads as the feature being
// broken when the finding reappears the next night unchanged.
test("setState on a nonexistent key throws instead of silently no-op'ing", () => {
  expect(() => store.setState("orphan:does-not-exist", "wont_fix", null, "2026-08-01T00:00:00Z"))
    .toThrow();
});

test("list filters by state and by kind", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.upsertDetected({ kind: "unresolved", subject: "b", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.setState("unresolved:b", "wont_fix", null, "2026-08-01T00:00:00Z");
  expect(store.list({ state: "open" }).map((f) => f.key)).toEqual(["orphan:a"]);
  expect(store.list({ kind: "unresolved" }).map((f) => f.key)).toEqual(["unresolved:b"]);
});

// Byte-determinism of brain-findings depends on a stable order out of the store,
// not on every caller remembering to sort.
test("list returns findings ordered by key", () => {
  for (const s of ["c", "a", "b"]) {
    store.upsertDetected({ kind: "orphan", subject: s, detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  }
  expect(store.list({}).map((f) => f.subject)).toEqual(["a", "b", "c"]);
});

test("resolves an open finding that is no longer detected", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  const r = store.reconcile(["orphan"], [], "macbrain", "2026-08-02T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("resolved");
  expect(r.resolved).toBe(1);
});

// A fixed finding that comes back is a real event. Silently re-counting it
// against the old row would hide a regression.
test("reopens a resolved finding when it is detected again", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.reconcile(["orphan"], [], "macbrain", "2026-08-02T00:00:00Z");
  const r = store.reconcile(["orphan"], [{ kind: "orphan", subject: "a", detail: "d" }], "macbrain", "2026-08-03T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("open");
  expect(r.reopened).toBe(1);
});

test("a wont_fix finding resolves silently once the condition disappears", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.setState("orphan:a", "wont_fix", "placeholder", "2026-08-01T00:00:00Z");
  store.reconcile(["orphan"], [], "macbrain", "2026-08-02T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("resolved");
});

// THE load-bearing test. Two sources write to one ledger. Without kind scoping,
// the gardener reporting ['contradiction'] would resolve every orphan MacBrain
// detected an hour earlier, and the next MacBrain run would reopen them all --
// every finding would flap open/resolved nightly forever.
test("reconcile leaves kinds outside its scope untouched", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.upsertDetected({ kind: "contradiction", subject: "x|y", detail: "d" }, "gardener", "2026-08-01T00:00:00Z");
  store.reconcile(["contradiction"], [], "gardener", "2026-08-02T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("open");
  expect(store.get("contradiction:x|y")!.state).toBe("resolved");
});

// The feature's headline invariant, asserted at the reconcile() boundary
// (not just one layer down at upsertDetected): a human declined this
// finding, and re-detecting it through the normal nightly path must not
// silently undo that decision.
test("a wont_fix finding re-detected via reconcile stays wont_fix", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  store.setState("orphan:a", "wont_fix", "deliberate placeholder", "2026-08-01T12:00:00Z");
  const r = store.reconcile(["orphan"], [{ kind: "orphan", subject: "a", detail: "d" }], "macbrain", "2026-08-02T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("wont_fix");
  expect(store.get("orphan:a")!.note).toBe("deliberate placeholder");
  expect(r).toMatchObject({ added: 0, reopened: 0, resolved: 0, unchanged: 1 });
});

// The one row of the reconciliation table (added/reopened/resolved/unchanged)
// with no direct assertion: an open finding that is detected again on a
// later run must stay open and count as unchanged, not added or reopened.
test("an open finding re-detected via reconcile stays open and counts as unchanged", () => {
  store.upsertDetected({ kind: "orphan", subject: "a", detail: "d" }, "macbrain", "2026-08-01T00:00:00Z");
  const r = store.reconcile(["orphan"], [{ kind: "orphan", subject: "a", detail: "d" }], "macbrain", "2026-08-02T00:00:00Z");
  expect(store.get("orphan:a")!.state).toBe("open");
  expect(r).toMatchObject({ added: 0, reopened: 0, resolved: 0, unchanged: 1 });
});

test("counts a first-time finding as added, not reopened", () => {
  const r = store.reconcile(["orphan"], [{ kind: "orphan", subject: "a", detail: "d" }], "macbrain", "2026-08-01T00:00:00Z");
  expect(r).toMatchObject({ added: 1, reopened: 0, resolved: 0 });
});

test("add files a finding as open, seen once, carrying its due date", () => {
  store.add({ kind: "needs-human", subject: "codex-reauth", detail: "token expires", due: "2026-08-20T20:39:00Z" },
    "session", "2026-08-16T00:00:00Z");
  const f = store.get("needs-human:codex-reauth")!;
  expect(f.state).toBe("open");
  expect(f.times_reported).toBe(1);
  expect(f.due).toBe("2026-08-20T20:39:00Z");
});

test("add defaults due to null when none is given", () => {
  store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-16T00:00:00Z");
  expect(store.get("needs-human:a")!.due).toBeNull();
});

test("re-filing refreshes detail and due, bumps the count, but never first_seen", () => {
  store.add({ kind: "needs-human", subject: "a", detail: "first", due: null }, "session", "2026-08-01T00:00:00Z");
  store.add({ kind: "needs-human", subject: "a", detail: "second", due: "2026-09-01" }, "session", "2026-08-02T00:00:00Z");
  const f = store.get("needs-human:a")!;
  expect(f.detail).toBe("second");
  expect(f.due).toBe("2026-09-01");
  expect(f.first_seen).toBe("2026-08-01T00:00:00Z");
  expect(f.times_reported).toBe(2);
});

// THE reason add() exists rather than routing through reconcile(). A session
// files the one ask it just discovered; it has no idea what else is
// outstanding. reconcile(["needs-human"], [oneItem]) would resolve every other
// open ask as "no longer detected" — the owner's list would silently empty itself
// every time a session filed anything.
test("add never resolves an item it did not mention", () => {
  store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-01T00:00:00Z");
  store.add({ kind: "needs-human", subject: "b", detail: "d" }, "session", "2026-08-02T00:00:00Z");
  expect(store.get("needs-human:a")!.state).toBe("open");
});

// An ask the owner finished, that a later session finds needs doing again, is a real
// event. upsertDetected deliberately never touches state (re-detection is
// evidence, not judgement); a model asserting the ask a second time IS a
// judgement, so add() differs from it here on purpose.
test("add reopens a resolved finding", () => {
  store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-01T00:00:00Z");
  store.setState("needs-human:a", "resolved", null, "2026-08-02T00:00:00Z");
  store.add({ kind: "needs-human", subject: "a", detail: "back again" }, "session", "2026-08-03T00:00:00Z");
  const f = store.get("needs-human:a")!;
  expect(f.state).toBe("open");
  expect(f.state_changed_at).toBe("2026-08-03T00:00:00Z");
});

// wont_fix stays sticky through add() as it does through every other path:
// "I am not doing this" must not be undone by a session filing it again.
test("add leaves a wont_fix finding declined", () => {
  store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-01T00:00:00Z");
  store.setState("needs-human:a", "wont_fix", "not worth it", "2026-08-02T00:00:00Z");
  store.add({ kind: "needs-human", subject: "a", detail: "d" }, "session", "2026-08-03T00:00:00Z");
  const f = store.get("needs-human:a")!;
  expect(f.state).toBe("wont_fix");
  expect(f.note).toBe("not worth it");
  expect(f.times_reported).toBe(2);
});

// A session that re-files a subject it did not know was already open should
// be told so by the write itself, not have to read the ledger back.
test("add reports whether it created the row, re-filed it, or reopened it", () => {
  const item = { kind: "needs-human", subject: "codex-reauth", detail: "d" };
  expect(store.add(item, "add_finding", "2026-08-11T00:00:00Z")).toEqual({ created: true, reopened: false, times_reported: 1 });
  expect(store.add(item, "add_finding", "2026-08-12T00:00:00Z")).toEqual({ created: false, reopened: false, times_reported: 2 });
  store.setState("needs-human:codex-reauth", "resolved", "done", "2026-08-13T00:00:00Z");
  expect(store.add(item, "add_finding", "2026-08-14T00:00:00Z")).toEqual({ created: false, reopened: true, times_reported: 3 });
});

// --- `doc`: the assignment lives in a document -----------------------------
//
// `detail` is a snapshot; a plan, a migration or anything that changes as it
// is worked belongs on a wiki page that can be edited and linked. `doc` names
// that page so the pointer is structured rather than buried in prose, which is
// what lets the hook and `findings show` render it distinctly.

test("add stores a doc pointer and it round-trips", () => {
  store.add({ kind: "todo", subject: "home-net", detail: "see the page", doc: "home-network-plan" },
    "add_finding", "2026-09-22T00:00:00Z");
  expect(store.get("todo:home-net")!.doc).toBe("home-network-plan");
});

test("a finding filed without a doc has doc null, not undefined", () => {
  store.add({ kind: "todo", subject: "plain", detail: "d" }, "add_finding", "2026-09-22T00:00:00Z");
  expect(store.get("todo:plain")!.doc).toBeNull();
});

// Same rule as `detail` and `due`: re-filing is the caller asserting current
// truth, so a moved or corrected page name must take.
test("re-filing refreshes the doc pointer", () => {
  store.add({ kind: "todo", subject: "moved", detail: "d", doc: "old-slug" }, "add_finding", "2026-09-22T00:00:00Z");
  store.add({ kind: "todo", subject: "moved", detail: "d", doc: "new-slug" }, "add_finding", "2026-09-23T00:00:00Z");
  const f = store.get("todo:moved")!;
  expect(f.doc).toBe("new-slug");
  expect(f.times_reported).toBe(2);
});

// Dropping the doc on a re-file must clear it, or a finding whose work moved
// back into `detail` would keep pointing at a page that no longer owns it.
test("re-filing without a doc clears a previously set one", () => {
  store.add({ kind: "todo", subject: "cleared", detail: "d", doc: "some-page" }, "add_finding", "2026-09-22T00:00:00Z");
  store.add({ kind: "todo", subject: "cleared", detail: "d" }, "add_finding", "2026-09-23T00:00:00Z");
  expect(store.get("todo:cleared")!.doc).toBeNull();
});

// --- setFields: patch, don't re-file ---------------------------------------
//
// `add` is "file this item" and REPLACES detail/due/doc, so re-filing a
// subject just to set a doc silently destroys a long handoff. setFields is the
// patch: only what is passed changes.

test("setFields updates one field and leaves the others alone", () => {
  store.add({ kind: "todo", subject: "p", detail: "the long handoff", due: "2026-10-01T23:59:59Z" },
    "add_finding", "2026-09-22T00:00:00Z");
  store.setFields("todo:p", { doc: "some-page" }, "2026-09-23T00:00:00Z");
  const f = store.get("todo:p")!;
  expect(f.doc).toBe("some-page");
  expect(f.detail).toBe("the long handoff");   // the whole point
  expect(f.due).toBe("2026-10-01T23:59:59Z");
});

// Unlike `add`, a patch is not the caller re-asserting the ask, so it must not
// inflate the "asked N times" count the ledger exists to keep honest.
test("setFields does not bump times_reported", () => {
  store.add({ kind: "todo", subject: "p", detail: "d" }, "add_finding", "2026-09-22T00:00:00Z");
  store.setFields("todo:p", { doc: "x" }, "2026-09-23T00:00:00Z");
  expect(store.get("todo:p")!.times_reported).toBe(1);
});

test("setFields never touches state", () => {
  store.add({ kind: "todo", subject: "p", detail: "d" }, "add_finding", "2026-09-22T00:00:00Z");
  store.setState("todo:p", "wont_fix", "declined", "2026-09-22T00:00:00Z");
  store.setFields("todo:p", { detail: "new text" }, "2026-09-23T00:00:00Z");
  const f = store.get("todo:p")!;
  expect(f.state).toBe("wont_fix");
  expect(f.note).toBe("declined");
  expect(f.detail).toBe("new text");
});

// Explicit null is how a field is CLEARED; omitting it means "leave it".
// Without the distinction there would be no way to unset a doc.
test("setFields clears a field on explicit null but not on omission", () => {
  store.add({ kind: "todo", subject: "p", detail: "d", doc: "page", due: "2026-10-01T23:59:59Z" },
    "add_finding", "2026-09-22T00:00:00Z");
  store.setFields("todo:p", { doc: null }, "2026-09-23T00:00:00Z");
  expect(store.get("todo:p")!.doc).toBeNull();
  expect(store.get("todo:p")!.due).toBe("2026-10-01T23:59:59Z"); // omitted, untouched
});

test("setFields with nothing to change is a no-op, not an error", () => {
  store.add({ kind: "todo", subject: "p", detail: "d" }, "add_finding", "2026-09-22T00:00:00Z");
  expect(() => store.setFields("todo:p", {}, "2026-09-23T00:00:00Z")).not.toThrow();
  expect(store.get("todo:p")!.detail).toBe("d");
});

// Same rule as setState: the caller is hand-typing a key, so a miss must be
// loud rather than reporting success while doing nothing.
test("setFields throws on an unknown key", () => {
  expect(() => store.setFields("todo:nope", { doc: "x" }, "2026-09-23T00:00:00Z")).toThrow(/no such finding/);
});
