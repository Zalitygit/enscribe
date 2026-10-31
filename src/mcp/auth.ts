import { readFileSync } from "node:fs";
import { ALL_SCOPES } from "./scopes.js";

export interface Client {
  name: string;
  scopes: Set<string>;
}

export type Tokens = Map<string, Client>;

// A tokens file maps bearer token -> { name, scopes }. A scopes entry of "*"
// grants every scope. Example:
//   { "s3cr3t": { "name": "agents", "scopes": ["*"] },
//     "ro-tok": { "name": "reader",    "scopes": ["memory.read", "memory.search"] } }
export function parseTokens(raw: Record<string, { name: string; scopes: string[] }>): Tokens {
  const tokens: Tokens = new Map();
  for (const [token, v] of Object.entries(raw)) {
    const scopes = v.scopes.includes("*") ? new Set<string>(ALL_SCOPES) : new Set(v.scopes);
    tokens.set(token, { name: v.name, scopes });
  }
  return tokens;
}

export function loadTokens(path: string): Tokens {
  return parseTokens(JSON.parse(readFileSync(path, "utf8")));
}

// Extract the raw token from an `Authorization: Bearer <token>` header, or
// null if the header is missing/malformed.
export function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}

// Resolve an `Authorization: Bearer <token>` header to its client, or null if
// the header is missing/malformed or the token is unknown.
export function authenticate(tokens: Tokens, authHeader: string | undefined): Client | null {
  const token = bearerToken(authHeader);
  if (token === null) return null;
  return tokens.get(token) ?? null;
}
