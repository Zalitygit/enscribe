import { expect, test } from "vitest";
import { dueDate, normalizeDue, normalizeSubject } from "../../src/findings/due.js";

test("expands a bare date to the end of that day in UTC", () => {
  expect(normalizeDue("2026-09-01")).toBe("2026-09-01T23:59:59Z");
});

// The whole reason this function exists. A bare date sorts before every
// instant on its own day, so needs-human's `due < strftime(...)` overdue test
// would fire from the moment the item was filed.
test("a normalized due date is not overdue at noon on its own day", () => {
  const noon = "2026-09-01T12:00:00Z";
  expect("2026-09-01" < noon).toBe(true);          // the bug, pinned
  expect(normalizeDue("2026-09-01")! < noon).toBe(false);
});

test("a normalized due date is overdue the next morning", () => {
  expect(normalizeDue("2026-09-01")! < "2026-09-02T09:00:00Z").toBe(true);
});

// An explicit instant is the caller being precise on purpose — the existing
// codex-reauth ask carries a real clock deadline. Never second-guess it.
test("passes an explicit instant through untouched", () => {
  expect(normalizeDue("2026-08-20T20:39:00Z")).toBe("2026-08-20T20:39:00Z");
});

// Finding 1: an unrecognised due used to pass through verbatim, which stored
// a value the hook's TEXT comparison can never correctly place (never reads
// as overdue) and the page renderer's 10-char slice mangled to "next tuesd".
// The write path is the one place that can catch this; nothing downstream
// can recover a shape it was never given.
test("rejects a due that is neither a bare date nor an instant ending in Z", () => {
  expect(() => normalizeDue("next tuesday")).toThrow(/next tuesday/);
  expect(() => normalizeDue("next tuesday")).toThrow(/YYYY-MM-DD/);
});

// A non-Z offset LOOKS like a real instant and would silently mis-compare
// against the UTC instants everything else in the ledger uses.
test("rejects an ISO instant with a non-Z offset", () => {
  expect(() => normalizeDue("2026-08-18T23:59:59-04:00")).toThrow(/2026-08-18T23:59:59-04:00/);
});

test("maps absent and null to null", () => {
  expect(normalizeDue(undefined)).toBeNull();
  expect(normalizeDue(null)).toBeNull();
  expect(normalizeDue("")).toBeNull();
});

// Display is the inverse: what the owner typed, not the instant it was stored as.
test("dueDate renders the calendar date a stored instant belongs to", () => {
  expect(dueDate("2026-09-01T23:59:59Z")).toBe("2026-09-01");
  expect(dueDate("2026-08-20T20:39:00Z")).toBe("2026-08-20");
});

// Finding 2: subject is the row's identity. The bash reader splits query
// output on `|` and reads it line by line, so a literal `|` or newline in a
// subject corrupts the block; the design spec also requires identity to be
// the NORMALIZED subject, so cosmetic whitespace differences must not create
// two rows for what is really one item.
test("trims a subject's leading and trailing whitespace", () => {
  expect(normalizeSubject("git-web-app ")).toBe("git-web-app");
  expect(normalizeSubject(" git-web-app")).toBe("git-web-app");
});

test("collapses internal whitespace runs to a single space", () => {
  expect(normalizeSubject("git  web   app")).toBe("git web app");
});

test("rejects a subject containing a literal pipe", () => {
  expect(() => normalizeSubject("pipe|in|subject")).toThrow(/pipe/);
});

test("rejects a subject containing a newline", () => {
  expect(() => normalizeSubject("line one\nline two")).toThrow(/newline/);
});
