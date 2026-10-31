import { expect, test } from "vitest";
import { diffSnapshots } from "../../../src/pages/generators/snapshot-diff.js";
import type { SnapshotRow } from "../../../src/pages/store.js";

// Terse row builder — every field matters to at least one transition, so the
// defaults are "a live page nobody links and which links nobody".
const row = (slug: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  slug, inbound: 0, outbound: 0, unresolved: 0, content_hash: "h", deleted: 0, ...over,
});

test("a slug present only in the current snapshot is added", () => {
  const d = diffSnapshots([], [row("a")], [], []);
  expect(d.added).toEqual(["a"]);
});

test("a slug flagged deleted only in the current snapshot is tombstoned", () => {
  const d = diffSnapshots([row("a")], [row("a", { deleted: 1 })], [], []);
  expect(d.tombstoned).toEqual(["a"]);
  expect(d.added).toEqual([]);
});

// The headline transition. This is the one health-report cannot express.
test("inbound falling to zero is becameOrphaned", () => {
  const d = diffSnapshots([row("a", { inbound: 3 })], [row("a", { inbound: 0 })], [], []);
  expect(d.becameOrphaned).toEqual(["a"]);
});

test("inbound rising from zero is noLongerOrphaned", () => {
  const d = diffSnapshots([row("a", { inbound: 0 })], [row("a", { inbound: 2 })], [], []);
  expect(d.noLongerOrphaned).toEqual(["a"]);
});

// A page that is tombstoned has no inbound links by definition. Reporting it as
// orphaned as well would be noise on top of the real event.
test("a tombstoned page is not also reported as becameOrphaned", () => {
  const d = diffSnapshots(
    [row("a", { inbound: 3 })],
    [row("a", { inbound: 0, deleted: 1 })],
    [], [],
  );
  expect(d.tombstoned).toEqual(["a"]);
  expect(d.becameOrphaned).toEqual([]);
});

// A page deleted and restored in git with identical content must still
// register SOME transition — softDelete never touches content_hash, so
// without a dedicated branch this falls through to the comparisons below
// and produces nothing at all.
test("a slug flagged deleted before and live now is restored", () => {
  const d = diffSnapshots([row("a", { deleted: 1 })], [row("a", { deleted: 0 })], [], []);
  expect(d.restored).toEqual(["a"]);
});

test("a restored page is not also reported as edited", () => {
  const d = diffSnapshots(
    [row("a", { deleted: 1, content_hash: "h1" })],
    [row("a", { deleted: 0, content_hash: "h2" })],
    [], [],
  );
  expect(d.restored).toEqual(["a"]);
  expect(d.edited).toEqual([]);
});

test("restored output is sorted regardless of input order", () => {
  const prev = [row("zeta", { deleted: 1 }), row("alpha", { deleted: 1 })];
  const cur = [row("zeta", { deleted: 0 }), row("alpha", { deleted: 0 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.restored).toEqual(["alpha", "zeta"]);
});

test("a changed inbound count is reported with both values", () => {
  const d = diffSnapshots([row("a", { inbound: 5 })], [row("a", { inbound: 2 })], [], []);
  expect(d.inboundChanged).toEqual([{ slug: "a", from: 5, to: 2 }]);
});

test("a changed outbound count is reported with both values", () => {
  const d = diffSnapshots([row("a", { outbound: 1 })], [row("a", { outbound: 4 })], [], []);
  expect(d.outboundChanged).toEqual([{ slug: "a", from: 1, to: 4 }]);
});

test("a moved content hash is an edit", () => {
  const d = diffSnapshots([row("a", { content_hash: "h1" })], [row("a", { content_hash: "h2" })], [], []);
  expect(d.edited).toEqual(["a"]);
});

test("a newly added page is not also reported as edited", () => {
  const d = diffSnapshots([], [row("a")], [], []);
  expect(d.added).toEqual(["a"]);
  expect(d.edited).toEqual([]);
});

test("an unresolved link present only now is new", () => {
  const d = diffSnapshots([row("a")], [row("a")], [], [{ from_slug: "a", raw_text: "Nowhere" }]);
  expect(d.unresolvedNew).toEqual([{ from_slug: "a", raw_text: "Nowhere" }]);
});

test("an unresolved link present only before is cleared", () => {
  const d = diffSnapshots([row("a")], [row("a")], [{ from_slug: "a", raw_text: "Nowhere" }], []);
  expect(d.unresolvedCleared).toEqual([{ from_slug: "a", raw_text: "Nowhere" }]);
});

test("an identical pair of snapshots yields no transitions at all", () => {
  const snap = [row("a", { inbound: 1, outbound: 2 }), row("b")];
  const un = [{ from_slug: "a", raw_text: "Nowhere" }];
  const d = diffSnapshots(snap, snap, un, un);
  expect(Object.values(d).every((v) => (v as unknown[]).length === 0)).toBe(true);
});

// Byte-stable output requires stable ordering, whatever order the rows arrive in.
test("output is sorted regardless of input order", () => {
  const d = diffSnapshots([], [row("z"), row("a"), row("m")], [], []);
  expect(d.added).toEqual(["a", "m", "z"]);
});

// A page created and pruned between two runs is not "added" — reporting it as
// new would be a lie about a page that no longer exists.
test("a row absent before and already tombstoned now is not added", () => {
  const d = diffSnapshots([], [row("a", { deleted: 1 })], [], []);
  expect(d.added).toEqual([]);
  expect(d.tombstoned).toEqual([]);
});

// The single-element "added" sort test above doesn't exercise the other eight
// sorted lists. Each of these gives its list at least two elements in
// deliberately unsorted input order, so a missing or broken .sort() on any
// one of them fails here rather than silently shipping non-deterministic
// digest bodies.

test("tombstoned output is sorted regardless of input order", () => {
  const prev = [row("zeta"), row("alpha")];
  const cur = [row("zeta", { deleted: 1 }), row("alpha", { deleted: 1 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.tombstoned).toEqual(["alpha", "zeta"]);
});

test("becameOrphaned output is sorted regardless of input order", () => {
  const prev = [row("zeta", { inbound: 3 }), row("alpha", { inbound: 2 })];
  const cur = [row("zeta", { inbound: 0 }), row("alpha", { inbound: 0 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.becameOrphaned).toEqual(["alpha", "zeta"]);
});

test("noLongerOrphaned output is sorted regardless of input order", () => {
  const prev = [row("zeta", { inbound: 0 }), row("alpha", { inbound: 0 })];
  const cur = [row("zeta", { inbound: 2 }), row("alpha", { inbound: 4 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.noLongerOrphaned).toEqual(["alpha", "zeta"]);
});

test("edited output is sorted regardless of input order", () => {
  const prev = [row("zeta", { content_hash: "h1" }), row("alpha", { content_hash: "h1" })];
  const cur = [row("zeta", { content_hash: "h2" }), row("alpha", { content_hash: "h2" })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.edited).toEqual(["alpha", "zeta"]);
});

test("inboundChanged output is sorted regardless of input order", () => {
  const prev = [row("zeta", { inbound: 5 }), row("alpha", { inbound: 1 })];
  const cur = [row("zeta", { inbound: 6 }), row("alpha", { inbound: 2 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.inboundChanged).toEqual([
    { slug: "alpha", from: 1, to: 2 },
    { slug: "zeta", from: 5, to: 6 },
  ]);
});

test("outboundChanged output is sorted regardless of input order", () => {
  const prev = [row("zeta", { outbound: 1 }), row("alpha", { outbound: 3 })];
  const cur = [row("zeta", { outbound: 2 }), row("alpha", { outbound: 4 })];
  const d = diffSnapshots(prev, cur, [], []);
  expect(d.outboundChanged).toEqual([
    { slug: "alpha", from: 3, to: 4 },
    { slug: "zeta", from: 1, to: 2 },
  ]);
});

test("unresolvedNew output is sorted regardless of input order", () => {
  const cur = [
    { from_slug: "zeta", raw_text: "Nowhere" },
    { from_slug: "alpha", raw_text: "Nowhere" },
  ];
  const d = diffSnapshots([], [], [], cur);
  expect(d.unresolvedNew).toEqual([
    { from_slug: "alpha", raw_text: "Nowhere" },
    { from_slug: "zeta", raw_text: "Nowhere" },
  ]);
});

test("unresolvedCleared output is sorted regardless of input order", () => {
  const prev = [
    { from_slug: "zeta", raw_text: "Nowhere" },
    { from_slug: "alpha", raw_text: "Nowhere" },
  ];
  const d = diffSnapshots([], [], prev, []);
  expect(d.unresolvedCleared).toEqual([
    { from_slug: "alpha", raw_text: "Nowhere" },
    { from_slug: "zeta", raw_text: "Nowhere" },
  ]);
});
