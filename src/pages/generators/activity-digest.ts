import type { Generator, GeneratedPage } from "./types.js";

const DIGEST_DAYS = 21;

// This page is DB-native, so the vault deny-list cannot exclude it, and it is
// regenerated nightly. Commit subjects are what leak: "add raw genotype export
// (<full name>, <birth date>)" says far more than the path it touched, and
// any client with pages.read can retrieve this page.
//
// Matching is on subject text, not paths, because `Commit` carries no paths.
// That is the right target anyway: a commit touching etc/health whose subject
// is "wip" reveals nothing.
//
// Deliberately narrow. A bare `health`, `tax`, or `diagnos` also matches
// ordinary work ("doctor tool (pages index health)", "fix a stale tax factor",
// "gardener parity/diagnostic pass"), and over-redacting makes the digest
// misreport routine commits. Checked against 636 real subjects: this pattern
// withholds 8 and keeps every legitimate mention.
export const SENSITIVE =
  /(etc\/health|^\s*(health|finance|insurance)\s*[:/]|\bgenome\b|\bgenotype\b|\b23andme\b|\bdna\b|\bdicom\b|\bx-?ray\b|\blumbar\b|radiolog|\binsurance\b|\bmedical\b)/i;

export const activityDigest: Generator = {
  name: "activity-digest",
  async run(ctx) {
    const sections: string[] = [];
    for (const r of ctx.repos.listRepos()) {
      const commits = ctx.repos.recentCommits(r.name, DIGEST_DAYS);
      if (commits.length === 0) continue;
      const shown = commits.filter((c) => !SENSITIVE.test(c.subject));
      const withheld = commits.length - shown.length;
      const lines = shown.map((c) => `- ${c.date} ${c.subject}`);
      // Stated, not silent: a digest that quietly drops commits misreports the
      // week. The count alone is a far smaller disclosure than the subject.
      if (withheld > 0) lines.push(`- _${withheld} commit(s) withheld_`);
      sections.push(`## ${r.name}\n` + lines.join("\n"));
    }
    const body = `# Recent git activity (${DIGEST_DAYS} days)

Across the git server. See [[git-repo-inventory]].

${sections.join("\n\n")}
`;
    const page: GeneratedPage = { slug: "recent-git-activity", title: `Recent Git Activity (${DIGEST_DAYS} days)`, body, type: "reference", tags: ["git", "activity", "digest"] };
    return [page];
  },
};
