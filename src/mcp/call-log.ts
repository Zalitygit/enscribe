import { findSecrets } from "../pages/secret-guard.js";

// One line per MCP tools/call, so the shared server keeps its own record of
// who asked what and how it went. Before this the only trace was each host's
// Claude Code transcripts, and Caddy's access log, which sees a POST on a
// session id but never the tool name.
//
// Only identifying arguments are logged (ARG_KEYS is an allowlist), so page
// bodies, edit text and finding detail never reach the journal. A value that
// looks like a credential is replaced by its secret-guard rule.

export interface ToolCallEvent {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  result?: unknown;
  error?: unknown;
}

const ARG_KEYS = ["query", "topic", "slug", "section", "page", "path", "text", "key", "kind", "state", "subject", "id", "days"];
const CAP = 120;

const cap = (s: string) => (s.length > CAP ? s.slice(0, CAP - 1) + "…" : s);

function logArg(v: unknown): unknown {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const hits = findSecrets(v);
  return hits.length ? `[redacted: ${hits[0].rule}]` : cap(v);
}

function parsedText(result: unknown): { text?: string; isError: boolean } {
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
  const first = r?.content?.[0];
  return { text: first?.type === "text" ? first.text : undefined, isError: r?.isError === true };
}

export function summarizeCall(e: ToolCallEvent): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const k of ARG_KEYS) {
    const v = logArg(e.args[k]);
    if (v !== undefined) args[k] = v;
  }
  // get_pages: one "slug" or "slug#section" per item, so batched reads count
  // toward section uptake like single get_page calls do.
  if (Array.isArray(e.args.pages)) {
    args.pages = e.args.pages.slice(0, 10).map((p: any) =>
      logArg(typeof p?.section === "string" ? `${p?.slug}#${p.section}` : String(p?.slug)));
  }
  const out: Record<string, unknown> = { tool: e.tool, args, ms: e.ms };
  if (e.error !== undefined) {
    out.error = cap(e.error instanceof Error ? e.error.message : String(e.error));
    return out;
  }
  const { text, isError } = parsedText(e.result);
  if (isError) {
    out.error = cap(text ?? "error");
    return out;
  }
  let data: any;
  try { data = text === undefined ? undefined : JSON.parse(text); } catch { return out; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  if (Array.isArray(data.hits)) {
    out.hits = data.hits.length;
    const top = data.hits[0];
    if (top) out.top = top.slug ?? top.id;
  }
  if (typeof data.confident === "boolean") out.confident = data.confident;
  if (typeof data.reason === "string") out.reason = data.reason;
  if (data.error === "not_found") out.not_found = true;
  if (data.truncated === true) out.truncated = true;
  if (typeof data.resolved_from === "string") out.resolved_from = logArg(data.resolved_from);
  if (data.ok === false) out.ok = false;
  return out;
}

export const formatCallLog = (client: string, e: ToolCallEvent): string =>
  `tool_call ${JSON.stringify({ client, ...summarizeCall(e) })}`;
