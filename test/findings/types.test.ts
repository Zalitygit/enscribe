import { expect, test } from "vitest";
import { APPENDABLE_KINDS, DAEMON_KINDS, REPORTABLE_KINDS } from "../../src/findings/types.js";

// A todo is filed one at a time by whoever noticed it and swept for by
// nothing, which is exactly the contract add_finding implements.
test("todo is appendable", () => {
  expect(APPENDABLE_KINDS).toContain("todo");
});

// An alert is filed by whatever noticed the condition (a session or a cron
// script) and cleared by hand or by that same script; nothing sweeps for it.
test("alert is appendable", () => {
  expect(APPENDABLE_KINDS).toContain("alert");
});

// The load-bearing invariant. A kind that a reconciling source also claims
// produces a row the next nightly reconcile resolves having never detected
// it, and the pair flaps open/resolved forever. Asserted over all three
// constants rather than just todo so a future kind cannot break it quietly.
test("the three kind constants are pairwise disjoint", () => {
  const pairs: [string, string[], string, string[]][] = [
    ["DAEMON_KINDS", DAEMON_KINDS, "REPORTABLE_KINDS", REPORTABLE_KINDS],
    ["DAEMON_KINDS", DAEMON_KINDS, "APPENDABLE_KINDS", APPENDABLE_KINDS],
    ["REPORTABLE_KINDS", REPORTABLE_KINDS, "APPENDABLE_KINDS", APPENDABLE_KINDS],
  ];
  for (const [an, a, bn, b] of pairs) {
    const overlap = a.filter((k) => b.includes(k));
    expect(overlap, `${an} and ${bn} overlap on ${overlap.join(", ")}`).toEqual([]);
  }
});

// rot-stale-todo is a different, deliberately-dead thing: a detector that
// sweeps vault markdown for unchecked boxes. It is excluded from
// DAEMON_KINDS because it measured zero input. If it is ever revived it
// must not collide with this kind's name.
test("todo is not swept for by any detector or external reporter", () => {
  expect(DAEMON_KINDS).not.toContain("todo");
  expect(REPORTABLE_KINDS).not.toContain("todo");
});
