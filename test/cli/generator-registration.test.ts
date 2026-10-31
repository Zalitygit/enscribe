import { expect, test } from "vitest";
import { GENERATORS } from "../../src/cli/index.js";
import { pageHistory } from "../../src/pages/generators/page-history.js";

// The nightly list, asserted by name so a reorder is not a failure and an
// addition is.
test("the nightly generator list is the five that shipped", () => {
  expect(GENERATORS.map((g) => g.name).sort()).toEqual(
    ["activity-digest", "change-digest", "findings", "health-report", "repo-inventory"],
  );
});

// Same guard the rot detectors get. page-history passed the thing it was built
// for — the 8 git-only temporal questions went 2/8 to 6/8, and the relational set
// gained (0.574 -> 0.585, temporal 0.472 -> 0.495) — and failed the rest of its
// pre-registered gate: qrels v2 fell 0.847 -> 0.807 against a budget of 0.01,
// because a page titled "History of <slug>" matches every query that matches its
// subject and takes a top-five slot beside it. Registering it is a deliberate act
// that has to delete this assertion, not a line someone adds during a refactor.
// docs/evidence/2026-09-13-page-history-gate.md has both reports.
test("GENERATORS excludes page-history, which was measured and did not pass", () => {
  expect(GENERATORS).not.toContain(pageHistory);
});
