import type { Generator, GeneratedPage, RepoInfo } from "./types.js";

const HUB_SLUG = "git-repo-inventory";

function stubBody(r: RepoInfo): string {
  return `# ${r.name}

**Remote:** \`/srv/git/${r.name}\` · \`${r.branch}\` · ${r.commits} commits · last ${r.lastDate}.

Auto-generated repo-inventory stub. To enrich it, create an authored vault page at
this slug — the generator won't overwrite an authored page. See [[${HUB_SLUG}]].
`;
}

function hubBody(repos: RepoInfo[]): string {
  const lines = [...repos]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => `- [[${r.slug}]] — \`${r.name}\`, ${r.commits} commits, last ${r.lastDate} (\`${r.branch}\`)`);
  return `# Self-hosted git repos — the authoritative inventory

Auto-generated from \`ls /srv/git\`; do not hand-edit. Sibling digest of what
changed lately: [[recent-git-activity]].

## Current repos (${repos.length})
${lines.join("\n")}
`;
}

export const repoInventory: Generator = {
  name: "repo-inventory",
  async run(ctx) {
    const repos = ctx.repos.listRepos();
    const pages: GeneratedPage[] = [
      { slug: HUB_SLUG, title: "Git Repo Inventory", body: hubBody(repos), type: "reference", tags: ["git", "inventory", "repos"] },
    ];
    for (const r of repos) {
      const existing = ctx.store.getPage(r.slug);
      if (existing && existing.source_path && existing.deleted_at === null) continue; // a LIVE authored page wins
      pages.push({ slug: r.slug, title: `${r.name} — repo`, body: stubBody(r), type: "reference", tags: ["git", "repo", "inventory"] });
    }
    return pages;
  },
};
