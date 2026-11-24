import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../core/db.js";
import { Store } from "../core/store.js";
import { SearchService } from "../search/index.js";
import { createEmbedder, type Embedder, type EmbedderConfig } from "../embed/index.js";
import { buildServer } from "./server.js";
import { formatCallLog } from "./call-log.js";
import { resolveContextPath } from "../config.js";
import { bearerToken, type Tokens } from "./auth.js";
import { PagesStore } from "../pages/store.js";
import { PageService } from "../pages/service.js";
import { loadVaultConfig } from "../pages/vault-config.js";
import type { VaultConfig } from "../pages/vault-config.js";
import { FindingsStore } from "../findings/ledger.js";
import { buildViewHandler } from "../view/handler.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  // The exact bearer token that opened the session — NOT the display name,
  // which is not unique across tokens.
  token: string;
  lastSeen: number;
}

// Resource bounds for the shared server. Every knob has a safe default; tests
// inject small values. A reverse proxy MAY also enforce limits, but the
// service must not depend on proxy configuration for its own survival.
export interface HttpLimits {
  maxBodyBytes?: number;   // reject larger request bodies with 413
  sessionTtlMs?: number;   // idle sessions expire after this
  maxSessions?: number;    // cap; creating past it evicts the least-recent
}
const DEFAULT_LIMITS = { maxBodyBytes: 4 * 1024 * 1024, sessionTtlMs: 60 * 60 * 1000, maxSessions: 128 };

class BodyTooLarge extends Error {}

function rpcError(res: ServerResponse, status: number, message: string, id: unknown = null): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id }));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) {
      // Stop buffering but keep draining (discarded), so the 413 response can
      // still be delivered instead of a connection reset.
      req.resume();
      throw new BodyTooLarge();
    }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

// Build the request handler for the shared MCP server. Every request requires a
// valid bearer token; the token's scopes bound the session's tools. Each client
// gets its own session/transport, all sharing one Store/SearchService (one DB).
export function buildHttpHandler(deps: {
  store: Store; search: SearchService; pages: PagesStore; service: PageService; vaultConfig: VaultConfig; tokens: Tokens;
  findings: FindingsStore;
  limits?: HttpLimits;
}) {
  const { store, search, pages, service, vaultConfig, tokens, findings } = deps;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const sessions = new Map<string, Session>();

  const dropSession = (sid: string): void => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    void s.transport.close().catch(() => {});
  };
  // Periodic sweep for sessions abandoned without a follow-up request; the
  // per-request expiry check below is the deterministic path.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - limits.sessionTtlMs;
    for (const [sid, s] of sessions) if (s.lastSeen < cutoff) dropSession(sid);
  }, Math.min(limits.sessionTtlMs, 5 * 60 * 1000));
  sweep.unref();
  // The read-only page viewer (/view, src/view/handler.ts) shares the port
  // and the tokens file.
  const view = buildViewHandler({ pages, findings, tokens });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (view(req, res)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") return rpcError(res, 404, "not found");

    // The Authorization header wins; ?token= is the fallback for clients whose
    // connector UI has no bearer field (claude.ai). Note query tokens appear in
    // reverse-proxy access logs — prefer the header where possible.
    const token = bearerToken(req.headers["authorization"]) ?? url.searchParams.get("token");
    const client = token !== null ? (tokens.get(token) ?? null) : null;
    if (!client) return rpcError(res, 401, "unauthorized: missing or invalid bearer token");

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing && existing.lastSeen < Date.now() - limits.sessionTtlMs) {
      dropSession(sessionId!);
      existing = undefined; // expired -> treated as unknown below
    }
    // A session belongs to the token that opened it — reject a different
    // valid token trying to drive it, even one with the same display name.
    if (existing && existing.token !== token) {
      return rpcError(res, 403, "forbidden: session belongs to a different client");
    }
    if (existing) existing.lastSeen = Date.now();

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req, limits.maxBodyBytes);
      } catch (e) {
        if (e instanceof BodyTooLarge) return rpcError(res, 413, `request body exceeds ${limits.maxBodyBytes} bytes`);
        return rpcError(res, 400, "invalid JSON body");
      }

      let transport: StreamableHTTPServerTransport;
      if (existing) {
        transport = existing.transport;
      } else if (isInitializeRequest(body)) {
        // An initialize is by definition a request for a NEW session, so any
        // session id riding along on it is stale -- ignore it rather than 404.
        // Clients are supposed to drop the id when they see a 404, but some
        // retry initialize with the dead header still attached, and requiring
        // `!sessionId` here sent those straight back to the 404 below with no
        // path out. The id is never adopted: the client always gets a freshly
        // generated one, because the session id is the authorization handle.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            // At capacity, evict the least-recently-seen session first.
            while (sessions.size >= limits.maxSessions) {
              let oldest: string | undefined, oldestSeen = Infinity;
              for (const [k, s] of sessions) if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldest = k; }
              if (!oldest) break;
              dropSession(oldest);
            }
            sessions.set(sid, { transport, token: token!, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = buildServer({
          store, search, pages, service, vaultConfig, findings, contextPath: resolveContextPath(),
          // stdout goes to the journal under macbrain-serve.
          onToolCall: (e) => console.log(formatCallLog(client.name, e)),
        }, client.scopes);
        await server.connect(transport);
      } else if (sessionId) {
        // A non-initialize call on a session id we don't know: restarted,
        // swept, or evicted. 404 is the spec's signal for "start a new session"
        // -- a 400 would read as a malformed request and the client would not
        // re-initialize.
        return rpcError(res, 404, "unknown or expired session id (re-initialize)");
      } else {
        return rpcError(res, 400, "no valid session id (send an initialize request first)");
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        return sessionId
          ? rpcError(res, 404, "unknown or expired session id (re-initialize)")
          : rpcError(res, 400, "missing session id");
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    return rpcError(res, 405, "method not allowed");
  };
}

export interface StartHttpConfig {
  dbPath: string;
  port: number;
  host?: string;
  tokens: Tokens;
  embedder?: EmbedderConfig;
  // An already-built embedder to use instead of `embedder`, so `serve` can
  // share one model between this server and its nightly pass.
  embedderInstance?: Embedder;
  limits?: HttpLimits;
}

// Start the shared HTTP MCP server. Resolves with the listening http.Server (so
// tests can close it); the CLI keeps the process alive after this returns.
export function startHttp(cfg: StartHttpConfig): Promise<Server> {
  const db = openDb(cfg.dbPath);
  const store = new Store(db);
  const embedder = cfg.embedderInstance ?? createEmbedder(cfg.embedder ?? {});
  const pages = new PagesStore(db);
  const service = new PageService(db, pages, embedder);
  const search = new SearchService(db, store, embedder, pages);
  const findings = new FindingsStore(db);
  const handler = buildHttpHandler({ store, search, pages, service, vaultConfig: loadVaultConfig(), tokens: cfg.tokens, findings, limits: cfg.limits });
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) rpcError(res, 500, (e as Error).message);
    });
  });
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host ?? "127.0.0.1", () => resolve(server));
  });
}
