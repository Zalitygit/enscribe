import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PagesStore } from "../pages/store.js";
import type { FindingsStore } from "../findings/ledger.js";
import type { Finding } from "../findings/types.js";
import { bearerToken, type Client, type Tokens } from "../mcp/auth.js";

// The read-only page viewer at /view. The shell (HTML, JS, CSS) is public and
// carries no data; it asks for a token and sends it as a bearer header to
// /view/api/*, which needs pages.read. Finding counts and details are added
// only for a token that also holds findings.read. The query string is never
// accepted for the token here, so tokens stay out of URLs and access logs.
// Like every read path (locked decision 8), nothing here writes.

const VIEWER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../viewer");

// A fixed whitelist, so no request path ever reaches the filesystem.
const ASSETS: Record<string, [file: string, type: string]> = {
  "/view": ["index.html", "text/html; charset=utf-8"],
  "/view/": ["index.html", "text/html; charset=utf-8"],
  "/view/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/view/hyper.js": ["hyper.js", "text/javascript; charset=utf-8"],
  "/view/demo.js": ["demo.js", "text/javascript; charset=utf-8"],
  "/view/app.css": ["app.css", "text/css; charset=utf-8"],
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// The trust fields the viewer shows (spec/okf.md §5.2-5.5), when present.
const TRUST_KEYS = ["status", "verified", "stale_after"];

export function buildViewHandler(deps: { pages: PagesStore; findings: FindingsStore; tokens: Tokens }) {
  const { pages, findings, tokens } = deps;

  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value), { "cache-control": "no-store" });

  // Open findings (open or acknowledged) keyed by the page they are about: a
  // subject that is the slug, or `<slug>:<detail>` (unknown-link-type).
  const findingsBySlug = (): Map<string, Finding[]> => {
    const out = new Map<string, Finding[]>();
    for (const f of [...findings.list({ state: "open" }), ...findings.list({ state: "acknowledged" })]) {
      const slug = f.subject.split(":")[0]!;
      out.set(slug, [...(out.get(slug) ?? []), f]);
    }
    return out;
  };

  // Declined (wont_fix) findings, so the demo can leave alone what the owner
  // has already judged. Red-link kinds are keyed by the link target, not by the
  // page that holds the link; every other kind by slug, as above.
  const TARGET_KINDS = new Set(["unresolved", "red-link"]);
  const declinedBySlug = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const f of findings.list({ state: "wont_fix" })) {
      if (TARGET_KINDS.has(f.kind)) continue;
      const slug = f.subject.split(":")[0]!;
      out.set(slug, [...new Set([...(out.get(slug) ?? []), f.kind])].sort());
    }
    return out;
  };

  const graph = (client: Client) => {
    const live = pages.listPages();
    const kinds = pages.kindsOf(live.map((p) => p.slug));
    const counts = client.scopes.has("findings.read") ? findingsBySlug() : null;
    const declined = counts ? declinedBySlug() : null;
    return {
      nodes: live.map((p) => ({
        slug: p.slug,
        title: p.title,
        kind: kinds.get(p.slug),
        type: p.type,
        ...(counts ? { findings: counts.get(p.slug)?.length ?? 0 } : {}),
        ...(declined?.has(p.slug) ? { declined: declined.get(p.slug) } : {}),
      })),
      links: pages.liveLinks(),
    };
  };

  const page = (client: Client, slug: string) => {
    const p = pages.getPage(slug);
    if (!p || p.deleted_at !== null) return null;
    const { links, unresolved } = pages.getLinks(slug);
    const trust = Object.fromEntries(TRUST_KEYS.filter((k) => k in p.frontmatter).map((k) => [k, p.frontmatter[k]]));
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const live = (xs: string[]) => [...pages.kindsOf(xs).keys()];
    const targets = new Set(unresolved.map((u) => u.raw_text));
    const declined = () => findings.list({ state: "wont_fix" })
      .filter((f) => (TARGET_KINDS.has(f.kind) ? targets.has(f.subject) : f.subject.split(":")[0] === slug))
      .map((f) => ({ kind: f.kind, subject: f.subject }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));
    return {
      slug: p.slug,
      title: p.title,
      kind: pages.kindsOf([slug]).get(slug),
      type: p.type,
      source_path: p.source_path,
      trust,
      body: p.body,
      links: uniq(live(links.map((l) => l.to_slug))),
      unresolved: uniq(unresolved.map((u) => u.raw_text)),
      backlinks: uniq(live(pages.getBacklinks(slug).map((b) => b.from_slug))),
      ...(client.scopes.has("findings.read")
        ? { findings: (findingsBySlug().get(slug) ?? []).map((f) => ({ kind: f.kind, detail: f.detail })), declined: declined() }
        : {}),
    };
  };

  // Returns false for a path outside /view, so the caller can route it on.
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/view" && !url.pathname.startsWith("/view/")) return false;
    if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }

    const asset = ASSETS[url.pathname];
    if (asset) {
      send(res, 200, asset[1], readFileSync(join(VIEWER_DIR, asset[0]), "utf8"), { "content-security-policy": CSP, "cache-control": "no-cache" });
      return true;
    }
    if (!url.pathname.startsWith("/view/api/")) { send(res, 404, "text/plain", "not found"); return true; }

    const token = bearerToken(req.headers["authorization"]);
    const client = token !== null ? tokens.get(token) : undefined;
    if (!client) { json(res, 401, { error: "missing or invalid bearer token" }); return true; }
    if (!client.scopes.has("pages.read")) { json(res, 403, { error: "token lacks pages.read" }); return true; }

    if (url.pathname === "/view/api/graph") { json(res, 200, graph(client)); return true; }
    if (url.pathname === "/view/api/page") {
      const slug = url.searchParams.get("slug");
      if (!slug) { json(res, 400, { error: "slug is required" }); return true; }
      const p = page(client, slug);
      json(res, p ? 200 : 404, p ?? { error: "not_found", slug });
      return true;
    }
    if (url.pathname === "/view/api/search") {
      const q = url.searchParams.get("q");
      if (q === null) { json(res, 400, { error: "q is required" }); return true; }
      json(res, 200, { slugs: pages.slugsMatchingText(q, { word: url.searchParams.get("word") === "1" }) });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  };
}
