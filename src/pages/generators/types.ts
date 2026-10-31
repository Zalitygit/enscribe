import type { PagesStore } from "../store.js";
import type { FindingsStore } from "../../findings/ledger.js";
import type { VaultCommit } from "../vault-git.js";

export interface RepoInfo {
  name: string;
  slug: string;
  branch: string;
  commits: number;
  lastDate: string;
}

export interface Commit {
  date: string;
  subject: string;
}

export interface RepoSource {
  listRepos(): RepoInfo[];
  recentCommits(repoName: string, days: number): Commit[];
}

export interface GeneratedPage {
  slug: string;
  title: string;
  body: string;
  type?: string;
  tags?: string[];
}

export interface GeneratorContext {
  repos: RepoSource;
  store: PagesStore;
  vault: VaultSource;
  git: GitHistorySource;
  // The finding ledger. Read-only from a generator's point of view: detection
  // and reconciliation run before runGenerators, so the page renders state that
  // is already committed.
  findings: FindingsStore;
  // Injected clock. The change digest is the only generator whose output is
  // time-dependent, and it cannot be tested for byte-stability without this.
  now: () => Date;
}

export interface Generator {
  name: string;
  run(ctx: GeneratorContext): Promise<GeneratedPage[]>;
}

export interface RunResult {
  generated: number;
  pruned: number;
  // Slugs a live authored vault file already owns, so the generator yielded.
  skipped: { slug: string; generator: string; sourcePath: string }[];
  lintErrors: { slug: string; raw_text: string }[];
}

// A read-only view of which files the vault actually contains, so a generator
// can compare disk against the index without touching the filesystem itself.
// Injectable for the same reason RepoSource is: the walk stays pure and
// testable. `failedDirs` is load-bearing — a non-empty list means sourcePaths
// is an INCOMPLETE view and must not be read as ground truth for "missing".
export interface VaultSource {
  list(): { sourcePaths: string[]; failedDirs: string[] };
}

// A read-only view of the vault's git history, injectable for the same reason
// RepoSource and VaultSource are. Keyed by vault-relative source path, so it
// joins directly against `pages.source_path`; newest commit first. Empty when
// the vault root is not a git worktree, which is the same degradation
// `gitCommitTimes` already makes for authored_at.
export interface GitHistorySource {
  history(): Map<string, VaultCommit[]>;
}
