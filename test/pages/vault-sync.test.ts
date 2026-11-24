import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { syncVault } from "../../src/pages/vault-sync.js";
import { fsLister, type FileLister } from "../../src/pages/vault.js";
import type { VaultConfig } from "../../src/pages/vault-config.js";

let db: Database;
let store: PagesStore;
let svc: PageService;
let root: string;

const read = (abs: string) => readFileSync(abs, "utf8");
const cfg = (): VaultConfig => ({ root, include: ["wiki/concepts", "raw"], deny: ["Vaulted"] });

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
  root = mkdtempSync(join(tmpdir(), "mb-vault-"));
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  mkdirSync(join(root, "raw/Vaulted"), { recursive: true });
  writeFileSync(join(root, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\n---\n# Alpha\nsee [[Beta]]\n");
  writeFileSync(join(root, "wiki/concepts/beta.md"), "---\ntitle: Beta\n---\n# Beta\nbody\n");
  writeFileSync(join(root, "raw/log.md"), "# Log\nnothing\n");
  writeFileSync(join(root, "raw/Vaulted/secret.md"), "# Secret\nsensitive\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("syncVault ingests included files and never ingests a Vaulted subtree", async () => {
  const s = await syncVault(cfg(), svc, store, read);
  expect(store.listPages().map((p) => p.slug).sort()).toEqual(["alpha", "beta", "log"]);
  expect(store.getPage("secret")).toBeUndefined();
  expect(s.ingested).toBe(3);
  expect(s.unchanged).toBe(0);
});

test("a resolvable wikilink lands in page_links after sync", async () => {
  await syncVault(cfg(), svc, store, read);
  const links = db.prepare(`SELECT to_slug FROM page_links WHERE from_slug='alpha'`).all() as { to_slug: string }[];
  expect(links.map((l) => l.to_slug)).toEqual(["beta"]);
});

test("re-syncing unchanged content reports all-unchanged", async () => {
  await syncVault(cfg(), svc, store, read);
  const s2 = await syncVault(cfg(), svc, store, read);
  expect(s2.ingested).toBe(0);
  expect(s2.unchanged).toBe(3);
});

test("deleting a file soft-deletes its page and an inbound link becomes unresolved", async () => {
  await syncVault(cfg(), svc, store, read);
  rmSync(join(root, "wiki/concepts/beta.md"));
  const s2 = await syncVault(cfg(), svc, store, read);
  expect(s2.pruned).toBe(1);
  expect(store.getPage("beta")?.deleted_at).not.toBeNull();
  const unresolved = db.prepare(`SELECT raw_text FROM unresolved_links WHERE from_slug='alpha'`).all() as { raw_text: string }[];
  expect(unresolved.some((u) => u.raw_text === "Beta")).toBe(true);
  expect((db.prepare(`SELECT count(*) AS c FROM page_links WHERE from_slug='alpha' AND to_slug='beta'`).get() as { c: number }).c).toBe(0);
});

test("re-adding a deleted file restores its page", async () => {
  await syncVault(cfg(), svc, store, read);
  rmSync(join(root, "wiki/concepts/beta.md"));
  await syncVault(cfg(), svc, store, read);
  writeFileSync(join(root, "wiki/concepts/beta.md"), "---\ntitle: Beta\n---\n# Beta\nback\n");
  await syncVault(cfg(), svc, store, read);
  expect(store.getPage("beta")?.deleted_at).toBeNull();
  expect(store.resolve("Beta")).toBe("beta");
});

test("duplicate basenames are reported as a collision", async () => {
  writeFileSync(join(root, "raw/alpha.md"), "# Another Alpha\n"); // collides with wiki/concepts/alpha.md on slug "alpha"
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.collisions.some((c) => c.slug === "alpha" && c.paths.length === 2)).toBe(true);
});

test("a slug collision quarantines only the colliding files", async () => {
  await syncVault(cfg(), svc, store, read); // clean baseline
  writeFileSync(join(root, "raw/alpha.md"), "# Another Alpha\n"); // collides on slug "alpha"
  writeFileSync(join(root, "wiki/concepts/fresh.md"), "# Fresh\nnew page\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.collisions.some((c) => c.slug === "alpha" && c.paths.length === 2)).toBe(true);
  expect(store.getPage("fresh")?.deleted_at).toBeNull(); // innocent new file still ingested
  expect(store.getPage("alpha")?.body).toContain("see"); // contested page untouched
  expect(store.getPage("alpha")?.deleted_at).toBeNull(); // and NOT pruned
});

// One malformed YAML block used to throw out of the whole sync: the slug
// pre-scan calls parseFrontmatter on every file with no guard, and the YAML
// parser throws. That took down ingest, prune, alias rebuild and link
// resolution for the entire vault over one bad file, and `vault watch` (which
// handles parse failure per file) was strictly more robust than `vault sync`.
// Treated as a quarantine, exactly like a slug collision.

test("a malformed frontmatter file does not abort the whole sync", async () => {
  writeFileSync(join(root, "wiki/concepts/broken.md"), "---\ntitle: [unclosed\nbad: : :\n---\n# Broken\nbody\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(store.listPages().map((p) => p.slug).sort()).toEqual(["alpha", "beta", "log"]);
  expect(s.ingested).toBe(3);
});

test("a malformed frontmatter file is reported, not silently dropped", async () => {
  writeFileSync(join(root, "wiki/concepts/broken.md"), "---\ntitle: [unclosed\nbad: : :\n---\n# Broken\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.unparseable.map((u) => u.path)).toEqual(["wiki/concepts/broken.md"]);
  expect(s.unparseable[0].error).toMatch(/./); // carries the parser's own message
});

// Same reasoning as the collision quarantine: the file is present on disk, so
// its page must not be tombstoned for a fault the operator has not fixed yet.
test("a page whose file becomes unparseable is quarantined, not pruned", async () => {
  await syncVault(cfg(), svc, store, read); // alpha ingested cleanly
  writeFileSync(join(root, "wiki/concepts/alpha.md"), "---\ntitle: [unclosed\nbad: : :\n---\n# Alpha\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.unparseable.map((u) => u.path)).toEqual(["wiki/concepts/alpha.md"]);
  expect(store.getPage("alpha")?.deleted_at).toBeNull();
  expect(store.getPage("alpha")?.body).toContain("see"); // last good body stands
});

// A file whose slug changes (a frontmatter `slug:` added or dropped) is still
// present, so a path-only prune left the OLD slug live beside the new one: two
// pages for one file, the stale one an orphan forever. Seen 2026-10-22 on
// ~/hdb_etc/bin/CLAUDE.md and README.md.
test("a file whose slug changes tombstones the old slug", async () => {
  writeFileSync(join(root, "raw/readme.md"), "---\nslug: bin-toolkit\ntitle: Toolkit\n---\n# Toolkit\n");
  await syncVault(cfg(), svc, store, read);
  expect(store.getPage("bin-toolkit")?.deleted_at).toBeNull();
  writeFileSync(join(root, "raw/readme.md"), "# Toolkit\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.pruned).toBe(0); // retired by ingest itself (same source_path), so the prune finds nothing
  expect(store.getPage("bin-toolkit")?.deleted_at).not.toBeNull();
  expect(store.getPage("readme")?.deleted_at).toBeNull();
});

test("frontmatter slug overrides participate in collision detection", async () => {
  writeFileSync(join(root, "wiki/concepts/one.md"), "---\nslug: shared\ntitle: One\n---\n# One\n");
  writeFileSync(join(root, "raw/two.md"), "---\nslug: shared\ntitle: Two\n---\n# Two\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.collisions.some((c) => c.slug === "shared" && c.paths.length === 2)).toBe(true);
  expect(store.getPage("shared")).toBeUndefined(); // neither claimant wins the slug
  expect(store.getPage("alpha")?.deleted_at).toBeNull(); // the rest of the vault still syncs
});

test("an alias claimed by two live pages resolves to neither and is reported", async () => {
  writeFileSync(join(root, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\naliases: [nick]\n---\n# Alpha\n");
  writeFileSync(join(root, "wiki/concepts/gamma.md"), "---\ntitle: Gamma\naliases: [nick]\n---\n# Gamma\n");
  const s = await syncVault(cfg(), svc, store, read);
  expect(s.ambiguousAliases.some((a) => a.alias === "nick" && a.slugs.sort().join() === "alpha,gamma")).toBe(true);
  expect(store.resolve("nick")).toBeNull();
  expect(store.resolve("Alpha")).toBe("alpha"); // unambiguous aliases still work
});

test("an unreadable include dir blocks the prune instead of tombstoning its pages", async () => {
  await syncVault(cfg(), svc, store, read); // baseline: alpha, beta, log
  // `raw` becomes unreadable (unmounted volume, wrong root, bad permissions).
  const failing: FileLister = (base) => {
    if (base.endsWith("raw")) throw new Error("ENOENT");
    return fsLister(base);
  };
  const s = await syncVault(cfg(), svc, store, read, failing);
  expect(s.failedDirs).toEqual(["raw"]);
  expect(s.pruneSkipped).toBe("failed-dirs");
  expect(s.pruned).toBe(0);
  expect(store.getPage("log")?.deleted_at).toBeNull();
});

// A walk that ENUMERATED CLEANLY and found nothing is the truth, not a broken
// disk. Every genuine breakage — unmounted root, typo'd config, bad permissions —
// makes readdirSync throw, which lands the dir in failedDirs and is caught by the
// test above. This case is a user who deleted their last page, and refusing it
// left the page live and searchable after deletion while failing the sync
// forever: on a scheduled sync, a unit that fails every run and never recovers.
test("an empty walk that enumerated cleanly does prune", async () => {
  await syncVault(cfg(), svc, store, read);
  const empty: FileLister = () => [];
  const s = await syncVault(cfg(), svc, store, read, empty);
  expect(s.pruneSkipped).toBeNull();
  expect(s.failedDirs).toEqual([]);
  expect(s.pruned).toBe(3);
  expect(store.listPages().every((p) => p.deleted_at !== null)).toBe(true);
});

// The prune is a soft delete against a git-canonical vault, so an emptied index
// is recoverable by the next successful sync. Restoring the files brings the
// pages back rather than leaving them tombstoned.
test("a prune from an empty walk is reversible on the next sync", async () => {
  await syncVault(cfg(), svc, store, read);
  await syncVault(cfg(), svc, store, read, () => []);
  expect(store.listPages().every((p) => p.deleted_at !== null)).toBe(true);
  const s = await syncVault(cfg(), svc, store, read); // files are still on disk
  expect(s.pruneSkipped).toBeNull();
  expect(store.listPages().filter((p) => p.deleted_at === null).map((p) => p.slug).sort())
    .toEqual(["alpha", "beta", "log"]);
});

test("syncVault stamps authored_at from the injected git-commit map", async () => {
  const commitTimes = () => new Map([["raw/log.md", "2000-01-01T00:00:00+00:00"]]);
  const s = await syncVault(cfg(), svc, store, read, fsLister, commitTimes);
  expect(s.authoredStamped).toBe(1);
  // log.md was authored long ago, so it drops out of a recent window despite a
  // fresh ingest updated_at; alpha/beta (unstamped) stay recent by fallback.
  const recent = store.recentPages(7).map((p) => p.slug).sort();
  expect(recent).toEqual(["alpha", "beta"]);
});

test("alias ownership heals when the second claimant drops the alias", async () => {
  writeFileSync(join(root, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\naliases: [nick]\n---\n# Alpha\n");
  await syncVault(cfg(), svc, store, read);
  expect(store.resolve("nick")).toBe("alpha");

  writeFileSync(join(root, "wiki/concepts/beta.md"), "---\ntitle: Beta\naliases: [nick]\n---\n# Beta\n");
  await syncVault(cfg(), svc, store, read);
  expect(store.resolve("nick")).toBeNull(); // ambiguous -> nobody

  writeFileSync(join(root, "wiki/concepts/beta.md"), "---\ntitle: Beta\n---\n# Beta\n");
  await syncVault(cfg(), svc, store, read);
  expect(store.resolve("nick")).toBe("alpha"); // heals even though alpha.md never changed
});

// Freshness: nothing recorded whether the scheduled sync is actually running,
// so a dead path unit or cron looked exactly like a quiet vault. syncVault
// stamps a completed run; doctor (pageHealth) reports it.
test("a completed sync stamps the last-sync time, which pageHealth reports", async () => {
  expect(store.pageHealth().lastVaultSync).toBeNull();
  await syncVault(cfg(), svc, store, read, fsLister, () => new Map());
  const stamped = store.pageHealth().lastVaultSync;
  expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

// A sync that prunes a vanished file must also cancel an ingest of that file
// still in flight (serve's put_page, a watcher), or its late embedding revives it.
test("pruning a vanished file cancels an in-flight ingest of it", async () => {
  await syncVault(cfg(), svc, store, read);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const inner = new FakeEmbedder();
  const held = new FakeEmbedder();
  held.embed = async (t, k) => { await gate; return inner.embed(t, k); };
  const pending = new PageService(db, store, held).ingest("wiki/concepts/beta.md", "---\ntitle: Beta\n---\n# Beta\nedited\n");
  rmSync(join(root, "wiki/concepts/beta.md"));
  expect((await syncVault(cfg(), svc, store, read)).pruned).toBe(1);
  release();
  await pending;
  expect(store.getPage("beta")?.deleted_at).not.toBeNull();
});
