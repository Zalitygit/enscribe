import type { PagesStore } from "../pages/store.js";
import type { FindingsStore, ReconcileResult } from "./ledger.js";
import { detectOrphans, detectSecrets, detectUnresolved, detectUnknownLinkTypes } from "./detectors.js";
import { DAEMON_KINDS, REPORTABLE_KINDS } from "./types.js";

// Re-exported for existing importers. DAEMON_KINDS/REPORTABLE_KINDS
// themselves live in types.js (see the comments there for why each list is
// what it is); this module is where DAEMON_KINDS is consumed for the
// actual nightly reconcile.
export { DAEMON_KINDS, REPORTABLE_KINDS };

export function runDetection(pages: PagesStore, findings: FindingsStore, now: Date): ReconcileResult {
  const detected = [
    ...detectOrphans(pages),
    ...detectUnresolved(pages),
    ...detectUnknownLinkTypes(pages),
    ...detectSecrets(pages),
  ];
  return findings.reconcile(DAEMON_KINDS, detected, "enscribe", now.toISOString());
}
