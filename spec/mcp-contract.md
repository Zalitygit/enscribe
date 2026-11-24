# MCP Contract

Exposed capabilities of the MacBrain MCP server, over both transports (stdio and
Streamable HTTP). Twenty-two tools: eight over agent **records**, ten over
knowledge **pages**, four over the **finding ledger**.

## Record tools

Adopted from the v0 design spec (`2026-07-12-macbrain-design.md`, §6). Always
registered.

| Tool | Purpose | Behavior | Scope |
|------|---------|-------------|-------|
| `search_memory(query, type?, limit?)` | Hybrid retrieval | FTS5 + vector fused, over `current_records`. The one filter is `type`, constrained to the record types | `memory.search` |
| `get_record(id)` | Fetch one record | Returns canonical record | `memory.read` |
| `add_memory(record)` | Create a record | Assigns ULID, embeds, indexes | `memory.append` |
| `update_memory(id, patch)` | Revise a record | New version, supersedes prior | `memory.modify` |
| `link_records(subject, predicate, object)` | Add a relationship | Inserts a relationship row | `memory.modify` |
| `list_recent(project?, since?, limit?)` | Recent records | Metadata filter + recency order; default 20 | `memory.read` |
| `forget_record(id, hard?)` | Remove a record | Tombstones the **whole supersession lineage**, not one row. `hard: true` deletes it outright — the hard path is reachable over MCP, not only from the CLI | `memory.delete` |
| `summarize_context(topic, limit?)` | Context for a topic | **Returns retrieved context set, not an LLM summary**; default 8 | `memory.read` |

## Page tools

Added in v1 (see `page-format.md`). Registered **conditionally** — only when the
server is built with the pages dependencies. `put_page` additionally requires a
page service and a loaded vault config. The findings tools below sit behind
their own independent gate, so a record-only deployment is now one built with
neither the pages nor the findings dependencies; it exposes exactly the eight
tools above. Both stdio and the shared HTTP server supply all of these today.

| Tool | Purpose | Behavior | Scope |
|------|---------|----------|-------|
| `search(query, limit?, intent?)` | Unified retrieval | RRF over page chunks **and** records in one pass; chunks collapse to one hit per page. `intent` is **declared by the caller, never inferred** — the calling model already knows the shape of its own question, and inferring it would need either brittle keyword rules or a model on the read path. No value changes the plan today: `entity`, `factual`, `temporal`, `causal`, `superseded` and `multihop` are accepted so a caller can label honestly, and retrieve exactly as omitting the field does (`entity`'s one-hop wikilink expansion was unwired 2026-11-02 after it measured a loss). Omitting it is byte-for-byte the pre-`intent` behavior | `pages.read` |
| `get_page(slug, section?, max_chars?)` | Fetch one page | A miss on the exact slug falls through the alias and slugify tiers and the page comes back with `resolved_from` set, so a title or alias typed where a slug was wanted costs no second call. A true miss returns `{error: "not_found", slug, suggestions}` — up to five live slugs by token overlap over slug and title — rather than null; a tombstoned slug is a true miss and is never suggested. A body over `PAGE_MAX_CHARS` (60,000) comes back cut there with `truncated: true`, `total_chars` and a `sections` outline (heading, level, chars). `section` returns one heading-delimited section (case-insensitive; a miss returns `not_found` plus the outline), `max_chars` overrides the cap. Pages under the cap are byte-identical to before | `pages.read` |
| `list_pages(limit?)` | Enumerate | slug / title / source_path; default 50 | `pages.read` |
| `get_links(slug)` | Outbound edges | Resolved links plus unresolved link text | `pages.read` |
| `get_backlinks(slug)` | Inbound edges | Pages linking to this slug | `pages.read` |
| `resolve_slug(text)` | Identity | Three-tier: exact slug → alias → slugify. An ambiguous alias is **absent** from the alias table, so it falls through to slugify and can still return a slug; null only when no tier matches | `pages.read` |
| `doctor()` | Pages index health | Counts, unresolved links, orphans, chunk provenance (chunk counts per embedding model / chunk scheme), and the last completed vault sync | `pages.read` |
| `orphans()` | Curation | Live authored pages with **no inbound links**; a page that links outward but has no citers is reported. Excludes generated | `pages.read` |
| `recent_pages(days?)` | Curation | Pages changed within N days (default 14), ranked by `COALESCE(authored_at, updated_at)`; excludes generator-owned pages | `pages.read` |
| `put_page(path, content)` | **The one write path**: whole file | Refuses placeholder/error-page content before any slug guard, then validates + git-commits the `.md` file, **pushes**, and ingests; the file stays canonical. A byte-identical rewrite is a git no-op and succeeds with `committed: false`. The push is non-fatal and reported through `pushed`/`pushError` rather than as an error — the commit has already landed locally, so failing the call would misdescribe what happened. `ok: false` means the vault is unchanged (a failed add/commit restores the file); an ingest failure after the commit is `ok: true` with `ingestError`. The result also carries `inbound` (wikilinks to this page from ingested pages) and `orphan` (`inbound === 0`) | `pages.write` |
| `edit_page(page, old, new)` | **The one write path**: in place | Same validation and commit → push → ingest tail as `put_page`, on an existing live authored page (`page` resolves like `get_page`). `git pull --ff-only` first; `old` must occur exactly once (overlapping occurrences count; the count is returned as `occurrences` on a miss); the frontmatter block may not change. Commit subject `macbrain: edit <slug>`. Same `ok` / `ingestError` contract | `pages.write` |

The `search` response is `{hits, confident, reason?}`. Page hits carry
`page_kind` (`authored` | `raw` | `generated`), `bm25` (FTS5's own score for the
best keyword chunk, more negative is stronger) and `distance` (sqlite-vec L2 for
the best vector chunk); record hits carry `distance`. `confident` is `false` with
`reason: "single-leg"` when no hit in the top three was reached by both keyword
and vector, `"distance"` when the both-legs hits in that window are all farther
than the floor, and `"no-hits"` when the search returned nothing. The fused
`score` alone cannot say "nothing here" — it is a rank blend and sits near the
same value for an exact match and for an off-topic question alike — which is why
these fields exist. **The floor is backend-specific**: 0.85 is calibrated against
the unit-length vectors the in-process ONNX embedder produces, and the
`MACBRAIN_EMBED_URL` path does not normalize, so an instance on that backend
needs its own `MACBRAIN_DISTANCE_FLOOR`.

> Naming collision: the MCP tool `doctor` reports **pages** health, while the CLI
> command `macbrain doctor` reports **record** index health. The same shape
> repeats below — `macbrain findings` is a CLI subcommand as well as an MCP tool.
> The MCP tool only reads the ledger; the CLI subcommand *runs* the detectors and
> reconciles first, then lists what is open.

## Findings tools

Added with the finding ledger. Registered behind their own gate, independent of
the pages gate; both stdio and the shared HTTP server supply the ledger today.

| Tool | Purpose | Behavior | Scope |
|------|---------|----------|-------|
| `findings(state?, kind?, key?, full?)` | Read the ledger | Returns `{findings: [...]}` — no synthesis; the caller does that. By default **open items as summaries** (`key`, `kind`, `subject`, `state`, `due`), because a `needs-human` item's `detail` is a whole handoff and the full list overflowed the tool-output cap in 13 of 19 consecutive calls — 29 rows carrying 61 KB of `detail` — which made the call-before-filing dedupe convention unenforceable. `key` returns one item in full, `full: true` returns whole rows, `state: "all"` lifts the open-only default. `state` is a free string at the tool boundary, though `FindingsStore.list` types it as a `FindingState` | `findings.read` |
| `report_findings(kinds: string[], findings: {kind, subject, detail}[])` | External detector write-back | `kinds` declares which kinds the caller is authoritative for on **this call**: findings of a declared kind that are absent from the payload are **resolved**, a previously-resolved one that reappears is **reopened**, and every undeclared kind is left untouched. Only the reportable kinds `red-link` and `contradiction` may be declared; any other declared kind rejects the whole call and nothing is written | `findings.report` |
| `add_finding(kind, subject, detail, due?)` | File one item that needs a human | **Appends only** — it never reconciles, so a session can file the single item it just hit without knowing what else is outstanding. `report_findings` is the wrong shape for that: `reconcile(["needs-human"], [oneItem])` would resolve every other open ask as no longer detected. Appendable kinds are `needs-human`, `todo` and `alert` (2026-11-04: a condition happening now, shown on the P4 desk panel; also filed by scripts with `enscribe findings add`, which shares this validation), and any other declared kind rejects the call before anything is written; they are disjoint from the reconciled kinds by construction, since an appended row of a reconciled kind would be resolved by the very next detection run and the pair would flap forever. `subject` is the identity: re-filing refreshes `detail`/`due` and counts the repeat, **reopens** a `resolved` item (a caller asserting the ask a second time is a judgment, where re-detection is not), and leaves a `wont_fix` one declined. `due` is nullable, used by these kinds alone, and takes a bare `YYYY-MM-DD` (stored as end of that day, UTC) or a full ISO-8601 instant | `findings.report` |
| `set_finding_state(key, state, note?)` | Operator verdict | `state` is one of `open`, `acknowledged`, `wont_fix`, `resolved` | `findings.write` |

`add_finding` returns `{created, reopened, times_reported, similar}` — the write
says what it did, which is what was missing when a session could not tell a new
row from a re-file. `similar` lists open same-kind keys whose subject shares a
word of three or more characters with the new one, computed **before** the write
so the new row never matches itself and capped at ten. It is a hint, never a
refusal.

The scope split is a trust boundary, not bookkeeping: the gardener holds
`findings.read` + `findings.report` but never `findings.write`, so it can report
what it detected and cannot judge its own findings. `add_finding` shares
`findings.report` with `report_findings` — a reporter may file an appendable
item, but the two kind lists are disjoint, so neither write path can reach the
other's rows.

## Permission scopes

`memory.read`, `memory.search`, `memory.append`, `memory.modify`,
`memory.delete`, `memory.private`, `pages.read`, `pages.write`,
`findings.read`, `findings.report`, `findings.write`.

Scopes are declared per tool and **enforced per client on the shared HTTP
server**: each bearer token in `tokens.json` carries its own scope set (`"*"`
expands to `ALL_SCOPES` — eleven today), and every tool call is checked against
the calling token's scopes. Local stdio mode runs unscoped (single trusted user,
no network boundary).

**`tools/list` is scope-filtered.** A tool whose declared scope the client lacks
is not registered at all, so a scoped session sees only what it can invoke and an
unauthorized call errors "tool not found" rather than "permission denied". The
in-handler checks remain as defense in depth, and a tool name missing from
`SCOPES` fails closed for scoped clients. Before this every tool registered and
denial happened at call time, so a `pages.read` token was shown `put_page`,
`forget_record` and `set_finding_state` it could never call — a model plans with
the tools it is shown. Local stdio still registers everything.

`memory.private` is declared in `ALL_SCOPES` but wired to no tool, so ten of the
eleven are enforced permissions and this one is inert — per-record visibility is
deferred. Do not count it as a permission the server checks.
