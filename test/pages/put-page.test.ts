import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { putPage, type GitRunner } from "../../src/pages/put-page.js";
import type { VaultConfig } from "../../src/pages/vault-config.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let root: string;
const cfg = (): VaultConfig => ({ root, include: ["wiki/concepts"], deny: ["Vaulted"] });

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  root = mkdtempSync(join(tmpdir(), "mb-put-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Fake git: reports a clean tree, records the commands it was asked to run.
function fakeGit(dirty = false): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: root + "\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M wiki/concepts/foo.md\n" : "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}

test("putPage writes the file, commits, and ingests a resolvable page", async () => {
  const { git, calls } = fakeGit();
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nbody\n" }, git);
  expect(r.ok).toBe(true);
  expect(r.slug).toBe("foo");
  expect(existsSync(join(root, "wiki/concepts/foo.md"))).toBe(true);
  expect(store.resolve("Foo")).toBe("foo");
  expect(calls.some((c) => c[0] === "commit" && c.includes("enscribe: foo"))).toBe(true);
});

test("putPage pushes after a successful commit and reports pushed:true", async () => {
  const { git, calls } = fakeGit();
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nbody\n" }, git);
  expect(r.ok).toBe(true);
  expect(r.pushed).toBe(true);
  expect(calls.some((c) => c[0] === "push")).toBe(true);
});

// A push can fail (offline, non-fast-forward on the remote) after the commit
// already landed locally. The write itself succeeded and must not be reported
// as a failure — but the caller needs to know the commit is stranded locally,
// or it silently diverges from origin the way the 2026-09-04 incident did.
test("putPage surfaces a failed push without failing the write", async () => {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: root + "\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "push") return { code: 1, stdout: "", stderr: "fatal: could not read Username" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nbody\n" }, git);
  expect(r.ok).toBe(true);
  expect(r.pushed).toBe(false);
  expect(r.pushError).toMatch(/could not read Username/);
});

test("putPage refuses a deny-listed path without writing", async () => {
  const { git } = fakeGit();
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/Vaulted/secret.md", content: "# x\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/deny/);
  expect(existsSync(join(root, "wiki/concepts/Vaulted/secret.md"))).toBe(false);
});

test("putPage refuses a path outside include dirs and a non-.md path", async () => {
  const { git } = fakeGit();
  expect((await putPage(cfg(), svc, store, { path: "raw/foo.md", content: "x" }, git)).ok).toBe(false);
  expect((await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.txt", content: "x" }, git)).ok).toBe(false);
  expect((await putPage(cfg(), svc, store, { path: "../escape.md", content: "x" }, git)).ok).toBe(false);
});

test("putPage refuses a dirty target path without writing or committing", async () => {
  const { git, calls } = fakeGit(true);
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "x" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/dirty/);
  expect(existsSync(join(root, "wiki/concepts/foo.md"))).toBe(false);
  expect(calls.some((c) => c[0] === "commit")).toBe(false);
});

test("putPage (real git) creates a macbrain commit and a resolved page", async () => {
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "seed"]);

  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/note.md", content: "---\ntitle: Note\n---\n# Note\nhi\n" });
  expect(r.ok).toBe(true);
  expect(r.committed).toBe(true);
  expect(g(["log", "--oneline", "-1"])).toContain("enscribe: note");
  expect(store.resolve("Note")).toBe("note");
});

test("putPage refuses to overwrite a generator-owned page via a frontmatter slug override", async () => {
  store.upsertPage({ slug: "gen-page", title: "Gen", frontmatter: {}, body: "orig", generator: "some-gen", source_path: "wiki/concepts/gen-page.md" });
  const { git } = fakeGit();
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/innocent.md", content: "---\nslug: gen-page\ntitle: Evil\n---\n# Evil\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/generated/);
  expect(store.getPage("gen-page")?.body).toBe("orig");
  expect(store.getPage("gen-page")?.generator).toBe("some-gen");
});

// The generator guard must test LIVENESS, like the slug-owner check below it.
// A pruned generator stub keeps its row (softDelete tombstones, it does not
// delete), and nothing in the nightly job runs `vault sync` or `purge` — so a
// liveness-blind guard bricks that slug for authoring, permanently.
test("putPage may claim the slug of a TOMBSTONED generated page", async () => {
  store.upsertPage({ slug: "repo-foo", title: "repo-foo", frontmatter: {}, body: "stub", generator: "repo-inventory", source_path: null });
  store.softDelete("repo-foo");
  const { git } = fakeGit();

  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/repo-foo.md", content: "---\ntitle: Repo Foo\n---\n# Repo Foo\nauthored\n" }, git);
  expect(r.ok).toBe(true);
  const page = store.getPage("repo-foo")!;
  expect(page.deleted_at).toBeNull();
  expect(page.generator).toBeNull();
  expect(page.body).toContain("authored");
});

// Slugs are basename-derived, so two files in different dirs can claim one slug.
// vault sync ABORTS wholesale on that collision, so put_page must refuse it at
// the write rather than commit a second file that wedges the next sync.
test("putPage refuses a path whose slug already belongs to another file", async () => {
  const { git, calls } = fakeGit();
  const first = await putPage(cfg(), svc, store, { path: "wiki/concepts/a/layout.md", content: "---\ntitle: Layout\n---\n# Layout\norig\n" }, git);
  expect(first.ok).toBe(true);

  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/b/layout.md", content: "---\ntitle: Layout Dup\n---\n# Dup\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/already belongs to wiki\/concepts\/a\/layout\.md/);
  expect(existsSync(join(root, "wiki/concepts/b/layout.md"))).toBe(false);
  expect(calls.filter((c) => c[0] === "commit").length).toBe(1);
  expect(store.getPage("layout")?.source_path).toBe("wiki/concepts/a/layout.md");
  expect(store.getPage("layout")?.body).toContain("orig");
});

test("putPage allows re-creating a tombstoned slug at a new path", async () => {
  const { git } = fakeGit();
  expect((await putPage(cfg(), svc, store, { path: "wiki/concepts/a/gone.md", content: "---\ntitle: Gone\n---\n# Gone\n" }, git)).ok).toBe(true);
  store.softDelete("gone");
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/b/gone.md", content: "---\ntitle: Gone Again\n---\n# Again\n" }, git);
  expect(r.ok).toBe(true);
  expect(store.getPage("gone")?.source_path).toBe("wiki/concepts/b/gone.md");
});

test("putPage fails closed when git status errors (no write)", async () => {
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: root + "\n", stderr: "" };
    if (args[0] === "status") return { code: 128, stdout: "", stderr: "fatal: bad" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "x" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/git status failed/);
  expect(existsSync(join(root, "wiki/concepts/foo.md"))).toBe(false);
});

test("putPage (real git) re-putting identical content is an idempotent success", async () => {
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "seed\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  const content = "---\ntitle: Dup\n---\n# Dup\nsame\n";
  const first = await putPage(cfg(), svc, store, { path: "wiki/concepts/dup.md", content });
  expect(first.ok).toBe(true);
  expect(first.committed).toBe(true);
  const second = await putPage(cfg(), svc, store, { path: "wiki/concepts/dup.md", content });
  expect(second.ok).toBe(true);
  expect(second.committed).toBe(false);
});

test("putPage refuses a path that escapes the vault through a symlinked directory", async () => {
  const { git } = fakeGit();
  const outside = mkdtempSync(join(tmpdir(), "mb-outside-"));
  try {
    mkdirSync(join(root, "wiki/concepts"), { recursive: true });
    symlinkSync(outside, join(root, "wiki/concepts/leak"));
    const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/leak/evil.md", content: "# evil\n" }, git);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes the vault/);
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("putPage refuses writing through a symlinked file that targets outside the vault", async () => {
  const { git } = fakeGit();
  const outside = mkdtempSync(join(tmpdir(), "mb-outside-"));
  try {
    mkdirSync(join(root, "wiki/concepts"), { recursive: true });
    writeFileSync(join(outside, "target.md"), "original\n");
    symlinkSync(join(outside, "target.md"), join(root, "wiki/concepts/alias.md"));
    const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/alias.md", content: "# overwritten\n" }, git);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/escapes the vault/);
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("original\n");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// The guard must refuse BEFORE anything touches disk or git: a rejected write
// leaves no file and no commit.
test("refuses placeholder content without writing or committing", async () => {
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  const { git, calls } = fakeGit();

  const r = await putPage(cfg(), svc, store, {
    path: "wiki/concepts/junk.md",
    content: "---\ntitle: Junk\n---\nLorem ipsum dolor sit amet.\n",
  }, git);

  expect(r.ok).toBe(false);
  expect(r.error).toContain("placeholder");
  expect(existsSync(join(root, "wiki/concepts/junk.md"))).toBe(false);
  expect(calls.some((c) => c[0] === "commit")).toBe(false);
});

// Frontmatter is scanned too: a token there is served just the same. The
// error names the rule and line, never the value.
test("refuses credential-shaped content without writing or committing", async () => {
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  const { git, calls } = fakeGit();
  const token = "a1".repeat(32);
  const r = await putPage(cfg(), svc, store, {
    path: "wiki/concepts/leak.md",
    content: "---\ntitle: Leak\n---\n# Leak\n\nAUCTION_MCP_BEAR" + "ER=" + token + "\n",
  }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("secret-assignment line 6");
  expect(r.error).not.toContain(token);
  expect(existsSync(join(root, "wiki/concepts/leak.md"))).toBe(false);
  expect(calls.some((c) => c[0] === "commit")).toBe(false);
});

// The orphan pressure on the vault (136-167 of 145-200 pages on one instance)
// was only visible through `doctor`, a day later. Say it at write time instead:
// the result reports the inbound-link count of the page just written. A parent
// that linked to this slug BEFORE the page existed left that link in
// unresolved_links, so the write has to re-resolve pending links first or a
// page written in the right order (parent, then child) would read as orphaned.
test("putPage reports the inbound-link count of the page it wrote, resolving forward references", async () => {
  const { git } = fakeGit();
  const alone = await putPage(cfg(), svc, store, { path: "wiki/concepts/alone.md", content: "---\ntitle: Alone\n---\n# Alone\nbody\n" }, git);
  expect(alone.inbound).toBe(0);
  expect(alone.orphan).toBe(true);

  const parent = await putPage(cfg(), svc, store, { path: "wiki/concepts/parent.md", content: "---\ntitle: Parent\n---\n# Parent\nsee [[child]]\n" }, git);
  expect(parent.orphan).toBe(true);
  const child = await putPage(cfg(), svc, store, { path: "wiki/concepts/child.md", content: "---\ntitle: Child\n---\n# Child\nbody\n" }, git);
  expect(child.inbound).toBe(1);
  expect(child.orphan).toBe(false);
  expect(store.getBacklinks("child").map((l) => l.from_slug)).toEqual(["parent"]);
});

// The pages that link here are the ones a change to this page may make wrong,
// so the writer is told which they are, not only how many. Deduped: one page
// can link twice (plain and typed).
test("putPage names the pages that link to the page it wrote", async () => {
  const { git } = fakeGit();
  await putPage(cfg(), svc, store, { path: "wiki/concepts/a.md", content: "---\ntitle: A\n---\n# A\n[[t]] and runs-on:: [[t]]\n" }, git);
  await putPage(cfg(), svc, store, { path: "wiki/concepts/b.md", content: "---\ntitle: B\n---\n# B\n[[t]]\n" }, git);
  const t = await putPage(cfg(), svc, store, { path: "wiki/concepts/t.md", content: "---\ntitle: T\n---\n# T\nbody\n" }, git);
  expect(t.backlinks).toEqual(["a", "b"]);
  const lone = await putPage(cfg(), svc, store, { path: "wiki/concepts/lone.md", content: "---\ntitle: Lone\n---\n# Lone\n" }, git);
  expect(lone.backlinks).toEqual([]);
});

// The longest-lived ledger findings were links written against slugs that never
// existed (a repo page under a domain-style slug, a `reference_*` page), each reported
// nightly for weeks. The writer is told at write time instead.
test("putPage reports the outbound links of the page it wrote that do not resolve", async () => {
  const { git } = fakeGit();
  await putPage(cfg(), svc, store, { path: "wiki/concepts/real.md", content: "---\ntitle: Real\n---\n# Real\nbody\n" }, git);
  const r = await putPage(cfg(), svc, store,
    { path: "wiki/concepts/w.md", content: "---\ntitle: W\n---\n# W\nsee [[real]], [[reference_gone]] and [[Also Gone]]\n" }, git);
  expect(r.unresolved).toEqual(["Also Gone", "reference_gone"]);
  const clean = await putPage(cfg(), svc, store, { path: "wiki/concepts/c.md", content: "---\ntitle: C\n---\n# C\nsee [[real]]\n" }, git);
  expect(clean.unresolved).toEqual([]);
});

// Once the commit has landed the vault HAS changed: a failure after it must be
// ok:true with ingestError, never ok:false (which means "vault unchanged").
test("putPage: an ingest failure after the commit is ok:true with ingestError", async () => {
  const { git } = fakeGit();
  vi.spyOn(svc, "ingest").mockRejectedValue(new Error("database is locked"));
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nbody\n" }, git);
  expect(r.ok).toBe(true);
  expect(r.committed).toBe(true);
  expect(r.pushed).toBe(true);
  expect(r.slug).toBe("foo");
  expect(r.ingestError).toMatch(/database is locked/);
  expect(r.error).toBeUndefined();
  expect(r.orphan).toBeUndefined();
  expect(existsSync(join(root, "wiki/concepts/foo.md"))).toBe(true);
});

function failingGit(...steps: string[]): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: root + "\n", stderr: "" };
    if (steps.includes(args[0])) return { code: 1, stdout: "", stderr: `fatal: ${args[0]} broke` };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}

// The undo's own unstage can fail for the reason the commit did (another git
// holding index.lock). The original bytes still go back, but the index keeps
// the new text and the path stays dirty, so the caller must be told.
test("putPage: a failed undo reset is reported, and the bytes are still restored", async () => {
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/foo.md"), "---\ntitle: Foo\n---\n# Foo\nold\n");
  const { git } = failingGit("commit", "reset");
  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nnew\n" }, git);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/git commit failed/);
  expect(r.error).toMatch(/undo incomplete: git reset failed: fatal: reset broke/);
  expect(r.error).toMatch(/git restore --staged wiki\/concepts\/foo\.md/);
  expect(readFileSync(join(root, "wiki/concepts/foo.md"), "utf8")).toBe("---\ntitle: Foo\n---\n# Foo\nold\n");
});

for (const step of ["add", "commit"]) {
  test(`putPage: a failed git ${step} removes a new file and reports ok:false`, async () => {
    const { git, calls } = failingGit(step);
    const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nbody\n" }, git);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`git ${step} failed`));
    expect(existsSync(join(root, "wiki/concepts/foo.md"))).toBe(false);
    expect(calls.some((c) => c[0] === "reset")).toBe(true);
    expect(store.getPage("foo")).toBeUndefined();
  });

  test(`putPage: a failed git ${step} restores an existing file and reports ok:false`, async () => {
    mkdirSync(join(root, "wiki/concepts"), { recursive: true });
    writeFileSync(join(root, "wiki/concepts/foo.md"), "---\ntitle: Foo\n---\n# Foo\nold\n");
    const { git } = failingGit(step);
    const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/foo.md", content: "---\ntitle: Foo\n---\n# Foo\nnew\n" }, git);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(root, "wiki/concepts/foo.md"), "utf8")).toBe("---\ntitle: Foo\n---\n# Foo\nold\n");
  });
}

// Real git, a commit refused by a pre-commit hook AFTER `git add` staged the
// new text: the index must be restored too, or the path stays dirty and every
// later write to it is refused.
test("putPage (real git) a refused commit leaves the tracked file and index clean", async () => {
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  const orig = "---\ntitle: Kept\n---\n# Kept\norig\n";
  writeFileSync(join(root, "wiki/concepts/kept.md"), orig);
  g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const r = await putPage(cfg(), svc, store, { path: "wiki/concepts/kept.md", content: "---\ntitle: Kept\n---\n# Kept\nchanged\n" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/git commit failed/);
  expect(readFileSync(join(root, "wiki/concepts/kept.md"), "utf8")).toBe(orig);
  expect(g(["status", "--porcelain"])).toBe("");

  const n = await putPage(cfg(), svc, store, { path: "wiki/concepts/new.md", content: "---\ntitle: New\n---\n# New\nx\n" });
  expect(n.ok).toBe(false);
  expect(existsSync(join(root, "wiki/concepts/new.md"))).toBe(false);
  expect(g(["status", "--porcelain"])).toBe("");
});
