import { beforeEach, expect, test } from "vitest";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";

let db: Database;
let store: PagesStore;
let svc: PageService;

beforeEach(() => {
  db = openDb(":memory:");
  store = new PagesStore(db);
  svc = new PageService(db, store, new FakeEmbedder());
});

const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

test("purgeTombstoned hard-deletes tombstoned pages and their aliases; body is gone from the DB", async () => {
  await svc.ingest("wiki/concepts/doomed.md", "---\ntitle: Doomed Page\naliases: [doom]\n---\n# Doomed\nsensitive body\n");
  await svc.ingest("wiki/concepts/keeper.md", "---\ntitle: Keeper\n---\n# Keeper\nstays\n");
  store.softDelete("doomed");

  // Precondition: the tombstone still holds the canonical body and aliases.
  expect(count(`SELECT count(*) n FROM pages WHERE slug='doomed' AND body LIKE '%sensitive%'`)).toBe(1);
  expect(count(`SELECT count(*) n FROM page_aliases WHERE slug='doomed'`)).toBeGreaterThan(0);

  const purged = store.purgeTombstoned();
  expect(purged).toBe(1);

  expect(count(`SELECT count(*) n FROM pages WHERE slug='doomed'`)).toBe(0);
  expect(count(`SELECT count(*) n FROM page_aliases WHERE slug='doomed'`)).toBe(0);
  // The living page is untouched and still resolves.
  expect(store.getPage("keeper")?.body).toContain("stays");
  expect(store.resolve("Keeper")).toBe("keeper");
});

test("purgeTombstoned is a no-op when nothing is tombstoned", async () => {
  await svc.ingest("wiki/concepts/alive.md", "---\ntitle: Alive\n---\n# Alive\n");
  expect(store.purgeTombstoned()).toBe(0);
  expect(store.getPage("alive")).toBeTruthy();
});
