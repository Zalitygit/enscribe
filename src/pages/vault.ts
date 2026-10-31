import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { VaultConfig } from "./vault-config.js";

export interface VaultFile {
  absPath: string;
  relPath: string;
}

// Yields every file path (absolute) under `dir`, recursively. Throws for a
// missing dir (walkVault catches per include dir).
export type FileLister = (dir: string) => string[];

export interface WalkResult {
  files: VaultFile[];
  // Include dirs that could not be enumerated. A non-empty list means `files`
  // is an incomplete view of the vault and cannot justify a deletion.
  failedDirs: string[];
}

// Enumerate .md files under each include dir, excluding any whose vault-relative
// path contains a deny segment (case-insensitive path-component match). `lister`
// is injected so the walk is pure and testable.
export function walkVault(config: VaultConfig, lister: FileLister): WalkResult {
  const denies = new Set(config.deny.map((d) => d.toLowerCase()));
  const out: VaultFile[] = [];
  const failedDirs: string[] = [];
  const seen = new Set<string>();
  for (const rel of config.include) {
    const base = join(config.root, rel);
    let files: string[];
    try {
      files = lister(base);
    } catch {
      // Could not enumerate: missing dir, unmounted volume, permissions. The
      // caller MUST NOT read the file list as ground truth for deletions, so
      // report it rather than swallowing it.
      failedDirs.push(rel);
      continue;
    }
    for (const abs of files) {
      if (!abs.endsWith(".md")) continue;
      const relPath = relative(config.root, abs);
      const denied = relPath.split(sep).some((s) => denies.has(s.toLowerCase()));
      if (denied || seen.has(relPath)) continue;
      seen.add(relPath);
      out.push({ absPath: abs, relPath });
    }
  }
  return { files: out, failedDirs };
}

// Production recursive lister over the real filesystem.
export function fsLister(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...fsLister(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
