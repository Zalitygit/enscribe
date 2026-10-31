import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, env } from "../env.js";

export interface VaultConfig {
  root: string;
  include: string[];
  deny: string[];
}

// The privacy floor. This is the denylist that runs whenever no config file is
// present — a fresh box, a restore, a second device — which is the documented
// "defaults are fine" path and therefore the one nobody thinks to check. It was
// once only ["Vaulted"], and that is exactly how health/genome pages were
// ingested and became readable to every pages.read client. Segments, not
// filenames: `deny` matches a whole path segment, so "health" denies a
// .../health/... subtree but NOT a file named health-records.md.
// NOTE: a config that sets `deny` REPLACES this list rather than extending it,
// so this protects the absent-config case only.
const DEFAULTS: VaultConfig = {
  root: join(homedir(), "workspace", "etc", "notes"),
  include: ["wiki/concepts", "wiki/entities", "wiki/synthesis", "wiki/sources", "raw", "projects", "daily"],
  deny: ["Vaulted", "private", "health", "genome", "insurance", "finance"],
};

function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^[/\\]/, "")) : p;
}

export function vaultConfigPath(): string {
  return env("VAULT_CONFIG") ?? join(dataDir(), "vault.json");
}

// Load the vault config, filling any missing field from defaults. A missing
// file yields all defaults (documented behaviour). A file that EXISTS but
// fails to parse throws instead of silently falling back — DEFAULTS.deny is
// only ["Vaulted"], far weaker than an operator-configured denylist
// (health/genome/insurance/finance/etc.), so silently downgrading to it on a
// parse error would be a real privacy hole, not a graceful degradation.
// `root`'s leading `~` expands to the home dir.
export function loadVaultConfig(path = vaultConfigPath()): VaultConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULTS };
    }
    throw e; // present but unreadable (e.g. permissions) — do not downgrade silently
  }
  const parsed = JSON.parse(text) as Partial<VaultConfig>; // malformed JSON throws here, on purpose
  return {
    root: expandTilde(parsed.root ?? DEFAULTS.root),
    include: parsed.include ?? DEFAULTS.include,
    deny: parsed.deny ?? DEFAULTS.deny,
  };
}
