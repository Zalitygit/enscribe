import { expect, test } from "vitest";
import { pageHistoryOf } from "../../src/pages/history.js";

// page_history runs inside the shared server, where a vault-wide `git log`
// (0.2 s on production) would block every client. The parsed history is kept
// until the vault's HEAD moves.
test("the parsed history is reused until HEAD moves", () => {
  let head = "aaa", loads = 0;
  const deps = {
    head: () => head,
    load: () => { loads++; return new Map([["p.md", [{ iso: "2026-11-01T00:00:00Z", subject: `load ${loads}` }]]]); },
  };
  expect(pageHistoryOf("/v-reuse", "p.md", deps)[0]!.subject).toBe("load 1");
  pageHistoryOf("/v-reuse", "p.md", deps);
  expect(loads).toBe(1);
  head = "bbb";
  expect(pageHistoryOf("/v-reuse", "p.md", deps)[0]!.subject).toBe("load 2");
});

test("an unreadable HEAD never serves a cached history", () => {
  let loads = 0;
  const deps = { head: () => "", load: () => { loads++; return new Map(); } };
  pageHistoryOf("/v-nohead", "p.md", deps);
  pageHistoryOf("/v-nohead", "p.md", deps);
  expect(loads).toBe(2);
});

test("a path with no commits has an empty history", () => {
  expect(pageHistoryOf("/v-empty", "none.md", { head: () => "h", load: () => new Map() })).toEqual([]);
});
