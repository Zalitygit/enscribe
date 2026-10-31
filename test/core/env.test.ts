import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir, env } from "../../src/env.js";
import { resolveDbPath } from "../../src/config.js";

// The project was renamed MacBrain -> enscribe on 2026-10-31. Every existing
// deployment sets MACBRAIN_* variables and keeps its data in ~/.macbrain, and
// none of them may notice the rename.

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "enscribe-env-"));
  process.env.HOME = home;
  for (const k of Object.keys(process.env)) if (/^(ENSCRIBE|MACBRAIN)_/.test(k)) delete process.env[k];
});
// Restore in place: replacing process.env with a plain object detaches it from
// the real environment, and os.homedir() stops seeing later HOME assignments.
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

test("ENSCRIBE_ wins over MACBRAIN_", () => {
  process.env.MACBRAIN_PORT = "1";
  process.env.ENSCRIBE_PORT = "2";
  expect(env("PORT")).toBe("2");
});

test("MACBRAIN_ is still honored when ENSCRIBE_ is unset", () => {
  process.env.MACBRAIN_DB = "/srv/old.db";
  expect(env("DB")).toBe("/srv/old.db");
  expect(resolveDbPath()).toBe("/srv/old.db");
});

test("a fresh install defaults to ~/.enscribe/enscribe.db", () => {
  expect(dataDir()).toBe(join(home, ".enscribe"));
  expect(resolveDbPath()).toBe(join(home, ".enscribe", "enscribe.db"));
});

test("an existing ~/.macbrain keeps winning, with its old db filename", () => {
  mkdirSync(join(home, ".macbrain"));
  expect(dataDir()).toBe(join(home, ".macbrain"));
  expect(resolveDbPath()).toBe(join(home, ".macbrain", "macbrain.db"));
});
