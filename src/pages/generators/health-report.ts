import type { Generator, GeneratedPage, GeneratorContext } from "./types.js";

// How many items to list per section before truncating. A report nobody can
// read is not a report; the counts above each list carry the full magnitude.
const LIST_LIMIT = 50;

// Replaces gbrain's `gbrain-wiki-verify`, which wrote this same slug. The wiki
// page `gbrain-maintenance-jobs` links to it, so without this generator that
// link dangles permanently once gbrain retires.
//
// NOTE: this body must never contain a [[wikilink]]. runGenerators lints
// generated pages and one unresolved link fails the entire nightly run — and
// this report's whole job is to name pages that are missing or unresolved.
// Everything is referenced in backticks.
//
// NOTE: the body must be deterministic. No timestamps, no run counters, every
// list sorted. A body that differs run to run re-chunks and re-embeds nightly.
export const healthReport: Generator = {
  name: "health-report",
  async run(ctx: GeneratorContext): Promise<GeneratedPage[]> {
    // NOTE: on the very first run ever, `health.pages` (the live-page count)
    // undercounts by exactly one — this generated page itself is written by
    // `putGenerated` AFTER `run()` returns, so it can't see itself in the
    // count it is about to report. It converges permanently from the second
    // run onward. Verified on production (report body said 123, DB said
    // 123 — matching, not off-by-one, on a non-first run). An earlier report
    // theorised a concurrent write; that theory is wrong, this is it.
    const health = ctx.store.pageHealth(LIST_LIMIT);
    const { sourcePaths, failedDirs } = ctx.vault.list();

    const indexed = new Set(
      ctx.store.listPages().map((p) => p.source_path).filter((s): s is string => s !== null),
    );
    const missing = sourcePaths.filter((p) => !indexed.has(p)).sort();

    const sections: string[] = [];

    sections.push(
      `## Counts\n\n` +
        `- Live pages: ${health.pages}\n` +
        `- Unresolved links: ${health.unresolved}\n` +
        `- Orphans: ${health.orphans}\n` +
        `- Vault files walked: ${sourcePaths.length}`,
    );

    // An include dir that failed to enumerate means sourcePaths is an
    // incomplete view of the vault. Claiming files are "missing" from it would
    // invert the truth — the files are there, the walk is broken.
    if (failedDirs.length > 0) {
      sections.push(
        `## Vault vs index\n\n` +
          `**Walk incomplete — not reported.** Could not enumerate: ` +
          `${[...failedDirs].sort().map((d) => `\`${d}\``).join(", ")}. ` +
          `The file list is not a complete view of the vault, so it cannot say what is missing.`,
      );
    } else if (missing.length === 0) {
      sections.push(`## Vault vs index\n\nEvery walked vault file has a page in the index.`);
    } else {
      const shown = missing.slice(0, LIST_LIMIT).map((p) => `- \`${p}\``);
      if (missing.length > LIST_LIMIT) shown.push(`- _…and ${missing.length - LIST_LIMIT} more_`);
      sections.push(
        `## Vault vs index\n\n${missing.length} walked file(s) have no page in the index:\n\n` +
          shown.join("\n"),
      );
    }

    // Do NOT drop this re-sort as "redundant with the SQL ORDER BY" — it isn't
    // here. `pageHealth`'s SQL orders unresolvedSample by
    // (first_seen, from_slug, raw_text); this report sorts by
    // (from_slug, raw_text). The two orders differ, and this client sort is
    // what makes the report body byte-identical across runs (see the
    // "must be deterministic" note above) rather than reshuffling whenever a
    // link's first_seen timestamp changes. (orphanSample below really is
    // redundant with its SQL's `ORDER BY p.slug` — that one genuinely could
    // be dropped, but is kept for the same "don't depend on SQL staying that
    // way forever" reason.)
    const unresolvedLines = [...health.unresolvedSample]
      .sort((a, b) => a.from_slug.localeCompare(b.from_slug) || a.raw_text.localeCompare(b.raw_text))
      .map((u) => `- \`${u.from_slug}\` -> \`${u.raw_text}\``);
    if (health.unresolved > unresolvedLines.length) {
      unresolvedLines.push(`- _…and ${health.unresolved - unresolvedLines.length} more_`);
    }
    sections.push(
      `## Unresolved links\n\n` +
        (unresolvedLines.length === 0 ? "none" : unresolvedLines.join("\n")),
    );

    const orphanLines = [...health.orphanSample].sort().map((s) => `- \`${s}\``);
    if (health.orphans > orphanLines.length) {
      orphanLines.push(`- _…and ${health.orphans - orphanLines.length} more_`);
    }
    sections.push(`## Orphans\n\n` + (orphanLines.length === 0 ? "none" : orphanLines.join("\n")));

    const body = `# Brain health report

Generated nightly from the live pages index. Replaces gbrain's
\`gbrain-wiki-verify\`. Page names are in backticks, not wikilinks, on purpose:
this report cites missing pages, and a wikilink to one would fail the
generator lint.

${sections.join("\n\n")}
`;

    return [{
      slug: "brain-health-report",
      title: "Brain health report",
      body,
      type: "reference",
      tags: ["health", "index", "maintenance"],
    }];
  },
};
