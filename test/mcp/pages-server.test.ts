import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

const textOf = (r: any) => JSON.parse(r.content[0].text);

async function pagesClient(scopes?: string[]) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/alpha.md", "---\ntitle: Alpha\naliases:\n  - al\n---\n# Alpha\nsee [[Beta]]\n");
  await service.ingest("wiki/concepts/beta.md", "---\ntitle: Beta\n---\n# Beta\nbody token zzqqx\n");
  // Alpha links to Beta before Beta exists (forward reference); resolveAll()
  // is the documented second pass that heals it (see test/pages/service.test.ts).
  await service.resolveAll();
  const rec = store.add({ type: "note", subject: "Rec", content: "record token zzqqx" });
  await search.index(rec);
  const server = buildServer({ store, search, pages, service }, scopes ? new Set(scopes) : undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, recId: rec.id };
}

test("page read tools register alongside the record tools", async () => {
  const { client } = await pagesClient();
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["search", "get_page", "list_pages", "get_links", "get_backlinks", "resolve_slug"]) {
    expect(names).toContain(t);
  }
  expect(names).toContain("search_memory");
});

test("get_page and resolve_slug round-trip a page", async () => {
  const { client } = await pagesClient();
  expect(textOf(await client.callTool({ name: "resolve_slug", arguments: { text: "Alpha" } })).slug).toBe("alpha");
  expect(textOf(await client.callTool({ name: "get_page", arguments: { slug: "alpha" } })).title).toBe("Alpha");
});

test("get_links and get_backlinks expose the wikilink graph", async () => {
  const { client } = await pagesClient();
  const links = textOf(await client.callTool({ name: "get_links", arguments: { slug: "alpha" } }));
  expect(links.links.map((l: any) => l.to_slug)).toEqual(["beta"]);
  const back = textOf(await client.callTool({ name: "get_backlinks", arguments: { slug: "beta" } }));
  expect(back.backlinks.map((l: any) => l.from_slug)).toEqual(["alpha"]);
});

// Typed edges: `type` narrows get_links/get_backlinks to one link_type.
async function typedClient() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/hub.md", "# hub\nthe hub\n");
  await service.ingest("wiki/concepts/caddy.md", "# caddy\nproxy\n");
  await service.ingest("wiki/concepts/auction.md",
    "# auction\nruns-on:: [[hub]]\ndepends-on:: [[caddy]]\nSee [[hub]] and [[gone]].\n");
  const server = buildServer({ store, search, pages, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("get_links with a type returns only that type, and no unresolved targets", async () => {
  const client = await typedClient();
  const r = textOf(await client.callTool({ name: "get_links", arguments: { slug: "auction", type: "runs-on" } }));
  expect(r).toEqual({ links: [{ to_slug: "hub", link_type: "runs-on", context: null }], unresolved: [] });
});

test("get_backlinks with a type returns only that type", async () => {
  const client = await typedClient();
  const r = textOf(await client.callTool({ name: "get_backlinks", arguments: { slug: "hub", type: "runs-on" } }));
  expect(r.backlinks).toEqual([{ from_slug: "auction", link_type: "runs-on", context: null }]);
  const plain = textOf(await client.callTool({ name: "get_backlinks", arguments: { slug: "hub", type: "wikilink" } }));
  expect(plain.backlinks.map((l: any) => l.link_type)).toEqual(["wikilink"]);
});

test("get_links without a type is unchanged: every link plus unresolved", async () => {
  const client = await typedClient();
  const r = textOf(await client.callTool({ name: "get_links", arguments: { slug: "auction" } }));
  expect(r.links.map((l: any) => l.link_type).sort()).toEqual(["depends-on", "runs-on", "wikilink"]);
  expect(r.unresolved).toEqual([{ raw_text: "gone" }]);
});

test("get_links rejects a type outside the vocabulary", async () => {
  const client = await typedClient();
  const r: any = await client.callTool({ name: "get_links", arguments: { slug: "auction", type: "hosted-on" } });
  expect(r.isError).toBe(true);
});

test("unified search returns both a page hit and a record hit", async () => {
  const { client, recId } = await pagesClient();
  const res = textOf(await client.callTool({ name: "search", arguments: { query: "token zzqqx" } }));
  expect(res.hits.some((h: any) => h.kind === "page")).toBe(true);
  expect(res.hits.some((h: any) => h.kind === "record" && h.record.id === recId)).toBe(true);
});

test("no page tools without pages deps", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new FakeEmbedder());
  const server = buildServer({ store, search });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).not.toContain("get_page");
  expect(names).toContain("search_memory");
});

test("scope enforcement: pages.read allows get_page; a memory-only client doesn't get it", async () => {
  const ok = (await (await pagesClient(["pages.read"])).client.callTool({ name: "get_page", arguments: { slug: "alpha" } })) as any;
  expect(ok.isError ?? false).toBe(false);
  const memOnly = (await pagesClient(["memory.read"])).client;
  expect((await memOnly.listTools()).tools.map((t) => t.name)).not.toContain("get_page");
  const denied = (await memOnly.callTool({ name: "get_page", arguments: { slug: "alpha" } })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");
});

test("doctor reports pages health", async () => {
  const { client } = await pagesClient();
  const h = textOf(await client.callTool({ name: "doctor", arguments: {} }));
  expect(h.pages).toBeGreaterThanOrEqual(2);
  expect(typeof h.unresolved).toBe("number");
  expect(Array.isArray(h.orphanSample)).toBe(true);
});

test("put_page tool writes + commits + ingests via MCP (real git)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-mcp-put-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "seed\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);

  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  const vaultConfig = { root, include: ["wiki/concepts"], deny: ["Vaulted"] };
  const server = buildServer({ store, search, pages, service, vaultConfig });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const r = textOf(await client.callTool({ name: "put_page", arguments: { path: "wiki/concepts/via.md", content: "---\ntitle: Via\n---\n# Via\nx\n" } }));
  expect(r.ok).toBe(true);
  expect(r.slug).toBe("via");
  expect(textOf(await client.callTool({ name: "get_page", arguments: { slug: "via" } })).title).toBe("Via");
  rmSync(root, { recursive: true, force: true });
});

test("put_page is absent without vaultConfig and absent without pages.write", async () => {
  // Absent without vaultConfig (pagesClient builds without one).
  const { client } = await pagesClient();
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("put_page");

  // Unregistered for a pages.read-only client even with a vaultConfig.
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  const server = buildServer({ store, search, pages, service, vaultConfig: { root: "/tmp/nope", include: ["wiki"], deny: [] } }, new Set(["pages.read"]));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client2 = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client2.connect(b)]);
  expect((await client2.listTools()).tools.map((t) => t.name)).not.toContain("put_page");
  const denied = (await client2.callTool({ name: "put_page", arguments: { path: "wiki/x.md", content: "y" } })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");
});

test("edit_page tool edits + commits via MCP (real git)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-mcp-edit-"));
  const remote = mkdtempSync(join(tmpdir(), "mb-mcp-edit-remote-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare"], { cwd: remote });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "seed\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "seed"]);
  g(["remote", "add", "origin", remote]); g(["push", "-q", "-u", "origin", "main"]);

  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  const vaultConfig = { root, include: ["wiki/concepts"], deny: ["Vaulted"] };
  const server = buildServer({ store, search, pages, service, vaultConfig });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const put = textOf(await client.callTool({ name: "put_page", arguments: { path: "wiki/concepts/ed.md", content: "---\ntitle: Ed\n---\n# Ed\nold line\n" } }));
  expect(put.ok).toBe(true);
  const r = textOf(await client.callTool({ name: "edit_page", arguments: { page: "ed", old: "old line", new: "new line" } }));
  expect(r.ok).toBe(true);
  expect(r.slug).toBe("ed");
  expect(readFileSync(join(root, "wiki/concepts/ed.md"), "utf8")).toContain("new line");
  expect(g(["log", "-1", "--format=%s"]).trim()).toBe("enscribe: edit ed");
  const miss = textOf(await client.callTool({ name: "edit_page", arguments: { page: "ed", old: "absent text", new: "x" } }));
  expect(miss.ok).toBe(false);
  expect(miss.occurrences).toBe(0);
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

test("edit_page is absent without vaultConfig and absent without pages.write", async () => {
  const { client } = await pagesClient();
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("edit_page");

  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  const server = buildServer({ store, search, pages, service, vaultConfig: { root: "/tmp/nope", include: ["wiki"], deny: [] } }, new Set(["pages.read"]));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client2 = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client2.connect(b)]);
  expect((await client2.listTools()).tools.map((t) => t.name)).not.toContain("edit_page");
  const denied = (await client2.callTool({ name: "edit_page", arguments: { page: "x", old: "a", new: "b" } })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");
});

test("get_page of a tombstoned page is not_found and never returns its body", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/secret.md", "---\ntitle: Secret\n---\n# Secret\nsensitive body\n");
  pages.softDelete("secret");
  const server = buildServer({ store, search, pages, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = textOf(await client.callTool({ name: "get_page", arguments: { slug: "secret" } }));
  expect(r.error).toBe("not_found");
  expect(JSON.stringify(r)).not.toContain("sensitive");
});

test("list_pages ignores a non-positive limit (returns all pages)", async () => {
  const { client } = await pagesClient(); // seeds exactly 2 pages: alpha, beta
  const r = textOf(await client.callTool({ name: "list_pages", arguments: { limit: -1 } }));
  expect(r.pages.length).toBe(2);
});

test("orphans and recent_pages tools serve the gardener data", async () => {
  const { client } = await pagesClient();
  const orphans = textOf(await client.callTool({ name: "orphans", arguments: {} }));
  expect(Array.isArray(orphans.orphans)).toBe(true);
  const recent = textOf(await client.callTool({ name: "recent_pages", arguments: { days: 30 } }));
  expect(recent.pages.some((p: any) => p.slug === "alpha")).toBe(true);
});

test("orphans excludes a generator-owned page but includes an authored orphan", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  pages.upsertPage({ slug: "lonely", title: "L", frontmatter: {}, body: "x", source_path: "wiki/concepts/lonely.md" });
  pages.upsertPage({ slug: "gen-x", title: "GX", frontmatter: {}, body: "y", generator: "g" });
  const server = buildServer({ store, search, pages, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = textOf(await client.callTool({ name: "orphans", arguments: {} }));
  expect(r.orphans).toEqual(["lonely"]);
});

test("recent_pages requires pages.read", async () => {
  const denied = (await (await pagesClient(["memory.read"])).client.callTool({ name: "recent_pages", arguments: {} })) as any;
  expect(denied.isError).toBe(true);
});

test("search reports confidence alongside the hits, and page hits carry their kind", async () => {
  const { client } = await pagesClient();
  const r = textOf(await client.callTool({ name: "search", arguments: { query: "body token zzqqx" } }));
  expect(typeof r.confident).toBe("boolean");
  const page = r.hits.find((h: any) => h.kind === "page" && h.slug === "beta");
  expect(page.page_kind).toBe("authored");
});
