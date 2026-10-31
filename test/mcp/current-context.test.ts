import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { buildServer } from "../../src/mcp/server.js";

const textOf = (r: any) => JSON.parse(r.content[0].text);

async function client(contextPath: string, scopes?: string[]) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const search = new SearchService(db, store, new FakeEmbedder());
  const server = buildServer({ store, search, contextPath }, scopes ? new Set(scopes) : undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

test("current_context returns the digest file with its age", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ctx-")), "current-context.md");
  writeFileSync(path, "# Current context\n## In flight\n");
  const r = textOf(await (await client(path, ["context.read"])).callTool({ name: "current_context", arguments: {} }));
  expect(r.text).toContain("## In flight");
  expect(r.age_hours).toBeLessThan(1);
});

test("current_context is hidden from a token without context.read", async () => {
  const c = await client("/nonexistent", ["memory.read"]);
  expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("current_context");
});

test("a missing digest is reported as a gap, not as empty context", async () => {
  const r = textOf(await (await client("/nonexistent/x.md")).callTool({ name: "current_context", arguments: {} }));
  expect(r.error).toMatch(/gap/);
  expect(r.text).toBeUndefined();
});
