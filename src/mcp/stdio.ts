import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../core/db.js";
import { Store } from "../core/store.js";
import { PagesStore } from "../pages/store.js";
import { PageService } from "../pages/service.js";
import { SearchService } from "../search/index.js";
import { createEmbedder, type EmbedderConfig } from "../embed/index.js";
import { loadVaultConfig } from "../pages/vault-config.js";
import { FindingsStore } from "../findings/ledger.js";
import { buildServer } from "./server.js";

export async function runStdio(dbPath: string, embedderConfig: EmbedderConfig = {}): Promise<void> {
  const db = openDb(dbPath);
  const store = new Store(db);
  const embedder = createEmbedder(embedderConfig);
  const pages = new PagesStore(db);
  const service = new PageService(db, pages, embedder);
  const search = new SearchService(db, store, embedder, pages);
  const findings = new FindingsStore(db);
  const server = buildServer({ store, search, pages, service, vaultConfig: loadVaultConfig(), findings });
  await server.connect(new StdioServerTransport());
  // server.connect() resolves as soon as the transport is wired up — it does NOT
  // block for the server's lifetime. Without this, runStdio() would return, the
  // CLI would reach process.exit(0), and the server would die before handling any
  // request. Stay pending; when the client closes stdin the transport tears down,
  // the event loop empties, and Node exits on its own.
  await new Promise<never>(() => {});
}
