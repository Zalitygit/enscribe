import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { PageService } from "./service.js";
import type { PagesStore } from "./store.js";
import type { VaultConfig } from "./vault-config.js";
import { slugFor } from "./slug.js";
import { parseFrontmatter } from "./parse.js";
import { checkContent } from "./content-guard.js";
import { checkSecrets } from "./secret-guard.js";

export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

// The contract: ok:false means the vault is unchanged (refused, or the write
// was undone because git add/commit failed). ok:true means the vault holds the
// requested text (committed, or already identical); push and index are
// reported separately, by `pushed`/`pushError` and `ingestError`.
export interface PutPageResult {
  ok: boolean;
  slug?: string;
  changed?: boolean;
  committed?: boolean;
  pushed?: boolean;
  pushError?: string;
  // Inbound wikilinks from ingested pages, read after the write. `orphan` is
  // `inbound === 0`: the page is invisible to the graph until something links
  // to it. Said here, at write time, rather than by `doctor` a day later.
  // Note `wiki/index.md` is not an ingested page, so a page catalogued only
  // there still reads as orphaned here (the same blind spot `orphans()` has).
  inbound?: number;
  orphan?: boolean;
  // The distinct pages linking here, sorted: the ones this write may have
  // made wrong. (Idea from lucasastorian/llmwiki's write "impact surface".)
  backlinks?: string[];
  // Outbound link targets of this page that resolve to nothing, sorted. The
  // longest-lived ledger findings were links to slugs that never existed, each
  // reported nightly for weeks; this says it while the writer can still fix it.
  unresolved?: string[];
  // Set when the commit landed but indexing it failed (e.g. "database is
  // locked" from a concurrent `vault sync`). The vault is changed, so this is
  // ok:true, not a retryable error; the next sync indexes the file. The graph
  // fields above are omitted when they could not be read.
  ingestError?: string;
  error?: string;
}

export const realGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

// A caller path must be vault-relative, end .md, sit under an include dir, and
// contain no deny segment. Returns an error string, or null if valid.
export function validatePath(config: VaultConfig, path: string): string | null {
  if (isAbsolute(path) || path.split(/[/\\]/).includes("..")) return "path must be vault-relative with no '..'";
  if (!path.endsWith(".md")) return "path must end in .md";
  const segs = path.split(/[/\\]/).map((s) => s.toLowerCase());
  const denies = new Set(config.deny.map((d) => d.toLowerCase()));
  if (segs.some((s) => denies.has(s))) return "path is deny-listed";
  const underInclude = config.include.some((inc) => path.startsWith(inc.endsWith("/") ? inc : inc + "/"));
  if (!underInclude) return "path is not under an include dir";
  return null;
}

// Lexical checks can't see symlinks: resolve the deepest existing ancestor of
// the target (which is the target itself when it exists, following a file
// symlink to wherever it points) and require it to sit under the real vault
// root. Returns an error string, or null if contained.
export function validateRealPath(root: string, abs: string): string | null {
  const lexists = (p: string): boolean => {
    try { lstatSync(p); return true; } catch { return false; }
  };
  let probe = abs;
  while (!lexists(probe)) probe = dirname(probe);
  let realRoot: string, real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(probe);
  } catch {
    return "path escapes the vault (unresolvable symlink)";
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return "path escapes the vault (symlink)";
  return null;
}

// Write an authored page to the vault, git-commit just that file, and ingest it.
// Refuses an invalid/denied path, a generator-owned target, or a dirty path
// (never clobbers a local edit; no merge machinery).
export async function putPage(
  config: VaultConfig,
  service: PageService,
  store: PagesStore,
  input: { path: string; content: string },
  git: GitRunner = realGit,
): Promise<PutPageResult> {
  const invalid = validatePath(config, input.path);
  if (invalid) return { ok: false, error: invalid };

  // Authoritative slug — derived exactly as PageService.ingest does, so the
  // guards below and the commit message reference the SAME slug the page will
  // actually get.
  const { frontmatter, body } = parseFrontmatter(input.content);
  // Guard the BODY, not the raw content: frontmatter words would inflate the
  // count past the threshold and disable the check on exactly the short pages
  // it exists to catch.
  const junk = checkContent(body);
  if (junk) return { ok: false, error: junk };
  // Secrets are scanned over the whole file: frontmatter is served too.
  const secret = checkSecrets(input.content);
  if (secret) return { ok: false, error: secret };
  const slug = slugFor(input.path, frontmatter);
  const existing = store.getPage(slug);
  // Both guards test LIVENESS: getPage() does not filter tombstones, and a
  // pruned page keeps its row forever (softDelete tombstones, and the nightly
  // job runs neither `vault sync` nor `purge`). Without the deleted_at check a
  // slug any generator ever owned could never be authored again.
  if (existing && existing.generator && existing.deleted_at === null) {
    return { ok: false, error: "generated page; not writable" };
  }
  // Slug is basename-derived, so a new path can claim a live page's slug. Two
  // files under one slug are QUARANTINED by the next `vault sync` (neither is
  // indexed until a human fixes the vault), so refuse before writing. A
  // tombstoned slug is fair game.
  if (existing && existing.deleted_at === null && existing.source_path && existing.source_path !== input.path) {
    return { ok: false, error: `slug '${slug}' already belongs to ${existing.source_path}` };
  }

  const abs = join(config.root, input.path);
  const escape = validateRealPath(config.root, abs);
  if (escape) return { ok: false, error: escape };

  const top = git(["rev-parse", "--show-toplevel"], config.root);
  if (top.code !== 0) return { ok: false, error: `not a git repo: ${top.stderr.trim()}` };
  const repoRoot = top.stdout.trim();

  // Dirty check — FAIL CLOSED: a failed status check refuses rather than proceeds.
  const status = git(["status", "--porcelain", "--", abs], repoRoot);
  if (status.code !== 0) return { ok: false, error: `git status failed: ${status.stderr.trim()}` };
  if (status.stdout.trim() !== "") return { ok: false, error: "vault path is dirty; commit or discard first" };

  const original = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, input.content, "utf8");

  const r = await commitPushIngest(service, store, repoRoot, abs, input.path, input.content, `enscribe: ${slug}`, git);
  if (!r.ok) {
    const undo = undoWrite(repoRoot, abs, original, git);
    if (undo) r.error = `${r.error}; ${undo}`;
  }
  return r;
}

// Undo a write whose add/commit failed, so ok:false really means the vault is
// unchanged and the path is not left dirty (which would refuse every later
// write to it). Unstage first: after a successful `git add` the index holds the
// NEW text, so `git checkout -- <abs>` would restore that, not the original.
// Then put back the original bytes (read before the write, from a tree the
// dirty check proved clean), or remove a file that did not exist. The bytes go
// back even when the unstage fails, but then the index still holds the new
// text, so the path stays dirty: return what failed for the caller's error,
// or null when the undo is complete.
export function undoWrite(repoRoot: string, abs: string, original: string | null, git: GitRunner): string | null {
  const reset = git(["reset", "-q", "--", abs], repoRoot);
  if (original === null) unlinkSync(abs);
  else writeFileSync(abs, original, "utf8");
  if (reset.code === 0) return null;
  return `undo incomplete: git reset failed: ${reset.stderr.trim()}; the new text is still staged, run \`git restore --staged ${relative(repoRoot, abs)}\``;
}

// The shared second half of every vault write: commit just `abs` with
// `subject`, push, ingest `content` as `relPath`, and report the graph view of
// the page. The caller has already validated the path and written the file.
export async function commitPushIngest(
  service: PageService,
  store: PagesStore,
  repoRoot: string,
  abs: string,
  relPath: string,
  content: string,
  subject: string,
  git: GitRunner,
): Promise<PutPageResult> {
  const add = git(["add", "--", abs], repoRoot);
  if (add.code !== 0) return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
  const commit = git(["commit", "-m", subject, "--", abs], repoRoot);
  let committed = true;
  if (commit.code !== 0) {
    // Writing identical content is a git no-op ("nothing to commit"); the vault
    // already matches the request, so treat it as success, not an error.
    if (/nothing to commit/.test(commit.stdout + commit.stderr)) committed = false;
    else return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
  }

  // Push regardless of whether THIS call committed anything: an earlier call
  // can have left a commit stranded locally (offline, race with another
  // writer), and leaving it unpushed is what caused the 2026-09-04 incident —
  // a downstream `git pull --ff-only` on another host conflicts, is tolerated
  // by design, and the index gets re-synced from a stale working copy while
  // reporting success. A push failure here does not fail the write: the
  // content is safely committed locally, so `ok` stays true and the caller is
  // told the commit is stranded via `pushed`/`pushError` instead.
  const push = git(["push"], repoRoot);
  const pushed = push.code === 0;
  const pushError = pushed ? undefined : (push.stderr || push.stdout).trim();

  // From here the vault has changed, so nothing below may turn into ok:false:
  // a caller reads that as "nothing happened" and retries, which double-applies
  // an append. Index failures are reported as `ingestError` instead.
  let slug = slugFor(relPath, parseFrontmatter(content).frontmatter);
  let changed: boolean | undefined;
  try {
    ({ slug, changed } = await service.ingest(relPath, content));
    // A parent written BEFORE this page left its link in unresolved_links;
    // ingest only resolves this page's own outbound links. Re-resolve the
    // pending ones so a child written in the natural order (parent first) is
    // not reported as orphaned, and so the graph is right without waiting for
    // the next full vault sync.
    await service.resolvePending();
    const links = store.getBacklinks(slug);
    const inbound = links.length;
    const backlinks = [...new Set(links.map((l) => l.from_slug))];
    const unresolved = store.getLinks(slug).unresolved.map((u) => u.raw_text);
    return { ok: true, slug, changed, committed, pushed, pushError, inbound, orphan: inbound === 0, backlinks, unresolved };
  } catch (e) {
    return { ok: true, slug, changed, committed, pushed, pushError, ingestError: String(e) };
  }
}
