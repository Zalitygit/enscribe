import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../core/store.js";
import type { MemoryRecord } from "../core/types.js";
import { SEARCH_INTENTS, assessConfidence, type SearchService } from "../search/index.js";
import { SCOPES } from "./scopes.js";
import { serverInstructions, USAGE_GUIDE_ALIAS } from "./instructions.js";
import { recordShape, recordInputSchema, typeEnum } from "../schema.js";
import type { PagesStore } from "../pages/store.js";
import type { PageService } from "../pages/service.js";
import type { VaultConfig } from "../pages/vault-config.js";
import { readFileSync, statSync } from "node:fs";
import { putPage } from "../pages/put-page.js";
import { editPage } from "../pages/edit-page.js";
import { splitSections, EDGE_TYPES } from "../pages/parse.js";
import type { FindingsStore } from "../findings/ledger.js";
import { APPENDABLE_KINDS, REPORTABLE_KINDS, type Finding } from "../findings/types.js";
import { normalizeDue } from "../findings/due.js";
import { appendFinding } from "../findings/append.js";
import type { ToolCallEvent } from "./call-log.js";
import { pageHistoryOf } from "../pages/history.js";
import { SENSITIVE } from "../pages/generators/activity-digest.js";

// get_page cuts a body here unless told otherwise. The harness's tool-output
// cap sits around 25K tokens; measured 2026-09-09, a 101 KB page failed every
// read and a 64 KB findings list overflowed, so this is a body that fits with
// room for the JSON envelope. An over-cap page gets an outline instead.
export const PAGE_MAX_CHARS = 60_000;
export const GET_PAGES_MAX = 10;

// Nearest live slugs to a missed get_page request: share of the request's
// tokens that appear in a page's slug or title, ties to the shorter slug, top
// five with a non-zero score. A full scan over ~200 pages per miss is cheap
// and needs no index; a miss is the rare path.
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
export function nearestSlugs(request: string, candidates: { slug: string; title: string }[], limit = 5): string[] {
  const want = [...tokens(request)];
  if (want.length === 0) return [];
  return candidates
    .map((c) => {
      const have = new Set([...tokens(c.slug), ...tokens(c.title)]);
      return { slug: c.slug, score: want.filter((t) => have.has(t)).length / want.length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug))
    .slice(0, limit)
    .map((c) => c.slug);
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// The record and its keyword row are already committed when the vector is
// embedded, so an embedding failure is not a failed write. Report it beside
// the result (as put_page reports ingestError): a caller told the write failed
// retries it, and each retry stores another copy. `reindex` heals the vector.
async function indexed(search: SearchService, rec: MemoryRecord): Promise<{ indexError?: string }> {
  try {
    await search.index(rec);
    return {};
  } catch (e) {
    return { indexError: String(e) };
  }
}


// `allowedScopes` gates each tool by its declared scope. Omit it (or pass
// undefined) for full-trust local use (stdio); pass an authenticated client's
// scopes for the shared HTTP server so, e.g., a read-only token can't forget.
export function buildServer(
  deps: {
    store: Store; search: SearchService; pages?: PagesStore; service?: PageService; vaultConfig?: VaultConfig; findings?: FindingsStore; contextPath?: string;
    // Called after every tool call (src/mcp/call-log.ts). Only the HTTP server
    // sets it: on stdio, stdout is the MCP channel itself.
    onToolCall?: (e: ToolCallEvent) => void;
  },
  allowedScopes?: Set<string>,
): McpServer {
  const { store, search, pages, service, vaultConfig, findings } = deps;
  const can = (tool: string) => !allowedScopes || allowedScopes.has(SCOPES[tool as keyof typeof SCOPES]);
  const server = new McpServer({ name: "enscribe", version: "0.0.0" }, {
    instructions: serverInstructions({
      can,
      hasPages: !!pages,
      hasFindings: !!findings,
      hasHistory: !!(pages && vaultConfig),
      guideSlug: pages?.resolve(USAGE_GUIDE_ALIAS) ?? null,
    }),
  });

  const require = (scope: string) => {
    if (allowedScopes && !allowedScopes.has(scope)) {
      throw new Error(`permission denied: this client lacks the '${scope}' scope`);
    }
  };

  // A tool whose scope this client lacks is not registered at all, so
  // tools/list only shows what the client can actually invoke. The require()
  // calls inside each handler stay as defense in depth. A name missing from
  // SCOPES fails closed for scoped clients (hidden, never callable).
  const registerTool: McpServer["registerTool"] = (name, config, cb) => {
    if (!can(name)) {
      return undefined as unknown as ReturnType<McpServer["registerTool"]>;
    }
    const hook = deps.onToolCall;
    if (!hook) return server.registerTool(name, config as never, cb as never);
    // A failing hook must never fail the call it is reporting.
    const report = (e: ToolCallEvent) => { try { hook(e); } catch { /* logging only */ } };
    const logged = async (...a: unknown[]) => {
      const args = (a.length > 1 && a[0] && typeof a[0] === "object" ? a[0] : {}) as Record<string, unknown>;
      const start = Date.now();
      try {
        const result = await (cb as (...x: unknown[]) => unknown)(...a);
        report({ tool: name, args, ms: Date.now() - start, result });
        return result;
      } catch (error) {
        report({ tool: name, args, ms: Date.now() - start, error });
        throw error;
      }
    };
    return server.registerTool(name, config as never, logged as never);
  };

  registerTool("add_memory",
    { description: `Create a canonical memory record (a durable fact, decision, or preference). For notes that belong in the git vault, use put_page instead. A result carrying indexError was still stored (keyword-searchable, vector pending); do not retry it. Scope: ${SCOPES.add_memory}`, inputSchema: recordShape },
    async (args) => {
      require(SCOPES.add_memory);
      const rec = store.add(args as any);
      return json({ ...rec, ...(await indexed(search, rec)) });
    });

  registerTool("get_record",
    { description: `Fetch one record by id. Use after search_memory returns an id you want in full. Scope: ${SCOPES.get_record}`, inputSchema: { id: z.string() } },
    async ({ id }) => { require(SCOPES.get_record); return json(store.get(id) ?? null); });

  registerTool("search_memory",
    { description: `Search records only, hybrid FTS + vector. Prefer the unified 'search' tool unless you specifically need records and not pages. Scope: ${SCOPES.search_memory}`,
      inputSchema: { query: z.string(), type: typeEnum.optional(), limit: z.number().optional() } },
    async ({ query, type, limit }) => {
      require(SCOPES.search_memory);
      const hits = await search.search(query, { type: type as any, limit });
      return json({ hits: hits.map((h) => ({ id: h.record.id, score: h.score, fts: h.fts, vector: h.vector, record: h.record })) });
    });

  registerTool("update_memory",
    { description: `Revise a record, creating a superseding version. The prior version stays in the lineage; it is not overwritten. Scope: ${SCOPES.update_memory}`,
      inputSchema: { id: z.string(), patch: recordInputSchema.partial() } },
    async ({ id, patch }) => {
      require(SCOPES.update_memory);
      const rec = store.update(id, patch as any);
      return json({ ...rec, ...(await indexed(search, rec)) });
    });

  registerTool("link_records",
    { description: `Add a relationship edge between two records. Appends to the current lineage head, so it never forks a record. Scope: ${SCOPES.link_records}`,
      inputSchema: { subject: z.string(), predicate: z.string(), object: z.string() } },
    async ({ subject, predicate, object }) => {
      require(SCOPES.link_records);
      const head = store.currentOf(subject);
      if (!head) return json({ ok: false, error: "no such record" });
      const rec = store.update(head.id, { relationships: [...head.relationships, { predicate, object }] });
      return json({ ok: true, id: rec.id, ...(await indexed(search, rec)) });
    });

  registerTool("list_recent",
    { description: `List recent live records, newest first. Use for "what did I record lately", not for lookup by topic. Scope: ${SCOPES.list_recent}`,
      inputSchema: { project: z.string().optional(), since: z.string().optional(), limit: z.number().optional() } },
    async ({ project, since, limit }) => {
      require(SCOPES.list_recent);
      return json({ records: store.listCurrent({ project, since, limit: limit ?? 20 }) });
    });

  registerTool("forget_record",
    { description: `Tombstone a record AND its whole version lineage. This is not reversible through the API; prior versions do not resurface. Scope: ${SCOPES.forget_record}`,
      inputSchema: { id: z.string(), hard: z.boolean().optional() } },
    async ({ id, hard }) => { require(SCOPES.forget_record); store.forget(id, hard ?? false); return json({ ok: true }); });

  registerTool("summarize_context",
    { description: `Return the retrieved record set for a topic. Returns raw rows, NOT an LLM summary: the caller does the synthesis. Scope: ${SCOPES.summarize_context}`,
      inputSchema: { topic: z.string(), limit: z.number().optional() } },
    async ({ topic, limit }) => {
      require(SCOPES.summarize_context);
      const hits = await search.search(topic, { limit: limit ?? 8 });
      return json({ topic, context: hits.map((h) => h.record) });
    });

  if (pages) {
    registerTool("search",
      { description: `Primary recall tool. Unified hybrid search over vault pages and memory records, fusing keyword (FTS5) and semantic (vector) ranking with RRF, so it finds both exact terms and conceptual matches in one call. Start here; reach for get_page once you know the slug. Pass \`intent\` describing the SHAPE of your question — you know what you are asking and this server deliberately does not guess. 'confident' describes how well the QUERY matched (a top hit reached by both keyword and vector, close enough in meaning); it does not mean the answer is in that page. A confident hit can be the right page that never states the fact you need, so read the text before relying on it, and when 'confident' is false treat the result as nothing found. Each page hit's 'chunk' is the section the keyword ranking chose, and its 'section' (absent for text before the first heading) is that heading in the form get_page's 'section' accepts; 'vector_heading', when present, names a different section the semantic ranking chose, which get_page can fetch the same way. Fetch the section first and read the whole page only when it does not answer the question. Scope: ${SCOPES.search}`,
        inputSchema: {
          query: z.string(),
          limit: z.number().optional(),
          // This description is the whole directive channel. An MCP server has no
          // system prompt: the calling model sees the tool description and these
          // parameter descriptions and nothing else, so the instruction on WHEN to
          // send each value has to live here, phrased in the caller's terms rather
          // than as a bare enum of internal labels.
          intent: z.enum(SEARCH_INTENTS).optional().describe(
            "The shape of the question: `entity` (about one specific thing — a host, "
            + "service, person, company, repo), `temporal`, `superseded`, `multihop`, "
            + "`causal` or `factual`. Accepted so you can label a question honestly, but "
            + "today every value retrieves exactly as omitting the field does: each "
            + "special plan, including the linked-page expansion `entity` used to add, "
            + "was tested against the benchmark and made results worse, so none is "
            + "wired up. Omitting the field is always safe.",
          ),
        } },
      async ({ query, limit, intent }) => {
        require(SCOPES.search);
        const hits = await search.searchUnified(query, { limit, intent });
        return json({ hits, ...assessConfidence(hits) });
      });

    // One get_page read, shared by get_page and get_pages. A miss on the exact
    // slug falls through the alias/slugify tiers, so a title or alias typed
    // where a slug was wanted still serves the page; `resolved_from` tells the
    // caller the canonical slug for next time. `cap` applies to a whole page
    // only; a section is returned whole.
    const readPage = (slug: string, section: string | undefined, cap: number): Record<string, any> => {
      const exact = pages.getPage(slug);
      const resolved = exact && !exact.deleted_at ? null : pages.resolve(slug);
      const p = exact && !exact.deleted_at ? exact : resolved ? pages.getPage(resolved) : undefined;
      if (!p || p.deleted_at) return { error: "not_found", slug, suggestions: nearestSlugs(slug, pages.slugTitles()) };
      const via = resolved && resolved !== slug ? { resolved_from: slug } : {};
      const outline = () => splitSections(p.body).map((s) => ({ heading: s.heading, level: s.level, chars: s.text.length }));
      if (section !== undefined) {
        const want = section.trim().toLowerCase();
        const hit = splitSections(p.body).find((s) => s.heading.toLowerCase() === want);
        if (!hit) return { error: "not_found", slug: p.slug, section, sections: outline() };
        return { slug: p.slug, title: p.title, section: hit.heading, body: hit.text, ...via };
      }
      if (p.body.length <= cap) return { ...p, ...via };
      return { ...p, body: p.body.slice(0, cap), truncated: true, total_chars: p.body.length, sections: outline(), ...via };
    };

    registerTool("get_page",
      { description: `Fetch one page by slug. When a search hit carries 'section', pass it here to get only that section; many pages are 30-50 KB. A title or alias also works: a miss on the exact slug falls through the alias and slugify tiers and the page comes back with 'resolved_from' set. A true miss returns {error: not_found, suggestions: [nearest live slugs]} rather than null. A body over ${PAGE_MAX_CHARS} chars comes back cut at that point with 'truncated: true', 'total_chars' and a 'sections' outline (heading, level, chars); pass 'section' (a heading's text, case-insensitive) to fetch just that section, or 'max_chars' to change the cap. Scope: ${SCOPES.get_page}`,
        inputSchema: { slug: z.string(), section: z.string().optional(), max_chars: z.number().optional() } },
      async ({ slug, section, max_chars }) => {
        require(SCOPES.get_page);
        return json(readPage(slug, section, max_chars ?? PAGE_MAX_CHARS));
      });

    // Several get_page reads in one call (claude-mem's get_observations(ids)
    // shape). One body budget covers the whole batch, spent in request order,
    // so ten large pages cannot overflow a client's tool-output cap.
    registerTool("get_pages",
      { description: `Fetch up to ${GET_PAGES_MAX} pages or sections in one call: 'pages' is a list of {slug, section?}, and each result has exactly get_page's shape, in request order (a miss is that item's {error: not_found, ...}, not a failed call). Use it when a search returned several hits worth reading, passing each hit's 'section'. The bodies share one ${PAGE_MAX_CHARS}-char budget, spent in order; an item past it comes back cut with 'truncated: true' and 'total_chars' (and the 'sections' outline for a whole page), so list the most important first. Scope: ${SCOPES.get_pages}`,
        inputSchema: { pages: z.array(z.object({ slug: z.string(), section: z.string().optional() })).min(1).max(GET_PAGES_MAX) } },
      async ({ pages: wanted }) => {
        require(SCOPES.get_pages);
        let left = PAGE_MAX_CHARS;
        const out = wanted.map(({ slug, section }) => {
          const r = readPage(slug, section, left);
          if (typeof r.body === "string" && r.body.length > left) {
            // Only a section can overrun: a whole page was already cut to `left`.
            Object.assign(r, { body: r.body.slice(0, left), truncated: true, total_chars: r.body.length });
          }
          if (typeof r.body === "string") left -= r.body.length;
          return r;
        });
        return json({ pages: out });
      });

    // Reads the vault's git log, so it needs the vault root. Commit subjects are
    // free text the deny-list never sees; the activity-digest filter withholds
    // the sensitive ones and the count says so.
    if (vaultConfig) {
      registerTool("page_history",
        { description: `When a page was first added, when it last changed, and every commit that changed it, newest first (ISO time + commit subject), from the vault's git history. Use it for questions only the history answers: when something was written down, how often a page was revised, what changed in a given week. search finds pages by their text and cannot see this. A pure rename is not a change, and commits made under a page's old path count toward it. A title or alias works as with get_page. 'limit' (default 50) caps the list; 'total' is always the full count. Commits whose subjects match the sensitive-subject filter are left out and counted in 'withheld'. Generated pages have no source file and so no history. Scope: ${SCOPES.page_history}`,
          inputSchema: { slug: z.string(), limit: z.number().optional() } },
        async ({ slug, limit }) => {
          require(SCOPES.page_history);
          const exact = pages.getPage(slug);
          const resolved = exact && !exact.deleted_at ? null : pages.resolve(slug);
          const p = exact && !exact.deleted_at ? exact : resolved ? pages.getPage(resolved) : undefined;
          if (!p || p.deleted_at) return json({ error: "not_found", slug, suggestions: nearestSlugs(slug, pages.slugTitles()) });
          const via = resolved && resolved !== slug ? { resolved_from: slug } : {};
          if (!p.source_path) return json({ error: "no_source_file", slug: p.slug, ...via });
          const all = pageHistoryOf(vaultConfig.root, p.source_path);
          const shown = all.filter((c) => !SENSITIVE.test(c.subject));
          const n = limit !== undefined && limit > 0 ? Math.floor(limit) : 50;
          // git's %cI keeps each committer's own offset, so a vault written from
          // a laptop and a UTC server mixes -04:00 and Z. Report UTC so the dates compare
          // as strings; one git cannot parse is passed through as-is.
          const utc = (iso: string) => {
            const t = new Date(iso);
            return isNaN(t.getTime()) ? iso : t.toISOString().replace(/\.000Z$/, "Z");
          };
          const first = all.at(-1);
          return json({
            slug: p.slug, title: p.title, source_path: p.source_path, total: all.length,
            first_added: first ? utc(first.iso) : null, last_changed: all[0] ? utc(all[0].iso) : null,
            commits: shown.slice(0, n).map((c) => ({ date: utc(c.iso), subject: c.subject })),
            ...(all.length > shown.length ? { withheld: all.length - shown.length } : {}),
            ...(shown.length > n ? { truncated: true } : {}),
            ...via,
          });
        });
    }

    registerTool("list_pages",
      { description: `List pages (slug/title/source_path). An inventory, not a search: it does not rank or filter by relevance. Use 'search' to find something. Scope: ${SCOPES.list_pages}`, inputSchema: { limit: z.number().optional() } },
      async ({ limit }) => {
        require(SCOPES.list_pages);
        const n = limit !== undefined && limit > 0 ? Math.floor(limit) : 50;
        const rows = pages.listPages().slice(0, n);
        return json({ pages: rows.map((p) => ({ slug: p.slug, title: p.title, source_path: p.source_path })) });
      });

    // Same directive-channel rule as search's `intent`: the caller sees only
    // this text, so it says when to send a type, in the caller's terms.
    const linkType = z.enum(EDGE_TYPES).optional().describe(
      "Only return links of this type. Typed links read \"this page <type> target\": "
      + "`runs-on` (service → host), `depends-on` (breaks if target breaks), "
      + "`source-in` (thing → its repo), `replaces` (new → old), `part-of` "
      + "(component → system), `owned-by` (asset → owner), `disambiguates` "
      + "(name page → each meaning), `falls-back-to` (primary → fallback). "
      + "`wikilink` is an untyped mention, `mdlink` a relative Markdown link to a .md file, `source` a frontmatter provenance edge. "
      + "Few pages are typed yet, so omit this unless you need one relationship; "
      + "omitting it returns every link.");

    registerTool("get_links",
      { description: `Outbound links from a page, each with its link_type, plus its unresolved link targets (omitted when \`type\` is set). Use to walk forward from a page; with \`type: "runs-on"\` on a service, to find its host. Scope: ${SCOPES.get_links}`, inputSchema: { slug: z.string(), type: linkType } },
      async ({ slug, type }) => { require(SCOPES.get_links); return json(pages.getLinks(slug, type)); });

    registerTool("get_backlinks",
      { description: `Inbound links to a page, each with its link_type: what cites this. Use to judge whether a page is load-bearing before editing it; with \`type: "runs-on"\` on a host, to list what runs there. Scope: ${SCOPES.get_backlinks}`, inputSchema: { slug: z.string(), type: linkType } },
      async ({ slug, type }) => { require(SCOPES.get_backlinks); return json({ backlinks: pages.getBacklinks(slug, type) }); });

    registerTool("resolve_slug",
      { description: `Resolve a slug, alias, or title to a canonical slug. Tries exact slug, then the alias table, then slugification. An ambiguous alias is absent from the alias table and falls through to slugification, so it is not guaranteed to return null; returns null only when nothing at any tier matches. Scope: ${SCOPES.resolve_slug}`, inputSchema: { text: z.string() } },
      async ({ text }) => { require(SCOPES.resolve_slug); return json({ slug: pages.resolve(text) }); });

    registerTool("doctor",
      { description: `Pages index health: page count, unresolved links, orphans, chunk provenance, and last vault sync. Operational telemetry, not knowledge; use 'search' to answer questions. The orphan count uses the 'orphans' tool's definition, which includes raw/ and daily/ pages; the finding ledger's orphan items skip those prefixes, so its count is lower by design. Scope: ${SCOPES.doctor}`, inputSchema: {} },
      async () => { require(SCOPES.doctor); return json(pages.pageHealth()); });

    registerTool("orphans",
      { description: `Live authored pages with no inbound links, i.e. unreachable from the rest of the graph. Excludes generated pages. Includes raw/ and daily/ pages (session notes and dailies), which the finding ledger's orphan detector skips because they are not meant to be linked to, so this list is longer than the ledger's orphan items. Neither count is wrong. Scope: ${SCOPES.orphans}`, inputSchema: {} },
      async () => { require(SCOPES.orphans); return json({ orphans: pages.orphans() }); });

    registerTool("recent_pages",
      { description: `Pages changed within N days (default 14), by authored date where known. "What moved lately", not topical lookup. Scope: ${SCOPES.recent_pages}`, inputSchema: { days: z.number().optional() } },
      async ({ days }) => { require(SCOPES.recent_pages); return json({ pages: pages.recentPages(days ?? 14) }); });

    if (service && vaultConfig) {
      registerTool("put_page",
        { description: `Write a page to the vault, git-commit that one file, and ingest it. The markdown file is canonical. Refuses a denied path, a generator-owned slug, a slug another live file owns, a dirty working tree, placeholder/error-page content, or credential-shaped text (keep secrets in the secrets store and name the key). The result carries 'inbound' (wikilinks to this page from ingested pages) and 'orphan' (inbound is 0): an orphaned page is invisible to the graph, so link it from the page that owns its subject in the same session. 'backlinks' names the pages linking here: if this write changed a fact, check them. It also carries 'unresolved' (this page's link targets that match no page): fix each, usually a misspelled or retired slug, before moving on. Scope: ${SCOPES.put_page}`,
          inputSchema: { path: z.string(), content: z.string() } },
        async ({ path, content }) => {
          require(SCOPES.put_page);
          return json(await putPage(vaultConfig, service, pages, { path, content }));
        });
      registerTool("edit_page",
        { description: `Change one exact piece of text on an authored page, committed, pushed and re-ingested on the server. Use it to correct or extend a page in place instead of put_page, which replaces the whole file. 'old' must occur exactly once in the file (the result reports the count when it does not: lengthen 'old'); to append, pass an anchor line as 'old' and repeat it in 'new' with the addition. Refuses generated pages, frontmatter changes, a dirty file, a vault that cannot fast-forward, or a 'new' holding credential-shaped text. The result carries the same 'backlinks' as put_page. If a call returns an error, get_page before retrying: an append whose first call failed late would otherwise be added twice. Scope: ${SCOPES.edit_page}`,
          inputSchema: { page: z.string(), old: z.string(), new: z.string() } },
        async ({ page, old, new: replacement }) => {
          require(SCOPES.edit_page);
          return json(await editPage(vaultConfig, service, pages, { page, old, new: replacement }));
        });
    }
  }

  if (findings) {
    registerTool("findings",
      { description: `Items from the nightly mechanical detectors, the gardener, and add_finding. By default lists OPEN items as summaries (key, kind, subject, state, due, summary, first_seen, times_reported, doc) — 'summary' is the first line of detail, which is written to be the whole ask; the full detail is a whole handoff and a full list overflows the tool-output cap. Pass 'key' (kind:subject) to get one item in full, 'state' to filter ("all" lifts the default), 'full' for whole rows. The caller does the synthesis. To remind the owner of outstanding items, order by: past due first, then most times_reported, then oldest first_seen. Reminding is not resolving: an item closes only when the condition is checked and gone, and the owner closes it. Scope: ${SCOPES.findings}`,
        inputSchema: { state: z.string().optional(), kind: z.string().optional(), key: z.string().optional(), full: z.boolean().optional() } },
      async ({ state, kind, key, full }) => {
        require(SCOPES.findings);
        if (key) {
          const one = findings.get(key);
          return json({ findings: one ? [one] : [] });
        }
        const wanted = state ?? "open";
        const rows = findings.list({ state: wanted === "all" ? undefined : (wanted as any), kind });
        // First non-blank line of detail, capped at 96 like the needs-human hook.
        const firstLine = (detail: string) => {
          const line = detail.split("\n").map(l => l.trim()).find(l => l) ?? "";
          return line.length > 96 ? line.slice(0, 95) + "…" : line;
        };
        const summary = ({ key, kind, subject, state, due, detail, first_seen, times_reported, doc }: Finding) =>
          ({ key, kind, subject, state, due, summary: firstLine(detail), first_seen, times_reported, doc });
        return json({ findings: full ? rows : rows.map(summary) });
      });

    registerTool("report_findings",
      { description: `Record findings this caller detected. 'kinds' declares which kinds the caller is authoritative for on THIS call: findings of those kinds that are absent from the payload are RESOLVED, and a previously-resolved finding of a declared kind that reappears is REOPENED — every other kind is left untouched. Reportable kinds: ${REPORTABLE_KINDS.join(", ")}. Any other declared kind is rejected, and rejection is all-or-nothing — nothing is written if any declared kind is rejected. Scope: ${SCOPES.report_findings}`,
        inputSchema: {
          kinds: z.array(z.string()),
          findings: z.array(z.object({ kind: z.string(), subject: z.string(), detail: z.string() })),
        } },
      async ({ kinds, findings: payload }) => {
        require(SCOPES.report_findings);
        // A findings.report client (e.g. the gardener) must never be able to
        // resolve kinds it isn't authoritative for: it could otherwise
        // enumerate every kind via `findings` and claim it here with an
        // empty payload to wipe out MacBrain's own detector findings. A
        // whitelist (not just excluding DAEMON_KINDS) also stops an
        // invented kind or a near-miss like "Orphan"/"orphan " from being
        // accepted and rendered under an unrecognised, unattributable
        // heading. Checked before reconcile() runs, and covers every
        // declared kind before writing any of them, so a rejection can
        // never be partial.
        const notReportable = kinds.filter((k) => !REPORTABLE_KINDS.includes(k));
        if (notReportable.length > 0) {
          throw new Error(`report_findings: kind(s) [${notReportable.join(", ")}] are not reportable by this caller (reportable: ${REPORTABLE_KINDS.join(", ")}); nothing was reconciled`);
        }
        return json(findings.reconcile(kinds, payload, "gardener", new Date().toISOString()));
      });

    registerTool("add_finding",
      { description: `File ONE item that needs a human. Appends only: unlike report_findings, this never resolves anything, so a caller may file the single item it just found without knowing what else is outstanding. Re-filing the same subject refreshes detail/due/doc and counts the repeat; it reopens a resolved item but leaves a wont_fix one declined. 'subject' is the identity — reuse the existing one to update an item, and call 'findings' first to see what is already open. The result says whether the row was 'created' or re-filed ('times_reported'), and 'similar' lists open same-kind keys whose subject shares a word with this one — a near-duplicate to fold into, or to ignore if it is genuinely distinct. 'due' takes a bare YYYY-MM-DD (stored as end of that day, UTC) or a full ISO-8601 instant; an item with no due date is never nagged about, only counted. 'doc' is the SLUG of a page that holds the assignment — pass it when the work is a plan, a migration, or anything that will change as it is worked, because 'detail' is a snapshot while a page can be edited and linked; still put enough in 'detail' to act without opening it, and write the FIRST LINE of 'detail' as the whole summary, since that is all the session-start hook shows. A 'doc' naming a page that does not exist yet is accepted on purpose — filing the ask before writing the page is the normal order — and the readers report the miss rather than refusing the write. Kind 'todo' is a dated item for the owner; close one with \`enscribe findings resolve todo:<subject> "<reason>"\`. Kind 'alert' is something happening now that the owner should see soon (a service down, an account overdrawn, a deadline today); the desk panel shows open alerts as a red banner, so resolve one with \`enscribe findings resolve alert:<subject> "<reason>"\` as soon as the condition clears. Scripts file the same rows with \`enscribe findings add\`. Appendable kinds: ${APPENDABLE_KINDS.join(", ")}. Scope: ${SCOPES.add_finding}`,
        inputSchema: {
          kind: z.string(),
          subject: z.string(),
          detail: z.string(),
          due: z.string().optional(),
          doc: z.string().optional(),
        } },
      async ({ kind, subject, detail, due, doc }) => {
        require(SCOPES.add_finding);
        // Kind whitelist, subject/due normalizers and the `similar` hint all
        // live in appendFinding, which the `findings add` CLI shares, so the
        // two write paths cannot drift apart. It throws before writing.
        const wrote = appendFinding(findings, { kind, subject, detail, due, doc }, "add_finding", new Date().toISOString());
        // Report whether the named page actually resolves, but never refuse on
        // it: filing the ask before writing the page is the normal order, so a
        // miss is information for the caller, not an error. `doc_resolved` is
        // absent entirely when no doc was given.
        const docResolved = doc && deps.pages ? deps.pages.resolve(doc) !== null : undefined;
        return json({
          ok: true, ...wrote,
          ...(doc ? { doc, doc_resolved: docResolved } : {}),
        });
      });

    registerTool("set_finding_state",
      { description: `Set a finding's state: open | acknowledged | wont_fix | resolved. wont_fix is sticky — a wont_fix finding that is re-detected stays silent, and clears only when the condition itself disappears. Scope: ${SCOPES.set_finding_state}`,
        inputSchema: {
          key: z.string(),
          state: z.enum(["open", "acknowledged", "wont_fix", "resolved"]),
          note: z.string().optional(),
        } },
      async ({ key, state, note }) => {
        require(SCOPES.set_finding_state);
        findings.setState(key, state, note ?? null, new Date().toISOString());
        return json({ ok: true });
      });

    registerTool("set_finding_field",
      { description: `Patch ONE existing finding's 'detail', 'due' or 'doc', leaving everything you do not pass alone. Use this instead of re-filing with add_finding when you only want to change one field: add_finding is "file this item", not "patch this field", so it REPLACES detail/due/doc and a short re-file silently destroys a long handoff. Omitting a field leaves it; passing null CLEARS it (that is the only way to unset a 'doc' or a 'due'). Never touches state, note, times_reported or last_seen — a patch is not the caller re-asserting the ask, and judgment belongs to set_finding_state. 'detail' may only be patched on an appendable kind (${APPENDABLE_KINDS.join(", ")}): every other kind is refreshed from its detector on the next sweep, which would silently overwrite the edit. 'due' and 'doc' are patchable on any kind, because no detector writes them. Scope: ${SCOPES.set_finding_field}`,
        inputSchema: {
          key: z.string(),
          detail: z.string().optional(),
          due: z.string().nullable().optional(),
          doc: z.string().nullable().optional(),
        } },
      async ({ key, detail, due, doc }) => {
        require(SCOPES.set_finding_field);
        const existing = findings.get(key);
        if (!existing) throw new Error(`set_finding_field: no such finding '${key}'`);
        // A detector rewrites `detail` from scratch on every reconcile, so an
        // edit to one would be gone by tomorrow with nothing to show it ever
        // happened. `due`/`doc` are safe on any kind — no detector writes
        // them — which is why this refuses on the field, not on the kind.
        if (detail !== undefined && !APPENDABLE_KINDS.includes(existing.kind)) {
          throw new Error(
            `set_finding_field: refusing to patch 'detail' on kind '${existing.kind}' — it is rewritten by its detector on the next sweep, so the edit would be silently lost. Appendable kinds: ${APPENDABLE_KINDS.join(", ")}. ('due' and 'doc' are patchable on any kind.)`,
          );
        }
        findings.setFields(
          key,
          {
            ...(detail !== undefined ? { detail } : {}),
            ...(due !== undefined ? { due: normalizeDue(due) } : {}),
            ...(doc !== undefined ? { doc } : {}),
          },
          new Date().toISOString(),
        );
        const after = findings.get(key)!;
        return json({
          ok: true,
          key,
          changed: [detail !== undefined ? "detail" : null, due !== undefined ? "due" : null, doc !== undefined ? "doc" : null].filter(Boolean),
          ...(after.doc ? { doc: after.doc, doc_resolved: deps.pages ? deps.pages.resolve(after.doc) !== null : undefined } : {}),
        });
      });
  }

  // The current-context digest written by an external digest job from
  // the owner's mail and iMessage. A file, never a page: it is not ingested, so search
  // and the page tools cannot surface it, and only context.read can read it.
  if (deps.contextPath) registerTool("current_context",
    { description: `What is in flight in the owner's life right now — orders, moves, payments, family logistics, deadlines and cross-thread conflicts — distilled every 4 hours from their mail and messages. Read it at the start of any task about their personal affairs, and before answering about an order, a bill, a carrier, travel or a family member: the conflict you need is often in another thread. Returns markdown plus its age. Scope: ${SCOPES.current_context}`,
      inputSchema: {} },
    async () => {
      require(SCOPES.current_context);
      const path = deps.contextPath!;
      try {
        const updated = statSync(path).mtime;
        return json({
          updated: updated.toISOString(),
          age_hours: Math.round((Date.now() - updated.getTime()) / 36e5 * 10) / 10,
          text: readFileSync(path, "utf8"),
        });
      } catch {
        return json({ error: "no current-context digest on this server yet; this is a gap, not an empty context", path });
      }
    });

  return server;
}
