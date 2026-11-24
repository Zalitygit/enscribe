import { afterEach, expect, test, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";
import { parseTokens } from "../../src/mcp/auth.js";
import { startHttp } from "../../src/mcp/http.js";
import { formatCallLog, summarizeCall, type ToolCallEvent } from "../../src/mcp/call-log.js";

const reply = (data: unknown, isError = false) =>
  ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], ...(isError ? { isError: true } : {}) });

test("a search logs its query, hit count, top slug and confidence", () => {
  const s = summarizeCall({
    tool: "search", args: { query: "hostname", intent: "entity", limit: 4 }, ms: 12,
    result: reply({ hits: [{ kind: "page", slug: "host-inventory" }, { kind: "record", id: "r1" }], confident: false, reason: "distance" }),
  });
  expect(s).toEqual({ tool: "search", args: { query: "hostname" }, ms: 12, hits: 2, top: "host-inventory", confident: false, reason: "distance" });
});

test("a get_page miss, truncation and alias resolution are logged", () => {
  expect(summarizeCall({ tool: "get_page", args: { slug: "nope" }, ms: 1, result: reply({ error: "not_found", slug: "nope", suggestions: [] }) }))
    .toMatchObject({ args: { slug: "nope" }, not_found: true });
  expect(summarizeCall({ tool: "get_page", args: { slug: "Big Page" }, ms: 1, result: reply({ slug: "big-page", body: "x", truncated: true, resolved_from: "Big Page" }) }))
    .toMatchObject({ truncated: true, resolved_from: "Big Page" });
});

test("only identifying arguments are logged, never page text or finding detail", () => {
  const s = summarizeCall({
    tool: "edit_page", args: { page: "network-notes", old: "OLD BODY", new: "NEW BODY" }, ms: 3,
    result: reply({ ok: true, slug: "network-notes", changed: true }),
  });
  expect(s.args).toEqual({ page: "network-notes" });
  expect(JSON.stringify(s)).not.toMatch(/BODY/);
  const f = summarizeCall({ tool: "add_finding", args: { kind: "todo", subject: "x", detail: "SECRET HANDOFF" }, ms: 1, result: reply({ ok: true }) });
  expect(f.args).toEqual({ kind: "todo", subject: "x" });
  expect(JSON.stringify(f)).not.toMatch(/HANDOFF/);
});

test("a write that fails is logged as ok:false", () => {
  expect(summarizeCall({ tool: "put_page", args: { path: "a.md", content: "c" }, ms: 1, result: reply({ ok: false, error: "refused" }) }))
    .toMatchObject({ args: { path: "a.md" }, ok: false });
});

test("an error result and a thrown error are both logged, capped", () => {
  expect(summarizeCall({ tool: "get_page", args: { slug: "a" }, ms: 1, result: reply("permission denied: lacks scope", true) }))
    .toMatchObject({ error: "permission denied: lacks scope" });
  const thrown = summarizeCall({ tool: "search", args: { query: "q" }, ms: 1, error: new Error("e".repeat(500)) });
  expect(typeof thrown.error).toBe("string");
  expect((thrown.error as string).length).toBeLessThanOrEqual(120);
});

test("long arguments are capped and credential-shaped ones redacted", () => {
  const long = summarizeCall({ tool: "search", args: { query: "word ".repeat(100) }, ms: 1, result: reply({ hits: [] }) });
  expect((long.args as any).query.length).toBeLessThanOrEqual(120);
  // Built at run time so the file itself holds nothing credential-shaped (the public export's guard scans it).
  const bearer = "Authorization: Bearer " + "abcdef0123456789".repeat(2);
  const secret = summarizeCall({ tool: "search", args: { query: bearer }, ms: 1, result: reply({ hits: [] }) });
  expect((secret.args as any).query).toMatch(/^\[redacted: /);
  expect(JSON.stringify(secret)).not.toMatch(/abcdef0123/);
});

test("a result that is not JSON still logs the call", () => {
  expect(summarizeCall({ tool: "doctor", args: {}, ms: 2, result: reply("plain text") })).toEqual({ tool: "doctor", args: {}, ms: 2 });
});

test("formatCallLog is one greppable line with the client name", () => {
  const line = formatCallLog("claude-ai", { tool: "doctor", args: {}, ms: 2, result: reply({}) });
  expect(line).toBe('tool_call {"client":"claude-ai","tool":"doctor","args":{},"ms":2}');
  expect(line).not.toContain("\n");
});

function pagesServer(onToolCall: (e: ToolCallEvent) => void) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  return { server: buildServer({ store, search, pages, service, onToolCall }), service };
}

test("buildServer reports every tool call to onToolCall, including a failing one", async () => {
  const events: ToolCallEvent[] = [];
  const { server, service } = pagesServer((e) => events.push(e));
  await service.ingest("wiki/concepts/alpha.md", "---\ntitle: Alpha\n---\n# Alpha\nbody zzqqx\n");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  await client.callTool({ name: "search", arguments: { query: "zzqqx" } });
  await client.callTool({ name: "get_page", arguments: { slug: "no-such-page" } });
  expect(events.map((e) => e.tool)).toEqual(["search", "get_page"]);
  expect(summarizeCall(events[0])).toMatchObject({ args: { query: "zzqqx" }, top: "alpha" });
  expect(summarizeCall(events[1])).toMatchObject({ not_found: true });
  expect(events[0].ms).toBeGreaterThanOrEqual(0);
});

test("a hook that throws does not break the tool call", async () => {
  const { server } = pagesServer(() => { throw new Error("hook broke"); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = (await client.callTool({ name: "doctor", arguments: {} })) as any;
  expect(r.isError).toBeFalsy();
});

let http: Server | undefined;
afterEach(() => { http?.close(); vi.restoreAllMocks(); });

test("the HTTP server logs one tool_call line per call, naming the token's client", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  http = await startHttp({ dbPath: ":memory:", port: 0, tokens: parseTokens({ tok: { name: "claude-ai", scopes: ["*"] } }), embedder: { backend: "fake" } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer tok" } },
  });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  await client.callTool({ name: "search", arguments: { query: "hello" } });
  await client.close();

  const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("tool_call "));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0].slice("tool_call ".length))).toMatchObject({ client: "claude-ai", tool: "search", args: { query: "hello" }, hits: 0 });
  expect(lines[0]).not.toContain("tok\"");
});

// get_pages carries its slugs in an array, which the flat allowlist would
// drop, leaving the section-uptake check blind to batched reads.
test("get_pages logs each requested slug and section", () => {
  expect(summarizeCall({ tool: "get_pages", args: { pages: [{ slug: "a", section: "Intro" }, { slug: "b" }] }, ms: 1, result: reply({ pages: [] }) }).args)
    .toEqual({ pages: ["a#Intro", "b"] });
});
