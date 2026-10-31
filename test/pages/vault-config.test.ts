import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadVaultConfig } from "../../src/pages/vault-config.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mb-cfg-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("loadVaultConfig returns defaults when the file is absent", () => {
  const cfg = loadVaultConfig(join(tmp(), "nope.json"));
  expect(cfg.deny).toContain("Vaulted");
  expect(cfg.include).toContain("raw");
  expect(cfg.include).toContain("wiki/concepts");
  expect(cfg.root).toContain("etc");
});

// An ABSENT config is the documented "defaults are fine" path, so DEFAULTS.deny
// is the denylist that actually runs on a fresh box, a restore, or a second
// device. It used to be only ["Vaulted"], which is how health/genome pages
// were once ingested and became shared-readable. These segments are the privacy
// floor: they must hold with no config file at all.
test("DEFAULTS.deny carries the privacy floor, not just Vaulted", () => {
  const cfg = loadVaultConfig(join(tmp(), "nope.json"));
  for (const seg of ["private", "health", "genome", "insurance", "finance"]) {
    expect(cfg.deny).toContain(seg);
  }
});

test("loadVaultConfig merges a partial file over defaults and expands ~ in root", () => {
  const p = join(tmp(), "vault.json");
  writeFileSync(p, JSON.stringify({ root: "~/myvault", deny: ["Secret"] }));
  const cfg = loadVaultConfig(p);
  expect(cfg.root).toBe(join(homedir(), "myvault"));
  expect(cfg.deny).toEqual(["Secret"]);
  expect(cfg.include).toContain("wiki/concepts");
});

// A present-but-unparseable file must NOT silently downgrade to DEFAULTS.deny
// (only ["Vaulted"]) — that would run the vault walk with a much weaker
// denylist than the operator configured, with no signal that it happened.
test("loadVaultConfig throws on a malformed (unparseable) file instead of silently falling back to defaults", () => {
  const p = join(tmp(), "vault.json");
  writeFileSync(p, "{ not valid json");
  expect(() => loadVaultConfig(p)).toThrow();
});
