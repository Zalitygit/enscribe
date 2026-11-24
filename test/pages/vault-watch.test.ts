import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

// chokidar's `ready` (which watchVault awaits) only means its initial scan is
// done; on macOS the OS-level fs.watch stream can still be starting, and an
// event in that window is lost outright, not delayed. Measured 2026-10-31 with
// the full suite running alongside: 8/1000 writes made right after `ready` were
// never reported, 0/1000 after a 100 ms pause. That was this file's flake.
// Rather than sleep, prove the watcher is live: rewrite a probe page until the
// watcher ingests it, then start the test proper. chokidar opens one fs.watch
// per directory, each with its own startup window, so arm every directory the
// test writes into. Probe slugs differ per directory: a shared slug would trip
// the watcher's collision guard.
async function armed(dirs = ["wiki/concepts"]): Promise<void> {
  for (const [i, dir] of dirs.entries()) {
    const slug = `armed-probe-${i}`;
    let live = false;
    for (let attempt = 0; attempt < 40 && !live; attempt++) {
      writeFileSync(join(root, dir, `${slug}.md`), `---\ntitle: Armed Probe ${i}\n---\nattempt ${attempt}\n`);
      try {
        await waitFor(() => store.getPage(slug) !== undefined, 250);
        live = true;
      } catch { /* not live yet: write again */ }
    }
    if (!live) throw new Error(`watcher never went live on ${dir}`);
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
  await armed();
  writeFileSync(join(root, "wiki/concepts/new.md"), "---\ntitle: New\n---\n# New\nfresh\n");
  await waitFor(() => store.getPage("new") !== undefined);
  expect(store.resolve("New")).toBe("new");

  rmSync(join(root, "wiki/concepts/new.md"));
  await waitFor(() => store.getPage("new")?.deleted_at != null);
}, 10000);

test("watchVault survives a file with invalid frontmatter and keeps processing", async () => {
  const errors: string[] = [];
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30, onError: (p) => errors.push(p) });
  await armed();
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
  await armed(["wiki/concepts", "wiki/concepts/sub"]);

  writeFileSync(join(root, "wiki/concepts/dup.md"), "---\ntitle: First\n---\n# First\noriginal\n");
  await waitFor(() => store.getPage("dup") !== undefined);

  writeFileSync(join(root, "wiki/concepts/sub/dup.md"), "---\ntitle: Second\n---\n# Second\nclobber\n");
  // Wait for the refusal itself. A sibling file in wiki/concepts is no proof the
  // sub/ event was handled: the two directories have separate fs.watch handles,
  // and nothing orders events across them.
  await waitFor(() => errors.some((e) => /already belongs to/.test(e)));

  const page = store.getPage("dup")!;
  expect(page.source_path).toBe("wiki/concepts/dup.md");
  expect(page.body).toContain("original");
}, 10000);

test("watchVault never ingests a file created live inside a deny (Vaulted) subtree", async () => {
  // Privacy-critical: the deny-list must hold on the LIVE watch path, not just
  // the baseline sync — sensitive material must never reach the shared brain.
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30 });
  await armed();
  // A non-denied twin built the same way (new child dir, then a file in it), so
  // the test first proves a freshly created subdirectory IS watched. Separate
  // directories have no event ordering, so the twin's arrival does not prove
  // the denied file's event was considered; the extra wait bounds it instead.
  mkdirSync(join(root, "wiki/concepts/Vaulted"), { recursive: true });
  mkdirSync(join(root, "wiki/concepts/Open"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/Vaulted/secret.md"), "---\ntitle: Secret\n---\n# Secret\nsensitive\n");
  writeFileSync(join(root, "wiki/concepts/Open/visible.md"), "---\ntitle: Visible\n---\n# Visible\nfine\n");
  await waitFor(() => store.getPage("visible") !== undefined);
  await sleep(1000);
  expect(store.getPage("secret")).toBeUndefined();
}, 10000);

// The baseline sync lists the vault, then reads it. A file written after that
// listing used to fall between the sync and the watcher, which only started
// once the sync was done (and, with ignoreInitial, treats the file as already
// there): never ingested until the next full sync. The watcher now starts
// first and holds its events until the sync finishes.
test("watchVault picks up a file written while the baseline sync is running", async () => {
  writeFileSync(join(root, "wiki/concepts/seed.md"), "---\ntitle: Seed\n---\n# Seed\n");
  let wrote = false;
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const read = (abs: string) => {
    if (!wrote) {
      wrote = true;
      // syncVault reads synchronously, so this blocks. Several writes spread
      // over 600 ms, so at least one lands after the OS watch is live (see
      // armed() above for why `ready` is not enough).
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(root, "wiki/concepts/during.md"), `---\ntitle: During\n---\n# During\nwrite ${i}\n`);
        sleep(200);
      }
    }
    return readFileSync(abs, "utf8");
  };
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30, read });
  expect(wrote).toBe(true);
  await waitFor(() => store.getPage("during") !== undefined);
  expect(store.getPage("seed")).toBeDefined();
}, 10000);

// An embedder whose next call blocks until released, and which reports when a
// held call has started.
function holdable() {
  const inner = new FakeEmbedder();
  const emb = new FakeEmbedder();
  let gate: Promise<void> | null = null;
  let hit = false;
  emb.embed = async (t, k) => {
    const g = gate; gate = null;
    if (g) { hit = true; await g; }
    return inner.embed(t, k);
  };
  const holdNext = () => { let release!: () => void; hit = false; gate = new Promise<void>((r) => { release = r; }); return release; };
  return { emb, holdNext, hit: () => hit };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Batches must run one at a time. Here the first batch holds [x upsert, a
// remove] and is blocked in x's embedding when a.md is re-created. A second
// batch running alongside ingested the new a, then the first batch's stale
// remove tombstoned it, though the file exists.
test("watchVault runs batches one at a time, so a stale remove cannot undo a newer add", async () => {
  writeFileSync(join(root, "wiki/concepts/x.md"), "---\ntitle: X\n---\nx0\n");
  writeFileSync(join(root, "wiki/concepts/a.md"), "---\ntitle: A\n---\na0\n");
  const { emb, holdNext, hit } = holdable();
  svc = new PageService(db, store, emb);
  handle = await watchVault(cfg(), svc, store, { debounceMs: 200 });
  await armed();
  const release = holdNext();
  writeFileSync(join(root, "wiki/concepts/x.md"), "---\ntitle: X\n---\nx1\n");
  rmSync(join(root, "wiki/concepts/a.md"));
  await waitFor(hit);
  writeFileSync(join(root, "wiki/concepts/a.md"), "---\ntitle: A\n---\na2\n");
  await sleep(600);
  release();
  await waitFor(() => store.getPage("x")?.body.includes("x1") === true);
  await waitFor(() => store.getPage("a")?.deleted_at === null && store.getPage("a")!.body.includes("a2"));
  await sleep(400);
  expect(store.getPage("a")?.deleted_at).toBeNull();
}, 15000);

// The holding contract with real async work: events delivered while the
// baseline sync is blocked in an embedding are applied after it, with the last
// event per path winning.
test("watchVault applies add, change and add-then-remove events held during the baseline sync", async () => {
  writeFileSync(join(root, "wiki/concepts/seed.md"), "---\ntitle: Seed\n---\nv1\n");
  const { emb, holdNext, hit } = holdable();
  svc = new PageService(db, store, emb);
  const release = holdNext();
  const starting = watchVault(cfg(), svc, store, { debounceMs: 30 });
  await waitFor(hit);   // the sync is now blocked inside seed's embedding
  await sleep(250);     // past the macOS window between `ready` and a live OS watch
  writeFileSync(join(root, "wiki/concepts/seed.md"), "---\ntitle: Seed\n---\nv2\n");
  writeFileSync(join(root, "wiki/concepts/during.md"), "---\ntitle: During\n---\nadded\n");
  writeFileSync(join(root, "wiki/concepts/late.md"), "---\ntitle: Late\n---\ngone soon\n");
  await sleep(300);
  rmSync(join(root, "wiki/concepts/late.md"));
  await sleep(300);
  release();
  handle = await starting;
  await waitFor(() => store.getPage("during") !== undefined && store.getPage("seed")!.body.includes("v2"));
  expect(store.getPage("late")).toBeUndefined();
}, 15000);

test("close() finishes the batch in progress before it resolves", async () => {
  const { emb, holdNext, hit } = holdable();
  svc = new PageService(db, store, emb);
  handle = await watchVault(cfg(), svc, store, { debounceMs: 30 });
  await armed();
  const release = holdNext();
  writeFileSync(join(root, "wiki/concepts/c.md"), "---\ntitle: C\n---\nbody\n");
  await waitFor(hit);
  let closed = false;
  const closing = handle.close().then(() => { closed = true; });
  handle = null;
  await sleep(100);
  expect(closed).toBe(false);
  release();
  await closing;
  expect(store.getPage("c")?.deleted_at).toBeNull();
}, 15000);
