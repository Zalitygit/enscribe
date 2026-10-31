# Page Format

The second knowledge class, added in v1. Where a **record** is DB-native and
canonical in SQLite (`record-format.md`), a **page** is a markdown file in git —
the file is canonical and the whole page index is disposable.

## The canonical artifact

```markdown
---
type: concept
title: Auction MCP (Capital City deal tracker)
aliases: [auction-mcp, cap-auction]
tags: [mcp, infra]
sources: [some-other-page]
generated: { by: claude-code/opus-5, at: 2026-08-19 }
---

Prose with [[wikilinks]] to other pages.
```

Frontmatter is YAML. Five keys drive behavior: `title` and `aliases` feed the
alias table, `sources` resolve into source edges, a `slug:` key overrides the
derived slug, and `type` is lifted into the `pages.type` column. Everything else
is carried, not read — stored whole in `pages.frontmatter` (JSON, NOT NULL),
covered by `content_hash`, and returned by `get_page`, but no code branches on
it.

`type`, `generated`, `status` and `verified` come from the
[Open Knowledge Format](okf.md) v0.2, adopted by the vault on 2026-08-19 across
all 119 authored pages; `_schema.md` in the vault holds the authoring rules.
Only `type` is promoted to a column; the other three are carried. MacBrain does
not implement OKF and is not an OKF consumer — it happens to index a corpus that
follows it.

- **`type` is shape-validated, never value-validated** (`frontmatterType()` in
  `parse.ts`, mirrored by migration 012's SQL). A non-empty string is taken as
  is; `type: [a, b]` and `type: 3` parse fine as YAML and become NULL rather
  than a stringified array in a TEXT column. OKF types are registered nowhere
  and consumers must tolerate an unknown one, so the value is never checked.
- **The lift needed a migration, not a resync**, and the reason generalizes to
  any future column derived from frontmatter. `content_hash` covers title +
  frontmatter + body, and a derived column is not *in* frontmatter, so an
  existing row's hash still matches its file. `ingest()`'s idempotence
  pre-check returns early, `writePage` is never reached, and the column would
  have stayed NULL through any number of `vault sync` runs. Migration 012
  backfills it in SQL, touching no hash, so nothing re-chunks and nothing
  re-embeds. Pinned by the test *"re-ingesting unchanged content does NOT
  backfill a null type"*.
- **The vault is not a traversable OKF bundle**, deliberately. OKF derives its
  graph from standard markdown links; this vault uses `[[wikilinks]]`, which is
  what `extractLinks` reads and what the whole resolution model below is built
  on. An OKF consumer pointed at the vault would see unconnected concepts.
  Likewise `sources:` stays a flat list of slugs, where OKF §5.1 wants a list of
  maps with a required `resource` key — adopting that shape would silently drop
  every source edge `frontmatterSources` builds.

Nothing else about a page lives outside the file. Its history is git history —
there is no supersession chain and no `forget` (that is the record model).

## Identity

**One derivation, shared by every reader and writer:** `slugFor(sourcePath,
frontmatter)` — a frontmatter `slug:` override if present, else the filename
basename, normalized (NFKD, combining marks stripped). Ingest, the collision
pre-scan, `put_page`'s guards, and the watcher all call it. A guard that computed
the slug differently than the write would protect a different page than the one
being overwritten.

Slugs are flat basenames, so a path-qualified `[[concepts/Struktura]]` does not
resolve today.

## Wikilink resolution

Three tiers, in order: **exact slug → alias table → slugify of the link text.**
This is the fix for the silent title/alias link loss in the system MacBrain
replaced, where links were slugified against slugs only.

- A link that resolves to nothing lands in `unresolved_links` — a first-class
  table, not a dropped edge. The doctor and gardener read it; the findings
  detectors read the **full** set through `listUnresolved()`, because
  `pageHealth`'s sample is capped and a target missed by the sample would flap
  resolved/reopened nightly; and each run snapshots it into
  `unresolved_snapshots`.
- Extraction runs inline on ingest; `resolveAll()` is a second pass that picks up
  forward references.
- An alias claimed by two or more live pages is **omitted** from `page_aliases`
  and reported as ambiguous. That drops tier 2 for it, not resolution outright:
  `resolve()` still tries tier 3, `slugify(raw)`, which may hit a live slug.
- `#heading` and `^blockid` anchors are stripped before resolution: `linkTarget()`
  keeps only the text before the first `#`, so `[[Design Notes#Typography]]`
  resolves to `design-notes`. A bare same-page `[[#anchor]]` yields no link at
  all, rather than an unresolved row no edit could ever clear.
- **Path qualifiers are deliberately not stripped.** Slugs are flat basenames, so
  `[[concepts/Struktura]]` genuinely cannot resolve, but taking the last `/`
  segment is a net loss on this corpus: measured 2026-08-16, zero links carry a
  path qualifier that stripping would repair, while seven carry a slash inside a
  legitimate *title* and resolve today. If revisited, the fallback belongs in
  `resolve()` as a further tier, not in the parser, which cannot see whether
  either form resolves.

## Storage model

| Object | Purpose |
|--------|---------|
| `pages` | slug PK, `title`, `type` (frontmatter `type:` for authored, `putGenerated`'s argument for generated), `frontmatter` (JSON, NOT NULL), `body`, `source_path` (null for generated), `generator` (null for authored), `authored_at`, `created_at`, `updated_at`, `deleted_at`, `content_hash`, `embed_hash` |
| `page_aliases` | normalized alias → slug; rebuilt wholesale by `vault sync` |
| `page_links` | resolved outbound edges |
| `unresolved_links` | link text that resolved to nothing |
| `page_chunks` | heading-aware body chunks: `chunk_id` (`${slug}#${ordinal}`), `slug`, `ordinal`, `heading`, `text`, and the `embedding_model` / `chunk_scheme` that produced each |
| `page_chunks_fts` | FTS5 over `title`, `aliases`, `heading`, `text`, plus `chunk_id` / `slug` UNINDEXED |
| `vec_page_chunks` | sqlite-vec `vec0`, 768-d chunk vectors |
| `page_snapshots` | per-run fingerprint of one authored page: `run_at` (a date), `slug`, `inbound`, `outbound`, `unresolved`, `content_hash`, `deleted` |
| `unresolved_snapshots` | the unresolved set by name for a run: `run_at`, `from_slug`, `raw_text` |
| `snapshot_runs` | `run_at` PK — every run, recorded unconditionally, so a run against an empty graph is not indistinguishable from no run at all |
| `findings` | the finding ledger (`record-format.md`); the pages layer only *renders* it, as the generated page `brain-findings` |
| `meta` | operational key/value; currently the last completed vault sync |

**Derived and rebuildable:** `page_aliases`, `page_links`, `unresolved_links`,
`page_chunks`, `page_chunks_fts`, `vec_page_chunks` — every one of them rebuilds
from `pages.body`, and `pages` itself rebuilds from the file.

**Durable and NOT rebuildable:** the three snapshot tables (a past run's
fingerprint cannot be recovered from the current body — see the header of
migration 006), `findings` (curated state), and `meta` (operational facts).
These are what a lost DB actually loses.

**Two hashes** — `content_hash` (title + frontmatter + body) answers "did the
page change?"; `embed_hash` (title + body, the chunk-embedding input) answers
"must the vectors be recomputed?". A frontmatter-only edit changes the first and
not the second, so aliases and links update while the chunks are kept. The
OKF backfill is the worked case: two new keys on 119 pages at once, which is
119 re-ingests and zero calls to the embedder.

**The title is indexed with every chunk** — `page_chunks_fts` carries a `title`
column, and each chunk's embedding input is prefixed `title\n…`. Without it a
page whose body never repeated its frontmatter title was unfindable by its own
title on both retrieval legs. It is **not** a `page_chunks` column: it lives only
in the FTS row and in the embedding-input prefix, which is exactly why migration
004 had to recreate the FTS table (FTS5 has no ALTER) and clear every
`content_hash` to force a re-embed.

**Aliases are indexed with every chunk too, but on the keyword leg ONLY** —
`page_chunks_fts` carries an `aliases` column (migration 009, which like 004 had
to recreate the FTS table). Measured 2026-08-16: 94 of 201 declared aliases
appear nowhere in their page's title or body, so searching one was a recall zero.

The asymmetry with `title` above is deliberate and was established by a wrong
turn. Extending 004's title-prefix argument to the alias list looks obviously
right and lost: relational nDCG@5 0.746 → 0.699 and recall@5 0.640 → 0.582
against a control given the identical re-embed treatment. A handful of short
alternate names drags every chunk vector on the page toward them and away from
what the chunk actually says. Aliases are short exact strings, which is the
keyword leg's job. Indexing them there and only there beat the control on both
query sets, so `CHUNK_SCHEME` is unchanged from 004, `embed_hash` stays
`(title, body)`, and **009 does not clear a single hash**. Migration 010 exists
only to heal a database that ran the bad draft.

The consequence for the write path: an alias edit no longer invalidates the
vectors, so `writePage`'s chunk-reuse branch updates the FTS aliases in place
(`updateChunkAliases`). Without that, an alias-only edit would rewrite the alias
table while the keyword index kept the old names — the page findable under a name
it dropped and unfindable under the one it gained, with nothing to signal it.

**`authored_at` is the recency signal** — the source file's last git-commit time,
stamped by `vault sync`. It reflects real edit history and survives a bulk
reseed, instead of collapsing to ingest time. Null for generated pages, which
fall back to `updated_at`. A pure rename does **not** reset it: `parseGitLog`
reads `--name-status -M` and skips `R100` entries when assigning a time while
still mapping the old path forward, so a page's clock comes from the commit that
last changed its bytes under whichever name it had then. (`--follow`, which the
original bug report asked for, is the wrong fix twice over: it takes exactly one
pathspec, so it cannot serve a whole-vault scan, and it would not change the
newest commit anyway.)

## Page classes

| Class | `source_path` | `generator` | Canonical home |
|-------|---------------|-------------|----------------|
| Authored | set | null | the `.md` file in git |
| Generated | null | set | nowhere — regenerated from ground truth |

**Authored wins.** A generator yields to a live source-backed page claiming its
slug and reports it as skipped. A tombstoned page does not hold its slug, so a
generator can reclaim it.

## Deletion

Prune-on-vanish is a **soft delete**: a page whose file disappeared is
tombstoned (`deleted_at`), its search rows and outbound edges pruned, its row and
aliases kept. `resolve()` filters `deleted_at` on all three tiers, so a
tombstoned page stops resolving.

The body is retained until `macbrain purge` hard-deletes it — which matters
because a page denied *after* ingest would otherwise linger.

## Writing

There is one write path, reached through two tools: `put_page` replaces a whole
file and `edit_page` swaps one exact piece of text on an existing authored page
(exactly one occurrence, frontmatter unchanged, after a `git pull --ff-only`).
Both share the validation and the commit → push → ingest tail below. `ok: false`
means the vault is unchanged; `ok: true` means the commit landed, and an ingest
failure after it is reported as `ingestError`. `put_page` writes *through* the
file: validate
(vault-relative, `.md`, under an include dir, not denied) → refuse placeholder or
error-page content, checked on the **body** alone so frontmatter words cannot
inflate it past the word threshold and disable the check on exactly the short
pages it exists to catch → refuse a slug owned by another live file or a live
generator → realpath-containment (a symlink under an include dir cannot escape
the vault) → git dirty-check (fail closed) → write →
`git commit -m "macbrain: <slug>"` for that path alone → `git push` → ingest.

The push is **non-fatal and reported, not raised**: the commit has already
landed locally, so a failed push returns `pushed: false` with `pushError`
rather than an error. Without it an agent-written page sat unpushed and the
shared index never saw it.

The result carries `inbound` (wikilinks from ingested pages) and
`orphan: inbound === 0`, so orphan pressure is said at write time instead of
surfacing through `doctor` a day later. Getting that right needs
`resolvePending()`: a parent written before its child leaves the link in
`unresolved_links`, and `ingest` only resolves the new page's *outbound* links,
so without a targeted re-resolve a page written parent-first read as orphaned
until the next full `vault sync`. The `wiki/index.md` blind spot applies here
too — a page catalogued only there is not linked from any *ingested* page, so
it reads as orphaned.

Writing byte-identical content is a git no-op: the vault already matches the
request, so the call succeeds with `committed: false` rather than failing.
