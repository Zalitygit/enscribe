import type { FindingsStore } from "./ledger.js";
import { APPENDABLE_KINDS, findingKey, type AppendedFinding } from "./types.js";
import { normalizeDue, normalizeSubject } from "./due.js";

// The one append path, shared by the MCP `add_finding` tool and the
// `enscribe findings add` CLI (added 2026-11-04 so cron scripts on the brain host can
// raise and clear `alert` findings without a Claude session). Both front ends
// call this rather than repeating the checks, so a kind that MCP refuses can
// never be written from a terminal, or the other way round. The error text
// names `add_finding` because that is the contract both implement.
//
// Validation runs in full before findings.add, so a rejection writes nothing.
export function appendFinding(
  findings: FindingsStore,
  f: { kind: string; subject: string; detail: string; due?: string | null; doc?: string | null },
  source: string,
  now: string,
): { key: string; created: boolean; reopened: boolean; times_reported: number; similar: string[] } {
  // Appending a kind the nightly reconcile owns would create a row that
  // the very next detection run resolves, having never detected it, and
  // the pair would flap open/resolved forever.
  if (!APPENDABLE_KINDS.includes(f.kind)) {
    throw new Error(`add_finding: kind '${f.kind}' is not appendable (appendable: ${APPENDABLE_KINDS.join(", ")}); nothing was written`);
  }
  // Normalized (and validated) at the one write path rather than at
  // each reader: `due` is compared as text, so a bare YYYY-MM-DD would
  // read overdue on its own due day, and `subject` is the row's
  // identity that the bash reader splits on `|`. Both normalizers
  // throw on a shape they can't make safe, and both are evaluated
  // before findings.add runs, so a rejection writes nothing.
  const subject = normalizeSubject(f.subject);
  const due = normalizeDue(f.due);
  // Same kind, not resolved, not this subject, sharing a word of three
  // or more characters. Computed BEFORE the write so the new row never
  // matches itself; a hint list for the caller, never a refusal.
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const mine = words(subject);
  const similar = findings.list({ kind: f.kind })
    .filter((x) => x.state !== "resolved" && x.subject !== subject)
    .filter((x) => [...words(x.subject)].some((w) => mine.has(w)))
    .map((x) => x.key)
    .slice(0, 10);
  const row: AppendedFinding = { kind: f.kind, subject, detail: f.detail, due, doc: f.doc ?? null };
  const wrote = findings.add(row, source, now);
  return { key: findingKey(f.kind, subject), ...wrote, similar };
}
