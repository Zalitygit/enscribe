import { vaultFileHistory } from "../vault-git.js";
import type { GitHistorySource } from "./types.js";

// Production GitHistorySource: the same `git log` the authored_at stamp reads,
// parsed for its full history rather than only its newest entry. `--relative`
// scopes the log to the vault root, so the paths returned match source_path.
export function gitHistorySource(root: string): GitHistorySource {
  return { history: () => vaultFileHistory(root) };
}
