import { expect, test } from "vitest";
import { vaultSource } from "../../../src/pages/generators/vault-source.js";
import type { VaultConfig } from "../../../src/pages/vault-config.js";

const config: VaultConfig = {
  root: "/vault",
  include: ["wiki/concepts", "raw"],
  deny: ["health"],
};

test("vaultSource lists vault-relative paths of included .md files", () => {
  const lister = (dir: string) =>
    dir === "/vault/wiki/concepts"
      ? ["/vault/wiki/concepts/a.md", "/vault/wiki/concepts/notes.txt"]
      : ["/vault/raw/b.md"];
  const src = vaultSource(config, lister);
  expect(src.list()).toEqual({
    sourcePaths: ["wiki/concepts/a.md", "raw/b.md"],
    failedDirs: [],
  });
});

test("vaultSource excludes denied path segments", () => {
  const lister = (dir: string) =>
    dir === "/vault/wiki/concepts"
      ? ["/vault/wiki/concepts/a.md", "/vault/wiki/concepts/health/secret.md"]
      : [];
  expect(vaultSource(config, lister).list().sourcePaths).toEqual(["wiki/concepts/a.md"]);
});

test("vaultSource reports an include dir it could not enumerate", () => {
  const lister = (dir: string) => {
    if (dir === "/vault/raw") throw new Error("ENOENT");
    return ["/vault/wiki/concepts/a.md"];
  };
  const r = vaultSource(config, lister).list();
  expect(r.sourcePaths).toEqual(["wiki/concepts/a.md"]);
  expect(r.failedDirs).toEqual(["raw"]);
});
