import { ulid } from "ulidx";
import type { Database } from "./db.js";
import { contentHash } from "./hash.js";
import type { MemoryRecord, RecordInput, RecordType } from "./types.js";

// Bound a caller-supplied limit to a sane positive integer, falling back to
// `def` on NaN / non-positive / absent values so bad input can't error or run
// away with a huge/negative SQL LIMIT.
export function clampLimit(v: number | undefined, def: number, max = 1000): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

export class Store {
  constructor(private db: Database) {}

  add(input: RecordInput, opts?: { supersedes?: string; version?: number }): MemoryRecord {
    const now = new Date().toISOString();
    const rec: MemoryRecord = {
      id: ulid(),
      type: input.type,
      subject: input.subject,
      content: input.content,
      source: input.source ?? { kind: "unknown" },
      entities: input.entities ?? [],
      tags: input.tags ?? [],
      relationships: input.relationships ?? [],
      provenance: input.provenance ?? { author: "user", confidence: 1 },
      created_at: now,
      updated_at: now,
      version: opts?.version ?? 1,
      supersedes: opts?.supersedes ?? null,
      content_hash: contentHash(input),
    };
    const insert = this.db.prepare(
      `INSERT INTO records (id,type,subject,content,created_at,updated_at,version,supersedes,content_hash,tombstoned,doc)
       VALUES (@id,@type,@subject,@content,@created_at,@updated_at,@version,@supersedes,@content_hash,0,@doc)`,
    );
    const fts = this.db.prepare(
      `INSERT INTO records_fts (id,subject,content,tags) VALUES (?,?,?,?)`,
    );
    const rel = this.db.prepare(
      `INSERT INTO relationships (subject_id,predicate,object) VALUES (?,?,?)`,
    );
    const tx = this.db.transaction(() => {
      insert.run({
        id: rec.id, type: rec.type, subject: rec.subject, content: rec.content,
        created_at: rec.created_at, updated_at: rec.updated_at, version: rec.version,
        supersedes: rec.supersedes, content_hash: rec.content_hash,
        doc: JSON.stringify(rec),
      });
      fts.run(rec.id, rec.subject, rec.content, rec.tags.join(" "));
      for (const r of rec.relationships) rel.run(rec.id, r.predicate, r.object);
    });
    tx();
    return rec;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT doc FROM records WHERE id = ?`).get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as MemoryRecord) : undefined;
  }

  // Walk FORWARD from `id` to the live head of its supersede lineage: repeatedly
  // follow the non-tombstoned record (if any) whose `supersedes` points at the
  // current id. Returns undefined if `id` doesn't exist, or if the lineage has
  // no live head (the starting record is itself tombstoned with no successor).
  currentOf(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT id, tombstoned FROM records WHERE id = ?`)
      .get(id) as { id: string; tombstoned: number } | undefined;
    if (!row) return undefined;

    const nextOf = this.db.prepare(
      `SELECT id FROM records WHERE supersedes = ? AND tombstoned = 0`,
    );
    const visited = new Set<string>([row.id]);
    let cur = row;
    while (true) {
      const next = nextOf.get(cur.id) as { id: string } | undefined;
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      cur = { id: next.id, tombstoned: 0 };
    }
    if (cur.tombstoned) return undefined;
    return this.get(cur.id);
  }

  update(id: string, patch: Partial<RecordInput>): MemoryRecord {
    // Resolve to the CURRENT head of the lineage first, so an update against a
    // stale (already-superseded) id supersedes the head rather than forking the
    // lineage into two live versions.
    const head = this.currentOf(id);
    if (!head) throw new Error(`no such record (or forgotten): ${id}`);
    const input: RecordInput = {
      type: patch.type ?? head.type,
      subject: patch.subject ?? head.subject,
      content: patch.content ?? head.content,
      source: patch.source ?? head.source,
      entities: patch.entities ?? head.entities,
      tags: patch.tags ?? head.tags,
      relationships: patch.relationships ?? head.relationships,
      provenance: patch.provenance ?? head.provenance,
    };
    return this.add(input, { supersedes: head.id, version: head.version + 1 });
  }

  // The full connected set of versions for `id`: ancestors reached by walking
  // `supersedes` backward, plus descendants reached by walking it forward.
  private lineageOf(id: string): string[] {
    const supersedesOf = this.db.prepare(`SELECT supersedes FROM records WHERE id = ?`);
    const supersededBy = this.db.prepare(`SELECT id FROM records WHERE supersedes = ?`);

    const lineage = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      const ancestor = (supersedesOf.get(cur) as { supersedes: string | null } | undefined)?.supersedes;
      if (ancestor && !lineage.has(ancestor)) {
        lineage.add(ancestor);
        queue.push(ancestor);
      }
      const descendants = supersededBy.all(cur) as { id: string }[];
      for (const d of descendants) {
        if (!lineage.has(d.id)) {
          lineage.add(d.id);
          queue.push(d.id);
        }
      }
    }
    return [...lineage];
  }

  // Remove records from the DERIVED search indexes (FTS + vector + embedding
  // metadata). The canonical `records` row is untouched — callers decide whether
  // to tombstone or hard-delete it. Used to prune superseded/forgotten versions so
  // the search legs only ever hold live records (no index bloat, no candidate-pool
  // crowding by stale versions).
  deleteFromIndexes(ids: string[]): void {
    const fts = this.db.prepare(`DELETE FROM records_fts WHERE id = ?`);
    const vec = this.db.prepare(`DELETE FROM vec_records WHERE record_id = ?`);
    const emb = this.db.prepare(`DELETE FROM embeddings WHERE record_id = ?`);
    const rel = this.db.prepare(`DELETE FROM relationships WHERE subject_id = ?`);
    for (const rid of ids) {
      fts.run(rid);
      vec.run(rid);
      emb.run(rid);
      rel.run(rid);
    }
  }

  // Remove ALL derived-index rows (FTS, vector, embedding metadata, relationships).
  // Canonical `records` are untouched. Used by reindex before rebuilding.
  clearDerivedIndexes(): void {
    this.db.exec(
      "DELETE FROM records_fts; DELETE FROM vec_records; DELETE FROM embeddings; DELETE FROM relationships;",
    );
  }

  // Re-populate the text-side derived indexes (FTS + relationships) for an existing
  // canonical record, without creating a new version. Used by reindex (the vector
  // side is rebuilt by SearchService.index).
  reindexText(rec: MemoryRecord): void {
    this.db.prepare(`INSERT INTO records_fts (id,subject,content,tags) VALUES (?,?,?,?)`)
      .run(rec.id, rec.subject, rec.content, rec.tags.join(" "));
    const rel = this.db.prepare(`INSERT INTO relationships (subject_id,predicate,object) VALUES (?,?,?)`);
    for (const r of rec.relationships) rel.run(rec.id, r.predicate, r.object);
  }

  forget(id: string, hard = false): void {
    const lineage = this.lineageOf(id);
    const tx = this.db.transaction(() => {
      // Either path removes the whole lineage from the search indexes: a
      // forgotten record must not stay searchable, and its rows must not linger.
      this.deleteFromIndexes(lineage);
      if (hard) {
        // Relationships (+ FTS/vector/embedding) are already removed by
        // deleteFromIndexes above; a hard forget additionally drops the
        // canonical records themselves.
        const recDel = this.db.prepare(`DELETE FROM records WHERE id = ?`);
        for (const rid of lineage) recDel.run(rid);
      } else {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`UPDATE records SET tombstoned = 1, updated_at = ? WHERE id = ?`);
        for (const rid of lineage) stmt.run(now, rid);
      }
    });
    tx();
  }

  listCurrent(filter: { type?: RecordType; project?: string; since?: string; limit?: number } = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.type)  { clauses.push("type = ?");        params.push(filter.type); }
    if (filter.since) { clauses.push("created_at >= ?"); params.push(filter.since); }
    if (filter.project) {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(doc, '$.entities') je
                 WHERE json_extract(je.value, '$.type') = 'project'
                   AND json_extract(je.value, '$.id') = ?)`,
      );
      params.push(filter.project);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? `LIMIT ${clampLimit(filter.limit, 100)}` : "";
    const rows = this.db
      .prepare(`SELECT doc FROM current_records ${where} ORDER BY created_at DESC ${limit}`)
      .all(...params) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as MemoryRecord);
  }

  setEmbeddingMeta(recordId: string, model: string, dim: number, hash: string): void {
    this.db.prepare(
      `INSERT INTO embeddings (record_id,embedding_model,dim,content_hash,generated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(record_id) DO UPDATE SET embedding_model=excluded.embedding_model,
         dim=excluded.dim, content_hash=excluded.content_hash, generated_at=excluded.generated_at`,
    ).run(recordId, model, dim, hash, new Date().toISOString());
  }
}
