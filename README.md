# enscribe

A standalone, **local-first personal-memory daemon** that every AI you authorize
can read and write over [MCP](https://modelcontextprotocol.io). One SQLite file.
No cloud. No API keys. An optional HTTP mode shares the same memory across your
agents and devices.

*Formerly MacBrain. Every `ENSCRIBE_*` variable below is also read as
`MACBRAIN_*` when the `ENSCRIBE_*` form is unset, an existing `~/.macbrain/`
data directory is used in preference to `~/.enscribe/`, and the `macbrain`
command name still works.*

## What it is

- **Local-first.** All memory lives in one SQLite file on your own machine.
- **AI-agnostic.** Any MCP-capable client (Claude Code, for example) can search
  your memory and add to it.
- **Hybrid search.** Full-text (SQLite FTS5) and vector search, fused with
  Reciprocal Rank Fusion. Embeddings are computed locally with an in-process ONNX
  model; nothing about your data leaves the machine.
- **Knowledge pages.** Point it at a git-tracked markdown vault (wikilinks plus
  frontmatter) and it indexes your notes alongside agent memories: alias-aware
  link resolution, backlinks, unified search, and `put_page`/`edit_page` write
  paths that commit the markdown file itself. The files stay canonical; the
  database is a disposable index over them.
- **No model on the read path.** Queries never trigger an LLM call, a network
  request or a write. Judgment work (synthesis, contradiction checks) belongs in
  a separate client that talks to enscribe over MCP.

## Prerequisites

- **Node.js 22 or 23.** Node 24 crashes on teardown inside `better-sqlite3`, and
  Node 25+ has no prebuilt binary for it. The app fails fast on anything else.
- **git**

## Get started

```bash
git clone https://github.com/Zalitygit/enscribe.git
cd enscribe
npm ci
npm test        # first run downloads the embedding model (~100MB), then runs offline
npm run build   # compiles TypeScript to dist/
```

## Try it (CLI)

```bash
echo '{"type":"note","subject":"Hello","content":"my first memory"}' > /tmp/r.json
node dist/cli/index.js ingest /tmp/r.json
node dist/cli/index.js query "first memory"
node dist/cli/index.js dump
```

The database is created at `~/.enscribe/enscribe.db` by default.

## Use it with an AI (MCP over stdio)

```bash
claude mcp add -s user enscribe -e ENSCRIBE_DB="$HOME/.enscribe/enscribe.db" \
  -- node "$(pwd)/dist/cli/index.js" mcp
```

The client gets 24 tools:

- **Records** (8): `search_memory`, `add_memory`, `get_record`, `update_memory`,
  `link_records`, `list_recent`, `forget_record`, `summarize_context`.
- **Pages** (11): unified `search`, `get_page`, `list_pages`, `get_links`,
  `get_backlinks`, `resolve_slug`, `doctor`, `orphans`, `recent_pages`,
  `put_page`, `edit_page`.
- **Findings** (5): `findings`, `report_findings`, `add_finding`,
  `set_finding_state`, `set_finding_field`.

The HTTP server adds a 25th, `current_context`, for tokens holding
`context.read`: it returns the markdown file at `ENSCRIBE_CONTEXT_FILE`
(default `~/.enscribe/context/current-context.md`), written by whatever external
job you point at it. `src/mcp/scopes.ts` is the authoritative list.

`search` is the one to start with. It fuses pages and records in one pass and
answers `{hits, confident, reason?}`:

- **`confident`** is `false` when nothing in the top three was reached by both
  the keyword and the vector leg, or when every such hit is past the distance
  floor. A search that found nothing relevant says so instead of ranking noise.
- **Page hits carry `page_kind`** (`authored` | `raw` | `generated`), **`bm25`**
  and **`distance`**, so a caller can judge a hit rather than trust a fused rank.
- **`intent` is declared by the caller, never inferred.** Send `entity` when the
  question is about one named thing; it adds pages one hop away in the wikilink
  graph. Other values are accepted but change nothing. Omitting it is safe.

The MCP `doctor` tool reports page-index health; the CLI `doctor` command
reports record-index health.

## Shared server (HTTP, multi-client)

```bash
# tokens file: bearer token -> { name, scopes }; "*" grants every scope
cat > ~/.enscribe/tokens.json <<'JSON'
{ "REPLACE-WITH-A-SECRET": { "name": "my-agents", "scopes": ["*"] },
  "REPLACE-WITH-ANOTHER":  { "name": "read-only", "scopes": ["memory.read", "memory.search"] } }
JSON
chmod 600 ~/.enscribe/tokens.json

ENSCRIBE_PORT=3134 node dist/cli/index.js serve
```

Clients send `Authorization: Bearer <token>` to `http(s)://host:PORT/mcp`
(Streamable HTTP). For connector UIs with no header field, `?token=<token>` also
works; the header wins, and query tokens show up in proxy access logs. Put it
behind a TLS reverse proxy for remote use.

Scopes: `memory.read`, `memory.search`, `memory.append`, `memory.modify`,
`memory.delete`, `memory.private` (declared, gates nothing), `pages.read`,
`pages.write`, `findings.read`, `findings.report`, `findings.write`,
`context.read`. `tools/list` is filtered by the token's scopes, so a client only
sees what it may call. Sessions bind to the exact token; body size, idle lifetime
and session count are bounded. Local stdio mode is unscoped.

`serve` also runs a nightly in-process pass at 04:00 local time: finding
detection, then the generators, then a backup. A deployed server needs no cron.

## Knowledge vault

```bash
# ~/.enscribe/vault.json: { "root": "~/notes", "include": ["wiki"], "deny": ["private"] }
node dist/cli/index.js vault sync    # ingest + prune + rebuild aliases + resolve links
node dist/cli/index.js vault watch   # sync, then reindex on file change
node dist/cli/index.js generate      # run the generators
node dist/cli/index.js findings      # run the detectors, reconcile the ledger, list what is open
node dist/cli/index.js findings list --kind needs-human
node dist/cli/index.js findings show <key>
node dist/cli/index.js findings resolve <key> 'why'
node dist/cli/index.js findings wont-fix <key> 'why'
node dist/cli/index.js backup        # SQLite online backup with retention
node dist/cli/index.js purge         # hard-delete tombstoned pages
```

What `vault sync` refuses to do quietly:

- **Colliding slugs are quarantined.** Two files claiming one slug are both left
  out, nothing is pruned for them, and the CLI exits 1.
- **No prune on an untrustworthy walk.** If an include directory cannot be read,
  nothing is pruned and the CLI exits 1. Pruning is a soft delete; a tombstoned
  body survives until `purge`.
- **A malformed `vault.json` stops the process** rather than falling back to
  defaults, because the fallback would drop your deny-list.

Writes through `put_page`/`edit_page` refuse credential-shaped text (API key
prefixes, bearer headers, `?token=` URLs, `NAME_TOKEN=value` assignments) and
report only the rule and line, never the matched text. The nightly pass flags any
such text already in the vault as a `secret` finding.

### The finding ledger

One table of maintenance items with states `open`, `acknowledged`, `wont_fix`,
`resolved`. `wont_fix` is sticky: a declined finding that keeps being re-detected
stays quiet. Three sources write to it under disjoint kinds:

- the built-in nightly detectors (`orphan`, `unresolved`, `unknown-link-type`,
  `secret`);
- an external judgment client through `report_findings` (`red-link`,
  `contradiction`);
- agents filing one item at a time through `add_finding` (`needs-human` for
  something only the owner can do, `todo`).

## Maintenance

Full-text, vector and relationship tables are derived indexes:

```bash
node dist/cli/index.js doctor    # record-index health
node dist/cli/index.js reindex   # rebuild every record index
```

The page index is rebuilt by `vault sync`. Three tables are **not** rebuildable
and only `backup` protects them: `findings` (human verdicts), the snapshot tables
behind the change digest, and `meta`.

## Configuration

- `ENSCRIBE_DB`: database path (default `~/.enscribe/enscribe.db`).
- `ENSCRIBE_EMBED_URL` (+ `ENSCRIBE_EMBED_MODEL`): use an Ollama-style HTTP
  embedding server instead of the built-in ONNX model.
- `ENSCRIBE_VAULT_CONFIG`: vault config (default `~/.enscribe/vault.json`).
- `ENSCRIBE_GIT_ROOT`: directory of bare git repos the repo-inventory and
  activity generators read (default `/srv/git`; missing is fine).
- `ENSCRIBE_BACKUP_DIR`: backup destination (default `~/.enscribe/backups`).
- `ENSCRIBE_PORT` / `ENSCRIBE_HOST` / `ENSCRIBE_TOKENS`: shared server.
- `ENSCRIBE_DISTANCE_FLOOR` (default `0.85`): calibrated for the unit-length ONNX
  embedder only. The HTTP embedder does not normalize, so set this per instance
  if you use one.
- `ENSCRIBE_GRAPH_WEIGHT` (default `0.25`), `ENSCRIBE_KIND_WEIGHT`: ranking knobs,
  measured rather than chosen. Leave them alone unless you are benchmarking.

## Known issues

- **macOS: the CLI exits 134 after finishing its work** when the ONNX embedder
  was loaded (onnxruntime teardown). The work is committed first. Linux and
  `serve` are unaffected; it matters under `set -e`.
- **`test/pages/vault-watch.test.ts` is a timing flake** under full-suite load.
  Re-run that file alone before believing a failure there.

## Project layout

| Path | What it holds |
|------|---------------|
| `src/core/`     | record types, the SQLite store, supersession, `forget`, migrations runner, backup |
| `src/embed/`    | embedders: in-process ONNX (default), HTTP, fake-for-tests |
| `src/search/`   | hybrid full-text + vector search (RRF), records and pages unified |
| `src/pages/`    | the vault: parse, slugs/aliases, links, sync, watch, write paths, secret guard, generators |
| `src/findings/` | the finding ledger: store, detectors, reconciliation |
| `src/mcp/`      | stdio and HTTP MCP servers, auth, scopes, nightly scheduler |
| `src/cli/`      | the `enscribe` command |
| `migrations/`   | schema, applied in order on open |
| `spec/`         | record format, page format, MCP contract, and the vendored Open Knowledge Format spec |
| `test/`         | vitest suite |

## Contributing

Write a failing test first, then make it pass. Keep `npm test` and
`npm run typecheck` green. Design rules worth not undoing: the markdown files are
canonical and every index rebuilds from them; `forget` erases a record's whole
version lineage; relationships are canonical in the record document; one SQLite
file has one writer; the read path does no analysis.

This repository is a periodic export of a private working repo, so history here
moves in release-sized commits. Issues and pull requests are welcome; accepted
changes are applied upstream and arrive in the next export.

The secret-guard patterns credit [Pratiyush/llm-wiki](https://github.com/Pratiyush/llm-wiki) (MIT).

## License

MIT. See [LICENSE](LICENSE).
