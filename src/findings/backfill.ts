import type { FindingsStore } from "./ledger.js";

// Seed first_seen and times_reported from the gardener's own archive
// (brain-gardener-YYYY-MM-DD.md digests), so day one of the
// ledger is truthful instead of reporting a finding that has recurred for two
// weeks as brand new. That framing is what makes triage obvious: anything
// reported ten or more times and still open is either never going to be done or
// the detector is wrong, and both are wont_fix.
//
// Substring match on the subject only. The digests are LLM-written prose and
// parsing their structure would be fragile; a slug appearing anywhere in the
// day's report is sufficient evidence it was reported that day.
//
// Idempotent by construction: first_seen only moves earlier, times_reported
// takes the max. Filesystem reads stay in the caller so this stays pure.
export function backfillFromArchive(
  findings: FindingsStore,
  files: { date: string; text: string }[],
): { updated: number } {
  let updated = 0;
  for (const f of findings.list({ state: "open" })) {
    const hits = files.filter((file) => file.text.includes(f.subject)).sort((a, b) => a.date.localeCompare(b.date));
    if (hits.length === 0) continue;
    const earliest = new Date(`${hits[0].date}T00:00:00Z`).toISOString();
    const firstSeen = earliest < f.first_seen ? earliest : f.first_seen;
    const count = Math.max(f.times_reported, hits.length);
    if (firstSeen === f.first_seen && count === f.times_reported) continue;
    findings.setFirstSeen(f.key, firstSeen, count);
    updated++;
  }
  return { updated };
}
