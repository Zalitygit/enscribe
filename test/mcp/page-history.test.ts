import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
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

// A real git vault: alpha.md is added, edited, moved into wiki/concepts (a pure
// rename, which is not a change), then edited again under one commit subject
// the sensitive-subject filter withholds. The second commit carries a -04:00
// offset, as a commit made on a laptop in local time does.
async function historyClient(scopes?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "mb-mcp-history-"));
  const g = (args: string[], date: string) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  g(["init", "-q"], ""); g(["config", "user.email", "t@t"], ""); g(["config", "user.name", "t"], "");
  mkdirSync(join(root, "wiki/concepts"), { recursive: true });
  const page = "---\ntitle: Alpha\naliases: [al]\n---\n# Alpha\n";
  const commit = (msg: string, date: string) => { g(["add", "-A"], date); g(["commit", "-q", "-m", msg], date); };
  writeFileSync(join(root, "alpha.md"), page + "one\n"); commit("add alpha", "2026-10-01T12:00:00Z");
  writeFileSync(join(root, "alpha.md"), page + "two\n"); commit("alpha: second fact", "2026-10-05T08:00:00-04:00");
  renameSync(join(root, "alpha.md"), join(root, "wiki/concepts/alpha.md")); commit("move alpha", "2026-10-07T12:00:00Z");
  writeFileSync(join(root, "wiki/concepts/alpha.md"), page + "three\n"); commit("medical: note", "2026-10-09T12:00:00Z");

  const db = openDb(":memory:");
  const store = new Store(db);
  const pages = new PagesStore(db);
  const emb = new FakeEmbedder();
  const service = new PageService(db, pages, emb);
  const search = new SearchService(db, store, emb, pages);
  await service.ingest("wiki/concepts/alpha.md", page + "three\n");
  await service.putGenerated({ slug: "gen", title: "Gen", body: "# Gen\n" }, "test-gen");
  const vaultConfig = { root, include: ["wiki/concepts"], deny: [] };
  const server = buildServer({ store, search, pages, service, vaultConfig }, scopes ? new Set(scopes) : undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("page_history lists a page's commits newest first, across a rename", async () => {
  const client = await historyClient();
  const r = textOf(await client.callTool({ name: "page_history", arguments: { slug: "alpha" } }));
  expect(r.slug).toBe("alpha");
  expect(r.source_path).toBe("wiki/concepts/alpha.md");
  expect(r.total).toBe(3);
  expect(r.first_added).toBe("2026-10-01T12:00:00Z");
  expect(r.last_changed).toBe("2026-10-09T12:00:00Z");
  // The pure-rename commit is not a change; the medical subject is withheld but counted.
  expect(r.commits.map((c: any) => c.subject)).toEqual(["alpha: second fact", "add alpha"]);
  expect(r.withheld).toBe(1);
});

test("page_history reports every date in UTC, whatever offset the committer had", async () => {
  const client = await historyClient();
  const r = textOf(await client.callTool({ name: "page_history", arguments: { slug: "alpha" } }));
  expect(r.commits.map((c: any) => c.date)).toEqual(["2026-10-05T12:00:00Z", "2026-10-01T12:00:00Z"]);
});

test("page_history honours limit and says the list was cut", async () => {
  const client = await historyClient();
  const r = textOf(await client.callTool({ name: "page_history", arguments: { slug: "alpha", limit: 1 } }));
  expect(r.commits.map((c: any) => c.subject)).toEqual(["alpha: second fact"]);
  expect(r.total).toBe(3);
  expect(r.truncated).toBe(true);
});

test("page_history resolves an alias and reports what was asked", async () => {
  const client = await historyClient();
  const r = textOf(await client.callTool({ name: "page_history", arguments: { slug: "al" } }));
  expect(r.slug).toBe("alpha");
  expect(r.resolved_from).toBe("al");
});

test("page_history on a miss or a generated page says why there is no history", async () => {
  const client = await historyClient();
  const miss = textOf(await client.callTool({ name: "page_history", arguments: { slug: "alpha notes" } }));
  expect(miss.error).toBe("not_found");
  expect(miss.suggestions).toContain("alpha");
  const gen = textOf(await client.callTool({ name: "page_history", arguments: { slug: "gen" } }));
  expect(gen.error).toBe("no_source_file");
});

test("page_history is listed for pages.read and absent without a vault", async () => {
  const scoped = await historyClient(["pages.read"]);
  expect((await scoped.listTools()).tools.map((t) => t.name)).toContain("page_history");
  const db = openDb(":memory:");
  const store = new Store(db), pages = new PagesStore(db), emb = new FakeEmbedder();
  const server = buildServer({ store, search: new SearchService(db, store, emb, pages), pages, service: new PageService(db, pages, emb) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const bare = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), bare.connect(b)]);
  expect((await bare.listTools()).tools.map((t) => t.name)).not.toContain("page_history");
});
