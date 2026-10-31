import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { watchVault, type WatchHandle } from "../../src/pages/vault-watch.js";
import type { VaultConfig } from "../../src/pages/vault-config.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let root: string;
let handle: WatchHandle | null;

const cfg = (): VaultConfig => ({ root, include: ["wiki/concepts"], deny: ["Vaulted"] });

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  root = mkdtempSync(join(tmpdir(), "mb-watch-"));
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  handle = null;
});
afterEach(async () => {
  if (handle) await handle.close();
  rmSync(root, { recursive: true, force: true });
});

test("watchVault ingests a new file and soft-deletes it on removal", async () => {
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30 });
  writeFileSync(join(root, "wiki/concepts/new.md"), "---\ntitle: New\n---\n# New\nfresh\n");
  await waitFor(() => store.getPage("new") !== undefined);
  expect(store.resolve("New")).toBe("new");

  rmSync(join(root, "wiki/concepts/new.md"));
  await waitFor(() => store.getPage("new")?.deleted_at != null);
}, 10000);

test("watchVault survives a file with invalid frontmatter and keeps processing", async () => {
  const errors: string[] = [];
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30, onError: (p) => errors.push(p) });
  writeFileSync(join(root, "wiki/concepts/bad.md"), "---\nfoo: [unclosed\n---\n# Bad\n");
  writeFileSync(join(root, "wiki/concepts/good.md"), "---\ntitle: Good\n---\n# Good\nok\n");
  await waitFor(() => store.getPage("good") !== undefined);
  expect(store.resolve("Good")).toBe("good");   // watcher survived and processed the good file
  expect(errors.length).toBeGreaterThan(0);      // the bad file was reported, not fatal
}, 10000);

// `vault sync` quarantines two files claiming one slug, but the watcher ingests
// each event blind. Without the same gate, dropping a second file with a
// colliding basename silently clobbers the live page's body and repoints its
// source_path — and the next sync then sees the collision and quarantines BOTH.
test("watchVault refuses a live file whose slug another live file already owns", async () => {
  mkdirSync(join(root, "wiki/concepts/sub"), { recursive: true });
  const errors: string[] = [];
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30, onError: (p, e) => errors.push(`${p}: ${e.message}`) });

  writeFileSync(join(root, "wiki/concepts/dup.md"), "---\ntitle: First\n---\n# First\noriginal\n");
  await waitFor(() => store.getPage("dup") !== undefined);

  writeFileSync(join(root, "wiki/concepts/sub/dup.md"), "---\ntitle: Second\n---\n# Second\nclobber\n");
  writeFileSync(join(root, "wiki/concepts/after.md"), "---\ntitle: After\n---\n# After\nfine\n");
  // Once the sibling lands, the colliding file's event has been seen too.
  await waitFor(() => store.getPage("after") !== undefined);

  const page = store.getPage("dup")!;
  expect(page.source_path).toBe("wiki/concepts/dup.md");
  expect(page.body).toContain("original");
  expect(errors.some((e) => /already belongs to/.test(e))).toBe(true);
}, 10000);

test("watchVault never ingests a file created live inside a deny (Vaulted) subtree", async () => {
  // Privacy-critical: the deny-list must hold on the LIVE watch path, not just
  // the baseline sync — sensitive material must never reach the shared brain.
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30 });
  mkdirSync(join(root, "wiki/concepts/Vaulted"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/Vaulted/secret.md"), "---\ntitle: Secret\n---\n# Secret\nsensitive\n");
  writeFileSync(join(root, "wiki/concepts/ok.md"), "---\ntitle: Ok\n---\n# Ok\nfine\n");
  // Once the sibling non-denied file is processed, any event for the denied file
  // would have been seen too — so its absence proves it was never ingested.
  await waitFor(() => store.getPage("ok") !== undefined);
  expect(store.getPage("secret")).toBeUndefined();
}, 10000);
