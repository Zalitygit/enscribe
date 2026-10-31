import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import type { GitRunner } from "../../src/pages/put-page.js";
import { editPage } from "../../src/pages/edit-page.js";
import type { VaultConfig } from "../../src/pages/vault-config.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let root: string;
const cfg = (): VaultConfig => ({ root, include: ["wiki/concepts"], deny: ["Vaulted"] });
const REL = "wiki/concepts/foo.md";
const ORIGINAL = "---\ntitle: Foo\naliases: [Foo Alias]\n---\n# Foo\nThe port is 3134.\nmeta a.*b [[x]] `c`  end\n";
const file = () => readFileSync(join(root, REL), "utf8");

beforeEach(async () => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  root = mkdtempSync(join(tmpdir(), "mb-edit-"));
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, REL), ORIGINAL);
  await svc.ingest(REL, ORIGINAL);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Fake git: clean tree, records calls; per-command overrides by first arg.
function fakeGit(over: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    const o = over[args[0]];
    if (o) return { code: o.code, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: root + "\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}
const committed = (calls: string[][]) => calls.some((c) => c[0] === "commit");

test("replaces exact text, commits \"enscribe: edit foo\", pushes, re-ingests", async () => {
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "The port is 3134.", new: "The port is 3135." }, git);
  expect(r.ok).toBe(true);
  expect(r.pushed).toBe(true);
  expect(r.slug).toBe("foo");
  expect(file()).toBe(ORIGINAL.replace("The port is 3134.", "The port is 3135."));
  expect(calls.some((c) => c[0] === "commit" && c.includes("enscribe: edit foo"))).toBe(true);
  expect(calls.some((c) => c[0] === "push")).toBe(true);
  expect(store.getPage("foo")?.body).toContain("The port is 3135.");
});

test("pulls --ff-only before reading the file", async () => {
  const { git, calls } = fakeGit();
  await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  const pull = calls.findIndex((c) => c[0] === "pull");
  expect(calls[pull]).toEqual(["pull", "--ff-only"]);
  expect(pull).toBeLessThan(calls.findIndex((c) => c[0] === "status"));
});

test("resolves the page by title or alias like get_page", async () => {
  const { git } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "Foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(true);
  expect(r.slug).toBe("foo");
  const r2 = await editPage(cfg(), svc, store, { page: "Foo Alias", old: "3135", new: "3136" }, git);
  expect(r2.ok).toBe(true);
  expect(file()).toContain("The port is 3136.");
});

test("refuses an unknown page", async () => {
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "nope", old: "a", new: "b" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not_found/);
  expect(committed(calls)).toBe(false);
});

test("refuses a tombstoned page as not_found", async () => {
  store.softDelete("foo");
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not_found/);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("counts overlapping occurrences: \"\\n\\n\" in a triple newline is 2", async () => {
  const rel = "wiki/concepts/gap.md";
  const text = "---\ntitle: Gap\n---\n# Gap\nA\n\n\nB\n";
  writeFileSync(join(root, rel), text);
  await svc.ingest(rel, text);
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "gap", old: "\n\n", new: "\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.occurrences).toBe(2);
  expect(readFileSync(join(root, rel), "utf8")).toBe(text);
  expect(committed(calls)).toBe(false);
});

test("refuses when the pull turns source_path into a symlink out of the vault", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mb-outside-"));
  try {
    writeFileSync(join(outside, "target.md"), ORIGINAL);
    const { git: base, calls } = fakeGit();
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "pull") {
        rmSync(join(root, REL));
        symlinkSync(join(outside, "target.md"), join(root, REL));
      }
      return base(args, cwd);
    };
    const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes the vault/);
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe(ORIGINAL);
    expect(committed(calls)).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("refuses when old occurs 0 times", async () => {
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "absent text", new: "x" }, git);
  expect(r.ok).toBe(false);
  expect(r.occurrences).toBe(0);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("refuses when old occurs 2 times", async () => {
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "Foo\n", new: "Bar\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.occurrences).toBe(2);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("matches old literally, never as a pattern", async () => {
  const { git } = fakeGit();
  // Regex-only match: "a.*b" as a pattern would match "a.*b" text AND "aXXb"; the
  // literal "port.*3134" does not occur, so it must refuse with 0.
  const miss = await editPage(cfg(), svc, store, { page: "foo", old: "port.*3134", new: "x" }, git);
  expect(miss.ok).toBe(false);
  expect(miss.occurrences).toBe(0);
  expect(file()).toBe(ORIGINAL);

  const r = await editPage(cfg(), svc, store, { page: "foo", old: "a.*b [[x]] `c`  ", new: "$& $1 literal " }, git);
  expect(r.ok).toBe(true);
  expect(file()).toContain("meta $& $1 literal end\n");
});

test("refuses a frontmatter change", async () => {
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "title: Foo\n", new: "title: Bar\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/frontmatter/);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("refuses adding a frontmatter block to a page that has none", async () => {
  const rel = "wiki/concepts/bare.md";
  const text = "# Bare\nfirst line\n";
  writeFileSync(join(root, rel), text);
  await svc.ingest(rel, text);
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "bare", old: "# Bare\n", new: "---\ntitle: X\n---\n# Bare\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/frontmatter/);
  expect(readFileSync(join(root, rel), "utf8")).toBe(text);
  expect(committed(calls)).toBe(false);
});

test("refuses a generated page", async () => {
  store.upsertPage({ slug: "gen-page", title: "Gen", frontmatter: {}, body: "orig body", generator: "some-gen", source_path: "wiki/concepts/gen-page.md" });
  writeFileSync(join(root, "wiki/concepts/gen-page.md"), "orig body\n");
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "gen-page", old: "orig", new: "new" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/generated/);
  expect(readFileSync(join(root, "wiki/concepts/gen-page.md"), "utf8")).toBe("orig body\n");
  expect(committed(calls)).toBe(false);
});

test("refuses a dirty file", async () => {
  const { git, calls } = fakeGit({ status: { code: 0, stdout: " M wiki/concepts/foo.md\n" } });
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/dirty/);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("fails closed when git status errors", async () => {
  const { git, calls } = fakeGit({ status: { code: 128, stderr: "fatal: bad" } });
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/git status failed/);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("refuses when the pull fails", async () => {
  const { git, calls } = fakeGit({ pull: { code: 1, stderr: "fatal: Not possible to fast-forward, aborting." } });
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/pull/);
  expect(r.error).toMatch(/fast-forward/);
  expect(file()).toBe(ORIGINAL);
  expect(committed(calls)).toBe(false);
});

test("refuses when source_path is missing on disk", async () => {
  rmSync(join(root, REL));
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not_found/);
  expect(() => readFileSync(join(root, REL))).toThrow();
  expect(committed(calls)).toBe(false);
});

test("refuses an edit that turns the body into placeholder content", async () => {
  const rel = "wiki/concepts/short.md";
  const text = "---\ntitle: Short\n---\nreal note\n";
  writeFileSync(join(root, rel), text);
  await svc.ingest(rel, text);
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "short", old: "real note", new: "Lorem ipsum dolor sit amet." }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("placeholder");
  expect(readFileSync(join(root, rel), "utf8")).toBe(text);
  expect(committed(calls)).toBe(false);
});

test("refuses an edit whose new text holds a secret", async () => {
  const rel = "wiki/concepts/short.md";
  const text = "---\ntitle: Short\n---\nreal note\n";
  writeFileSync(join(root, rel), text);
  await svc.ingest(rel, text);
  const { git, calls } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "short", old: "real note", new: "Authorization: Bear" + "er " + "a1".repeat(32) }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("bearer-header");
  expect(readFileSync(join(root, rel), "utf8")).toBe(text);
  expect(committed(calls)).toBe(false);
});

// Only the new text is judged: a page that already holds a flagged line (the
// nightly detector's business) must stay editable, or the fix itself, and
// every unrelated edit, would be refused.
test("allows an unrelated edit to a page that already holds a flagged line", async () => {
  const rel = "wiki/concepts/old.md";
  const text = "---\ntitle: Old\n---\nreal note\nSIP pass" + "word=abcdefgh123 kept from 2025\n";
  writeFileSync(join(root, rel), text);
  await svc.ingest(rel, text);
  const { git } = fakeGit();
  const r = await editPage(cfg(), svc, store, { page: "old", old: "real note", new: "real note, revised" }, git);
  expect(r.ok).toBe(true);
});

test("surfaces a failed push without failing the write", async () => {
  const { git } = fakeGit({ push: { code: 1, stderr: "fatal: could not read Username" } });
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(true);
  expect(r.pushed).toBe(false);
  expect(r.pushError).toMatch(/could not read Username/);
  expect(file()).toContain("3135");
});

// Once the commit has landed the vault HAS changed, so a failure after it (the
// field case: `database is locked` from a concurrent `vault sync`) must not read
// as ok:false, which a caller takes to mean "nothing happened" and retries.
test("an ingest failure after the commit is ok:true with ingestError", async () => {
  const { git } = fakeGit();
  vi.spyOn(svc, "ingest").mockRejectedValue(new Error("database is locked"));
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(true);
  expect(r.committed).toBe(true);
  expect(r.pushed).toBe(true);
  expect(r.slug).toBe("foo");
  expect(r.ingestError).toMatch(/database is locked/);
  expect(r.error).toBeUndefined();
  expect(r.inbound).toBeUndefined();
  expect(file()).toContain("3135");
});

test("a resolvePending failure after the commit is ok:true with ingestError", async () => {
  const { git } = fakeGit();
  vi.spyOn(svc, "resolvePending").mockRejectedValue(new Error("database is locked"));
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(true);
  expect(r.committed).toBe(true);
  expect(r.changed).toBe(true);
  expect(r.ingestError).toMatch(/database is locked/);
});

// ok:false must mean the vault is unchanged: a failed add/commit restores the
// file, or it stays dirty and every later edit of it is refused.
for (const step of ["add", "commit"]) {
  test(`a failed git ${step} restores the file and reports ok:false`, async () => {
    const { git, calls } = fakeGit({ [step]: { code: 1, stderr: `fatal: ${step} broke` } });
    const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`git ${step} failed`));
    expect(file()).toBe(ORIGINAL);
    expect(calls.some((c) => c[0] === "reset")).toBe(true);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(store.getPage("foo")?.body).toContain("3134");
  });
}

test("a failed undo reset is reported, and the file is still restored", async () => {
  const { git } = fakeGit({ commit: { code: 1, stderr: "fatal: commit broke" }, reset: { code: 1, stderr: "fatal: reset broke" } });
  const r = await editPage(cfg(), svc, store, { page: "foo", old: "3134", new: "3135" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/git commit failed/);
  expect(r.error).toMatch(/undo incomplete: git reset failed: fatal: reset broke/);
  expect(file()).toBe(ORIGINAL);
});
