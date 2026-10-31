import { execFileSync } from "node:child_process";

// Marker prefix for the commit-time line in `git log` output. Chosen so it can't
// collide with a real vault-relative path (paths never start with "@@").
const MARK = "@@";

// git's rename similarity score, as a percentage. 100 means the two blobs are
// identical, i.e. the commit moved the file without touching a byte of it.
const PURE_RENAME = 100;

// `R<score>\told\tnew` (rename) or `C<score>\told\tnew` (copy, only with -C).
const RENAME = /^[RC](\d+)$/;

// One commit that changed a file, as the log reports it.
export interface VaultCommit {
  iso: string;
  subject: string;
}

// Walk `git log --relative --format=@@%cI%x09%s --name-status -M` output and
// emit one (current path, commit) CHANGE EVENT per entry, newest first. Pure, so
// it is unit-testable without git.
//
// Two things make this more than a scan. A pure rename is not a change event:
// moving a page into a new directory leaves its text identical, so crediting the
// move commit would make a bulk reorganization look like a night of fresh
// authoring. And once a page has been renamed, the commits that DID change it are
// recorded under its old name, so those have to be attributed forward to the path
// the page has today. Walking newest-first means a rename is always seen before
// the older history it renames, which is what lets one pass do both.
//
// Both readers below are built on this one walk on purpose. A page's "last
// changed" date and its own commit list are two views of the same history, and
// two hand-written rename models would eventually disagree about whether a move
// was an edit — the shape of drift the orphan predicate already demonstrates.
function* changeEvents(out: string): Generator<{ path: string; commit: VaultCommit }> {
  // Historical path -> the path that file is known by now. Transitive: a chain
  // a -> b -> c is seen newest-first (b->c, then a->b), so a resolves to c.
  const renamedTo = new Map<string, string>();
  let current: VaultCommit | null = null;

  for (const line of out.split("\n")) {
    if (line.startsWith(MARK)) {
      // `<iso>\t<subject>`. The subject is optional so that a log taken with the
      // older time-only format still parses, and everything after the first tab
      // is the subject: git subjects are a single line but may contain tabs.
      const rest = line.slice(MARK.length);
      const tab = rest.indexOf("\t");
      current = tab < 0
        ? { iso: rest.trim(), subject: "" }
        : { iso: rest.slice(0, tab).trim(), subject: rest.slice(tab + 1).trim() };
      continue;
    }
    if (!current) continue;

    const fields = line.split("\t");
    const status = fields[0]?.trim();
    if (!status || fields.length < 2) continue;

    const rename = RENAME.exec(status);
    if (rename && fields.length >= 3) {
      const from = fields[1]!.trim();
      const to = fields[2]!.trim();
      if (!from || !to) continue;
      const canonical = renamedTo.get(to) ?? to;
      renamedTo.set(from, canonical);
      // A rename below 100% similarity also edited the file, so it IS a change.
      if (Number(rename[1]) < PURE_RENAME) yield { path: canonical, commit: current };
      continue;
    }

    const path = fields[1]!.trim();
    if (!path) continue;
    yield { path: renamedTo.get(path) ?? path, commit: current };
  }
}

// Vault-relative path -> the ISO time of the commit that last CHANGED it. The
// log is newest-first, so the first event for a path is its latest change.
export function parseGitLog(out: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const { path, commit } of changeEvents(out)) {
    if (!times.has(path)) times.set(path, commit.iso);
  }
  return times;
}

// Vault-relative path -> every commit that changed it, newest first.
export function parseFileHistory(out: string): Map<string, VaultCommit[]> {
  const history = new Map<string, VaultCommit[]>();
  for (const { path, commit } of changeEvents(out)) {
    const list = history.get(path);
    if (list) list.push(commit);
    else history.set(path, [commit]);
  }
  return history;
}

// Last content-change time per source file under `root`, as a vault-relative-path
// -> ISO map. One `git log` invocation; `--relative` emits paths relative to
// `root` so they match the stored source_path. Returns an empty map if git fails
// (not a repo, git missing, root outside a worktree) — callers then leave
// authored_at null, and recency falls back to ingest time. `runner` is injected
// for tests.
//
// Note `--relative` also SCOPES the log to `root`, so a file renamed in from
// outside the vault has no counterpart in range and git reports it as an add.
// That is the right answer here: it is genuinely new to the vault.
export function gitCommitTimes(
  root: string,
  runner: (root: string) => string = defaultRunner,
): Map<string, string> {
  try {
    return parseGitLog(runner(root));
  } catch {
    return new Map();
  }
}

// The full history behind the same log, for the page-history generator. Fails
// the same way gitCommitTimes does: an empty map, never a throw, so a vault that
// is not a git worktree simply produces no history pages.
export function vaultFileHistory(
  root: string,
  runner: (root: string) => string = defaultRunner,
): Map<string, VaultCommit[]> {
  try {
    return parseFileHistory(runner(root));
  } catch {
    return new Map();
  }
}

function defaultRunner(root: string): string {
  return execFileSync(
    "git",
    // -M is explicit rather than relying on diff.renames (true by default since
    // git 2.9): a user-level `diff.renames=false` would otherwise silently turn
    // every move back into an add+delete and reintroduce the reorganization bug.
    // %x09 is a literal tab, separating the commit time from its subject.
    ["-C", root, "log", "--relative", `--format=${MARK}%cI%x09%s`, "--name-status", "-M"],
    // stderr ignored: a non-repo root fails the call (caught -> empty map) without
    // leaking git's "fatal: not a git repository" to the process stderr.
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
}
