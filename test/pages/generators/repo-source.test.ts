import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitRepoSource } from "../../../src/pages/generators/repo-source.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Build a bare repo `<root>/my_proj.git` with one commit on `main`.
function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mb-root-"));
  dirs.push(root);
  const bare = join(root, "my_proj.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = mkdtempSync(join(tmpdir(), "mb-work-"));
  dirs.push(work);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", work, "config", "user.name", "t"]);
  writeFileSync(join(work, "README.md"), "hi\n");
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "first commit"]);
  execFileSync("git", ["-C", work, "push", "-q", bare, "main"]);
  return root;
}

test("gitRepoSource lists a bare repo with slug + stats", () => {
  const root = seedRoot();
  const repos = gitRepoSource(root).listRepos();
  const proj = repos.find((r) => r.slug === "repo-my-proj");
  expect(proj).toBeDefined();
  expect(proj!.name).toBe("my_proj.git");
  expect(proj!.branch).toBe("main");
  expect(proj!.commits).toBe(1);
  expect(proj!.lastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("gitRepoSource.recentCommits returns commits within the window", () => {
  const root = seedRoot();
  const commits = gitRepoSource(root).recentCommits("my_proj.git", 7);
  expect(commits.some((c) => c.subject === "first commit")).toBe(true);
});

test("gitRepoSource returns [] for a missing root path", () => {
  expect(gitRepoSource("/no/such/root").listRepos()).toEqual([]);
});
