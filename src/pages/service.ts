import { posix } from "node:path";
import type { Database } from "../core/db.js";
import type { Embedder } from "../embed/types.js";
import { pageContentHash, pageEmbedHash } from "../core/hash.js";
import { PagesStore, type PageInput } from "./store.js";
import { slugFor } from "./slug.js";
import { parseFrontmatter, firstH1, frontmatterAliases, frontmatterSources, frontmatterType, extractLinks, extractMdLinks, chunkBody, CHUNK_SCHEME } from "./parse.js";

interface EmbeddedChunk {
  ordinal: number;
  heading: string | null;
  text: string;
  embedding: Float32Array;
}

export class PageService {
  constructor(private db: Database, private store: PagesStore, private embedder: Embedder) {}

  // Ingest one markdown source. Idempotent: unchanged live content short-circuits
  // with no writes and no embedding. When content changed, embeddings are computed
  // first (the only async step), then the page row and ALL its derived indexes
  // (aliases, links, chunks) commit in one transaction — so a crash mid-ingest can
  // never leave a live page whose content_hash matches while its derived tables are
  // stale (which the changed:false guard would then skip forever). Order inside the
  // transaction matters: aliases are rebuilt before links resolve, so a page's own
  // title/aliases serve its own body's links.
  async ingest(sourcePath: string, raw: string): Promise<{ slug: string; changed: boolean }> {
    const { frontmatter, body } = parseFrontmatter(raw);
    const slug = slugFor(sourcePath, frontmatter);
    const title = typeof frontmatter.title === "string" && frontmatter.title
      ? frontmatter.title
      : firstH1(body) ?? slug;

    // Read-only idempotence pre-check (mirrors PagesStore.upsertPage's skip
    // condition) so an unchanged re-ingest does no work — crucially, no embedding.
    const existing = this.store.getPage(slug);
    const hash = pageContentHash(title, frontmatter, body);
    if (existing && existing.deleted_at === null && existing.content_hash === hash
        && existing.source_path === sourcePath && existing.generator === null) {
      return { slug, changed: false };
    }

    await this.writePage({ slug, title, frontmatter, body, type: frontmatterType(frontmatter), source_path: sourcePath });
    return { slug, changed: true };
  }

  // Deterministic alias rebuild across every live page (title + frontmatter
  // aliases, same derivation as ingest). Ambiguous aliases (2+ claimants)
  // resolve to none and are returned for reporting. Run before resolveAll so
  // links resolve against the healed alias table.
  rebuildAllAliases(): { alias: string; slugs: string[] }[] {
    const claims = this.store.listPages().map((p) => ({
      slug: p.slug,
      sources: [p.title, ...frontmatterAliases(p.frontmatter)],
    }));
    return this.store.replaceAllAliases(claims);
  }

  // Re-derive every non-deleted page's links from its stored body. The hook a
  // full vault sync calls as a second pass, so forward references (a link to a
  // page ingested later) resolve once all pages and aliases exist. Batched in
  // one transaction (mirrors PagesStore.replaceChunks) since a full vault can
  // be thousands of pages.
  async resolveAll(): Promise<void> {
    const pages = this.store.listPages();
    this.db.transaction(() => {
      for (const p of pages) this.resolveLinks(p.slug, p.body, p.frontmatter, p.source_path);
    })();
  }

  // The targeted form of resolveAll for a single write: only pages that hold
  // an unresolved link can gain a resolution from a page that just appeared,
  // so re-derive those and leave the rest alone. Bounded by the unresolved
  // set (single digits on the live vault), not the vault.
  async resolvePending(): Promise<void> {
    const from = (this.db.prepare(`SELECT DISTINCT from_slug FROM unresolved_links`).all() as { from_slug: string }[])
      .map((r) => r.from_slug);
    // IMMEDIATE (see writePage): the body reads (getPage) before it writes.
    this.db.transaction(() => {
      for (const slug of from) {
        const p = this.store.getPage(slug);
        if (p && p.deleted_at === null) this.resolveLinks(p.slug, p.body, p.frontmatter, p.source_path);
      }
    }).immediate();
  }

  private resolveLinks(slug: string, body: string, frontmatter: Record<string, unknown>, sourcePath: string | null): void {
    this.store.clearLinksFrom(slug);
    const now = new Date().toISOString();
    for (const link of extractLinks(body)) {
      const to = this.store.resolve(link.raw);
      // An inline-field link (`runs-on:: [[x]]`) is stored once, with its type,
      // in place of the wikilink row it would otherwise have produced.
      if (to && link.type) this.store.addLink(slug, to, link.type, link.display, "inline-field");
      else if (to) this.store.addLink(slug, to, "wikilink", link.display, "wikilink");
      else this.store.addUnresolved(slug, link.raw, now);
    }
    // Relative Markdown links resolve by PATH against the target's stored
    // source_path, never by title or slug. A miss is dropped rather than flagged
    // unresolved: docs link plenty of .md files outside the vault include list,
    // and unresolved_links stays about wikilinks (authoring intent). Generated
    // pages have no source path, so they carry no mdlinks. Since a miss leaves
    // no unresolved row, resolvePending cannot see a forward mdlink; the full
    // resolveAll in vault sync is what picks those up.
    if (sourcePath) {
      const seen = new Set<string>();
      for (const link of extractMdLinks(body)) {
        const target = posix.normalize(posix.join(posix.dirname(sourcePath), link.href));
        const to = this.store.slugBySourcePath(target);
        if (!to || to === slug || seen.has(to)) continue;
        seen.add(to);
        this.store.addLink(slug, to, "mdlink", link.display || null, "mdlink");
      }
    }
    // Frontmatter `sources:` become provenance edges when they resolve to a real
    // page. Unresolvable sources (import tags, URLs) are ignored — NOT flagged as
    // unresolved, which stays about body wikilinks (authoring intent).
    for (const src of frontmatterSources(frontmatter)) {
      const to = this.store.resolve(src);
      if (to && to !== slug) this.store.addLink(slug, to, "source", null, "frontmatter-source");
    }
  }

  // Embed the body, then commit the page row + all its derived indexes (aliases,
  // links, chunks) in one transaction. Shared by ingest and putGenerated so the
  // atomic-write path is defined once.
  private async writePage(pageInput: PageInput): Promise<void> {
    // The alias list is derived here rather than passed in, so the names that go
    // into the alias TABLE, the FTS `aliases` column and the embedding input are
    // by construction the same list. A generated page has no frontmatter
    // aliases, so this is [] for it — the previous single-element [title] it
    // passed is already covered by the title itself.
    const aliases = frontmatterAliases(pageInput.frontmatter);
    // The chunk rows depend on title + body, so when embed_hash matches we keep
    // the existing chunks and skip the embedder entirely — a frontmatter-only
    // edit (new alias, bumped `updated:`) still rewrites the page, aliases and
    // links, but produces byte-identical vectors, so recomputing them is cost
    // for nothing.
    const existing = this.store.getPage(pageInput.slug);
    const reuseChunks = existing !== undefined
      && existing.deleted_at === null
      && existing.embed_hash === pageEmbedHash(pageInput.title, pageInput.body);
    const embedded = reuseChunks ? null : await this.embedChunks(pageInput.title, pageInput.body);
    // IMMEDIATE, not the default DEFERRED: upsertPage reads before it writes,
    // and under WAL a deferred transaction that has read cannot upgrade to a
    // writer once another connection holds or has committed the write lock —
    // it fails at once with SQLITE_BUSY ("database is locked"), and
    // busy_timeout never applies. That is how an edit_page ingest lost to the
    // `vault sync` its own push fired. BEGIN IMMEDIATE takes the lock up
    // front, where busy_timeout does wait. The embedding above stays OUTSIDE
    // the transaction, so the lock is held only for the synchronous writes.
    this.db.transaction(() => {
      this.store.upsertPage(pageInput);
      this.store.rebuildAliases(pageInput.slug, [pageInput.title, ...aliases]);
      this.resolveLinks(pageInput.slug, pageInput.body, pageInput.frontmatter, pageInput.source_path ?? null);
      if (embedded) {
        this.store.replaceChunks(pageInput.slug, pageInput.title, aliases, embedded,
          { model: this.embedder.model, scheme: CHUNK_SCHEME });
      } else {
        // Chunks were reused, so replaceChunks did not run — but the aliases
        // live in those chunks' FTS rows and may have just changed. Without this
        // an alias-only edit would update the alias TABLE while the keyword index
        // kept the old names, leaving the page findable under a name it no longer
        // claims and unfindable under the one it just gained.
        this.store.updateChunkAliases(pageInput.slug, aliases);
      }
    }).immediate();
  }

  // Write a DB-native generated page (source_path null, generator set) through the
  // same atomic path as ingest. Idempotent: unchanged content for the same
  // generator short-circuits. Yields to a live authored page (see below), in
  // which case `skipped` carries the owning source path.
  async putGenerated(
    input: { slug: string; title: string; body: string; type?: string; tags?: string[] },
    generator: string,
  ): Promise<{ slug: string; changed: boolean; skipped?: string }> {
    const frontmatter: Record<string, unknown> = { title: input.title };
    if (input.type) frontmatter.type = input.type;
    if (input.tags) frontmatter.tags = input.tags;
    const hash = pageContentHash(input.title, frontmatter, input.body);
    const existing = this.store.getPage(input.slug);
    // AUTHORED-WINS. Markdown-in-git is canonical and a generated page is
    // DB-native and disposable, so a live source-backed page keeps the slug.
    // Without this, `vault sync` and the nightly generator run overwrite each
    // other forever — re-chunking and re-embedding on both passes, each
    // reporting success — and the page never settles. A tombstoned page does
    // not hold the slug; the generator reclaims it.
    if (existing && existing.deleted_at === null && existing.source_path !== null) {
      return { slug: input.slug, changed: false, skipped: existing.source_path };
    }
    if (existing && existing.deleted_at === null && existing.content_hash === hash
        && existing.generator === generator && existing.source_path === null) {
      return { slug: input.slug, changed: false };
    }
    await this.writePage(
      { slug: input.slug, title: input.title, frontmatter, body: input.body, type: input.type ?? null, generator, source_path: null },
    );
    return { slug: input.slug, changed: true };
  }

  // Chunk the body and embed each chunk, returning the embedded chunks WITHOUT
  // writing — the caller persists them inside the ingest transaction. The page
  // title prefixes every chunk (contextual retrieval): a chunk lifted out of its
  // page otherwise carries no trace of what the page is about, so a page whose
  // body never repeats its title was unreachable by title on the vector leg.
  //
  // The aliases do NOT go in here, and that is a measured decision rather than an
  // oversight. Extending the same title-prefix argument to a page's other names
  // looks right and is wrong: it cost nDCG@5 0.746 -> 0.699 on the relational
  // benchmark, because a handful of alternate names pulls every chunk vector on
  // the page toward them and away from what the chunk actually says. Aliases are
  // short exact strings, which is what the keyword leg is good at, so 009 indexes
  // them there and only there.
  private async embedChunks(title: string, body: string): Promise<EmbeddedChunk[]> {
    const chunks = chunkBody(body);
    const embedded: EmbeddedChunk[] = [];
    for (const c of chunks) {
      const input = c.heading ? `${title}\n${c.heading}\n${c.text}` : `${title}\n${c.text}`;
      embedded.push({ ...c, embedding: await this.embedder.embed(input, "document") });
    }
    return embedded;
  }
}
