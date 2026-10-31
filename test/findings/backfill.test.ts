import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { backfillFromArchive } from "../../src/findings/backfill.js";

let db: Database;
let findings: FindingsStore;

beforeEach(() => {
  db = openDb(":memory:");
  findings = new FindingsStore(db);
  findings.upsertDetected({ kind: "orphan", subject: "uuid-primary-keys", detail: "d" },
    "macbrain", "2026-08-11T00:00:00Z");
});

test("moves first_seen back to the earliest report and counts occurrences", () => {
  const r = backfillFromArchive(findings, [
    { date: "2026-07-29", text: "orphans: uuid-primary-keys" },
    { date: "2026-08-01", text: "orphans: uuid-primary-keys" },
    { date: "2026-08-05", text: "nothing relevant here" },
  ]);
  const f = findings.get("orphan:uuid-primary-keys")!;
  expect(f.first_seen).toBe("2026-07-29T00:00:00.000Z");
  expect(f.times_reported).toBe(2);
  expect(r.updated).toBe(1);
});

// Running it twice must be safe: first_seen only moves earlier and
// times_reported takes the max, so a second pass changes nothing.
test("is idempotent", () => {
  const files = [{ date: "2026-07-29", text: "uuid-primary-keys" }];
  backfillFromArchive(findings, files);
  const first = findings.get("orphan:uuid-primary-keys")!;
  backfillFromArchive(findings, files);
  expect(findings.get("orphan:uuid-primary-keys")).toEqual(first);
});

test("never moves first_seen forward", () => {
  backfillFromArchive(findings, [{ date: "2026-09-01", text: "uuid-primary-keys" }]);
  expect(findings.get("orphan:uuid-primary-keys")!.first_seen).toBe("2026-08-11T00:00:00Z");
});
