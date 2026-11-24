import type { Database } from "../core/db.js";
import { pageContentHash, pageEmbedHash } from "../core/hash.js";
import { normalize, slugify } from "./slug.js";

// `meta` key for the last completed vault sync (written by syncVault, read by
// pageHealth). One name, so the writer and the reader cannot drift.
export const LAST_VAULT_SYNC = "last_vault_sync";

export interface PageRow {
  slug: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  content_hash: string;
  // Hash of the chunk-embedding input (title + body) only. NULL on rows written
  // before migration 005; a NULL never matches, so those re-embed once.
  embed_hash: string | null;
  source_path: string | null;
  generator: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Source file's last git-commit time (rename-aware), stamped by vault sync.
  // NULL for a generated page or a fresh ingest the stamp pass hasn't reached.
  authored_at: string | null;
}

// Where a page came from, for the search layer's kind weight. `raw/` and
// `daily/` are dated notes rather than synthesis (the same split detectOrphans
// makes); a generated page is DB-native and regenerated nightly.
export type PageKind = "authored" | "raw" | "generated";

export interface PageInput {
  slug: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  type?: string | null;
  source_path?: string | null;
  generator?: string | null;
}

interface RawPage extends Omit<PageRow, "frontmatter"> {
  frontmatter: string;
}

export interface SnapshotRow {
  slug: string;
  inbound: number;
  outbound: number;
  unresolved: number;
  content_hash: string | null;
  deleted: number;
}

export interface UnresolvedSnapshotRow {
  from_slug: string;
  raw_text: string;
}

export class PagesStore {
  constructor(private db: Database) {}

  getPage(slug: string): PageRow | undefined {
    const r = this.db.prepare(`SELECT * FROM pages WHERE slug = ?`).get(slug) as RawPage | undefined;
    return r ? this.hydrate(r) : undefined;
  }

  // The live page ingested from exactly this vault-relative path, if any.
  slugBySourcePath(sourcePath: string): string | undefined {
    const r = this.db.prepare(
      `SELECT slug FROM pages WHERE source_path = ? AND deleted_at IS NULL`,
    ).get(sourcePath) as { slug: string } | undefined;
    return r?.slug;
  }

  // Live slugs other than `slug` still claiming `sourcePath`: what a file
  // leaves behind when its frontmatter slug changes in place.
  formerSlugsOf(sourcePath: string, slug: string): string[] {
    return (this.db.prepare(
      `SELECT slug FROM pages WHERE source_path = ? AND slug <> ? AND deleted_at IS NULL`,
    ).all(sourcePath, slug) as { slug: string }[]).map((r) => r.slug);
  }

  // Pages holding a resolved link to any of `slugs`.
  linkersOf(slugs: string[]): string[] {
    if (slugs.length === 0) return [];
    return (this.db.prepare(
      `SELECT DISTINCT from_slug FROM page_links WHERE to_slug IN (${slugs.map(() => "?").join(",")})`,
    ).all(...slugs) as { from_slug: string }[]).map((r) => r.from_slug);
  }

  // In-flight ingest tickets (migration 015). A newer ingest of a path cancels
  // every older one; an ingest whose ticket is gone must not commit.
  beginIngest(sourcePath: string): number {
    return this.db.transaction(() => {
      const id = Number(this.db.prepare(`INSERT INTO page_ingests (source_path) VALUES (?)`).run(sourcePath).lastInsertRowid);
      this.db.prepare(`DELETE FROM page_ingests WHERE source_path = ? AND id < ?`).run(sourcePath, id);
      return id;
    }).immediate();
  }

  ingestIsCurrent(id: number): boolean {
    return this.db.prepare(`SELECT 1 FROM page_ingests WHERE id = ?`).get(id) !== undefined;
  }

  endIngest(id: number): void {
    this.db.prepare(`DELETE FROM page_ingests WHERE id = ?`).run(id);
  }

  // Cancel every ingest of `sourcePath` in flight now. Reads first, so the
  // common case (nothing in flight) takes no write lock; deleting only ids
  // already seen leaves alone an ingest that starts in between, which is newer.
  cancelIngests(sourcePath: string): void {
    const r = this.db.prepare(`SELECT MAX(id) AS id FROM page_ingests WHERE source_path = ?`).get(sourcePath) as { id: number | null };
    if (r.id !== null) this.db.prepare(`DELETE FROM page_ingests WHERE source_path = ? AND id <= ?`).run(sourcePath, r.id);
  }

  listPages(): PageRow[] {
    const rows = this.db.prepare(`SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY slug`).all() as RawPage[];
    return rows.map((r) => this.hydrate(r));
  }

  // Live pages whose chunks, taken together, hold every term of `query`, on
  // the stemmed keyword index with the term's last word as a prefix, or the
  // same prefix on the unstemmed one (a word typed past its stem, irriga for
  // irrigation, matches no stem); with `word`, as whole words exactly, on the
  // unstemmed one. A term is a
  // whitespace-separated run or a "quoted" one, read as its words; a term of
  // two or more (needs-human, "git push") is an FTS5 phrase, its words adjacent
  // and in order. Each term is matched on its own and the slugs intersected,
  // so terms may sit in different chunks of one page. Only letters and digits
  // reach MATCH, so no FTS5 syntax gets through.
  slugsMatchingText(query: string, { word = false }: { word?: boolean } = {}): string[] {
    const terms = [...query.matchAll(/"([^"]*)"|(\S+)/g)]
      .map((m) => (m[1] ?? m[2])!.match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((ws) => ws.length)
      .map((ws) => ws.join(" "));
    if (!terms.length) return [];
    const matcher = (table: string) => this.db.prepare(
      `SELECT DISTINCT f.slug FROM ${table} f JOIN pages p ON p.slug = f.slug
       WHERE ${table} MATCH ? AND p.deleted_at IS NULL`);
    const exact = matcher("page_chunks_fts_exact");
    const stemmed = matcher("page_chunks_fts");
    const slugs = (stmt: ReturnType<typeof matcher>, m: string) => (stmt.all(m) as { slug: string }[]).map((r) => r.slug);
    const hits = (t: string) => word ? slugs(exact, `"${t}"`)
      : [...new Set([...slugs(stemmed, `"${t}"*`), ...slugs(exact, `"${t}"*`)])];
    let out = hits(terms[0]!);
    for (const t of terms.slice(1)) {
      if (!out.length) break;
      const more = new Set(hits(t));
      out = out.filter((s) => more.has(s));
    }
    return out.sort();
  }

  upsertPage(input: PageInput): { row: PageRow; changed: boolean } {
    const hash = pageContentHash(input.title, input.frontmatter, input.body);
    const existing = this.getPage(input.slug);
    if (existing && existing.deleted_at === null && existing.content_hash === hash
        && existing.generator === (input.generator ?? null)
        && existing.source_path === (input.source_path ?? null)) {
      return { row: existing, changed: false };
    }
    const now = new Date().toISOString();
    const row: PageRow = {
      slug: input.slug,
      title: input.title,
      type: input.type ?? null,
      frontmatter: input.frontmatter,
      body: input.body,
      content_hash: hash,
      embed_hash: pageEmbedHash(input.title, input.body),
      source_path: input.source_path ?? null,
      generator: input.generator ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
      // Not an INSERT column: the DB keeps the existing stamp on conflict and
      // leaves a new row NULL until the sync's stamp pass reaches it.
      authored_at: existing?.authored_at ?? null,
    };
    this.db.prepare(
      `INSERT INTO pages (slug,title,type,frontmatter,body,content_hash,embed_hash,source_path,generator,created_at,updated_at,deleted_at)
       VALUES (@slug,@title,@type,@frontmatter,@body,@content_hash,@embed_hash,@source_path,@generator,@created_at,@updated_at,NULL)
       ON CONFLICT(slug) DO UPDATE SET
         title=excluded.title, type=excluded.type, frontmatter=excluded.frontmatter,
         body=excluded.body, content_hash=excluded.content_hash, embed_hash=excluded.embed_hash,
         source_path=excluded.source_path,
         generator=excluded.generator, updated_at=excluded.updated_at, deleted_at=NULL`,
    ).run({ ...row, frontmatter: JSON.stringify(row.frontmatter) });
    return { row, changed: true };
  }

  // Replace this slug's alias rows with normalized keys from its title +
  // frontmatter aliases. Alias is the PK, so a cross-page collision resolves
  // last-writer-wins (a dedicated collision report is a later phase).
  rebuildAliases(slug: string, aliasSources: string[]): void {
    this.db.prepare(`DELETE FROM page_aliases WHERE slug = ?`).run(slug);
    const ins = this.db.prepare(
      `INSERT INTO page_aliases (alias, slug) VALUES (?, ?)
       ON CONFLICT(alias) DO UPDATE SET slug = excluded.slug`,
    );
    const seen = new Set<string>();
    for (const src of aliasSources) {
      const key = normalize(src);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ins.run(key, slug);
    }
  }

  // Resolve a wikilink target: exact live slug, then alias table (live pages
  // only), then the slugified text as a live slug. Null if nothing matches.
  resolve(raw: string): string | null {
    const bySlug = this.db.prepare(`SELECT slug FROM pages WHERE slug = ? AND deleted_at IS NULL`);
    const exact = bySlug.get(raw) as { slug: string } | undefined;
    if (exact) return exact.slug;
    const alias = this.db.prepare(
      `SELECT pa.slug AS slug FROM page_aliases pa JOIN pages p ON p.slug = pa.slug
       WHERE pa.alias = ? AND p.deleted_at IS NULL`,
    ).get(normalize(raw)) as { slug: string } | undefined;
    if (alias) return alias.slug;
    const slugged = bySlug.get(slugify(raw)) as { slug: string } | undefined;
    return slugged ? slugged.slug : null;
  }

  getBySourcePath(sourcePath: string): PageRow | undefined {
    const r = this.db.prepare(`SELECT * FROM pages WHERE source_path = ? AND deleted_at IS NULL`)
      .get(sourcePath) as RawPage | undefined;
    return r ? this.hydrate(r) : undefined;
  }

  unresolvedCount(): number {
    return (this.db.prepare(`SELECT count(*) AS c FROM unresolved_links`).get() as { c: number }).c;
  }

  // Tombstone a page: set deleted_at and prune its derived SEARCH index rows
  // (chunks/fts/vec) and OUTBOUND edges (links/unresolved from it). Keep the page
  // row (body preserved) and its page_aliases; resolve()'s deleted_at filter is
  // what prevents a tombstoned page from resolving. No-op if absent/already gone.
  softDelete(slug: string): void {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const res = this.db.prepare(
        `UPDATE pages SET deleted_at = ?, updated_at = ? WHERE slug = ? AND deleted_at IS NULL`,
      ).run(now, now, slug);
      if (res.changes === 0) return;
      const ids = this.db.prepare(`SELECT chunk_id FROM page_chunks WHERE slug = ?`).all(slug) as { chunk_id: string }[];
      const delVec = this.db.prepare(`DELETE FROM vec_page_chunks WHERE chunk_id = ?`);
      for (const { chunk_id } of ids) delVec.run(chunk_id);
      this.deleteChunkFts(slug);
      this.db.prepare(`DELETE FROM page_chunks WHERE slug = ?`).run(slug);
      this.db.prepare(`DELETE FROM page_links WHERE from_slug = ?`).run(slug);
      this.db.prepare(`DELETE FROM unresolved_links WHERE from_slug = ?`).run(slug);
    });
    tx();
  }

  // Both keyword tables (migration 014): the stemmed one ranks, the exact one
  // picks entity seeds. Every write goes through here or writes both, so the two
  // never describe different corpora.
  private deleteChunkFts(slug: string): void {
    this.db.prepare(`DELETE FROM page_chunks_fts WHERE slug = ?`).run(slug);
    this.db.prepare(`DELETE FROM page_chunks_fts_exact WHERE slug = ?`).run(slug);
  }

  // Deterministic full-vault alias rebuild: drop every alias row, then insert
  // only aliases with EXACTLY ONE live claimant. An alias claimed by 2+ pages
  // resolves to none (reported back), instead of ingestion-order
  // last-writer-wins. Called by syncVault after ingest + prune.
  replaceAllAliases(claims: { slug: string; sources: string[] }[]): { alias: string; slugs: string[] }[] {
    const claimants = new Map<string, Set<string>>();
    for (const { slug, sources } of claims) {
      for (const src of sources) {
        const key = normalize(src);
        if (!key) continue;
        let set = claimants.get(key);
        if (!set) claimants.set(key, (set = new Set()));
        set.add(slug);
      }
    }
    const ambiguous: { alias: string; slugs: string[] }[] = [];
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM page_aliases`).run();
      const ins = this.db.prepare(`INSERT INTO page_aliases (alias, slug) VALUES (?, ?)`);
      for (const [alias, slugs] of claimants) {
        if (slugs.size === 1) ins.run(alias, [...slugs][0]);
        else ambiguous.push({ alias, slugs: [...slugs].sort() });
      }
    });
    tx();
    return ambiguous.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  // Hard-delete every tombstoned page: the retained row (canonical body) and
  // its aliases, plus any derived rows softDelete already pruned (idempotent
  // belt-and-braces). Returns the number of pages purged. Content only truly
  // disappears once DB backups age out.
  purgeTombstoned(): number {
    let purged = 0;
    // IMMEDIATE: the body reads (SELECT tombstones) before it writes; see
    // PageService.writePage for why a deferred one fails under a concurrent writer.
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT slug FROM pages WHERE deleted_at IS NOT NULL`).all() as { slug: string }[];
      for (const { slug } of rows) {
        const ids = this.db.prepare(`SELECT chunk_id FROM page_chunks WHERE slug = ?`).all(slug) as { chunk_id: string }[];
        const delVec = this.db.prepare(`DELETE FROM vec_page_chunks WHERE chunk_id = ?`);
        for (const { chunk_id } of ids) delVec.run(chunk_id);
        this.deleteChunkFts(slug);
        this.db.prepare(`DELETE FROM page_chunks WHERE slug = ?`).run(slug);
        this.db.prepare(`DELETE FROM page_links WHERE from_slug = ?`).run(slug);
        this.db.prepare(`DELETE FROM unresolved_links WHERE from_slug = ?`).run(slug);
        this.db.prepare(`DELETE FROM page_aliases WHERE slug = ?`).run(slug);
        this.db.prepare(`DELETE FROM pages WHERE slug = ?`).run(slug);
        purged++;
      }
    });
    tx.immediate();
    return purged;
  }

  clearLinksFrom(fromSlug: string): void {
    this.db.prepare(`DELETE FROM page_links WHERE from_slug = ?`).run(fromSlug);
    this.db.prepare(`DELETE FROM unresolved_links WHERE from_slug = ?`).run(fromSlug);
  }

  addLink(fromSlug: string, toSlug: string, linkType: string | null, context: string | null, linkSource: string): void {
    this.db.prepare(
      `INSERT INTO page_links (from_slug, to_slug, link_type, context, link_source) VALUES (?, ?, ?, ?, ?)`,
    ).run(fromSlug, toSlug, linkType, context, linkSource);
  }

  addUnresolved(fromSlug: string, rawText: string, firstSeen: string): void {
    this.db.prepare(
      `INSERT INTO unresolved_links (from_slug, raw_text, first_seen) VALUES (?, ?, ?)
       ON CONFLICT(from_slug, raw_text) DO NOTHING`,
    ).run(fromSlug, rawText, firstSeen);
  }

  // Replace all derived chunk rows (page_chunks + FTS + vec) for a slug.
  // `provenance` stamps each row with the model and chunking convention that
  // produced it, so a later model or scheme change can find the stale chunks
  // instead of forcing a whole-vault re-embed.
  replaceChunks(
    slug: string,
    title: string,
    aliases: string[],
    chunks: { ordinal: number; heading: string | null; text: string; embedding: Float32Array }[],
    provenance: { model: string; scheme: string },
  ): void {
    const aliasText = aliases.join(" ");
    // IMMEDIATE: reads chunk ids before deleting (see PageService.writePage).
    // Called inside writePage's transaction it is a savepoint, unchanged.
    const tx = this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT chunk_id FROM page_chunks WHERE slug = ?`).all(slug) as { chunk_id: string }[];
      const delVec = this.db.prepare(`DELETE FROM vec_page_chunks WHERE chunk_id = ?`);
      for (const { chunk_id } of ids) delVec.run(chunk_id);
      this.deleteChunkFts(slug);
      this.db.prepare(`DELETE FROM page_chunks WHERE slug = ?`).run(slug);

      const insC = this.db.prepare(
        `INSERT INTO page_chunks (chunk_id, slug, ordinal, heading, text, embedding_model, chunk_scheme, fts_rowid, exact_rowid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insF = this.db.prepare(`INSERT INTO page_chunks_fts (chunk_id, slug, title, aliases, heading, text) VALUES (?, ?, ?, ?, ?, ?)`);
      const insE = this.db.prepare(`INSERT INTO page_chunks_fts_exact (chunk_id, slug, title, aliases, heading, text) VALUES (?, ?, ?, ?, ?, ?)`);
      const insV = this.db.prepare(`INSERT INTO vec_page_chunks (chunk_id, embedding) VALUES (?, ?)`);
      for (const c of chunks) {
        const chunkId = `${slug}#${c.ordinal}`;
        // A vector whose page_chunks row was lost is invisible to the delete
        // above; chunk ids are deterministic, so clear this one by id.
        delVec.run(chunkId);
        // The keyword rows' rowids are kept on the chunk row: chunk_id and slug
        // are UNINDEXED in FTS5, so rowid is the only cheap way back to them.
        const ftsRowid = insF.run(chunkId, slug, title, aliasText, c.heading, c.text).lastInsertRowid;
        const exactRowid = insE.run(chunkId, slug, title, aliasText, c.heading, c.text).lastInsertRowid;
        insC.run(chunkId, slug, c.ordinal, c.heading, c.text, provenance.model, provenance.scheme, ftsRowid, exactRowid);
        insV.run(chunkId, new Uint8Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength));
      }
      // Leftover vectors past the new count (their chunk rows lost, so the
      // delete above missed them). Ordinals were written contiguously.
      for (let n = chunks.length; delVec.run(`${slug}#${n}`).changes > 0; n++);
    });
    tx.immediate();
  }

  // Rewrite just the `aliases` column of a slug's existing FTS rows. The cheap
  // path for an alias-only edit: the aliases reach the keyword index but never
  // the embedding input, so the vectors and chunk text are already correct and
  // only this one column is stale. Called when writePage reuses chunks.
  updateChunkAliases(slug: string, aliases: string[]): void {
    this.db.prepare(`UPDATE page_chunks_fts SET aliases = ? WHERE slug = ?`).run(aliases.join(" "), slug);
    this.db.prepare(`UPDATE page_chunks_fts_exact SET aliases = ? WHERE slug = ?`).run(aliases.join(" "), slug);
  }

  // True when a slug's derived chunk rows are exactly what a fresh write would
  // leave: `expected` chunks, all stamped with this model and scheme, each with
  // a row in both keyword tables and the vector table. Anything else means the
  // rows are stale or partly lost, and an unchanged page must be rebuilt rather
  // than skipped, or vault sync could never heal it.
  // Runs for every unchanged page on every sync, so every lookup is indexed:
  // the keyword rows by the rowids replaceChunks stored (a slug filter on an
  // FTS5 table reads the whole table). An extra keyword row for the slug is not
  // detected; every write path deletes by slug before inserting.
  chunksIntact(slug: string, expected: number, provenance: { model: string; scheme: string }): boolean {
    const rows = this.db.prepare(
      `SELECT chunk_id, fts_rowid, exact_rowid FROM page_chunks WHERE slug = ? AND embedding_model = ? AND chunk_scheme = ?`,
    ).all(slug, provenance.model, provenance.scheme) as { chunk_id: string; fts_rowid: number | null; exact_rowid: number | null }[];
    const all = (this.db.prepare(`SELECT count(*) AS c FROM page_chunks WHERE slug = ?`).get(slug) as { c: number }).c;
    if (rows.length !== expected || all !== expected) return false;
    const fts = this.db.prepare(`SELECT 1 FROM page_chunks_fts WHERE rowid = ? AND chunk_id = ?`);
    const exact = this.db.prepare(`SELECT 1 FROM page_chunks_fts_exact WHERE rowid = ? AND chunk_id = ?`);
    const vec = this.db.prepare(`SELECT 1 FROM vec_page_chunks WHERE chunk_id = ?`);
    return rows.every((r) => fts.get(r.fts_rowid, r.chunk_id) !== undefined
        && exact.get(r.exact_rowid, r.chunk_id) !== undefined
        && vec.get(r.chunk_id) !== undefined)
      && vec.get(`${slug}#${expected}`) === undefined;
  }

  // Chunk counts grouped by the model + scheme that produced them. One row means
  // the index is internally consistent; more than one means the vector space
  // mixes conventions, and names exactly which chunks are stale.
  chunkProvenance(): { embedding_model: string | null; chunk_scheme: string | null; chunks: number }[] {
    return this.db.prepare(
      `SELECT embedding_model, chunk_scheme, count(*) AS chunks FROM page_chunks
       GROUP BY embedding_model, chunk_scheme ORDER BY embedding_model, chunk_scheme`,
    ).all() as { embedding_model: string | null; chunk_scheme: string | null; chunks: number }[];
  }

  // Record a fingerprint of the authored graph under `runAt` (a YYYY-MM-DD
  // date). Deletes that date's rows first, so a same-day re-run REPLACES its
  // own snapshot rather than merging into it — that is what makes recovery
  // from a failed generator run idempotent.
  //
  // Generator-owned pages are excluded: snapshotting them would make the digest
  // report its own body changing every night. Tombstoned pages are KEPT with
  // deleted=1, because dropping them would make "just tombstoned" and "never
  // existed" indistinguishable.
  writeSnapshot(runAt: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM page_snapshots WHERE run_at = ?`).run(runAt);
      this.db.prepare(`DELETE FROM unresolved_snapshots WHERE run_at = ?`).run(runAt);
      this.db.prepare(
        `INSERT INTO page_snapshots (run_at, slug, inbound, outbound, unresolved, content_hash, deleted)
         SELECT ?, p.slug,
           (SELECT count(*) FROM page_links l WHERE l.to_slug = p.slug),
           (SELECT count(*) FROM page_links l WHERE l.from_slug = p.slug),
           (SELECT count(*) FROM unresolved_links u WHERE u.from_slug = p.slug),
           p.content_hash,
           CASE WHEN p.deleted_at IS NULL THEN 0 ELSE 1 END
         FROM pages p WHERE p.generator IS NULL`,
      ).run(runAt);
      this.db.prepare(
        `INSERT INTO unresolved_snapshots (run_at, from_slug, raw_text)
         SELECT ?, u.from_slug, u.raw_text FROM unresolved_links u
         JOIN pages p ON p.slug = u.from_slug
         WHERE p.generator IS NULL AND p.deleted_at IS NULL`,
      ).run(runAt);
      // Recorded unconditionally, even when the SELECTs above matched zero
      // pages. page_snapshots only gets a row per LIVE page, so a run against
      // an empty graph would otherwise leave no trace of the date at all --
      // this ledger is what lets previousSnapshotDate tell "ran with nothing
      // to snapshot" apart from "never ran".
      this.db.prepare(
        `INSERT INTO snapshot_runs (run_at) VALUES (?) ON CONFLICT(run_at) DO NOTHING`,
      ).run(runAt);
    })();
  }

  getSnapshot(runAt: string): SnapshotRow[] {
    return this.db.prepare(
      `SELECT slug, inbound, outbound, unresolved, content_hash, deleted
       FROM page_snapshots WHERE run_at = ? ORDER BY slug`,
    ).all(runAt) as SnapshotRow[];
  }

  getUnresolvedSnapshot(runAt: string): UnresolvedSnapshotRow[] {
    return this.db.prepare(
      `SELECT from_slug, raw_text FROM unresolved_snapshots WHERE run_at = ?
       ORDER BY from_slug, raw_text`,
    ).all(runAt) as UnresolvedSnapshotRow[];
  }

  // Reads snapshot_runs, not page_snapshots: an empty-graph run has no rows
  // in page_snapshots at all, and page_snapshots' own dates are a subset of
  // this ledger. `<` (strict) is what keeps a same-day rerun from finding
  // itself -- a run recorded for `before` itself must never come back as its
  // own "previous" run.
  previousSnapshotDate(before: string): string | null {
    const r = this.db.prepare(
      `SELECT run_at FROM snapshot_runs WHERE run_at < ?
       ORDER BY run_at DESC LIMIT 1`,
    ).get(before) as { run_at: string } | undefined;
    return r ? r.run_at : null;
  }

  // Keep the newest `keep` snapshot dates, delete the rest. Returns the number
  // of dates dropped. Reads snapshot_runs for the same reason
  // previousSnapshotDate does: it is the complete run history, including
  // dates page_snapshots has no rows for.
  pruneSnapshots(keep: number): number {
    const dates = (this.db.prepare(
      `SELECT run_at FROM snapshot_runs ORDER BY run_at DESC`,
    ).all() as { run_at: string }[]).map((r) => r.run_at);
    const drop = dates.slice(keep);
    if (drop.length === 0) return 0;
    this.db.transaction(() => {
      const ps = this.db.prepare(`DELETE FROM page_snapshots WHERE run_at = ?`);
      const us = this.db.prepare(`DELETE FROM unresolved_snapshots WHERE run_at = ?`);
      const sr = this.db.prepare(`DELETE FROM snapshot_runs WHERE run_at = ?`);
      for (const d of drop) { ps.run(d); us.run(d); sr.run(d); }
    })();
    return drop.length;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  // `type` narrows to one link_type. Unresolved targets carry no type, so a
  // typed call returns none rather than every untyped one.
  getLinks(slug: string, type?: string): { links: { to_slug: string; link_type: string | null; context: string | null }[]; unresolved: { raw_text: string }[] } {
    const links = this.db.prepare(
      `SELECT to_slug, link_type, context FROM page_links
        WHERE from_slug = ? AND (? IS NULL OR link_type = ?) ORDER BY to_slug`,
    ).all(slug, type ?? null, type ?? null) as { to_slug: string; link_type: string | null; context: string | null }[];
    const unresolved = type !== undefined ? [] : this.db.prepare(
      `SELECT raw_text FROM unresolved_links WHERE from_slug = ? ORDER BY raw_text`,
    ).all(slug) as { raw_text: string }[];
    return { links, unresolved };
  }

  getBacklinks(slug: string, type?: string): { from_slug: string; link_type: string | null; context: string | null }[] {
    return this.db.prepare(
      `SELECT from_slug, link_type, context FROM page_links
        WHERE to_slug = ? AND (? IS NULL OR link_type = ?) ORDER BY from_slug`,
    ).all(slug, type ?? null, type ?? null) as { from_slug: string; link_type: string | null; context: string | null }[];
  }

  // One-hop neighbourhood of `seeds` over the resolved wikilink graph, in EITHER
  // direction, ranked by how many distinct seeds each neighbour touches (ties
  // broken by slug, so the order is deterministic). Live pages only; the seeds
  // themselves are excluded, because this exists to ADD candidates a lexical or
  // vector match missed, not to re-boost the anchors that are already ranked.
  //
  // UNION rather than UNION ALL: a page may be linked twice from the same seed
  // (a body wikilink plus a frontmatter `sources:` edge), and that should not
  // count as two seeds' worth of evidence.
  //
  // KNOWN WEAKNESS: with only a few seeds most neighbours tie at one hit, so the
  // ordering collapses to the slug tiebreak — which sorts `2026-*` dated session
  // logs ahead of concept pages purely because of how they are named. That is a
  // real bias, not a cosmetic one, and it likely caps how much the entity leg can
  // win. Left as-is because the current configuration is a measured net gain and
  // changing the tiebreak means re-running the relational benchmark to justify
  // whatever replaces it; guessing at a better one unmeasured is how the number
  // stops meaning anything.
  neighbors(seeds: string[], limit: number): string[] {
    if (seeds.length === 0) return [];
    const ph = seeds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT n.slug AS slug, count(DISTINCT n.seed) AS hits
         FROM (
           SELECT from_slug AS seed, to_slug AS slug FROM page_links WHERE from_slug IN (${ph})
           UNION
           SELECT to_slug AS seed, from_slug AS slug FROM page_links WHERE to_slug IN (${ph})
         ) n
         JOIN pages p ON p.slug = n.slug AND p.deleted_at IS NULL
        WHERE n.slug NOT IN (${ph})
        GROUP BY n.slug
        ORDER BY hits DESC, n.slug ASC
        LIMIT ?`,
    ).all(...seeds, ...seeds, ...seeds, limit) as { slug: string; hits: number }[];
    return rows.map((r) => r.slug);
  }

  // Live page slugs ordered by change-event recency, newest first, restricted to
  // `slugs`. Restricted on purpose: an unrestricted recency ranking would let the
  // most recently edited page in the vault win every temporal query regardless of
  // what was asked. This RE-RANKS candidates, it never introduces them.
  byRecency(slugs: string[]): string[] {
    if (slugs.length === 0) return [];
    const ph = slugs.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT slug FROM pages
        WHERE slug IN (${ph}) AND deleted_at IS NULL
        ORDER BY COALESCE(authored_at, updated_at) DESC, slug ASC`,
    ).all(...slugs) as { slug: string }[]).map((r) => r.slug);
  }

  // Aggregate pages-index health for the doctor tool. Orphan = a live authored
  // page with no inbound page_links (same predicate as orphans(); see the note
  // there on why outbound links are not part of it).
  pageHealth(sample = 10): {
    pages: number;
    unresolved: number;
    unresolvedSample: { from_slug: string; raw_text: string }[];
    orphans: number;
    orphanSample: string[];
    // When the vault last synced end to end, or null if it never has here. A
    // dead path unit or cron otherwise looks exactly like a vault nobody edited.
    lastVaultSync: string | null;
    chunkProvenance: { embedding_model: string | null; chunk_scheme: string | null; chunks: number }[];
  } {
    const pages = (this.db.prepare(`SELECT count(*) AS c FROM pages WHERE deleted_at IS NULL`).get() as { c: number }).c;
    const unresolvedSample = this.db.prepare(
      `SELECT from_slug, raw_text FROM unresolved_links ORDER BY first_seen, from_slug, raw_text LIMIT ?`,
    ).all(sample) as { from_slug: string; raw_text: string }[];
    const orphanRows = this.db.prepare(
      `SELECT slug FROM pages p WHERE p.deleted_at IS NULL AND p.generator IS NULL
         AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.to_slug = p.slug)
       ORDER BY p.slug`,
    ).all() as { slug: string }[];
    return {
      pages,
      unresolved: this.unresolvedCount(),
      unresolvedSample,
      orphans: orphanRows.length,
      orphanSample: orphanRows.slice(0, sample).map((r) => r.slug),
      lastVaultSync: this.getMeta(LAST_VAULT_SYNC),
      chunkProvenance: this.chunkProvenance(),
    };
  }

  listGeneratedBy(generator: string): string[] {
    return (this.db.prepare(`SELECT slug FROM pages WHERE generator = ? AND deleted_at IS NULL ORDER BY slug`)
      .all(generator) as { slug: string }[]).map((r) => r.slug);
  }

  generatedUnresolvedLinks(): { slug: string; raw_text: string }[] {
    return this.db.prepare(
      `SELECT u.from_slug AS slug, u.raw_text AS raw_text FROM unresolved_links u
       JOIN pages p ON p.slug = u.from_slug
       WHERE p.generator IS NOT NULL AND p.deleted_at IS NULL
       ORDER BY u.from_slug, u.raw_text`,
    ).all() as { slug: string; raw_text: string }[];
  }

  // Live authored pages with no INBOUND links — unreachable pages. Generator-owned
  // pages are excluded (generated pages are never nagged as orphans).
  //
  // This deliberately does NOT also require "no outbound links". That stricter
  // AND predicate was the original design, but it hides the most actionable
  // case: a page that cites others while nothing cites it, i.e. live work that
  // has fallen out of the graph. It is what kept a duplicate host stub
  // invisible while all 17 inbound links pointed at the canonical host page.
  // Matches gbrain's find_orphans, so the gardener repoint is not a coverage
  // regression.
  orphans(): string[] {
    return (this.db.prepare(
      `SELECT slug FROM pages p WHERE p.deleted_at IS NULL AND p.generator IS NULL
         AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.to_slug = p.slug)
       ORDER BY p.slug`,
    ).all() as { slug: string }[]).map((r) => r.slug);
  }

  // Every unresolved link, ungrouped and unsampled. pageHealth() returns a
  // capped sample for reporting; the findings detector needs the full set,
  // because a target missed by the sample would flap resolved/reopened nightly.
  listUnresolved(): { from_slug: string; raw_text: string }[] {
    return this.db.prepare(
      `SELECT from_slug, raw_text FROM unresolved_links ORDER BY raw_text, from_slug`,
    ).all() as { from_slug: string; raw_text: string }[];
  }

  // Pages changed within the window, by change-event recency. `authored_at`
  // (source's last git-commit time) is the recency signal when present, falling
  // back to `updated_at` (ingest time) for generated pages that have no source.
  // Generator-owned pages are excluded (matching orphans()): a generated page
  // has no authored_at, so it falls back to updated_at, which a nightly
  // generator run bumps every night by design — without this filter a
  // generated page would sit permanently at the top of "what moved lately".
  recentPages(days: number): { slug: string; title: string; updated_at: string; recency: string }[] {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return this.db.prepare(
      `SELECT slug, title, updated_at, COALESCE(authored_at, updated_at) AS recency
       FROM pages WHERE deleted_at IS NULL AND generator IS NULL AND COALESCE(authored_at, updated_at) >= ?
       ORDER BY COALESCE(authored_at, updated_at) DESC`,
    ).all(cutoff) as { slug: string; title: string; updated_at: string; recency: string }[];
  }

  // Live authored pages with body and change recency, for content scans.
  // Mirrors recentPages' COALESCE(authored_at, updated_at): authored_at is the
  // source file's git-commit time and is the only honest "when did this last
  // change" signal, since updated_at moves on every re-ingest.
  listAuthoredWithRecency(): { slug: string; body: string; recency: string }[] {
    return this.db.prepare(
      `SELECT slug, body, COALESCE(authored_at, updated_at) AS recency
       FROM pages WHERE deleted_at IS NULL AND generator IS NULL ORDER BY slug`,
    ).all() as { slug: string; body: string; recency: string }[];
  }

  // Stamp each live source-backed page's authored_at from a source-path -> ISO
  // git-commit-time map. Idempotent; leaves pages absent from the map (and all
  // generated pages) untouched. Returns the number of rows updated.
  stampAuthoredDates(times: Map<string, string>): number {
    const upd = this.db.prepare(
      `UPDATE pages SET authored_at = ? WHERE source_path = ? AND deleted_at IS NULL`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const [path, iso] of times) n += upd.run(iso, path).changes;
    })();
    return n;
  }

  getChunk(chunkId: string): { ordinal: number; heading: string | null; text: string } | null {
    const r = this.db.prepare(`SELECT ordinal, heading, text FROM page_chunks WHERE chunk_id = ?`).get(chunkId) as
      | { ordinal: number; heading: string | null; text: string }
      | undefined;
    return r ? { ordinal: r.ordinal, heading: r.heading ?? null, text: r.text } : null;
  }

  // Slug and title of every live page, for get_page's nearest-slug suggestions.
  slugTitles(): { slug: string; title: string }[] {
    return this.db.prepare(`SELECT slug, title FROM pages WHERE deleted_at IS NULL ORDER BY slug`).all() as { slug: string; title: string }[];
  }

  // Every live page backed by a vault file, for a generator that joins the index
  // against something outside it (git, the filesystem). Generated pages are
  // absent by construction, having no source_path.
  sourceBackedPages(): { slug: string; source_path: string }[] {
    return this.db.prepare(
      `SELECT slug, source_path FROM pages WHERE deleted_at IS NULL AND source_path IS NOT NULL ORDER BY slug`,
    ).all() as { slug: string; source_path: string }[];
  }

  // Every resolved link between two live pages, one row per ordered pair,
  // self-links dropped. The viewer's whole graph in one query.
  liveLinks(): [string, string][] {
    const rows = this.db.prepare(
      `SELECT DISTINCT l.from_slug AS f, l.to_slug AS t FROM page_links l
       JOIN pages a ON a.slug = l.from_slug AND a.deleted_at IS NULL
       JOIN pages b ON b.slug = l.to_slug AND b.deleted_at IS NULL
       WHERE l.from_slug <> l.to_slug ORDER BY f, t`,
    ).all() as { f: string; t: string }[];
    return rows.map((r) => [r.f, r.t]);
  }

  // One lookup for a candidate set. Unknown or tombstoned slugs are absent.
  kindsOf(slugs: string[]): Map<string, PageKind> {
    const out = new Map<string, PageKind>();
    if (slugs.length === 0) return out;
    const ph = slugs.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT slug, source_path, generator FROM pages WHERE slug IN (${ph}) AND deleted_at IS NULL`,
    ).all(...slugs) as { slug: string; source_path: string | null; generator: string | null }[];
    for (const r of rows) {
      const kind: PageKind = r.generator !== null ? "generated"
        : /^(raw|daily)\//.test(r.source_path ?? "") ? "raw"
        : "authored";
      out.set(r.slug, kind);
    }
    return out;
  }

  private hydrate(r: RawPage): PageRow {
    return { ...r, frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown>, deleted_at: r.deleted_at ?? null, authored_at: r.authored_at ?? null };
  }
}
