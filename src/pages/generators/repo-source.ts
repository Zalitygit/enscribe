import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoSource, RepoInfo, Commit } from "./types.js";
import { env } from "../../env.js";

function slugForRepo(name: string): string {
  return "repo-" + name.replace(/\.git$/, "").toLowerCase().replace(/[._]/g, "-");
}

// Run a git command against a bare repo dir; return trimmed stdout, or "" on error.
function git(gitDir: string, args: string[]): string {
  try {
    return execFileSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// The active branch: first of main/master with a ref, else the symbolic HEAD.
function pickBranch(gitDir: string): string {
  for (const b of ["main", "master"]) {
    if (git(gitDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  }
  return git(gitDir, ["symbolic-ref", "--short", "HEAD"]) || "main";
}

// A RepoSource over the bare repos under `gitRoot` (default MACBRAIN_GIT_ROOT or
// /srv/git). Read-only; a missing path or git error degrades to empty.
export function gitRepoSource(gitRoot = env("GIT_ROOT") ?? "/srv/git"): RepoSource {
  return {
    listRepos(): RepoInfo[] {
      let entries: string[];
      try {
        entries = readdirSync(gitRoot);
      } catch {
        return [];
      }
      const repos: RepoInfo[] = [];
      for (const name of entries) {
        const dir = join(gitRoot, name);
        if (!existsSync(join(dir, "HEAD"))) continue; // bare-repo marker
        const branch = pickBranch(dir);
        const commits = Number(git(dir, ["rev-list", "--count", branch]) || "0");
        const lastDate = git(dir, ["log", "-1", "--format=%cs", branch]) || "-";
        repos.push({ name, slug: slugForRepo(name), branch, commits, lastDate });
      }
      return repos.sort((a, b) => a.name.localeCompare(b.name));
    },
    recentCommits(repoName: string, days: number): Commit[] {
      const dir = join(gitRoot, repoName);
      const branch = pickBranch(dir);
      const out = git(dir, ["log", `--since=${days} days`, "--format=%cs%x09%s", branch]);
      if (!out) return [];
      return out.split("\n").map((line) => {
        const tab = line.indexOf("\t");
        return tab < 0 ? { date: line, subject: "" } : { date: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    },
  };
}
