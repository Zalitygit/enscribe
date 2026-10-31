import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PageService } from "./service.js";
import type { PagesStore } from "./store.js";
import type { VaultConfig } from "./vault-config.js";
import { FRONTMATTER_RE, parseFrontmatter } from "./parse.js";
import { checkContent } from "./content-guard.js";
import { checkSecrets } from "./secret-guard.js";
import {
  commitPushIngest, realGit, undoWrite, validatePath, validateRealPath,
  type GitRunner, type PutPageResult,
} from "./put-page.js";

export interface EditPageResult extends PutPageResult {
  // How many times `old` occurred, reported when that count is why the edit
  // was refused (0 = stale text, >1 = ambiguous; widen `old` to one spot).
  occurrences?: number;
}

// Count literal occurrences of `needle`, overlapping ones included: "\n\n" in
// "\n\n\n" is 2, so it is ambiguous and refused. indexOf, never a RegExp: `old`
// routinely holds `.`, `*`, `[[`, backticks and trailing spaces.
function countLiteral(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

// Exact-text in-place edit of an authored page: replace the one occurrence of
// `old` with `new`, then commit/push/ingest like putPage. Refuses (writing
// nothing) unless the page is live, authored and on disk, the vault fast-
// forwards cleanly, the file is clean, `old` occurs exactly once, and the
// frontmatter block is untouched. Frontmatter carries slug/title/aliases, so a
// change there is a rename or re-identification and belongs to put_page.
export async function editPage(
  config: VaultConfig,
  service: PageService,
  store: PagesStore,
  input: { page: string; old: string; new: string },
  git: GitRunner = realGit,
): Promise<EditPageResult> {
  if (input.old === "") return { ok: false, error: "old must be non-empty" };

  // Resolve exactly as get_page does: slug, then title/alias.
  const slug = store.resolve(input.page);
  const row = slug ? store.getPage(slug) : undefined;
  // getPage() does not filter tombstones; resolve() does, but check liveness
  // here too rather than depend on that.
  if (!slug || !row || row.deleted_at !== null) return { ok: false, error: `not_found: no page '${input.page}'` };
  if (row.generator) return { ok: false, error: "generated page; not writable" };
  if (!row.source_path) return { ok: false, error: `not_found: page '${slug}' has no source file` };

  const relPath = row.source_path;
  const invalid = validatePath(config, relPath);
  if (invalid) return { ok: false, error: invalid };
  const abs = join(config.root, relPath);
  const escape = validateRealPath(config.root, abs);
  if (escape) return { ok: false, error: escape };

  const top = git(["rev-parse", "--show-toplevel"], config.root);
  if (top.code !== 0) return { ok: false, error: `not a git repo: ${top.stderr.trim()}` };
  const repoRoot = top.stdout.trim();

  // Fast-forward first, so an edit never lands on a copy that lags a push
  // from another host. A failed pull refuses: editing a stale copy is how the
  // 2026-09-04 divergence started.
  const pull = git(["pull", "--ff-only"], repoRoot);
  if (pull.code !== 0) return { ok: false, error: `git pull --ff-only failed: ${(pull.stderr || pull.stdout).trim()}` };

  // The pull can change what source_path is (e.g. into a symlink out of the
  // vault), so re-check containment against the post-pull tree.
  const escapeAfterPull = validateRealPath(config.root, abs);
  if (escapeAfterPull) return { ok: false, error: escapeAfterPull };

  // Read AFTER the pull. A file renamed or deleted since the last ingest is
  // not_found: the index row is stale, and writing would resurrect the path.
  let current: string;
  try {
    current = readFileSync(abs, "utf8");
  } catch {
    return { ok: false, error: `not_found: ${relPath} is not on disk` };
  }

  // Dirty check — FAIL CLOSED, as putPage.
  const status = git(["status", "--porcelain", "--", abs], repoRoot);
  if (status.code !== 0) return { ok: false, error: `git status failed: ${status.stderr.trim()}` };
  if (status.stdout.trim() !== "") return { ok: false, error: "vault path is dirty; commit or discard first" };

  const occurrences = countLiteral(current, input.old);
  if (occurrences !== 1) {
    const why = occurrences === 0 ? "old text not found" : `old text occurs ${occurrences} times; include more context`;
    return { ok: false, occurrences, error: why };
  }
  // Slice, never String.replace: a string replacement interprets `$&`, `$1`.
  const at = current.indexOf(input.old);
  const next = current.slice(0, at) + input.new + current.slice(at + input.old.length);

  const block = (t: string) => t.match(FRONTMATTER_RE)?.[0] ?? "";
  if (block(current) !== block(next)) return { ok: false, error: "edit changes the frontmatter; use put_page" };

  const junk = checkContent(parseFrontmatter(next).body);
  if (junk) return { ok: false, error: junk };
  // Judge only the new text. A line already in the page is the nightly
  // detector's finding; refusing here would block the fix and every unrelated
  // edit along with it. Line numbers are within `new`.
  const secret = checkSecrets(input.new);
  if (secret) return { ok: false, error: `new text: ${secret}` };

  writeFileSync(abs, next, "utf8");
  const r = await commitPushIngest(service, store, repoRoot, abs, relPath, next, `enscribe: edit ${slug}`, git);
  if (!r.ok) {
    const undo = undoWrite(repoRoot, abs, current, git);
    if (undo) r.error = `${r.error}; ${undo}`;
  }
  return r;
}
