import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

async function scopedClient(scopes: string[]) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new FakeEmbedder());
  const server = buildServer({ store, search }, new Set(scopes));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("a read/search-only client can search but cannot add or forget", async () => {
  const client = await scopedClient(["memory.read", "memory.search"]);

  const ok = (await client.callTool({ name: "search_memory", arguments: { query: "x" } })) as any;
  expect(ok.isError ?? false).toBe(false);

  const denied = (await client.callTool({
    name: "add_memory",
    arguments: { type: "note", subject: "s", content: "c" },
  })) as any;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain("not found");

  const denied2 = (await client.callTool({ name: "forget_record", arguments: { id: "x" } })) as any;
  expect(denied2.isError).toBe(true);
});

// tools/list must be honest: a tool the client's scopes can never invoke is
// not registered at all, rather than listed and denied at call time.
test("a scoped client's tools/list contains only tools its scopes can invoke", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  const findings = new FindingsStore(db);
  const server = buildServer(
    { store, search, pages, service, findings, vaultConfig: { root: "/tmp/nope", include: ["wiki"], deny: [] } },
    new Set(["pages.read", "findings.read"]),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const visible of ["search", "get_page", "resolve_slug", "doctor", "findings"]) {
    expect(names).toContain(visible);
  }
  for (const hidden of ["add_memory", "search_memory", "forget_record", "put_page", "edit_page", "report_findings", "set_finding_state"]) {
    expect(names).not.toContain(hidden);
  }
});

test("a full-trust server (no allowedScopes) permits every tool", async () => {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new FakeEmbedder());
  const server = buildServer({ store, search }); // no scopes -> full trust (stdio/local)
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const added = (await client.callTool({
    name: "add_memory",
    arguments: { type: "note", subject: "s", content: "c" },
  })) as any;
  expect(added.isError ?? false).toBe(false);
});
