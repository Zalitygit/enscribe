import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/core/db.js";
import { Store } from "../../src/core/store.js";
import { FakeEmbedder } from "../../src/embed/fake.js";
import { SearchService } from "../../src/search/index.js";
import { PagesStore } from "../../src/pages/store.js";
import { PageService } from "../../src/pages/service.js";
import { FindingsStore } from "../../src/findings/ledger.js";
import { buildServer } from "../../src/mcp/server.js";
import { serverInstructions, USAGE_GUIDE_ALIAS } from "../../src/mcp/instructions.js";

const all = () => true;

test("full trust: names the read, write and findings rules", () => {
  const text = serverInstructions({ can: all, hasPages: true, hasFindings: true, guideSlug: null });
  expect(text).toMatch(/proper noun/);
  expect(text).toMatch(/confident: false/);
  expect(text).toMatch(/slug/);
  expect(text).toMatch(/edit_page/);
  expect(text).toMatch(/add_finding/);
  expect(text).not.toMatch(/get_page \S+ for the long form/);
});

test("a read-only client is not told about tools it cannot call", () => {
  const can = (tool: string) => !["put_page", "edit_page", "add_finding", "report_findings"].includes(tool);
  const text = serverInstructions({ can, hasPages: true, hasFindings: true, guideSlug: null });
  expect(text).not.toMatch(/edit_page|put_page|add_finding/);
  expect(text).toMatch(/`findings`/);
});

test("a records-only server points at search_memory, not search", () => {
  const text = serverInstructions({ can: all, hasPages: false, hasFindings: false, guideSlug: null });
  expect(text).toMatch(/search_memory/);
  expect(text).not.toMatch(/get_page|findings/);
});

test("names the guide page when one exists", () => {
  const text = serverInstructions({ can: all, hasPages: true, hasFindings: false, guideSlug: "brain-guide" });
  expect(text).toMatch(/get_page brain-guide for the long form/);
});

async function connect(withGuide: boolean, scopes?: Set<string>) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const embedder = new FakeEmbedder();
  const search = new SearchService(db, store, embedder);
  const pages = new PagesStore(db);
  const service = new PageService(db, pages, embedder);
  if (withGuide) {
    await service.ingest("wiki/brain-guide.md",
      `---\ntitle: Brain guide\naliases: [${USAGE_GUIDE_ALIAS}]\n---\n# Brain guide\n\nHow to use it.\n`);
    service.rebuildAllAliases();
  }
  const findings = new FindingsStore(db);
  const server = buildServer({ store, search, pages, service, findings }, scopes);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("the server sends instructions on initialize, with the guide resolved by alias", async () => {
  const client = await connect(true);
  const text = client.getInstructions() ?? "";
  expect(text).toMatch(/edit_page/);
  expect(text).toMatch(/get_page brain-guide for the long form/);
});

test("a pages.read-only client gets read-only instructions", async () => {
  const client = await connect(false, new Set(["pages.read"]));
  const text = client.getInstructions() ?? "";
  expect(text).toMatch(/proper noun/);
  expect(text).not.toMatch(/edit_page|add_finding|`findings`/);
});

test("names page_history only when the server has a vault to read it from", () => {
  expect(serverInstructions({ can: all, hasPages: true, hasFindings: false, guideSlug: null, hasHistory: true })).toMatch(/page_history/);
  expect(serverInstructions({ can: all, hasPages: true, hasFindings: false, guideSlug: null })).not.toMatch(/page_history/);
});

// Measured 2026-11-24 from the HTTP call log: 147 get_page calls against 53
// searches, and only 2 passed `section`, while the most-read pages are
// 32-49 KB. The instructions are the one channel that reaches every client.
test("tells the client to fetch the hit's section, not the whole page", () => {
  const text = serverInstructions({ can: all, hasPages: true, hasFindings: false, guideSlug: null });
  expect(text).toMatch(/`section`/);
  expect(text).toMatch(/whole page only/);
});

test("names get_pages for several pages at once, only when callable", () => {
  expect(serverInstructions({ can: all, hasPages: true, hasFindings: false, guideSlug: null })).toMatch(/get_pages/);
  const can = (t: string) => t !== "get_pages";
  expect(serverInstructions({ can, hasPages: true, hasFindings: false, guideSlug: null })).not.toMatch(/get_pages/);
});
