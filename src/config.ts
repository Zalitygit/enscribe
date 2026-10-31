import { join } from "node:path";
import type { EmbedderConfig } from "./embed/index.js";
import { dataDir, defaultDbFile, env } from "./env.js";

export function resolveDbPath(): string {
  return env("DB") ?? defaultDbFile();
}

export function resolveEmbedderConfig(): EmbedderConfig {
  if (env("EMBED_BACKEND") === "fake") return { backend: "fake" };
  const url = env("EMBED_URL");
  if (url) {
    return { backend: "http", httpUrl: url, httpModel: env("EMBED_MODEL") };
  }
  return { backend: "onnx" };
}

export function resolvePort(): number {
  const p = Number(env("PORT"));
  return Number.isInteger(p) && p > 0 ? p : 3134;
}

export function resolveHost(): string | undefined {
  return env("HOST"); // undefined -> bind 127.0.0.1 (Caddy proxies)
}

export function resolveTokensPath(): string {
  return env("TOKENS") ?? join(dataDir(), "tokens.json");
}

// The current-context digest: a file written by an external digest job
// and served only through the context.read-gated current_context tool. It is
// never ingested, so search and the page tools cannot surface it.
export function resolveContextPath(): string {
  return env("CONTEXT_FILE") ?? join(dataDir(), "context", "current-context.md");
}
