import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseTokens } from "../../src/mcp/auth.js";
import { startHttp } from "../../src/mcp/http.js";

let server: Server | undefined;
afterEach(() => server?.close());

function portOf(s: Server): number {
  return (s.address() as AddressInfo).port;
}

async function connect(port: number, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const text = (r: any) => JSON.parse(r.content[0].text);

test("shared HTTP server: bearer auth, round-trip, and per-client scope enforcement", async () => {
  const tokens = parseTokens({
    admin: { name: "admin", scopes: ["*"] },
    reader: { name: "reader", scopes: ["memory.read", "memory.search"] },
  });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  // admin (full scopes) can add, then search finds it
  const admin = await connect(port, "admin");
  const added = text(await admin.callTool({ name: "add_memory", arguments: { type: "note", subject: "S", content: "hello shared world" } }));
  expect(added.id).toBeTruthy();
  const found = text(await admin.callTool({ name: "search_memory", arguments: { query: "hello shared world" } }));
  expect(found.hits.some((h: any) => h.id === added.id)).toBe(true);

  // reader (read/search only) shares the same DB, can search, but is denied add
  const reader = await connect(port, "reader");
  const readerFound = text(await reader.callTool({ name: "search_memory", arguments: { query: "hello shared world" } }));
  expect(readerFound.hits.some((h: any) => h.id === added.id)).toBe(true); // same shared DB
  const denied = (await reader.callTool({ name: "add_memory", arguments: { type: "note", subject: "x", content: "y" } })) as any;
  expect(denied.isError).toBe(true);

  await admin.close();
  await reader.close();
});

test("shared HTTP server rejects a missing/invalid bearer token", async () => {
  const tokens = parseTokens({ good: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const bad = new Client({ name: "t", version: "0" });
  await expect(
    bad.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: "Bearer WRONG" } },
    })),
  ).rejects.toThrow();
});

test("shared HTTP server exposes page tools with pages.* scope enforcement", async () => {
  const tokens = parseTokens({
    admin: { name: "admin", scopes: ["*"] },
    reader: { name: "reader", scopes: ["memory.read", "memory.search"] },
  });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const admin = await connect(port, "admin");
  const names = (await admin.listTools()).tools.map((t) => t.name);
  expect(names).toContain("search");
  expect(names).toContain("get_page");
  expect(names).toContain("put_page");
  expect(names).toContain("edit_page");
  expect(text(await admin.callTool({ name: "get_page", arguments: { slug: "nope" } })).error).toBe("not_found");

  const reader = await connect(port, "reader");
  const denied = (await reader.callTool({ name: "get_page", arguments: { slug: "nope" } })) as any;
  expect(denied.isError).toBe(true);

  await admin.close();
  await reader.close();
});

test("a session is bound to the token that opened it, not the display name", async () => {
  const tokens = parseTokens({
    tokA: { name: "same", scopes: ["*"] },
    tokB: { name: "same", scopes: ["*"] },
  });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer tokA" } },
  });
  const a = new Client({ name: "t", version: "0" });
  await a.connect(transport);
  const sid = transport.sessionId;
  expect(sid).toBeTruthy();

  // A DIFFERENT token with the SAME display name must not drive A's session.
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer tokB",
      "mcp-session-id": sid!,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(403);
  await a.close();
});

const init = (port: number, token: string, sid?: string, pad?: string) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(sid ? { "mcp-session-id": sid } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0", ...(pad ? { pad } : {}) } },
    }),
  });

test("a request body over the limit is rejected with 413", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" }, limits: { maxBodyBytes: 1024 } });
  const res = await init(portOf(server), "tok", undefined, "x".repeat(4096));
  expect(res.status).toBe(413);
});

test("an idle session expires after the TTL", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" }, limits: { sessionTtlMs: 50 } });
  const port = portOf(server);
  const r1 = await init(port, "tok");
  const sid = r1.headers.get("mcp-session-id")!;
  expect(sid).toBeTruthy();
  await new Promise((r) => setTimeout(r, 120));
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "mcp-session-id": sid, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(404); // expired -> unknown session -> client re-initializes
});

// The spec's recovery contract: a client holding a session id the server does
// not know (server restarted, session swept, session evicted) must get 404 so it
// re-initializes. A 400 reads as "malformed request" and the client gives up --
// which left connectors dead after every deploy until someone reconnected by hand.
test("an unknown session id gets 404 so the client re-initializes", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const headers = {
    authorization: "Bearer tok",
    "mcp-session-id": randomUUID(), // never issued by this server
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const post = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(post.status).toBe(404);

  // the GET (SSE) and DELETE paths carry the same contract
  expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET", headers })).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE", headers })).status).toBe(404);
});

// The other half of that contract. A client that gets a 404 is supposed to drop
// its session id and re-initialize -- but some retry `initialize` while STILL
// sending the dead `mcp-session-id` header. The guard used to require
// `!sessionId`, so that landed in the 404 branch above and the client could not
// recover on its own however many times it tried. Measured on the live server:
// 96 session-404s in five weeks of Caddy logs (2026-07-26 -> 2026-08-30), and on
// 2026-08-30 one surfaced to a claude.ai user as a bare "Error occurred during
// tool execution" with the connector then dropping every MacBrain tool from its
// working set. An initialize IS the request to start a new session, so the id
// riding along on it is stale by definition -- honour it and issue a fresh one.
test("an initialize carrying a stale session id opens a new session instead of 404", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);
  const stale = randomUUID(); // never issued by this server

  const res = await init(port, "tok", stale);
  expect(res.status).toBe(200);

  // A NEW session, not an adoption of the dead id -- adopting it would let a
  // client pick its own session id, and the id is the authorization handle.
  const fresh = res.headers.get("mcp-session-id");
  expect(fresh).toBeTruthy();
  expect(fresh).not.toBe(stale);

  // and the fresh session actually drives the server
  const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "mcp-session-id": fresh!, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(call.status).toBe(200);

  // the stale id is still dead -- this fixes recovery, it does not resurrect
  const dead = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "mcp-session-id": stale, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect(dead.status).toBe(404);
});

// A POST with no session id at all is a genuinely malformed request, not a lost
// session -- there is nothing for the client to recover, so it stays a 400.
test("a non-initialize POST with no session id is still 400", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const res = await fetch(`http://127.0.0.1:${portOf(server)}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(400);
});

test("the session map is capped: opening past the cap evicts the least-recent session", async () => {
  const tokens = parseTokens({ tok: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" }, limits: { maxSessions: 2 } });
  const port = portOf(server);
  const sid1 = (await init(port, "tok")).headers.get("mcp-session-id")!;
  await init(port, "tok");
  await init(port, "tok"); // third session -> evicts sid1
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "mcp-session-id": sid1, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(404); // evicted -> unknown session -> client re-initializes
});

// claude.ai's connector UI has no static-bearer field, so the token may ride
// in the URL as ?token= (query param), equivalent to the Authorization header.
test("a client may authenticate with ?token= in the URL instead of a bearer header", async () => {
  const tokens = parseTokens({ qtok: { name: "claude-ai", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?token=qtok`));
  const client = new Client({ name: "q", version: "0" });
  await client.connect(transport);
  const added = text(await client.callTool({ name: "add_memory", arguments: { type: "note", subject: "Q", content: "query token works" } }));
  expect(added.id).toBeTruthy();
  await client.close();
});

test("an unknown ?token= is rejected, and a bearer header wins over the query param", async () => {
  const tokens = parseTokens({ good: { name: "c", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  // unknown query token -> 401
  const bad = new Client({ name: "b", version: "0" });
  await expect(
    bad.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?token=WRONG`))),
  ).rejects.toThrow();

  // valid bearer header + bogus query param -> header wins, connect succeeds
  const ok = new Client({ name: "o", version: "0" });
  await ok.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?token=WRONG`), {
    requestInit: { headers: { authorization: "Bearer good" } },
  }));
  await ok.close();
});

test("a session opened via ?token= is bound to that token", async () => {
  const tokens = parseTokens({ a: { name: "one", scopes: ["*"] }, b: { name: "two", scopes: ["*"] } });
  server = await startHttp({ dbPath: ":memory:", port: 0, tokens, embedder: { backend: "fake" } });
  const port = portOf(server);

  const res = await fetch(`http://127.0.0.1:${port}/mcp?token=a`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
  });
  const sid = res.headers.get("mcp-session-id")!;
  expect(sid).toBeTruthy();

  // reusing the session with a DIFFERENT (valid) token -> 403
  const hijack = await fetch(`http://127.0.0.1:${port}/mcp?token=b`, {
    method: "POST",
    headers: { "mcp-session-id": sid, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect(hijack.status).toBe(403);
});
