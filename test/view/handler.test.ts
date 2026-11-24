import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb, type Database } from "../../src/core/db.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { parseTokens } from "../../src/mcp/auth.js";
import { buildViewHandler } from "../../src/view/handler.js";

let db: Database;
let pages: PagesStore;
let findings: FindingsStore;
let server: Server;
let base: string;

const tokens = parseTokens({
  full: { name: "full", scopes: ["pages.read", "findings.read"] },
  pagesonly: { name: "p", scopes: ["pages.read"] },
  memonly: { name: "m", scopes: ["memory.read"] },
});

beforeEach(async () => {
  db = openDb(":memory:");
  pages = new PagesStore(db);
  findings = new FindingsStore(db);
  const svc = new PageService(db, pages, new FakeEmbedder());
  await svc.ingest("wiki/concepts/hub.md", "---\ntitle: Hub\ntype: concept\n---\n# Hub\nSee [[Spoke]] and [[Nowhere]].\n");
  await svc.ingest("wiki/concepts/spoke.md", "---\ntitle: Spoke\nstale_after: 2026-01-01\n---\n# Spoke\nBack to [[Hub]].\n");
  await svc.ingest("raw/2026-10-31-x-session.md", "---\ntitle: Session\n---\n# Session\nWorked on [[Hub]] irrigation.\n");
  await svc.ingest("wiki/concepts/gone.md", "---\ntitle: Gone\n---\n# Gone\n[[Hub]]\n");
  pages.softDelete("gone");
  await svc.resolveAll(); // what vault sync does for forward references
  await svc.putGenerated({ slug: "digest", title: "Digest", body: "# Digest\n" }, "test");
  findings.upsertDetected({ kind: "stale", subject: "spoke", detail: "d" }, "enscribe", "2026-10-31T00:00:00Z");
  const view = buildViewHandler({ pages, findings, tokens });
  server = createServer((req, res) => { if (!view(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const get = (path: string, token?: string) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("the viewer shell is served without a token, carries no data, and sets a strict CSP", async () => {
  const r = await get("/view");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toMatch(/text\/html/);
  expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await r.text()).not.toContain("Spoke");
  for (const asset of ["/view/app.js", "/view/hyper.js", "/view/demo.js"]) {
    const js = await get(asset);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
  }
});

test("an unknown asset is a 404 and a path outside /view is not handled", async () => {
  expect((await get("/view/../package.json")).status).not.toBe(200);
  expect((await get("/view/nope.js")).status).toBe(404);
  expect((await get("/mcp")).status).toBe(418);
});

test("the API needs a bearer header with pages.read", async () => {
  expect((await get("/view/api/graph")).status).toBe(401);
  expect((await get("/view/api/graph?token=full")).status).toBe(401); // header only: no tokens in URLs
  expect((await get("/view/api/graph", "wrong")).status).toBe(401);
  expect((await get("/view/api/graph", "memonly")).status).toBe(403);
  expect((await get("/view/api/graph", "pagesonly")).status).toBe(200);
});

test("graph lists live pages with kind and type, and links between live pages only", async () => {
  const r = await get("/view/api/graph", "full");
  expect(r.headers.get("cache-control")).toBe("no-store");
  const g = await r.json();
  expect(g.nodes.map((n: any) => n.slug)).toEqual(["2026-10-31-x-session", "digest", "hub", "spoke"]);
  const hub = g.nodes.find((n: any) => n.slug === "hub");
  expect(hub).toMatchObject({ title: "Hub", kind: "authored", type: "concept", findings: 0 });
  expect(g.nodes.find((n: any) => n.slug === "digest").kind).toBe("generated");
  expect(g.nodes.find((n: any) => n.slug === "2026-10-31-x-session").kind).toBe("raw");
  expect(g.nodes.find((n: any) => n.slug === "spoke").findings).toBe(1);
  expect(g.links).toEqual([["2026-10-31-x-session", "hub"], ["hub", "spoke"], ["spoke", "hub"]]);
});

test("finding counts and details are withheld from a token without findings.read", async () => {
  const g = await (await get("/view/api/graph", "pagesonly")).json();
  expect(g.nodes.every((n: any) => n.findings === undefined)).toBe(true);
  const p = await (await get("/view/api/page?slug=spoke", "pagesonly")).json();
  expect(p.findings).toBeUndefined();
});

test("page returns body, trust fields, links, unresolved, backlinks and open findings", async () => {
  const p = await (await get("/view/api/page?slug=hub", "full")).json();
  expect(p).toMatchObject({ slug: "hub", title: "Hub", kind: "authored", type: "concept" });
  expect(p.body).toContain("See [[Spoke]]");
  expect(p.links).toEqual(["spoke"]);
  expect(p.unresolved).toEqual(["Nowhere"]);
  expect(p.backlinks).toEqual(["2026-10-31-x-session", "spoke"]);
  const s = await (await get("/view/api/page?slug=spoke", "full")).json();
  expect(s.trust).toEqual({ stale_after: "2026-01-01" });
  expect(s.findings).toEqual([{ kind: "stale", detail: "d" }]);
});

test("a missing or tombstoned page is a 404, and a missing slug a 400", async () => {
  expect((await get("/view/api/page?slug=gone", "full")).status).toBe(404);
  expect((await get("/view/api/page?slug=nope", "full")).status).toBe(404);
  expect((await get("/view/api/page", "full")).status).toBe(400);
});

test("only GET is allowed", async () => {
  expect((await fetch(base + "/view/api/graph", { method: "POST", headers: { authorization: "Bearer full" } })).status).toBe(405);
});

test("search returns live pages whose text holds every term, as prefixes, stemmed", async () => {
  const q = async (s: string) => (await (await get(`/view/api/search?q=${encodeURIComponent(s)}`, "full")).json()).slugs;
  expect(await q("worked")).toEqual(["2026-10-31-x-session"]);
  expect(await q("wor")).toEqual(["2026-10-31-x-session"]);          // a word still being typed
  expect(await q("irriga")).toEqual(["2026-10-31-x-session"]);       // typed past the stem (irrig)
  expect(await q("works")).toEqual(["2026-10-31-x-session"]);        // stemmed: works ~ worked
  expect(await q("back hub")).toEqual(["spoke"]);                    // every term, not any
  expect(await q("nowhere")).toEqual(["hub"]);
  expect(await q("zzz")).toEqual([]);
  expect(await q(" \"* ")).toEqual([]);                               // no terms, no FTS syntax error
  expect((await get("/view/api/search", "full")).status).toBe(400);
});

test("search with word=1 matches whole, unstemmed words only", async () => {
  const q = async (s: string) => (await (await get(`/view/api/search?q=${encodeURIComponent(s)}&word=1`, "full")).json()).slugs;
  expect(await q("worked")).toEqual(["2026-10-31-x-session"]);
  expect(await q("wor")).toEqual([]);      // no prefix match
  expect(await q("works")).toEqual([]);    // no stemming
  expect(await q("back hub")).toEqual(["spoke"]);
});

test("declined (wont_fix) findings are listed apart from open ones, red links by target, for findings.read only", async () => {
  const now = "2026-11-02T00:00:00Z";
  findings.upsertDetected({ kind: "orphan", subject: "hub", detail: "no inbound links" }, "enscribe", now);
  findings.setState("orphan:hub", "wont_fix", null, now);
  findings.upsertDetected({ kind: "unresolved", subject: "Nowhere", detail: "linked from hub" }, "enscribe", now);
  findings.setState("unresolved:Nowhere", "wont_fix", null, now);
  const g = await (await get("/view/api/graph", "full")).json();
  expect(g.nodes.find((n: any) => n.slug === "hub").declined).toEqual(["orphan"]);
  expect(g.nodes.find((n: any) => n.slug === "spoke").declined).toBeUndefined();
  const p = await (await get("/view/api/page?slug=hub", "full")).json();
  expect(p.findings).toEqual([]);
  expect(p.declined).toEqual([{ kind: "orphan", subject: "hub" }, { kind: "unresolved", subject: "Nowhere" }]);
  const g2 = await (await get("/view/api/graph", "pagesonly")).json();
  expect(g2.nodes.every((n: any) => n.declined === undefined)).toBe(true);
  expect((await (await get("/view/api/page?slug=hub", "pagesonly")).json()).declined).toBeUndefined();
});

test("search reads a hyphenated or quoted term as a phrase", async () => {
  const q = async (s: string, w = "") => (await (await get(`/view/api/search?q=${encodeURIComponent(s)}${w}`, "full")).json()).slugs;
  expect(await q("back-to")).toEqual(["spoke"]);
  expect(await q("to-back")).toEqual([]);                        // order matters
  expect(await q('"worked on"')).toEqual(["2026-10-31-x-session"]);
  expect(await q("on-worked")).toEqual([]);
  expect(await q("back-t")).toEqual(["spoke"]);                  // last word may be a prefix
  expect(await q("back-t", "&word=1")).toEqual([]);              // not as whole words
  expect(await q("back-to", "&word=1")).toEqual(["spoke"]);
});

// Locked decision 8: the read path never writes.
test("serving the viewer and its API writes nothing to the database", async () => {
  const changes = () => (db.prepare("SELECT total_changes() AS c").get() as { c: number }).c;
  const before = changes();
  await get("/view");
  await get("/view/api/graph", "full");
  await get("/view/api/page?slug=hub", "full");
  await get("/view/api/search?q=hub", "full");
  expect(changes()).toBe(before);
});
