import { expect, test } from "vitest";
import { walkVault, type FileLister } from "../../src/pages/vault.js";
import type { VaultConfig } from "../../src/pages/vault-config.js";

test("walkVault returns only .md under include dirs, excluding deny subtrees", () => {
  const cfg: VaultConfig = { root: "/v", include: ["wiki", "raw"], deny: ["Vaulted"] };
  const files: Record<string, string[]> = {
    "/v/wiki": ["/v/wiki/a.md", "/v/wiki/note.txt", "/v/wiki/Vaulted/secret.md"],
    "/v/raw": ["/v/raw/b.md", "/v/raw/sub/c.md"],
  };
  const lister: FileLister = (dir) => {
    if (!(dir in files)) throw new Error("ENOENT");
    return files[dir];
  };
  const result = walkVault(cfg, lister).files.map((f) => f.relPath).sort();
  expect(result).toEqual(["raw/b.md", "raw/sub/c.md", "wiki/a.md"]);
});

test("walkVault skips a missing include dir and reports it as failed", () => {
  const cfg: VaultConfig = { root: "/v", include: ["exists", "missing"], deny: [] };
  const lister: FileLister = (dir) => {
    if (dir === "/v/exists") return ["/v/exists/a.md"];
    throw new Error("ENOENT");
  };
  const result = walkVault(cfg, lister);
  expect(result.files.map((f) => f.relPath)).toEqual(["exists/a.md"]);
  expect(result.failedDirs).toEqual(["missing"]);
});

test("walkVault deny match is case-insensitive on a path component", () => {
  const cfg: VaultConfig = { root: "/v", include: ["raw"], deny: ["Vaulted"] };
  const lister: FileLister = () => ["/v/raw/ok.md", "/v/raw/Vaulted/x.md"];
  expect(walkVault(cfg, lister).files.map((f) => f.relPath)).toEqual(["raw/ok.md"]);
});
