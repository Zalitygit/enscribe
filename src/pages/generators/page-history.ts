import type { Generator, GeneratedPage } from "./types.js";
import type { VaultCommit } from "../vault-git.js";
import { SENSITIVE } from "./activity-digest.js";

// How many paths the timeline ranks. A ranking's job is the top of it; the full
// per-path counts are on the per-page history pages.
const TOP_PATHS = 25;

// Same lookahead form the findings generator uses, and for the same reason: a
// run of three or more brackets survives a non-overlapping replaceAll and still
// matches the wikilink regex. Commit subjects are free text.
const escape = (s: string): string => s.replace(/\[(?=\[)/g, "[ ");

const day = (iso: string): string => iso.slice(0, 10);

// Commit identity for counting. A pair of commits sharing a second AND a subject
// would collapse into one here; that is not worth a second `git log` to rule out,
// and the number is a count of the vault's history, not an audit record.
const identity = (c: VaultCommit): string => `${c.iso}\t${c.subject}`;

// Render a commit list, withholding the subjects activity-digest's filter
// catches and SAYING how many were withheld rather than dropping them silently.
// The hazard is larger here than there: that page shows 21 days, this one shows
// the whole history of the vault, and both are DB-native so the vault deny-list
// cannot reach them.
function commitLines(commits: VaultCommit[]): string[] {
  const shown = commits.filter((c) => !SENSITIVE.test(c.subject));
  const lines = shown.map((c) => `- ${day(c.iso)} ${escape(c.subject)}`);
  const withheld = commits.length - shown.length;
  if (withheld > 0) lines.push(`- _${withheld} commit(s) withheld_`);
  return lines;
}

// Per-page revision history plus a vault-wide commit timeline.
//
// The gap this closes is ingestion, not reasoning. MacBrain answers "when did X
// happen" well when a page says so in prose, and the authoring gate makes it say
// so; what it could not answer was anything only the commit stream knows — when a
// page first appeared, how often it has been revised, what the vault was doing in
// a week nobody wrote up. activity-digest already indexes a 21-day per-repo
// digest; this is the per-page view and the unbounded window.
//
// Deliberately NO wikilinks, which matters more than the generator lint. One
// history page per authored page, each linking its subject, would hand every page
// in the vault an inbound link and silently zero out orphan detection across all
// four of its consumers.
//
// Deliberately NO co-change section, though it was in the recommendation: nothing
// measured it. The 2/8-to-6/8 reading that justifies this generator was taken
// against the shape below and nothing else.
export const pageHistory: Generator = {
  name: "page-history",
  async run(ctx) {
    const history = ctx.git.history();
    const pages: GeneratedPage[] = [];

    // The index is the allow-list for naming a path. A denied file is never
    // ingested, so it has no page, so it is never named here — which makes the
    // deny-list authoritative for this page by construction rather than through a
    // second copy of it that could drift.
    const live = ctx.store.sourceBackedPages();
    const counts: { path: string; n: number }[] = [];

    for (const { slug, source_path } of live) {
      const commits = history.get(source_path);
      // No history at all means the file is not committed yet. A page asserting
      // zero commits would be noise, and wrong the moment it is pushed.
      if (!commits || commits.length === 0) continue;
      counts.push({ path: source_path, n: commits.length });
      const body = `# Revision history of the \`${slug}\` page

- First added to the vault: **${day(commits[commits.length - 1]!.iso)}**
- Last changed: **${day(commits[0]!.iso)}**
- Total commits touching this page: **${commits.length}**

## Commits
${commitLines(commits).join("\n")}
`;
      pages.push({
        slug: `history-${slug}`,
        title: `History of ${slug}`,
        body,
        type: "history",
        tags: ["git", "history"],
      });
    }

    // Every commit once, newest first. The per-path lists above hold the same
    // events keyed by file; this is the view that answers a question about the
    // vault rather than about one page.
    const all = new Map<string, VaultCommit>();
    for (const commits of history.values()) {
      for (const c of commits) if (!all.has(identity(c))) all.set(identity(c), c);
    }
    const ordered = [...all.values()].sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));

    // Ties break on path so the ranking is stable run to run; an unstable order
    // would re-chunk and re-embed this page on nights nothing changed.
    counts.sort((a, b) => b.n - a.n || (a.path < b.path ? -1 : 1));
    const ranked = counts.slice(0, TOP_PATHS).map((r) => `- **${r.n}** commits: \`${r.path}\``);

    pages.push({
      slug: "vault-commit-timeline",
      title: "Vault commit timeline",
      body: `# Vault commit timeline

Total commits touching the vault: **${all.size}**

## Most-revised pages
${ranked.join("\n")}

## All commits, newest first
${commitLines(ordered).join("\n")}
`,
      type: "history",
      tags: ["git", "history", "timeline"],
    });

    return pages;
  },
};
