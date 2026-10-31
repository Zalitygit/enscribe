import { walkVault, fsLister, type FileLister } from "../vault.js";
import type { VaultConfig } from "../vault-config.js";
import type { VaultSource } from "./types.js";

// Production VaultSource: the same walk `vault sync` uses, so the health report
// measures exactly the file set that ingest considers, deny-list included.
export function vaultSource(config: VaultConfig, lister: FileLister = fsLister): VaultSource {
  return {
    list() {
      const { files, failedDirs } = walkVault(config, lister);
      return { sourcePaths: files.map((f) => f.relPath), failedDirs };
    },
  };
}
