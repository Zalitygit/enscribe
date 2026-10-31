import type { Generator, GeneratedPage, GeneratorContext } from "./types.js";
import { LAST_VAULT_SYNC } from "../store.js";
import { diffSnapshots, type Transitions } from "./snapshot-diff.js";

// Snapshot dates retained. Thirty nights of history is enough to answer "when
// did this page fall out of the graph?" without unbounded growth.
const RETAIN = 30;
// How many items to list per section before truncating. Full magnitude
// survives truncation only via the trailing "…and N more" line — section()
// renders no count in the heading itself.
const LIST_LIMIT = 50;
// A vault sync older than this is reported as stale. The path unit fires within
// seconds of a push and the cron backstop runs twice an hour, so two days of
// silence means a trigger is dead, not that nobody wrote anything.
const STALE_SYNC_HOURS = 48;

// UTC, deliberately, even though src/mcp/scheduler.ts fires the nightly run at
// 04:00 LOCAL. This stays consistent and monotone on a fixed timezone, which is
// all diffSnapshots needs to compare correctly — but on a UTC+N host every
// run_at is labelled the PREVIOUS calendar day relative to the local clock.
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function section(heading: string, lines: string[]): string {
  if (lines.length === 0) return `## ${heading}\n\nnone`;
  const shown = lines.slice(0, LIST_LIMIT);
  if (lines.length > LIST_LIMIT) shown.push(`- _…and ${lines.length - LIST_LIMIT} more_`);
  return `## ${heading}\n\n${shown.join("\n")}`;
}

function renderTransitions(t: Transitions): string {
  return [
    section("Added", t.added.map((s) => `- \`${s}\``)),
    section("Tombstoned", t.tombstoned.map((s) => `- \`${s}\``)),
    section("Restored", t.restored.map((s) => `- \`${s}\``)),
    section("Became orphaned", t.becameOrphaned.map((s) => `- \`${s}\``)),
    section("No longer orphaned", t.noLongerOrphaned.map((s) => `- \`${s}\``)),
    section("Edited", t.edited.map((s) => `- \`${s}\``)),
    section("Inbound links changed", t.inboundChanged.map((d) => `- \`${d.slug}\`: ${d.from} -> ${d.to}`)),
    section("Outbound links changed", t.outboundChanged.map((d) => `- \`${d.slug}\`: ${d.from} -> ${d.to}`)),
    section("Newly unresolved", t.unresolvedNew.map((u) => `- \`${u.from_slug}\` -> \`${u.raw_text}\``)),
    section("Resolved", t.unresolvedCleared.map((u) => `- \`${u.from_slug}\` -> \`${u.raw_text}\``)),
  ].join("\n\n");
}

// Reports what CHANGED in the authored graph between the two most recent runs,
// which is the one thing brain-health-report (a snapshot of current state)
// cannot express.
//
// NOTE: this body must never contain a [[wikilink]]. runGenerators lints
// generated pages and one unresolved link fails the entire nightly run — and
// this digest names pages that were just tombstoned. Everything is in backticks.
//
// NOTE: unlike the other generators, this body is EXPECTED to change nightly,
// so the page re-chunks and re-embeds each run. That is one page on a local
// embedder, and the changing content is the whole point. The clock is injected
// so the body is still byte-stable for a fixed date and an unchanged brain.
//
// NOTE: this generator has a side effect beyond its page — it writes the
// snapshot it will diff against next time. It must therefore run LAST, after
// the other generators have settled the graph.
export const changeDigest: Generator = {
  name: "change-digest",
  async run(ctx: GeneratorContext): Promise<GeneratedPage[]> {
    const now = ctx.now();
    const today = isoDate(now);

    const prevDate = ctx.store.previousSnapshotDate(today);
    ctx.store.writeSnapshot(today);

    const lastSync = ctx.store.getMeta(LAST_VAULT_SYNC);
    let syncLine = "- Last vault sync: never recorded here";
    if (lastSync) {
      const ageHours = (now.getTime() - new Date(lastSync).getTime()) / 3600000;
      // new Date(garbage).getTime() is NaN, and NaN > STALE_SYNC_HOURS is
      // false — so without this check a corrupt meta value read as FRESH,
      // the opposite of what a stale/dead sync marker exists to catch.
      if (!Number.isFinite(ageHours)) {
        syncLine = `- Last vault sync: ${lastSync} **(unreadable timestamp)**`;
      } else {
        const stale = ageHours > STALE_SYNC_HOURS ? " **(stale)**" : "";
        syncLine = `- Last vault sync: ${lastSync}${stale}`;
      }
    }

    let window: string;
    let detail: string;
    if (prevDate === null) {
      window = `- Baseline snapshot taken: ${today}\n- No previous snapshot to compare against`;
      detail =
        "Baseline established. The first run records the current shape of the graph " +
        "without reporting it as change; the next run reports what moved.";
    } else {
      window = `- Previous snapshot: ${prevDate}\n- Current snapshot: ${today}`;
      detail = renderTransitions(diffSnapshots(
        ctx.store.getSnapshot(prevDate),
        ctx.store.getSnapshot(today),
        ctx.store.getUnresolvedSnapshot(prevDate),
        ctx.store.getUnresolvedSnapshot(today),
      ));
    }

    ctx.store.pruneSnapshots(RETAIN);

    const body = `# Brain change digest

What changed in the authored knowledge graph between the two most recent
generator runs. Page names are in backticks, not wikilinks, on purpose: this
digest cites pages that were just tombstoned, and a wikilink to one would fail
the generator lint.

## Window

${window}
${syncLine}

${detail}
`;

    return [{
      slug: "brain-change-digest",
      title: "Brain change digest",
      body,
      type: "reference",
      tags: ["change", "digest", "maintenance"],
    }];
  },
};
