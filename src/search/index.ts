import type { Database } from "../core/db.js";
import { type Store, clampLimit } from "../core/store.js";
import type { MemoryRecord, RecordType } from "../core/types.js";
import type { Embedder } from "../embed/types.js";
import { PagesStore, type PageKind } from "../pages/store.js";
import { splitSections } from "../pages/parse.js";
import { env } from "../env.js";

export interface SearchHit {
  record: MemoryRecord;
  score: number;
  fts: boolean;
  vector: boolean;
}

export type UnifiedHit =
  // `distance` is the record's own sqlite-vec L2 reading, same meaning as on a
  // page hit, so assessConfidence can read both kinds against one floor.
  | { kind: "record"; record: MemoryRecord; score: number; fts: boolean; vector: boolean; graph?: boolean; distance?: number }
  | {
      kind: "page";
      slug: string;
      title: string;
      chunk: { ordinal: number; heading: string | null; text: string } | null;
      score: number;
      fts: boolean;
      vector: boolean;
      // True when the wikilink-neighbourhood leg contributed to this hit, so a
      // caller can tell a page the query matched from one reached by association.
      graph?: boolean;
      page_kind: PageKind;
      // The retrievers' own readings for the page's best chunk on each leg —
      // FTS5 bm25 (more negative = stronger) and sqlite-vec L2 distance
      // (smaller = closer). The fused `score` is a rank blend and sits near
      // 2/(k+1) for an exact match and for a query about nothing in the vault
      // alike; these are what let a caller tell the two apart.
      bm25?: number;
      distance?: number;
      // Heading of the vector leg's best chunk, present only when it differs
      // from `chunk.heading`. `chunk` is the keyword leg's pick, so a page found
      // by meaning in another section would otherwise show only the wrong one.
      vector_heading?: string;
      // `chunk.heading` as a value get_page's `section` accepts, so the caller
      // can fetch that section instead of the whole page. Absent when get_page
      // would not find it: a preamble chunk has no heading, and chunkBody (not
      // fence-aware) takes a `#` line in a code fence as one.
      section?: string;
      // Source file's last git-commit time, rename-aware. null means "no
      // authorship date" (a generated page, or a page the vault sync's stamp
      // pass hasn't reached) — never a regen or ingest timestamp.
      authored_at: string | null;
    };

// What `search` says about its own top hit. Every fused score sits near the
// RRF ceiling, so the score cannot say "nothing here"; the leg flags and the
// vector distance can. `single-leg`: the top hit was reached by keyword OR
// vector, not both. `distance`: both legs, but the nearest chunk is farther
// than the floor. Calibrated on production 2026-09-09 against the benchmark
// queries and the off-topic ones a fleet audit turned up.
export type Confidence = { confident: true } | { confident: false; reason: "no-hits" | "single-leg" | "distance" };

// Reads the top three, not rank 1 alone: under intent=entity the graph leg can
// lift a neighbour above the exact page (seen live for "what is <overloaded name>",
// neighbour at 0.87 over the page at 0.72), and the question is whether a
// strong text match sits near the top, not which hit the rank blend put first.
export const CONFIDENCE_WINDOW = 3;

export function assessConfidence(hits: UnifiedHit[], floor = DISTANCE_FLOOR): Confidence {
  if (hits.length === 0) return { confident: false, reason: "no-hits" };
  const both = hits.slice(0, CONFIDENCE_WINDOW).filter((h) => h.fts && h.vector);
  if (both.length === 0) return { confident: false, reason: "single-leg" };
  // Records read the same floor as pages. Until 2026-09-10 a non-page hit was
  // waved through, and on a records-light index the self-description record
  // matched gibberish on both legs and made every search "confident".
  const near = both.some((h) => h.distance === undefined || h.distance <= floor);
  return near ? { confident: true } : { confident: false, reason: "distance" };
}

// What the CALLER says the question is. Never inferred here: classifying intent
// from the query string would mean either brittle keyword rules or a model on the
// read path, and locked decision 8 keeps the query channel free of both. The
// calling agent already knows what it is asking, so it declares it.
//
// `factual` (or omitted) is byte-for-byte today's behaviour — that is what makes
// the parameter safe to add to a live tool and what lets the benchmark measure
// the cooperative and the indifferent caller as two legs of one experiment.
export const SEARCH_INTENTS = ["factual", "entity", "temporal", "causal", "superseded", "multihop"] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

// Which intents actually change retrieval. None, since 2026-11-02 (`entity` was
// the last; see the note on GRAPH_INTENTS). Every value is accepted so a caller
// can label its question honestly without having to know which labels are wired
// up, but they all map to plain RRF. The 2026-08-16 readings that first set the
// list:
//
// That list is short because it was MEASURED, not designed. On the 20-query
// relational benchmark (`qrels-relational.json`), against an identical index:
//
//   entity     nDCG@5 0.615 -> 0.647, recall@5 0.475 -> 0.567, MRR 0.750 -> 1.000
//   multihop   nDCG@5 0.794 -> 0.542   (same neighbourhood expansion, harmful)
//   temporal   nDCG@5 0.722 -> 0.559   (recency leg)
//   superseded MRR    1.000 -> 0.611   (recency leg)
//
// The readings are consistent with what the legs do. An entity question anchors
// on one thing whose neighbourhood is tightly relevant; a multi-page question
// anchors on several, so expanding from the top few pulls in noise — and
// multi-page questions already scored HIGHER than single-page ones (0.768 vs
// 0.721) with no expansion at all, so there was nothing there to repair. Recency
// fails because the page answering "when did X happen" is the page about X, not
// whatever was edited most recently; as a full RRF leg that outvotes the text.
//
// Both rejected legs are still implemented and covered by tests. Re-enabling one
// is a line here plus a benchmark run, which is the point of keeping the number.
//
// `entity` was unwired too, 2026-11-02 (docs/evidence/2026-11-02-query-weighted-graph.md).
// On the production index it had turned from neutral (2026-10-22: entity 0.672
// -> 0.677) to a loss (0.704 -> 0.599), with code identical. The leg never did
// what it was for: text hits sit ~0.0007 apart in fused score, a graph slot adds
// at least 0.0035, and a graph-only page cannot reach the top ten, so all it did
// was re-rank pages the text legs had found. Seeds are excluded from their own
// expansion, so the page it lifted depended on which side of the seed cut the
// answer landed: one corpus shift moved the answer page into the seeds and the
// boost went to its sibling instead.
const GRAPH_INTENTS: ReadonlySet<string> = new Set<SearchIntent>([]);
const RECENCY_INTENTS: ReadonlySet<string> = new Set<SearchIntent>([]);

// How many top-ranked pages seed the neighbourhood expansion, and how many
// neighbours it may contribute. Both deliberately small: the leg is meant to
// recover a few strongly-connected pages the text legs missed, and a wide
// expansion in a 146-page vault with 930 edges would reach most of the graph.
const GRAPH_SEEDS = 3;
const GRAPH_EXPANSION = 10;

// How much a wikilink neighbour's rank counts against a text hit's rank. Tuned
// on the relational benchmark; see the fuse() note for the failure at 1.0.
// Overridable for the tuning sweep only — production reads the default.
const GRAPH_WEIGHT = Number(env("GRAPH_WEIGHT") ?? 0.25);

// Multiplier on the fused score of a `raw` or `generated` page, so an authored
// page with the same text evidence outranks a session narrative or a nightly
// hub. 1 is the pre-2026-09-09 behaviour. The default is set by the benchmark
// sweep (see CLAUDE.md, "Ranking by page kind"); the env var is for that sweep.
const KIND_WEIGHT = Number(env("KIND_WEIGHT") ?? 1);
// Per-kind overrides. Raw pages default to KIND_WEIGHT (1): session logs are
// what answer "when did X happen". Generated pages default to 0.5, set by the
// 2026-09-24 sweep (docs/evidence/2026-09-24-generated-weight-sweep.md): it
// cleared the top five of nightly hubs and lost no relational class. An
// explicit MACBRAIN_KIND_WEIGHT still sets both, so the 09-09 sweep reproduces.
const RAW_WEIGHT = Number(env("RAW_WEIGHT") ?? KIND_WEIGHT);
const GENERATED_WEIGHT = Number(env("GENERATED_WEIGHT") ?? env("KIND_WEIGHT") ?? 0.5);

// Vector distance above which a both-legs top hit is still reported as not
// confident. Infinity disables the check; the production value is calibrated,
// not designed — see assessConfidence.
export const DISTANCE_FLOOR = Number(env("DISTANCE_FLOOR") ?? 0.85);

export interface HealthReport {
  currentRecords: number;
  missingVector: string[];        // current records with no vector row
  missingFts: string[];           // current records with no FTS row
  missingEmbeddingMeta: string[]; // current records with no embedding metadata
  orphanVector: number;           // vector rows not backing a current record
  orphanFts: number;              // FTS rows not backing a current record
  orphanRelationships: number;    // relationship rows whose subject isn't current
  staleModel: number;             // embedding rows from a different model than the active embedder
}

const RRF_K = 60;

export class SearchService {
  private pagesStore: PagesStore;
  private rawWeight: number;
  private generatedWeight: number;
  // Which intents take the graph leg. Tests set it to keep the unwired leg covered.
  private graphIntents: ReadonlySet<string>;
  constructor(
    private db: Database, private store: Store, private embedder: Embedder, pagesStore?: PagesStore,
    opts: { kindWeight?: number; rawWeight?: number; generatedWeight?: number; graphIntents?: SearchIntent[] } = {},
  ) {
    this.pagesStore = pagesStore ?? new PagesStore(db);
    this.rawWeight = opts.rawWeight ?? opts.kindWeight ?? RAW_WEIGHT;
    this.generatedWeight = opts.generatedWeight ?? opts.kindWeight ?? GENERATED_WEIGHT;
    this.graphIntents = opts.graphIntents ? new Set(opts.graphIntents) : GRAPH_INTENTS;
  }

  async index(rec: MemoryRecord): Promise<void> {
    // Prune the version this record supersedes from the derived search indexes,
    // so only the current version stays searchable (no stale-row bloat or
    // candidate-pool crowding from old versions). Done before the embed: the
    // new version is already committed, so the old one is not current even if
    // the embed below fails.
    const supersedes = rec.supersedes;
    if (supersedes) this.db.transaction(() => this.store.deleteFromIndexes([supersedes]))();
    const vec = await this.embedder.embed(`${rec.subject}\n${rec.content}`, "document");
    const upsert = this.db.transaction(() => {
      // The embedding await yields: another client may have forgotten or
      // superseded this record meanwhile. Writing then would recreate derived
      // rows for a record that is no longer current, so check inside the txn.
      if (!this.db.prepare(`SELECT 1 FROM current_records WHERE id = ?`).get(rec.id)) return;
      this.db.prepare(`DELETE FROM vec_records WHERE record_id = ?`).run(rec.id);
      this.db.prepare(`INSERT INTO vec_records (record_id, embedding) VALUES (?, ?)`)
        .run(rec.id, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      this.store.setEmbeddingMeta(rec.id, this.embedder.model, this.embedder.dim, rec.content_hash);
    });
    upsert();
  }

  async search(query: string, opts: { type?: RecordType; limit?: number } = {}): Promise<SearchHit[]> {
    const limit = clampLimit(opts.limit, 10);
    const pool = Math.max(limit * 4, 20);

    // FTS leg — ranked by bm25 (lower is better -> rank order by ascending).
    // Skip the query entirely when there are no alphanumeric terms: `MATCH '""'`
    // can error on some FTS5 builds, and there's nothing meaningful to match anyway.
    // The current-record and type filters are pushed into SQL so a candidate pool
    // dominated by another type can't starve out valid matches.
    const matchQuery = toMatchQuery(query);
    const ftsRows = matchQuery
      ? (this.db.prepare(
          `SELECT f.id FROM records_fts f
             JOIN current_records c ON c.id = f.id
             ${opts.type ? "JOIN records r ON r.id = f.id AND r.type = ?" : ""}
           WHERE records_fts MATCH ? ORDER BY bm25(records_fts) LIMIT ?`,
        ).all(...(opts.type ? [opts.type] : []), matchQuery, pool) as { id: string }[])
      : [];

    // Vector leg — KNN by distance. sqlite-vec's KNN can't take a type join, so
    // when a type filter would starve the pool, expand it until enough matches
    // surface or every vector row has been seen.
    const qbytes = await this.embedQuery(query);
    let vecRows: { id: string }[] = [];
    if (qbytes) {
      const total = (this.db.prepare(`SELECT count(*) AS c FROM vec_records`).get() as { c: number }).c;
      let k = pool;
      for (;;) {
        const rows = this.db.prepare(
          `SELECT record_id AS id FROM vec_records
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        ).all(qbytes, k) as { id: string }[];
        vecRows = opts.type
          ? rows.filter((r) => this.store.get(r.id)?.type === opts.type)
          : rows;
        if (vecRows.length >= limit || k >= total) break;
        k = Math.min(k * 4, total);
      }
    }

    const scores = fuse([
      { rows: ftsRows, leg: "fts" },
      { rows: vecRows, leg: "vector" },
    ]);

    const hits: SearchHit[] = [];
    for (const [id, s] of scores) {
      const record = this.store.get(id);
      if (!record) continue;
      if (opts.type && record.type !== opts.type) continue;
      if (!this.isCurrent(id)) continue;
      hits.push({ record, score: s.score, fts: s.fts, vector: s.vector });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async searchUnified(query: string, opts: { limit?: number; intent?: SearchIntent } = {}): Promise<UnifiedHit[]> {
    const limit = clampLimit(opts.limit, 10);
    const pool = Math.max(limit * 4, 20);
    const matchQuery = toMatchQuery(query);

    const recFts = matchQuery
      ? (this.db.prepare(`SELECT id FROM records_fts WHERE records_fts MATCH ? ORDER BY bm25(records_fts) LIMIT ?`).all(matchQuery, pool) as { id: string }[])
      : [];
    const qbytes = await this.embedQuery(query);
    const recVec = qbytes
      ? (this.db.prepare(
          `SELECT record_id AS id, distance FROM vec_records WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        ).all(qbytes, pool) as { id: string; distance: number }[])
      : [];

    const pageFtsChunks = matchQuery
      ? (this.db.prepare(`SELECT chunk_id, slug, bm25(page_chunks_fts) AS bm25 FROM page_chunks_fts WHERE page_chunks_fts MATCH ? ORDER BY bm25(page_chunks_fts) LIMIT ?`).all(matchQuery, pool) as { chunk_id: string; slug: string; bm25: number }[])
      : [];
    // Query vec_page_chunks directly (no JOIN) — sqlite-vec's KNN LIMIT isn't
    // recognized once the vec0 table is joined to another table in the same
    // query. chunk_id is `${slug}#${ordinal}` (slugs never contain "#"), so
    // the slug is recovered by splitting rather than joining.
    const pageVecIds = qbytes
      ? (this.db.prepare(
          `SELECT chunk_id, distance FROM vec_page_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        ).all(qbytes, pool) as { chunk_id: string; distance: number }[])
      : [];
    const pageVecChunks = pageVecIds.map((r) => ({
      chunk_id: r.chunk_id,
      slug: r.chunk_id.slice(0, r.chunk_id.lastIndexOf("#")),
      distance: r.distance,
    }));
    // Each leg's own reading for the page's best chunk on that leg.
    const readings = new Map<string, { bm25?: number; distance?: number }>();
    const reading = (id: string) => { let r = readings.get(id); if (!r) { r = {}; readings.set(id, r); } return r; };
    for (const r of pageFtsChunks) { const rd = reading(`page:${r.slug}`); if (rd.bm25 === undefined) rd.bm25 = r.bm25; }
    for (const r of pageVecChunks) { const rd = reading(`page:${r.slug}`); if (rd.distance === undefined) rd.distance = r.distance; }
    for (const r of recVec) reading(`record:${r.id}`).distance = r.distance;

    // Collapse chunk rows to one entry per page (first = best-ranked), keying by
    // `page:<slug>` and remembering which chunk represented the page. The
    // keyword leg's chunk wins `bestChunk`; the vector leg's own pick is kept
    // apart so a hit can name its section when the two legs disagree.
    const bestChunk = new Map<string, string>();
    const vecChunk = new Map<string, string>();
    const collapse = (rows: { chunk_id: string; slug: string }[], legChunk?: Map<string, string>): { id: string }[] => {
      const seen = new Set<string>();
      const out: { id: string }[] = [];
      for (const r of rows) {
        const id = `page:${r.slug}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!bestChunk.has(id)) bestChunk.set(id, r.chunk_id);
        legChunk?.set(id, r.chunk_id);
        out.push({ id });
      }
      return out;
    };
    const pageFts = collapse(pageFtsChunks);
    const pageVec = collapse(pageVecChunks, vecChunk);

    const legs: { rows: { id: string }[]; leg: Leg; weight?: number }[] = [
      { rows: recFts.map((r) => ({ id: `record:${r.id}` })), leg: "fts" },
      { rows: recVec.map((r) => ({ id: `record:${r.id}` })), leg: "vector" },
      { rows: pageFts, leg: "fts" },
      { rows: pageVec, leg: "vector" },
    ];

    // The extra legs are derived FROM the text ranking, so the text legs have to
    // be fused first to know what the anchors are. Fusing again with the extras
    // appended is equivalent to accumulating into the first map (RRF is additive)
    // and keeps the leg list the single description of what was scored.
    const kinds = this.pagesStore.kindsOf([...new Set([...pageFts, ...pageVec].map((r) => r.id.slice("page:".length)))]);
    const base = this.applyKindWeight(fuse(legs), kinds);
    const intent = opts.intent;
    if (intent && (this.graphIntents.has(intent) || RECENCY_INTENTS.has(intent))) {
      const ranked = (scores: Map<string, FuseEntry>) => [...scores.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .map(([key]) => key)
        .filter((key) => key.startsWith("page:"))
        .map((key) => key.slice("page:".length));
      const rankedSlugs = ranked(base);

      if (this.graphIntents.has(intent)) {
        // Seeds come from the EXACT keyword table fused with the vector leg, not
        // from the stemmed ranking (migration 014). Stemming makes "boxes" match
        // every "box", which on the live index moved the anchors and dropped the
        // right page for "which of my two boxes handles mail" from rank 1 to 9.
        const exactRows = matchQuery
          ? (this.db.prepare(`SELECT slug FROM page_chunks_fts_exact WHERE page_chunks_fts_exact MATCH ? ORDER BY bm25(page_chunks_fts_exact) LIMIT ?`).all(matchQuery, pool) as { slug: string }[])
          : [];
        const pageExact = [...new Set(exactRows.map((r) => `page:${r.slug}`))].map((id) => ({ id }));
        const seedKinds = this.pagesStore.kindsOf([...new Set([...pageExact, ...pageVec].map((r) => r.id.slice("page:".length)))]);
        const seedScores = this.applyKindWeight(fuse([legs[0], legs[1], { rows: pageExact, leg: "fts" }, legs[3]]), seedKinds);
        const seeds = ranked(seedScores).slice(0, GRAPH_SEEDS);
        const neighbours = this.pagesStore.neighbors(seeds, GRAPH_EXPANSION);
        if (neighbours.length) legs.push({ rows: neighbours.map((s) => ({ id: `page:${s}` })), leg: "graph", weight: GRAPH_WEIGHT });
      }
      if (RECENCY_INTENTS.has(intent)) {
        const recent = this.pagesStore.byRecency(rankedSlugs);
        if (recent.length) legs.push({ rows: recent.map((s) => ({ id: `page:${s}` })), leg: "graph", weight: GRAPH_WEIGHT });
      }
    }
    const scores = legs.length > 4 ? this.applyKindWeight(fuse(legs), kinds) : base;

    const hits: UnifiedHit[] = [];
    for (const [key, s] of scores) {
      if (key.startsWith("record:")) {
        const id = key.slice("record:".length);
        const record = this.store.get(id);
        if (!record || !this.isCurrent(id)) continue;
        hits.push({ kind: "record", record, score: s.score, fts: s.fts, vector: s.vector, distance: readings.get(key)?.distance });
      } else {
        const slug = key.slice("page:".length);
        const page = this.pagesStore.getPage(slug);
        if (!page || page.deleted_at) continue;
        // A page reached only by the graph leg has no matching chunk, since no
        // text leg ranked one for it. Fall back to its first chunk so the hit
        // still carries readable content rather than a bare slug.
        const chunkId = bestChunk.get(key) ?? (s.graph ? `${slug}#0` : undefined);
        const chunk = chunkId ? this.pagesStore.getChunk(chunkId) : null;
        const rd = readings.get(key) ?? {};
        const vecId = vecChunk.get(key);
        const vecHeading = vecId && vecId !== chunkId ? this.pagesStore.getChunk(vecId)?.heading : null;
        const want = chunk?.heading?.toLowerCase();
        const section = want ? splitSections(page.body).find((x) => x.heading.toLowerCase() === want)?.heading : undefined;
        hits.push({
          kind: "page", slug, title: page.title, chunk, score: s.score, fts: s.fts, vector: s.vector, graph: s.graph,
          page_kind: kinds.get(slug) ?? "authored", bm25: rd.bm25, distance: rd.distance, authored_at: page.authored_at ?? null,
          ...(vecHeading && vecHeading !== chunk?.heading ? { vector_heading: vecHeading } : {}),
          ...(section ? { section } : {}),
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // Scale raw/generated page scores after fusion. Applied to the text-leg
  // fusion before the intent legs pick their seeds, so association anchors on
  // authored pages too, and again after the re-fuse. A slug the lookup did not
  // return (a page reached only by the graph leg, or tombstoned mid-query) is
  // treated as authored — the weight only ever demotes.
  private applyKindWeight(scores: Map<string, FuseEntry>, kinds: Map<string, PageKind>): Map<string, FuseEntry> {
    if (this.rawWeight === 1 && this.generatedWeight === 1) return scores;
    for (const [key, s] of scores) {
      if (!key.startsWith("page:")) continue;
      const kind = kinds.get(key.slice("page:".length));
      if (kind === "raw") s.score *= this.rawWeight;
      else if (kind === "generated") s.score *= this.generatedWeight;
    }
    return scores;
  }

  private isCurrent(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM current_records WHERE id = ?`).get(id);
    return !!row;
  }

  // Embed the query for the vector leg, or null if the embedder is unavailable —
  // search then degrades to FTS-only (every hit carries vector:false) instead of
  // failing outright. Canonical + FTS data must stay usable when embedding fails.
  private async embedQuery(query: string): Promise<Uint8Array | null> {
    try {
      const qvec = await this.embedder.embed(query, "query");
      return new Uint8Array(qvec.buffer, qvec.byteOffset, qvec.byteLength);
    } catch (e) {
      console.error(`[search] vector leg unavailable (${(e as Error).message}); serving FTS-only results`);
      return null;
    }
  }

  // Rebuild every derived index (FTS, vector, embedding metadata, relationships)
  // from the canonical current records. Safe to run anytime; heals partial-index
  // states (e.g. an add that succeeded but whose embedding failed) and re-embeds
  // after an embedder/model change.
  //
  // The text side (FTS + relationships) rebuilds in one synchronous transaction
  // that does not depend on the embedder, so keyword search survives an outage.
  // Vectors are replaced per record only after that record embeds; a failure
  // keeps the prior vector (a current id's content never changes in place, so it
  // is still right unless the model changed, which doctor's staleModel reports)
  // and is returned in `failed` rather than abandoning the rest.
  async reindexAll(): Promise<{ records: number; failed: string[] }> {
    const current = this.db.transaction(() => {
      const recs = this.store.listCurrent(); // reads canonical `records`, not the indexes
      this.store.clearTextIndexes();
      this.store.pruneNonCurrentVectors();
      for (const rec of recs) this.store.reindexText(rec);
      return recs;
    })();
    const failed: string[] = [];
    for (const rec of current) {
      try {
        await this.index(rec);
      } catch (e) {
        console.error(`[reindex] embedding failed for ${rec.id} (${(e as Error).message}); kept prior vector`);
        failed.push(rec.id);
      }
    }
    return { records: current.length, failed };
  }

  // Report derived-index health against the canonical current records without
  // changing anything. Any non-empty/non-zero field is healable with reindex.
  doctor(): HealthReport {
    const ids = (sql: string) => new Set((this.db.prepare(sql).all() as { id: string }[]).map((r) => r.id));
    const currentIds = [...ids(`SELECT id FROM current_records`)];
    const current = new Set(currentIds);
    const vec = ids(`SELECT record_id AS id FROM vec_records`);
    const fts = ids(`SELECT id FROM records_fts`);
    const emb = ids(`SELECT record_id AS id FROM embeddings`);
    const relSubjects = [...ids(`SELECT DISTINCT subject_id AS id FROM relationships`)];
    const staleModel = (this.db
      .prepare(`SELECT count(*) AS c FROM embeddings WHERE embedding_model != ?`)
      .get(this.embedder.model) as { c: number }).c;
    return {
      currentRecords: currentIds.length,
      missingVector: currentIds.filter((id) => !vec.has(id)),
      missingFts: currentIds.filter((id) => !fts.has(id)),
      missingEmbeddingMeta: currentIds.filter((id) => !emb.has(id)),
      orphanVector: [...vec].filter((id) => !current.has(id)).length,
      orphanFts: [...fts].filter((id) => !current.has(id)).length,
      orphanRelationships: relSubjects.filter((id) => !current.has(id)).length,
      staleModel,
    };
  }
}

interface FuseEntry { score: number; fts: boolean; vector: boolean; graph: boolean; }

type Leg = "fts" | "vector" | "graph";

// Reciprocal Rank Fusion over N ranked legs. Each leg contributes
// weight/(k+rank+1) to its rows' scores and marks which leg matched.
//
// `weight` exists because the graph leg is NOT a peer of the text legs. At equal
// weight a page reached purely by association scored the same as the best
// keyword match, and since the neighbourhood ordering mostly ties (see
// PagesStore.neighbors) the top graph slot went to an essentially arbitrary
// page. Observed on the live index for "what all runs on <host>":
// the host's own page fell from rank 3 to rank 6 behind three graph-only pages.
// Association is weaker evidence than the query matching the text, and the
// weight is what says so.
function fuse(legs: { rows: { id: string }[]; leg: Leg; weight?: number }[], k = RRF_K): Map<string, FuseEntry> {
  const scores = new Map<string, FuseEntry>();
  for (const { rows, leg, weight = 1 } of legs) {
    rows.forEach((r, i) => {
      const cur = scores.get(r.id) ?? { score: 0, fts: false, vector: false, graph: false };
      cur.score += weight / (k + i + 1);
      cur[leg] = true;
      scores.set(r.id, cur);
    });
  }
  return scores;
}

// Turn free text into a safe FTS5 OR-query of quoted terms.
// Returns "" when the query has no alphanumeric terms — callers must treat
// that as "skip the FTS leg" rather than running MATCH with an empty query.
function toMatchQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}
