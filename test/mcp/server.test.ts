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

// The canonical write commits before the vector is embedded. When embedding
// fails, the tool must report the committed record with an indexError, not an
// error: a caller told "failed" retries, and every retry stores another copy.
async function clientWithBrokenEmbedder() {
  const db = openDb(":memory:");
  const store = new Store(db);
  const broken = new FakeEmbedder();
  broken.embed = async () => { throw new Error("embedding unavailable"); };
  const search = new SearchService(db, store, broken);
  const server = buildServer({ store, search });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return { client: c, store };
}

test("add_memory reports a committed record with indexError when embedding fails", async () => {
  const { client: c, store } = await clientWithBrokenEmbedder();
  const result: any = await c.callTool({ name: "add_memory", arguments: { type: "note", subject: "S", content: "body" } });
  expect(result.isError).toBeFalsy();
  const added = textOf(result);
  expect(added.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(added.indexError).toContain("embedding unavailable");
  expect(store.listCurrent({}).map((r) => r.id)).toEqual([added.id]);
});

test("update_memory reports the new version with indexError when embedding fails", async () => {
  const { client: c, store } = await clientWithBrokenEmbedder();
  const added = textOf(await c.callTool({ name: "add_memory", arguments: { type: "note", subject: "S", content: "v1" } }));
  const result: any = await c.callTool({ name: "update_memory", arguments: { id: added.id, patch: { content: "v2" } } });
  expect(result.isError).toBeFalsy();
  const updated = textOf(result);
  expect(updated.supersedes).toBe(added.id);
  expect(updated.indexError).toContain("embedding unavailable");
  expect(store.listCurrent({}).map((r) => r.id)).toEqual([updated.id]);
});

test("link_records reports ok with indexError when embedding fails", async () => {
  const { client: c } = await clientWithBrokenEmbedder();
  const a = textOf(await c.callTool({ name: "add_memory", arguments: { type: "note", subject: "A", content: "a" } }));
  const result: any = await c.callTool({ name: "link_records", arguments: { subject: a.id, predicate: "relates_to", object: "x" } });
  expect(result.isError).toBeFalsy();
  const linked = textOf(result);
  expect(linked.ok).toBe(true);
  expect(linked.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(linked.indexError).toContain("embedding unavailable");
});
