import type { PagesStore } from "../pages/store.js";
import type { FindingsStore, ReconcileResult } from "./ledger.js";
import { DEFAULT_STALE_DAYS, detectOrphans, detectSecrets, detectStale, detectUnresolved, detectUnknownLinkTypes } from "./detectors.js";
import { DAEMON_KINDS, REPORTABLE_KINDS } from "./types.js";
import { env } from "../env.js";

// Re-exported for existing importers. DAEMON_KINDS/REPORTABLE_KINDS
// themselves live in types.js (see the comments there for why each list is
// what it is); this module is where DAEMON_KINDS is consumed for the
// actual nightly reconcile.
export { DAEMON_KINDS, REPORTABLE_KINDS };

// STALE_DAYS: how old a page's `verified:` date may get. Anything that is not
// a positive integer falls back to the default.
function staleDays(): number {
  const n = Number(env("STALE_DAYS"));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STALE_DAYS;
}

export function runDetection(pages: PagesStore, findings: FindingsStore, now: Date): ReconcileResult {
  const detected = [
    ...detectOrphans(pages),
    ...detectUnresolved(pages),
    ...detectUnknownLinkTypes(pages),
    ...detectSecrets(pages),
    ...detectStale(pages, now, staleDays()),
  ];
  return findings.reconcile(DAEMON_KINDS, detected, "enscribe", now.toISOString());
}
