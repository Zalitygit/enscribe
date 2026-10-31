import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/index.js";

// `macbrain check FILE...` is what the Claude Code PostToolUse hook runs after a
// vault edit: the write-time twin of the nightly unresolved / unknown-link-type
// findings. Silent and 0 when the file is clean; one line per problem and 1 when not.

let dir: string;
let root: string;
let out: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mb-check-"));
  root = join(dir, "vault");
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/a.md"), "---\ntitle: Alpha Page\n---\n# Alpha Page\nbody\n");
  const cfgPath = join(dir, "vault.json");
  writeFileSync(cfgPath, JSON.stringify({ root, include: ["wiki/concepts"], deny: [] }));
  process.env.MACBRAIN_DB = join(dir, "mb.db");
  process.env.MACBRAIN_EMBED_BACKEND = "fake";
  process.env.MACBRAIN_VAULT_CONFIG = cfgPath;
  vi.spyOn(console, "log").mockImplementation(() => {});
  await run(["vault", "sync"]);
  vi.restoreAllMocks();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { out.push(a.join(" ")); });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACBRAIN_DB;
  delete process.env.MACBRAIN_EMBED_BACKEND;
  delete process.env.MACBRAIN_VAULT_CONFIG;
});

const page = (name: string, body: string): string => {
  const p = join(root, "wiki/concepts", name);
  writeFileSync(p, `---\ntitle: ${name}\n---\n# ${name}\n${body}\n`);
  return p;
};

test("a file whose links all resolve is silent and exits 0", async () => {
  const p = page("w.md", "see [[a]], [[Alpha Page]] and\nruns-on:: [[a]]");
  expect(await run(["check", p])).toBe(0);
  expect(out).toEqual([]);
});

test("reports each unresolved link and unknown link type, and exits 1", async () => {
  const p = page("w.md", "see [[reference_gone]]\nhosted-on:: [[a]]");
  expect(await run(["check", p])).toBe(1);
  expect(out).toEqual([
    `${p}: unresolved [[reference_gone]]`,
    `${p}: \`hosted-on::\` is not a link type (one of runs-on, depends-on, source-in, replaces, part-of, owned-by, disambiguates, falls-back-to); its links are stored as plain wikilinks`,
  ]);
});

// A page written earlier in the same session is on disk before it is ingested.
test("a link to a vault file not yet ingested is not reported", async () => {
  page("brand-new.md", "body");
  const p = page("w.md", "see [[brand-new]]");
  expect(await run(["check", p])).toBe(0);
});

// Denied and non-included files are never ingested, but Obsidian resolves links
// to them by filename or title. Found by running check over the real vault:
// every private/ health page and the index's links into it read as unresolved.
test("a link to a deny-listed or non-included vault file, by name or title, is not reported", async () => {
  mkdirSync(join(root, "wiki/entities/private"), { recursive: true });
  writeFileSync(join(root, "wiki/entities/private/health-records.md"),
    "---\ntitle: Health Records (labs.db + genome.db)\n---\n# x\n");
  const p = page("w.md", "see [[health-records]] and [[Health Records (labs.db + genome.db)]]");
  expect(await run(["check", p])).toBe(0);
  expect(out).toEqual([]);
});

// The gardener's red-link scan learned the same rule the same day.
test("a path link to an existing file, relative to the file or the vault root, is not reported", async () => {
  writeFileSync(join(dir, "biography.md"), "bio");
  writeFileSync(join(root, "README.md"), "see [[../biography.md]], [[wiki/concepts/a|alpha]] and [[wiki/gone]]\n");
  expect(await run(["check", join(root, "README.md")])).toBe(1);
  expect(out).toEqual([`${join(root, "README.md")}: unresolved [[wiki/gone]]`]);
});

test("check with no file prints usage and exits 1", async () => {
  expect(await run(["check"])).toBe(1);
  expect(out[0]).toMatch(/^usage: enscribe check/);
});
