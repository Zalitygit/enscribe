import { execFileSync } from "node:child_process";
import { vaultFileHistory, type VaultCommit } from "./vault-git.js";

// One vault's commit history for the page_history tool, as the same
// rename-aware walk that stamps authored_at. The history-page generator
// answered git-only questions too, but its pages ranked beside their subjects
// and cost 0.040 nDCG@5; a read tool returns the same facts with no new
// searchable page.
//
// A vault-wide `git log` takes about 0.2 s on production, and the shared
// server runs every client on one event loop, so the parsed map is kept until
// HEAD moves. The cache is module-level because the HTTP server builds a
// fresh McpServer per session. An unreadable HEAD caches nothing.
const cache = new Map<string, { head: string; history: Map<string, VaultCommit[]> }>();

export interface HistoryDeps {
  head: (root: string) => string;
  load: (root: string) => Map<string, VaultCommit[]>;
}

const defaults: HistoryDeps = { head: gitHead, load: (root) => vaultFileHistory(root) };

// Every commit that changed SOURCEPATH (vault-relative), newest first.
export function pageHistoryOf(root: string, sourcePath: string, deps: HistoryDeps = defaults): VaultCommit[] {
  const head = deps.head(root);
  let hit = cache.get(root);
  if (!hit || !head || hit.head !== head) {
    hit = { head, history: deps.load(root) };
    if (head) cache.set(root, hit);
    else cache.delete(root);
  }
  return hit.history.get(sourcePath) ?? [];
}

function gitHead(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
