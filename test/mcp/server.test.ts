import { beforeEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

async function connectedClient() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new FakeEmbedder());
  const server = buildServer({ store, search });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(result: any): any {
  return JSON.parse(result.content[0].text);
}

let client: Awaited<ReturnType<typeof connectedClient>>;
beforeEach(async () => { client = await connectedClient(); });

test("lists all eight tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "add_memory", "forget_record", "get_record", "link_records",
    "list_recent", "search_memory", "summarize_context", "update_memory",
  ]);
});

test("add_memory then search_memory round-trips a record", async () => {
  const added = textOf(await client.callTool({
    name: "add_memory",
    arguments: { type: "decision", subject: "DB choice", content: "MacBrain uses SQLite with sqlite-vec." },
  }));
  expect(added.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  const results = textOf(await client.callTool({
    name: "search_memory",
    arguments: { query: "MacBrain uses SQLite with sqlite-vec." },
  }));
  expect(results.hits.some((h: any) => h.id === added.id)).toBe(true);
});

test("get_record round-trips a record added via add_memory", async () => {
  const added = textOf(await client.callTool({
    name: "add_memory",
    arguments: { type: "note", subject: "round-trip", content: "fetch me by id" },
  }));

  const fetched = textOf(await client.callTool({
    name: "get_record", arguments: { id: added.id },
  }));
  expect(fetched).toEqual(added);
});

test("link_records appends the edge to the subject record's canonical doc", async () => {
  const added = textOf(await client.callTool({
    name: "add_memory",
    arguments: { type: "note", subject: "subject rec", content: "n/a" },
  }));

  const linked = textOf(await client.callTool({
    name: "link_records",
    arguments: { subject: added.id, predicate: "relates_to", object: "other:1" },
  }));
  expect(linked.ok).toBe(true);

  const fetched = textOf(await client.callTool({
    name: "get_record", arguments: { id: linked.id },
  }));
  expect(fetched.relationships).toContainEqual({ predicate: "relates_to", object: "other:1" });
});

test("link_records against a stale (superseded) subject id is additive, not forking", async () => {
  const added = textOf(await client.callTool({
    name: "add_memory",
    arguments: { type: "note", subject: "stale link target", content: "n/a" },
  }));
  const originalId = added.id;

  const first = textOf(await client.callTool({
    name: "link_records",
    arguments: { subject: originalId, predicate: "edge1", object: "other:1" },
  }));
  expect(first.ok).toBe(true);

  // Link again using the ORIGINAL (now-superseded) id, not the head returned above.
  const second = textOf(await client.callTool({
    name: "link_records",
    arguments: { subject: originalId, predicate: "edge2", object: "other:2" },
  }));
  expect(second.ok).toBe(true);

  const fetched = textOf(await client.callTool({
    name: "get_record", arguments: { id: second.id },
  }));
  expect(fetched.relationships).toContainEqual({ predicate: "edge1", object: "other:1" });
  expect(fetched.relationships).toContainEqual({ predicate: "edge2", object: "other:2" });

  const recent = textOf(await client.callTool({ name: "list_recent", arguments: {} }));
  const currentVersions = recent.records.filter((r: any) =>
    r.id === originalId || r.id === first.id || r.id === second.id);
  expect(currentVersions.length).toBe(1);
  expect(currentVersions[0].id).toBe(second.id);
});

test("update_memory supersedes and forget_record removes from current", async () => {
  const { id } = textOf(await client.callTool({
    name: "add_memory", arguments: { type: "note", subject: "s", content: "first" },
  }));
  const v2 = textOf(await client.callTool({
    name: "update_memory", arguments: { id, patch: { content: "second" } },
  }));
  expect(v2.supersedes).toBe(id);

  await client.callTool({ name: "forget_record", arguments: { id: v2.id } });
  const recent = textOf(await client.callTool({ name: "list_recent", arguments: {} }));
  expect(recent.records.some((r: any) => r.id === v2.id)).toBe(false);
});
