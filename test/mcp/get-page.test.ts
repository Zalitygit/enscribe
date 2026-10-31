import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

const textOf = (r: any) => JSON.parse(r.content[0].text);

// A 2026-09-09 audit of fleet transcripts found every one of the 8 get_page
// reads of the 101 KB `macbrain` page failing at the harness's tool-output
// cap, while the same page ranked top-3 in 8 searches: the brain kept pointing
// at a page nobody could open. get_page therefore caps the body server-side and
// hands back an outline, and a caller can ask for one section.
const SECTIONED = "# Doc\nintro\n\n## Alpha\na\n### Alpha child\nac\n## Beta\nb\n";
const HUGE = "# Big\n\n## One\n" + "x".repeat(40_000) + "\n## Two\n" + "y".repeat(40_000) + "\n";

async function client() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/sectioned.md", "---\ntitle: Sectioned\n---\n" + SECTIONED);
  await service.ingest("wiki/concepts/huge.md", "---\ntitle: Huge\n---\n" + HUGE);
  const server = buildServer({ store, search, pages, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

test("get_page of a page under the cap is the plain row, no truncation fields", async () => {
  const r = textOf(await (await client()).callTool({ name: "get_page", arguments: { slug: "sectioned" } }));
  expect(r.title).toBe("Sectioned");
  expect(r.body).toBe(SECTIONED);
  expect(r).not.toHaveProperty("truncated");
  expect(r).not.toHaveProperty("sections");
});

test("get_page section returns that heading through the next of equal or higher level, case-insensitively", async () => {
  const r = textOf(await (await client()).callTool({ name: "get_page", arguments: { slug: "sectioned", section: "alpha" } }));
  expect(r).toEqual({ slug: "sectioned", title: "Sectioned", section: "Alpha", body: "## Alpha\na\n### Alpha child\nac\n" });
});

test("get_page section miss returns not_found with the outline", async () => {
  const r = textOf(await (await client()).callTool({ name: "get_page", arguments: { slug: "sectioned", section: "Gamma" } }));
  expect(r.error).toBe("not_found");
  expect(r.slug).toBe("sectioned");
  expect(r.sections).toEqual([
    { heading: "Doc", level: 1, chars: SECTIONED.length },
    { heading: "Alpha", level: 2, chars: "## Alpha\na\n### Alpha child\nac\n".length },
    { heading: "Alpha child", level: 3, chars: "### Alpha child\nac\n".length },
    { heading: "Beta", level: 2, chars: "## Beta\nb\n".length },
  ]);
});

test("get_page of an over-cap page truncates the body and adds an outline", async () => {
  const r = textOf(await (await client()).callTool({ name: "get_page", arguments: { slug: "huge" } }));
  expect(r.body).toHaveLength(60_000);
  expect(r.body).toBe(HUGE.slice(0, 60_000));
  expect(r.truncated).toBe(true);
  expect(r.total_chars).toBe(HUGE.length);
  expect(r.sections.map((s: any) => s.heading)).toEqual(["Big", "One", "Two"]);
});

test("get_page max_chars overrides the cap", async () => {
  const r = textOf(await (await client()).callTool({ name: "get_page", arguments: { slug: "sectioned", max_chars: 10 } }));
  expect(r.body).toBe(SECTIONED.slice(0, 10));
  expect(r.truncated).toBe(true);
  expect(r.total_chars).toBe(SECTIONED.length);
});

// The 2026-09-09 audit counted six get_page calls that returned a bare null
// for a guessed slug, two of them a title typed where a slug was wanted. A
// miss now either resolves through the alias/slugify tiers and serves the page,
// or says not_found with the nearest live slugs.
async function clientWithAliases() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/domain-portfolio.md", "---\ntitle: Domain Portfolio\naliases:\n  - domains\n---\n# Domain Portfolio\nbody\n");
  await service.ingest("wiki/concepts/fleet-package-inventory.md", "---\ntitle: Fleet package inventory\n---\n# Fleet package inventory\nbody\n");
  await service.ingest("wiki/concepts/fleet-driver.md", "---\ntitle: Fleet driver\n---\n# Fleet driver\nbody\n");
  await service.ingest("wiki/concepts/secret.md", "---\ntitle: Secret\n---\n# Secret\nsensitive body\n");
  pages.softDelete("secret");
  const server = buildServer({ store, search, pages, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

test("get_page with a title or alias serves the page and names what it resolved from", async () => {
  const c = await clientWithAliases();
  const byTitle = textOf(await c.callTool({ name: "get_page", arguments: { slug: "Domain Portfolio" } }));
  expect(byTitle.slug).toBe("domain-portfolio");
  expect(byTitle.resolved_from).toBe("Domain Portfolio");
  expect(byTitle.body).toContain("body");
  const byAlias = textOf(await c.callTool({ name: "get_page", arguments: { slug: "domains" } }));
  expect(byAlias.slug).toBe("domain-portfolio");
  expect(byAlias.resolved_from).toBe("domains");
  const exact = textOf(await c.callTool({ name: "get_page", arguments: { slug: "domain-portfolio" } }));
  expect(exact).not.toHaveProperty("resolved_from");
});

test("get_page miss returns not_found with the nearest live slugs by token overlap", async () => {
  const c = await clientWithAliases();
  const r = textOf(await c.callTool({ name: "get_page", arguments: { slug: "fleet-packages" } }));
  expect(r.error).toBe("not_found");
  expect(r.slug).toBe("fleet-packages");
  // Both fleet pages share one token; the shorter slug breaks the tie.
  expect(r.suggestions).toEqual(["fleet-driver", "fleet-package-inventory"]);
  const none = textOf(await c.callTool({ name: "get_page", arguments: { slug: "zzqq" } }));
  expect(none).toEqual({ error: "not_found", slug: "zzqq", suggestions: [] });
});

test("get_page of a tombstoned page is not_found and never suggests the tombstone", async () => {
  const c = await clientWithAliases();
  const r = textOf(await c.callTool({ name: "get_page", arguments: { slug: "secret" } }));
  expect(r.error).toBe("not_found");
  expect(JSON.stringify(r)).not.toContain("sensitive");
  expect(r.suggestions).not.toContain("secret");
});
