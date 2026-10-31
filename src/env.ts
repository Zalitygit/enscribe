import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The project was MacBrain until 2026-10-31. Every setting is read as
// ENSCRIBE_<NAME> first and MACBRAIN_<NAME> second, so an existing deployment
// keeps working without touching its environment.
export function env(name: string): string | undefined {
  return process.env[`ENSCRIBE_${name}`] ?? process.env[`MACBRAIN_${name}`];
}

const LEGACY_DIR = ".macbrain";

// The data directory: ~/.enscribe, unless a ~/.macbrain from before the rename
// exists, in which case that one is still the data directory.
export function dataDir(): string {
  const legacy = join(homedir(), LEGACY_DIR);
  return existsSync(legacy) ? legacy : join(homedir(), ".enscribe");
}

// The default database file inside dataDir(); a legacy directory keeps its
// legacy filename.
export function defaultDbFile(): string {
  const dir = dataDir();
  return join(dir, dir.endsWith(LEGACY_DIR) ? "macbrain.db" : "enscribe.db");
}
